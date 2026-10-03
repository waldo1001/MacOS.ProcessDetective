import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { ClutterItem, HealthEvidence, HealthFinding } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { CLUTTER_CATALOG, DEFAULT_MIN_BYTES, classifyAppSupport, type ClutterEntry } from '../catalog.js';
import { evidence, onDiskBytes, plural, realFs, runPool, skipIds, SKIP_REASON, withDeadline, type FsLike } from '../util.js';

const GIB = 1024 ** 3;
const DAY = 86_400_000;
const SURVEY_BUDGET_MS = 90_000;
const DU_LIMIT_MS = 30_000;
const TOP_CHILDREN = 15;
const PERM = /Operation not permitted|Permission denied/i;
const NO_PERMISSION = 'no permission — grant Full Disk Access to include';
/** Another app's container: macOS holds the read until its "access data from other apps" dialog is answered. */
const CONTAINER = /\/Library\/(Group )?Containers\//;
const NO_ANSWER = 'no answer — macOS is asking to "access data from other apps"; allow it (or grant Full Disk Access) and rescan';

/** Home folders macOS protects behind a permission prompt — never probed for agent folders. */
const PROTECTED_HOME = new Set([
  'Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public',
]);

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

export interface DuRow { kb: number; path: string }

/** Parse `du -k` output: lines `<kb>\t<path>`; everything else (errors, noise) is ignored. */
export function parseDuK(stdout: string): DuRow[] {
  const rows: DuRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\d+)\t(.+)$/);
    if (m) rows.push({ kb: parseInt(m[1]!, 10), path: m[2]! });
  }
  return rows;
}

export interface AgentInfo {
  agentName: string | null;
  poolName: string | null;
  agentId: number | null;
  poolId: number | null;
}

