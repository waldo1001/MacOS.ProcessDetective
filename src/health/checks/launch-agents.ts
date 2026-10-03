import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { ClutterItem, HealthFinding } from '../../types.js';
import { launchAgentSteps } from '../manual.js';
import { evidence, onDiskBytes, plural, realFs, runPool, slug, tilde, type FsLike } from '../util.js';

interface PlistRef { dir: string; name: string; path: string }
interface ProgramRef { program: string; key: 'Program' | 'ProgramArguments.0' }

/** A program counts as dangling only when it is an absolute path that does not exist. */
export function isDanglingProgram(program: string, exists: (p: string) => boolean): boolean {
  return program.startsWith('/') && !exists(program);
}

async function programOf(ctx: HealthContext, file: string): Promise<ProgramRef | null> {
  const a = await ctx.run('/usr/bin/plutil', ['-extract', 'Program', 'raw', '-o', '-', file], 2000);
  if (!a.failed && a.stdout.trim()) return { program: a.stdout.trim(), key: 'Program' };
  const b = await ctx.run('/usr/bin/plutil', ['-extract', 'ProgramArguments.0', 'raw', '-o', '-', file], 2000);
  if (!b.failed && b.stdout.trim()) return { program: b.stdout.trim(), key: 'ProgramArguments.0' };
  return null; // neither key present: nothing to judge
}

/** Survey the three launchd folders (exported with an injectable fs for tests). */
export async function checkLaunchAgents(ctx: HealthContext, fs: FsLike = realFs): Promise<CheckResult> {
  const userDir = `${ctx.home}/Library/LaunchAgents`;
  const dirs = [userDir, '/Library/LaunchAgents', '/Library/LaunchDaemons'];

  const plists: PlistRef[] = [];
  const strays: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // folder missing or unreadable
    }
    for (const e of entries) {
      if (e.name.endsWith('.plist')) plists.push({ dir, name: e.name, path: `${dir}/${e.name}` });
      else if (dir === userDir && !e.name.startsWith('.') && !e.isDirectory()) strays.push(`${dir}/${e.name}`);
    }
  }

  const programs = await runPool(plists, 6, async (p) => ({ p, ref: await programOf(ctx, p.path) }));
  const findings: HealthFinding[] = [];
  for (const { p, ref } of programs) {
    if (!ref || !isDanglingProgram(ref.program, ctx.exists)) continue; // missing keys / relative program: skip silently
    const kind = p.dir.endsWith('LaunchDaemons') ? 'LaunchDaemon' : 'LaunchAgent';
    findings.push({
      id: `launch-agents:${slug(p.name.replace(/\.plist$/, ''))}`,
      checkId: 'launch-agents',
      category: 'startup',
      severity: 'warn',
      title: `${kind} “${p.name}” points at a program that no longer exists`,
      detail: `${tilde(p.path, ctx.home)} launches ${tilde(ref.program, ctx.home)}, which is gone. launchd retries it on every login or boot and logs a failure each time; the plist is leftover from an uninstalled app.`,
      evidence: [evidence(`plutil -extract ${ref.key} raw -o - "${p.path}"`, [ref.program, '(path does not exist)'])],
      safety: 'orphan',
      manualSteps: launchAgentSteps(p.path, ctx.home),
    });
  }

  const skipped: { id: string; reason: string }[] = [];
  if (strays.length) {
    const items: ClutterItem[] = [];
    for (const path of strays) {
      try {
        const st = await fs.lstat(path);
        items.push({ path, bytes: onDiskBytes(st), lastModified: st.mtimeMs, safety: 'orphan', note: 'not a .plist — launchd ignores it' });
      } catch {
        items.push({ path, bytes: 0, lastModified: null, safety: 'orphan', note: 'not a .plist — launchd ignores it' });
      }
    }
    findings.push({
      id: 'launch-agents:stray-files',
      checkId: 'launch-agents',
      category: 'startup',
      severity: 'info',
      title: `${plural(strays.length, 'stray file')} in ~/Library/LaunchAgents (launchd ignores ${strays.length === 1 ? 'it' : 'them'})`,
      detail: 'Backups and disabled plists left next to the live ones. They do nothing, but they make it hard to see what actually runs at login.',
      evidence: [evidence('ls ~/Library/LaunchAgents', strays.map((s) => s.slice(userDir.length + 1)))],
      items,
      reclaimableBytes: items.reduce((s, i) => s + i.bytes, 0),
      safety: 'orphan',
    });
  }
  return { findings, skipped };
}

export const launchAgentsCheck: HealthCheck = {
  id: 'launch-agents',
  category: 'startup',
  scope: 'quick',
  timeoutMs: 10_000,
  run: (ctx) => checkLaunchAgents(ctx),
};
