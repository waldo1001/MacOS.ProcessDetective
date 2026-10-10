import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  ActionMethod, ActionPlan, ActionResult, ActionTarget, AuditEntry, ClutterItem, HealthFinding, HealthReport, SafetyClass,
} from '../types.js';
import { fmtBytes } from '../render/format.js';
import { parseDf } from '../collect/system.js';
import { isLoopbackHost } from '../util/loopback.js';
import type { HealthContext } from './context.js';
import { actionsConfig, checkActionable, clutterEntryFor, isInside, type ActionsConfig } from './actionable.js';
import { appendAudit } from './audit.js';
import { BREW_ENV, BREW_PATHS } from './checks/brew.js';
import { parseDuK } from './checks/disk-clutter.js';
import { trashPaths } from './trash.js';
import { onDiskBytes, plural, realFs, runPool, type FsLike } from './util.js';

/**
 * The clean-up layer: a dry-run planner and an executor. It never runs on its own; it
 * acts only on a plan it stored itself (token in, no paths in), and only on items the
 * current report found. Files go to the Trash (recoverable); the three commands are
 * fixed argv arrays that take no value from a request.
 */

export class ActionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface CleanupAction {
  id: string;
  title: string;
  method: ActionMethod;
  explain: string;
  needsAck?: true;
  findingId?: string;                                   // command actions: the finding that offers it
  argv?: (ctx: HealthContext) => string[] | null;       // command actions; null = unavailable (no brew)
  pattern?: RegExp;                                     // the argv joined by ' ' must match
  timeoutMs?: number;
}

export const ACTIONS: CleanupAction[] = [
  {
    id: 'trash-paths', title: 'Move to the Trash', method: 'trash',
    explain: 'Moves the selected items to the Trash. Nothing is deleted: each item stays in the Trash until you empty it, and the audit log records where it came from, so it can be moved back.',
  },
  {
    id: 'brew-cleanup', title: 'Run brew cleanup', method: 'command', findingId: 'brew', timeoutMs: 120_000,
    explain: 'Runs brew cleanup, which removes old versions of installed formulae and stale downloads. Homebrew downloads again what it needs; this cannot be undone.',
    argv: (ctx) => {
      const brew = BREW_PATHS.find((p) => ctx.exists(p));
      return brew ? ['/usr/bin/env', ...BREW_ENV, brew, 'cleanup'] : null;
    },
    pattern: /^\/usr\/bin\/env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 (?:\/opt\/homebrew|\/usr\/local)\/bin\/brew cleanup$/,
  },
  {
    id: 'thin-snapshots', title: 'Thin local snapshots', method: 'command', findingId: 'apfs-snapshots', needsAck: true, timeoutMs: 120_000,
    explain: 'Thins the APFS local Time Machine snapshots so deleted files are really freed. It deletes local restore points (your backup destination is untouched); this cannot be undone.',
    argv: () => ['/usr/bin/tmutil', 'thinlocalsnapshots', '/', '999999999999', '4'],
    pattern: /^\/usr\/bin\/tmutil thinlocalsnapshots \/ 999999999999 4$/,
  },
  {
    id: 'simctl-delete-unavailable', title: 'Delete unavailable simulators', method: 'command', findingId: 'coresimulator', timeoutMs: 180_000,
    explain: 'Asks CoreSimulator to delete the simulator devices whose runtime is gone. Devices that still work are kept; this can take minutes when CoreSimulator is cold, and cannot be undone.',
    argv: () => ['/usr/bin/xcrun', 'simctl', 'delete', 'unavailable'],
    pattern: /^\/usr\/bin\/xcrun simctl delete unavailable$/,
  },
];

export const findAction = (id: string): CleanupAction | undefined => ACTIONS.find((a) => a.id === id);