/** Parse an Azure Pipelines `.agent` file. It starts with a UTF-8 BOM, which JSON.parse rejects. */
export function parseAgentFile(text: string): AgentInfo | null {
  try {
    const o = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    return { agentName: str(o['agentName']), poolName: str(o['poolName']), agentId: num(o['agentId']), poolId: num(o['poolId']) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

interface Measured {
  items: ClutterItem[];
  skipped: { id: string; reason: string }[];
  evidence: HealthEvidence[];
  remainder: { count: number; bytes: number } | null;
  notes: string[];
}
const empty = (): Measured => ({ items: [], skipped: [], evidence: [], remainder: null, notes: [] });

const expand = (base: string, home: string): string => (base.startsWith('~/') ? home + base.slice(1) : base);
const quote = (p: string): string => (/^[A-Za-z0-9_/.@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;
const duLimit = (deadline: number): number => Math.max(3000, Math.min(DU_LIMIT_MS, deadline - Date.now()));

async function lstatOrNull(fs: FsLike, p: string): Promise<Awaited<ReturnType<FsLike['lstat']>> | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** Latest mtime of a path and its first 200 direct children; null when unreadable. */
async function lastModified(fs: FsLike, p: string): Promise<number | null> {
  try {
    return await withDeadline(
      (async () => {
        const st = await fs.lstat(p);
        let max = st.mtimeMs;
        if (st.isDirectory()) {
          const kids = (await fs.readdir(p)).slice(0, 200);
          const times = await Promise.all(kids.map((k) => fs.lstat(`${p}/${k.name}`).then((s) => s.mtimeMs, () => 0)));
          for (const t of times) if (t > max) max = t;
        }
        return max;
      })(),
      8000,
      'mtime scan',
    );
  } catch {
    return null;
  }
}

async function installedApps(ctx: HealthContext, fs: FsLike): Promise<string[]> {
  const dirs = ['/Applications', '/Applications/Utilities', `${ctx.home}/Applications`, '/System/Applications'];
  const names: string[] = [];
  for (const d of dirs) {
    try {
      for (const e of await fs.readdir(d)) if (e.name.endsWith('.app')) names.push(e.name.slice(0, -4));
    } catch {
      /* folder missing */
    }
  }
  return names;
}

function runningNote(entry: ClutterEntry, ctx: HealthContext): string | undefined {
  const h = entry.runningHint;
  if (!h) return undefined;
  const running = ctx.processes.some((p) => h.name.test(p.name));
  return running ? `${h.label} is running` : `${h.label} is not running`;
}

async function measurePath(entry: ClutterEntry, ctx: HealthContext, fs: FsLike, deadline: number): Promise<Measured> {
  const m = empty();
  const base = expand(entry.base, ctx.home);
  const st = await lstatOrNull(fs, base);
  if (!st) return m; // not installed: no finding
  if (st.isSymbolicLink()) {
    m.skipped.push({ id: entry.id, reason: 'symlink — not followed' });
    return m;
  }
  const limit = duLimit(deadline);
  const r = await ctx.run('/usr/bin/du', ['-sk', '-P', '-x', '--', base], limit);
  const rows = parseDuK(r.stdout);
  const row = rows.find((x) => x.path === base) ?? rows[0];
  if (!row) {
    // A permission error must never look like "0 B".
    m.skipped.push({
      id: entry.id,
      reason: PERM.test(r.stderr) ? NO_PERMISSION
        : r.failed && CONTAINER.test(base) ? NO_ANSWER
        : r.failed ? `du failed or timed out after ${secs(limit)}` : 'du printed no size',
    });
    return m;
  }
  m.evidence.push(evidence(`du -sk -P -x -- ${quote(base)}`, [`${row.kb}\t${base}`]));
  if (PERM.test(r.stderr)) m.notes.push('partial: some sub-folders unreadable');
  const bytes = row.kb * 1024;
  if (bytes < (entry.minBytes ?? DEFAULT_MIN_BYTES)) return m;
  m.items.push({ path: base, bytes, lastModified: await lastModified(fs, base), safety: entry.safety, note: runningNote(entry, ctx) });
  return m;
}

async function measureChildren(
  entry: ClutterEntry,
  ctx: HealthContext,
  fs: FsLike,
  deadline: number,
  apps: () => Promise<string[]>,
): Promise<Measured> {
  const m = empty();
  const base = expand(entry.base, ctx.home);
  const st = await lstatOrNull(fs, base);
  if (!st) return m;
  if (st.isSymbolicLink()) {
    m.skipped.push({ id: entry.id, reason: 'symlink — not followed' });
    return m;
  }
  const limit = duLimit(deadline);
  const cmd = `du -k -d 1 -P -x -- ${quote(base)}`;
  const r = await ctx.run('/usr/bin/du', ['-k', '-d', '1', '-P', '-x', '--', base], limit);
  const rows = parseDuK(r.stdout);
  if (rows.length === 0) {
    if (PERM.test(r.stderr)) m.skipped.push({ id: entry.id, reason: NO_PERMISSION });
    else if (r.failed) m.skipped.push({ id: entry.id, reason: `du failed or timed out after ${secs(limit)}` });
    return m;
  }
  // du prints the base total last; a missing total on a failed run means it was cut off.
  const hasTotal = rows.some((x) => x.path === base);
  if (r.failed && !hasTotal) {
    m.skipped.push({ id: entry.id, reason: `partial: timed out after ${secs(limit)}` });
    m.notes.push(`partial: du timed out after ${secs(limit)}, later folders are missing`);
  } else if (PERM.test(r.stderr)) {
    m.notes.push('partial: some sub-folders unreadable');
  }

  const min = entry.minBytes ?? DEFAULT_MIN_BYTES;
  const matching = rows
    .filter((x) => x.path !== base && x.path.startsWith(`${base}/`))
    .map((x) => ({ path: x.path, name: x.path.slice(base.length + 1), bytes: x.kb * 1024, kb: x.kb }))
    .filter((x) => (entry.match ? entry.match.test(x.name) : true) && !(entry.exclude && entry.exclude.test(x.name)));
  const kept = matching.filter((x) => x.bytes >= min).sort((a, b) => b.bytes - a.bytes);
  const top = kept.slice(0, TOP_CHILDREN);
  const rest = matching.filter((x) => !top.includes(x));
  if (rest.length) m.remainder = { count: rest.length, bytes: rest.reduce((s, x) => s + x.bytes, 0) };
  if (top.length === 0) return m;
  m.evidence.push(evidence(cmd, top.slice(0, 10).map((x) => `${x.kb}\t${x.path}`)));

  const installed = entry.ownerCheck ? await apps() : [];
  m.items = await runPool(top, 4, async (x): Promise<ClutterItem> => {
    let safety = entry.safety;
    let note: string | undefined;
    if (entry.ownerCheck) {
      const c = classifyAppSupport(x.name, installed);
      safety = c.safety;
      note = c.note;
    } else if (entry.nameFromPlist) {
      const p = await ctx.run('/usr/bin/plutil', ['-extract', 'name', 'raw', '-o', '-', `${x.path}/${entry.nameFromPlist}`], 3000);
      if (!p.failed && p.stdout.trim()) note = p.stdout.trim();
    }
    return { path: x.path, bytes: x.bytes, lastModified: await lastModified(fs, x.path), safety, note };
  });
  return m;
}

async function measureFiles(entry: ClutterEntry, ctx: HealthContext, fs: FsLike): Promise<Measured> {
  const m = empty();
  const base = expand(entry.base, ctx.home);
  const st = await lstatOrNull(fs, base);
  if (!st) return m;
  if (st.isSymbolicLink()) {
    m.skipped.push({ id: entry.id, reason: 'symlink — not followed' });
    return m;
  }
  const min = entry.minBytes ?? DEFAULT_MIN_BYTES;
  const cutoff = ctx.now - (entry.olderThanDays ?? 0) * DAY;
  try {
    const items = await withDeadline(
      (async (): Promise<ClutterItem[]> => {
        const out: ClutterItem[] = [];
        for (const e of await fs.readdir(base)) {
          if (!e.isFile() || (entry.match && !entry.match.test(e.name))) continue;
          const f = await fs.lstat(`${base}/${e.name}`);
          if (!f.isFile() || f.mtimeMs > cutoff) continue;
          const bytes = onDiskBytes(f);
          if (bytes >= min) out.push({ path: `${base}/${e.name}`, bytes, lastModified: f.mtimeMs, safety: entry.safety });
        }
        return out.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_CHILDREN);
      })(),
      20_000,
      `reading ${base}`,
    );
    m.items = items;
    if (items.length) {
      m.evidence.push(evidence(`ls -ls ${quote(base)}`, items.slice(0, 10).map((i) => `${Math.round(i.bytes / 1024)}\t${i.path}`)));
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    m.skipped.push({
      id: entry.id,
      reason:
        code === 'EPERM' || code === 'EACCES'
          ? NO_PERMISSION
          : `${err instanceof Error ? err.message : String(err)} — a permission prompt may be waiting`,
    });
  }
  return m;
}

function devRoots(ctx: HealthContext): string[] {
  const env = process.env['PD_HEALTH_DEV_ROOTS'];
  if (env) return env.split(':').filter(Boolean);
  return ['SourceCode', 'Source', 'Developer', 'Projects', 'Code', 'src', 'git', 'repos', 'dev']
    .map((d) => `${ctx.home}/${d}`)
    .filter((d) => ctx.exists(d));
}

async function measureWorktrees(entry: ClutterEntry, ctx: HealthContext, deadline: number): Promise<Measured> {
  const m = empty();
  const min = entry.minBytes ?? DEFAULT_MIN_BYTES;
  const finds = await runPool(devRoots(ctx), 3, (root) =>
    ctx.run(
      '/usr/bin/find',
      [root, '-maxdepth', '6', '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', '-type', 'd', '-path', '*/.claude/worktrees', '-print', '-prune'],
      15_000,
    ),
  );
  const dirs = [...new Set(finds.flatMap((f) => f.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'))))];
  const children: { path: string; kb: number }[] = [];
  const lines: string[] = [];
  for (const dir of dirs) {
    const r = await ctx.run('/usr/bin/du', ['-k', '-d', '1', '-P', '-x', '--', dir], duLimit(deadline));
    for (const row of parseDuK(r.stdout)) {
      if (row.path !== dir && row.path.startsWith(`${dir}/`) && row.kb * 1024 >= min) {
        children.push(row);
        lines.push(`${row.kb}\t${row.path}`);
      }
    }
  }
  if (children.length === 0) return m;
  m.evidence.push(
    evidence('find <dev roots> -maxdepth 6 … -path "*/.claude/worktrees" -print; du -k -d 1 -P -x -- <worktrees dir>', lines.slice(0, 10)),
  );

  m.items = await runPool(
    children.sort((a, b) => b.kb - a.kb).slice(0, TOP_CHILDREN),
    3,
    async (c): Promise<ClutterItem> => {
      // `status` must not write anything in someone's worktree: no optional index refresh,
      // and no filesystem-monitor daemon started on their behalf.
      const g = await ctx.run(
        '/usr/bin/git',
        ['-c', 'core.fsmonitor=false', '--no-optional-locks', '-C', c.path, 'status', '--porcelain'],
        5000,
      );
      let safety: ClutterItem['safety'] = 'keep';
      let note = 'not a git worktree';
      if (!g.failed) {
        const changes = g.stdout.split('\n').filter((l) => l.trim() !== '').length;
        if (changes === 0) {
          safety = 'regenerates';
          note = 'clean worktree';
        } else {
          note = plural(changes, 'uncommitted change');
        }
      }
      return { path: c.path, bytes: c.kb * 1024, lastModified: null, safety, note };
    },
  );
  return m;
}

async function measureDevopsAgents(entry: ClutterEntry, ctx: HealthContext, fs: FsLike, deadline: number): Promise<Measured> {
  const m = empty();
  const min = entry.minBytes ?? DEFAULT_MIN_BYTES;
  let names: string[];
  try {
    names = (await fs.readdir(ctx.home))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !PROTECTED_HOME.has(e.name))
      .map((e) => e.name);
  } catch {
    return m;
  }
  for (const name of names) {
    const dir = `${ctx.home}/${name}`;
    const work = await lstatOrNull(fs, `${dir}/_work`);
    if (!work || !work.isDirectory()) continue;
    let agent: AgentInfo | null = null;
    try {
      agent = parseAgentFile(await fs.readFile(`${dir}/.agent`));
    } catch {
      continue; // no .agent file: not an Azure Pipelines agent folder
    }
    const r = await ctx.run('/usr/bin/du', ['-sk', '-P', '-x', '--', `${dir}/_work`], duLimit(deadline));
    const row = parseDuK(r.stdout)[0];
    if (!row) {
      m.skipped.push({ id: entry.id, reason: PERM.test(r.stderr) ? NO_PERMISSION : 'du failed or timed out' });
      continue;
    }
    m.evidence.push(evidence(`du -sk -P -x -- ${quote(`${dir}/_work`)}`, [`${row.kb}\t${dir}/_work`]));
    if (row.kb * 1024 < min) continue;
    m.items.push({
      path: `${dir}/_work`,
      bytes: row.kb * 1024,
      lastModified: await lastModified(fs, `${dir}/_work`),
      safety: entry.safety,
      note: agent ? `agent ${agent.agentName ?? '?'} (pool ${agent.poolName ?? '?'})` : 'agent folder (.agent unreadable)',
    });
  }
  return m;
}

/** Turn one measured entry into its finding (null when nothing was found). */
function toFinding(entry: ClutterEntry, m: Measured): HealthFinding | null {
  if (m.items.length === 0) return null;
  const total = m.items.reduce((s, i) => s + i.bytes, 0);
  const reclaimable = m.items
    .filter((i) => i.safety === 'regenerates' || i.safety === 'orphan' || i.safety === 'ask')
    .reduce((s, i) => s + i.bytes, 0);
  const cap = entry.regenNote.replace(/^[a-z]/, (c) => c.toUpperCase());
  const rest = m.remainder ? ` + ${m.remainder.count} smaller, ${fmtBytes(m.remainder.bytes)}.` : '';
  const notes = m.notes.length ? ` (${m.notes.join('; ')})` : '';
  return {
    id: entry.id,
    checkId: 'disk-clutter',
    category: 'clutter',
    severity: reclaimable >= GIB ? 'advice' : 'info',
    title: `${entry.title}: ${fmtBytes(total)}${m.items.length > 1 ? ` in ${m.items.length} items` : ''}`,
    detail: `${cap}${cap.endsWith('.') ? '' : '.'}${rest}${notes}`,
    evidence: m.evidence,
    items: m.items,
    reclaimableBytes: reclaimable,
    safety: entry.safety,
    regenNote: entry.regenNote,
    ...(entry.actionId ? { actionId: entry.actionId } : {}),
  };
}

/**
 * Survey the catalog: pool of 3 entries, whole survey bounded by `budgetMs`
 * (entries not started by then are skipped, not silently dropped).
 * Exported with an injectable fs for tests.
 */
export async function surveyClutter(
  ctx: HealthContext,
  catalog: ClutterEntry[] = CLUTTER_CATALOG,
  onProgress?: (current: string) => void,
  fs: FsLike = realFs,
  budgetMs = SURVEY_BUDGET_MS,
): Promise<CheckResult> {
  const deadline = Date.now() + budgetMs;
  const disabled = skipIds();
  let appsPromise: Promise<string[]> | null = null;
  const apps = (): Promise<string[]> => (appsPromise ??= installedApps(ctx, fs));

  const results = await runPool(
    catalog,
    3,
    async (entry): Promise<{ finding: HealthFinding | null; skipped: Measured['skipped'] }> => {
      if (disabled.has(entry.id)) return { finding: null, skipped: [{ id: entry.id, reason: SKIP_REASON }] };
      if (Date.now() >= deadline) return { finding: null, skipped: [{ id: entry.id, reason: 'survey budget exhausted' }] };
      onProgress?.(entry.title);
      try {
        const m =
          entry.kind === 'path' ? await measurePath(entry, ctx, fs, deadline)
          : entry.kind === 'children' ? await measureChildren(entry, ctx, fs, deadline, apps)
          : entry.kind === 'files' ? await measureFiles(entry, ctx, fs)
          : entry.kind === 'worktrees' ? await measureWorktrees(entry, ctx, deadline)
          : await measureDevopsAgents(entry, ctx, fs, deadline);
        return { finding: toFinding(entry, m), skipped: m.skipped };
      } catch (err) {
        return { finding: null, skipped: [{ id: entry.id, reason: `failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
  return {
    findings: results.flatMap((r) => (r.finding ? [r.finding] : [])),
    skipped: results.flatMap((r) => r.skipped).map((s) => ({ id: `disk-clutter:${s.id}`, reason: s.reason })),
  };
}

export const diskClutterCheck: HealthCheck = {
  id: 'disk-clutter',
  category: 'clutter',
  scope: 'full',
  timeoutMs: 100_000,
  run: (ctx, onProgress) => surveyClutter(ctx, CLUTTER_CATALOG, onProgress),
};