/** Whether the layer is on: the kill-switch, the sandbox settings and (when known) the address the server is bound to. */
export function actionsEnabled(boundHost?: string, config: ActionsConfig = actionsConfig()): ActionsConfig {
  if (!config.enabled) return config;
  if (boundHost !== undefined && !isLoopbackHost(boundHost)) {
    return { enabled: false, reason: 'the server is not bound to a loopback address', sandbox: config.sandbox };
  }
  return config;
}

/** First 16 hex of sha256(actionId + "\n" + sorted paths joined by "\n"): paths only, so size drift cannot invalidate a plan. */
export function planToken(actionId: string, paths: string[]): string {
  return createHash('sha256').update(`${actionId}\n${[...paths].sort().join('\n')}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The plan store (server-side: execute takes a token, never paths)
// ---------------------------------------------------------------------------

export const PLAN_TTL_MS = 5 * 60_000;
export const MAX_PLANS = 20;
const plans = new Map<string, { plan: ActionPlan; at: number }>();

/** Keep a plan for 5 minutes, single use, at most 20 (the oldest is evicted first). */
export function storePlan(plan: ActionPlan, now: number = plan.createdAt): void {
  plans.delete(plan.token);
  plans.set(plan.token, { plan, at: now });
  for (const [t, e] of plans) if (now - e.at > PLAN_TTL_MS) plans.delete(t);
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value as string);
}

/** Take a plan out of the store: once only, and not after 5 minutes. */
export function takePlan(token: string, now: number = Date.now()): ActionPlan | undefined {
  const e = plans.get(token);
  if (!e) return undefined;
  plans.delete(token);
  return now - e.at > PLAN_TTL_MS ? undefined : e.plan;
}

export function clearPlans(): void {
  plans.clear();
}

// ---------------------------------------------------------------------------
// Resolving targets (rules 1–3): at plan time and again before acting
// ---------------------------------------------------------------------------

export interface ActionDeps {
  ctx: HealthContext;
  report: HealthReport;
  fs?: FsLike;
  now?: number;
}

export interface Resolved {
  findingId: string;
  path: string;
  bytes: number;
  safety: SafetyClass;
  note?: string;
}
export interface Refusal { findingId: string; path: string; reason: string; changed: boolean }

const DISK_IMAGE = /\.(raw|img|qcow2|dmg|iso)$/i;
const LSOF = '/usr/sbin/lsof';
const LSOF_MS = 10_000;
const DU_MS = 90_000;

/** Who has this file open, `null` when nobody, or a reason string when that could not be established. */
async function openHolder(ctx: HealthContext, p: string): Promise<{ holder: string | null; unknown?: string }> {
  if (!ctx.exists(LSOF)) return { holder: null, unknown: 'lsof is not available, so it cannot be checked whether the file is open' };
  const t0 = Date.now();
  const r = await ctx.run(LSOF, ['--', p], LSOF_MS);
  // lsof writes harmless warnings (an unreachable network mount) to stderr; only stdout rows count.
  const rows = r.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('COMMAND'));
  if (rows.length > 0) return { holder: rows[0]!.trim().split(/\s+/)[0]!.replace(/\\x20/g, ' ') };
  // A timeout looks like "no output"; never read it as "not open".
  if (r.failed && Date.now() - t0 >= LSOF_MS - 500) return { holder: null, unknown: 'checking whether the file is open timed out' };
  return { holder: null };
}

/** Run every rule for one target. Returns the resolved target (with the report's size) or the reason it is refused. */
async function resolveOne(
  t: ActionTarget,
  deps: ActionDeps,
  cfg: ActionsConfig,
  fs: FsLike,
): Promise<{ ok: Resolved; isFile: boolean } | { refused: Refusal }> {
  const { ctx, report } = deps;
  const refuse = (reason: string, changed = false): { refused: Refusal } => ({ refused: { findingId: t.findingId, path: t.path, reason, changed } });

  // Rule 1: only what the current report found.
  const finding: HealthFinding | undefined = report.findings.find((f) => f.id === t.findingId);
  const item: ClutterItem | undefined = finding?.items?.find((i) => i.path === t.path);
  if (!finding || !item) return refuse('not in the current report — re-check', true);

  // Rule 2: only where the catalog looks.
  const shape = checkActionable(finding, item, ctx.home, cfg.sandbox);
  if (!shape.ok) return refuse(shape.reason);

  // Rule 8(b), lexical half: with a sandbox set, anything outside it is refused without touching the path.
  if (cfg.sandbox && (!isInside(item.path, cfg.sandbox) || item.path === cfg.sandbox)) return refuse('outside the sandbox');

  // Rule 3: look at the disk.
  let st;
  try {
    st = await fs.lstat(item.path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    return refuse(code === 'ENOENT' ? 'it no longer exists' : `it cannot be read (${code ?? 'error'})`, true);
  }
  if (st.isSymbolicLink()) return refuse('it is a symlink — not followed', true);

  let real: string;
  let realRoot: string;
  let realLimit: string;
  try {
    real = await fs.realpath(item.path);
    realRoot = await fs.realpath(shape.root);
    realLimit = await fs.realpath(cfg.sandbox ?? ctx.home);
  } catch {
    return refuse('its folder could not be resolved', true);
  }
  if (cfg.sandbox && (!isInside(real, realLimit) || real === realLimit)) return refuse('outside the sandbox', true);
  if (!cfg.sandbox && (!isInside(real, realLimit) || real === realLimit)) return refuse('it resolves to somewhere outside your home folder', true);
  if (!isInside(real, realRoot) || real === realRoot) return refuse('it resolves outside the folder the survey looked in', true);

  // The survey never follows a symlinked base folder; neither does the action.
  try {
    if ((await fs.lstat(shape.root)).isSymbolicLink()) return refuse('the folder it is in is a symlink — not followed', true);
  } catch {
    return refuse('the folder it is in could not be read', true);
  }

  const entry = clutterEntryFor(finding, cfg.sandbox);
  if (entry?.runningHint && ctx.processes.some((p) => entry.runningHint!.name.test(p.name))) {
    return refuse(`${entry.runningHint.label} is running — quit it first`, true);
  }
  if (st.isFile() && DISK_IMAGE.test(item.path)) {
    const h = await openHolder(ctx, item.path);
    if (h.unknown) return refuse(h.unknown, true);
    if (h.holder) return refuse(`it is open in ${h.holder} — quit it first`, true);
  }
  return { ok: { findingId: finding.id, path: item.path, bytes: item.bytes, safety: item.safety, note: item.note }, isFile: st.isFile() };
}

/**
 * Rules 1–3 for a list of targets. `measure` re-measures sizes (plan time); execution
 * skips that. A target inside another selected target is refused: trashing the parent
 * already takes it along.
 */
export async function resolveTargets(
  targets: ActionTarget[],
  deps: ActionDeps,
  opts: { measure?: boolean; config?: ActionsConfig } = {},
): Promise<{ ok: Resolved[]; refused: Refusal[] }> {
  const fs = deps.fs ?? realFs;
  const cfg = opts.config ?? actionsConfig();
  const unique = targets.filter((t, i) => targets.findIndex((o) => o.path === t.path) === i);
  const outcomes = await runPool(unique, 3, async (t) => {
    try {
      const r = await resolveOne(t, deps, cfg, fs);
      if ('refused' in r || !opts.measure) return r;
      if (r.isFile) {
        const st = await fs.lstat(r.ok.path);
        return { ...r, ok: { ...r.ok, bytes: onDiskBytes(st) } };
      }
      const du = await deps.ctx.run('/usr/bin/du', ['-sk', '-P', '-x', '--', r.ok.path], DU_MS);
      const row = parseDuK(du.stdout).find((x) => x.path === r.ok.path);
      if (row) return { ...r, ok: { ...r.ok, bytes: row.kb * 1024 } };
      return { ...r, ok: { ...r.ok, note: [r.ok.note, 'size not re-measured'].filter(Boolean).join(' · ') } };
    } catch (err) {
      return { refused: { findingId: t.findingId, path: t.path, reason: `could not be checked: ${err instanceof Error ? err.message : String(err)}`, changed: true } };
    }
  });

  const ok: Resolved[] = [];
  const refused: Refusal[] = [];
  for (const o of outcomes) {
    if ('refused' in o) refused.push(o.refused);
    else ok.push(o.ok);
  }
  const kept: Resolved[] = [];
  for (const r of ok) {
    const parent = ok.find((o) => o !== r && r.path.startsWith(`${o.path}/`));
    if (parent) refused.push({ findingId: r.findingId, path: r.path, reason: `included in ${path.basename(parent.path)} (also selected)`, changed: false });
    else kept.push(r);
  }
  return { ok: kept, refused };
}

// ---------------------------------------------------------------------------
// Selecting targets from a report (CLI): the same rules the page applies
// ---------------------------------------------------------------------------

/**
 * Pick targets out of a report. `findingIds` selects every actionable `regenerates`/`orphan` item
 * of those findings (plus `ask` items with `includeAsk`); `paths` selects those exact items, which
 * must be actionable items of some finding. Never invents a target the report does not hold.
 */
export function selectTargets(
  report: HealthReport,
  sel: { findingIds?: string[]; paths?: string[]; includeAsk?: boolean },
  home: string,
  sandbox: string | null,
): { targets: ActionTarget[]; problems: string[] } {
  const targets: ActionTarget[] = [];
  const problems: string[] = [];
  const add = (findingId: string, p: string): void => {
    if (!targets.some((t) => t.path === p)) targets.push({ findingId, path: p });
  };
  for (const id of sel.findingIds ?? []) {
    const f = report.findings.find((x) => x.id === id);
    if (!f) {
      problems.push(`no finding "${id}" in the current report`);
      continue;
    }
    for (const it of f.items ?? []) {
      if (!checkActionable(f, it, home, sandbox).ok) continue;
      if (it.safety === 'ask' && !sel.includeAsk) continue;
      add(f.id, it.path);
    }
  }
  for (const p of sel.paths ?? []) {
    const hit = report.findings.find((f) => f.items?.some((it) => it.path === p && checkActionable(f, it, home, sandbox).ok));
    if (hit) add(hit.id, p);
    else problems.push(`${p} is not an actionable item of the current report`);
  }
  return { targets, problems };
}

/** The command actions the report currently offers (their finding is in it and the command exists here). */
export function offeredCommands(report: HealthReport, ctx: HealthContext): CleanupAction[] {
  return ACTIONS.filter(
    (a) => a.method === 'command' && report.findings.some((f) => f.id === a.findingId && f.actionId === a.id) && a.argv!(ctx) !== null,
  );
}

// ---------------------------------------------------------------------------
// Planning (the dry run)
// ---------------------------------------------------------------------------

function requireEnabled(): ActionsConfig {
  const cfg = actionsEnabled();
  if (!cfg.enabled) throw new ActionError(403, `actions disabled (${cfg.reason ?? 'off'})`);
  return cfg;
}

/**
 * Build and store a plan. Trash: every target goes through rules 1–3 and is re-measured; the
 * ones that fail are listed under `refused`. Command: no targets, its finding must be in the
 * report. A plan with nothing to do is returned (so the UI can say why) but is not stored.
 */
export async function planAction(actionId: string, targets: ActionTarget[], deps: ActionDeps): Promise<ActionPlan> {
  const cfg = requireEnabled();
  const action = findAction(actionId);
  if (!action) throw new ActionError(400, `unknown action "${actionId}"`);
  const now = deps.now ?? Date.now();
  const { ctx, report } = deps;

  if (action.method === 'command') {
    if (targets.length > 0) throw new ActionError(400, 'a command action takes no targets');
    const finding = report.findings.find((f) => f.id === action.findingId && f.actionId === action.id);
    if (!finding) throw new ActionError(409, `${action.title} is not offered by the current report — re-check`);
    const argv = action.argv!(ctx);
    if (!argv) throw new ActionError(409, `${action.title} is not available on this Mac`);
    if (!action.pattern!.test(argv.join(' '))) throw new ActionError(500, `${action.title}: the command does not match its pattern`);
    const plan: ActionPlan = {
      token: planToken(action.id, []), actionId: action.id, method: 'command', createdAt: now, reportAt: report.at,
      targets: [], refused: [], totalBytes: finding.reclaimableBytes ?? 0, command: argv.join(' '),
      explain: action.explain, needsAck: action.needsAck === true,
    };
    storePlan(plan);
    return plan;
  }

  if (targets.length === 0) throw new ActionError(400, 'no targets: select at least one item');
  const { ok, refused } = await resolveTargets(targets, deps, { measure: true, config: cfg });
  const plan: ActionPlan = {
    token: planToken(action.id, ok.map((t) => t.path)), actionId: action.id, method: 'trash', createdAt: now, reportAt: report.at,
    targets: ok.map((t) => ({ findingId: t.findingId, path: t.path, bytes: t.bytes, safety: t.safety, ...(t.note ? { note: t.note } : {}) })),
    refused: refused.map(({ findingId, path: p, reason }) => ({ findingId, path: p, reason })),
    totalBytes: ok.reduce((s, t) => s + t.bytes, 0),
    explain: action.explain,
    needsAck: ok.some((t) => t.safety === 'ask'),
  };
  if (plan.targets.length > 0) storePlan(plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const lastLines = (text: string, n: number): string => text.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-n).join('\n');

/** `Available` of `/` in bytes, or null when `df` gave no answer. */
async function availBytes(ctx: HealthContext): Promise<number | null> {
  const r = await ctx.run('/bin/df', ['-k', '/'], 5000);
  const root = parseDf(r.stdout).find((v) => v.mount === '/');
  return root ? root.availBytes : null;
}

const SNAPSHOT_NOTE = 'The space is held by local Time Machine snapshots — run Thin snapshots.';
let executing = false;

/**
 * Run a plan that {@link takePlan} handed out. Re-checks rules 1–3 for every target, enforces the
 * kill-switch and the sandbox here (not only in the route), measures the space with `df`, writes
 * the audit line and returns the result. A failed target or command is `partial`/`failed`, never a throw.
 */
export async function executePlan(plan: ActionPlan, deps: ActionDeps & { ack?: boolean }): Promise<ActionResult> {
  const cfg = requireEnabled();
  const action = findAction(plan.actionId);
  if (!action || action.method !== plan.method) throw new ActionError(400, `unknown action "${plan.actionId}"`);
  // The sandbox refusal comes first: with or without an acknowledgement, a command is never run in a sandbox.
  if (action.method === 'command' && cfg.sandbox) throw new ActionError(403, 'command actions are not executed while PD_ACTIONS_SANDBOX is set');
  if (plan.needsAck && !deps.ack) throw new ActionError(400, 'this clean-up needs your acknowledgement');
  if (executing) throw new ActionError(409, 'another clean-up is already running');
  executing = true;
  try {
    const result = action.method === 'trash' ? await executeTrash(plan, deps, cfg) : await executeCommand(plan, action, deps);
    const entry: AuditEntry = {
      at: result.at, actionId: result.actionId, method: result.method,
      paths: plan.targets.map((t) => t.path),
      bytesPlanned: result.bytesPlanned, bytesFreed: result.bytesFreed, result: result.result, note: result.note,
      ...(result.method === 'trash' ? { trashedTo: result.targets.flatMap((t) => (t.ok && t.trashedTo ? [t.trashedTo] : [])) } : {}),
    };
    await appendAudit(entry);
    return result;
  } finally {
    executing = false;
  }
}

async function executeTrash(plan: ActionPlan, deps: ActionDeps, cfg: ActionsConfig): Promise<ActionResult> {
  const { ctx } = deps;
  const now = deps.now ?? Date.now();
  const again = await resolveTargets(plan.targets.map((t) => ({ findingId: t.findingId, path: t.path })), deps, { config: cfg });
  const goOn = new Set(again.ok.map((t) => t.path));
  const skipped = new Map(again.refused.map((r) => [r.path, r.changed ? `changed since the dry run — ${r.reason}` : r.reason]));

  const before = goOn.size > 0 ? await availBytes(ctx) : null;
  const outcomes = goOn.size > 0 ? await trashPaths(ctx, [...goOn]) : [];
  const after = goOn.size > 0 ? await availBytes(ctx) : null;
  const byPath = new Map(outcomes.map((o) => [o.path, o]));

  const targets: ActionResult['targets'] = plan.targets.map((t) => {
    const o = byPath.get(t.path);
    if (o) return { path: t.path, ok: o.ok, ...(o.trashedTo ? { trashedTo: o.trashedTo } : {}), ...(o.error ? { error: o.error } : {}) };
    return { path: t.path, ok: false, error: skipped.get(t.path) ?? 'skipped' };
  });
  const nOk = targets.filter((t) => t.ok).length;
  const movedBytes = plan.targets.filter((t) => targets.find((r) => r.path === t.path)?.ok).reduce((s, t) => s + t.bytes, 0);
  const firstError = targets.find((t) => !t.ok)?.error;
  const note =
    `${plural(nOk, 'item')} (${fmtBytes(movedBytes)}) ${nOk === 1 ? 'is' : 'are'} now in the Trash — the space is freed when you empty the Trash in Finder; ` +
    'local Time Machine snapshots can hold it after that (Thin snapshots).' +
    (nOk < targets.length ? ` ${targets.length - nOk} of ${targets.length} could not be moved: ${firstError}.` : '');
  return {
    token: plan.token, actionId: plan.actionId, method: 'trash', at: now,
    result: nOk === 0 ? 'failed' : nOk === targets.length ? 'ok' : 'partial',
    targets, bytesPlanned: plan.totalBytes,
    bytesFreed: before !== null && after !== null ? Math.max(0, after - before) : 0,
    note,
  };
}

async function executeCommand(plan: ActionPlan, action: CleanupAction, deps: ActionDeps): Promise<ActionResult> {
  const { ctx, report } = deps;
  const now = deps.now ?? Date.now();
  const base = { token: plan.token, actionId: plan.actionId, method: 'command' as const, at: now, targets: [], bytesPlanned: plan.totalBytes };
  const finding = report.findings.find((f) => f.id === action.findingId && f.actionId === action.id);
  const argv = finding ? action.argv!(ctx) : null;
  if (!finding || !argv || !action.pattern!.test(argv.join(' ')) || argv.join(' ') !== plan.command) {
    return { ...base, result: 'failed', bytesFreed: 0, note: `${action.title} was not run: it is no longer offered by the current report, or the command changed — re-check.` };
  }
  const before = await availBytes(ctx);
  const r = await ctx.run(argv[0]!, argv.slice(1), action.timeoutMs ?? 120_000);
  const after = await availBytes(ctx);
  const freed = before !== null && after !== null ? Math.max(0, after - before) : 0;
  const output = lastLines(`${r.stdout}\n${r.stderr}`, 12);
  const parts = [
    r.failed ? `${action.title} failed or timed out (exit ${r.code}).` : `${action.title} finished.`,
    `df reports ${fmtBytes(freed)} more free space.`,
  ];
  if (!r.failed && action.id !== 'thin-snapshots' && freed < plan.totalBytes * 0.5 && (report.vitals.localSnapshots ?? 0) >= 1) {
    parts.push(SNAPSHOT_NOTE);
  }
  return { ...base, result: r.failed ? 'failed' : 'ok', bytesFreed: freed, ...(output ? { output } : {}), note: parts.join(' ') };
}
