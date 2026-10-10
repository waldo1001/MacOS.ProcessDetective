import { randomUUID } from 'node:crypto';
import type { ActionResult, HealthFinding, HealthReport, HealthScanJob, HealthVitals } from '../types.js';
import { fmtBytes } from '../render/format.js';
import type { HealthCheck, HealthContext } from './context.js';
import { makeContext } from './context.js';
import { defaultCache, type CacheEntry, type HealthCacheStore } from './cache.js';
import { ALL_CHECKS, runCheck, runPool, type CheckRun } from './registry.js';
import { computeReclaimable, computeVerdict, itemLabel, sortFindings } from './verdict.js';
import { actionsConfig, stampActionable } from './actionable.js';
import { SKIP_REASON, skipIds } from './util.js';

const DAY = 86_400_000;
const GIB = 1024 ** 3;
const QUICK_POOL = 6;
/**
 * After a failed background refresh, wait before trying again: as long as the check's
 * own ttl, but between 5 and 60 minutes. A check that fails or times out (for example
 * a command that is waiting on a macOS prompt nobody answered) must not re-run on
 * every request.
 */
const backoffMs = (check: HealthCheck): number => Math.min(Math.max(check.ttlMs ?? 0, 5 * 60_000), 60 * 60_000);

export interface CollectOptions {
  mode: 'quick' | 'full';
  awaitCached?: boolean;          // CLI: true. Server quick path: false.
  noCache?: boolean;              // ignore cached entries of cached checks (run + await them)
  include?: string[];             // on-demand (optIn) check ids to run now — only ever set by an explicit user action
  onProgress?: (p: { done: number; total: number; current: string }) => void;
  checks?: HealthCheck[];         // default ALL_CHECKS — injectable for tests
  ctx?: HealthContext;            // default makeContext()
  cache?: HealthCacheStore;       // default fileCache(healthCachePath())
}

// ---------------------------------------------------------------------------
// Background refresh bookkeeping (per cache store, so tests and data dirs never mix)
// ---------------------------------------------------------------------------

interface RefreshState {
  inflight: Map<string, Promise<void>>;
}
const states = new WeakMap<HealthCacheStore, RefreshState>();
const allInflight = new Set<Promise<void>>();

function stateFor(cache: HealthCacheStore): RefreshState {
  let s = states.get(cache);
  if (!s) {
    s = { inflight: new Map() };
    states.set(cache, s);
  }
  return s;
}

const entryFrom = (r: CheckRun): CacheEntry => ({
  at: Date.now(),
  durationMs: r.durationMs,
  findings: r.result!.findings,
  ...(r.result!.vitals ? { vitals: r.result!.vitals } : {}),
  ...(r.result!.skipped?.length ? { skipped: r.result!.skipped } : {}),
});

/** Single-flight background refresh of one cached check. Never throws; stores only on success. */
function startRefresh(check: HealthCheck, ctx: HealthContext, cache: HealthCacheStore): void {
  const st = stateFor(cache);
  if (st.inflight.has(check.id)) return;
  const p: Promise<void> = (async () => {
    const r = await runCheck(check, ctx);
    if (r.result) {
      cache.set(check.id, entryFrom(r));
      cache.setFailure(check.id, null);
    } else {
      cache.setFailure(check.id, { at: Date.now(), reason: r.skipped ?? 'failed' });
    }
  })()
    .catch(() => {})
    .finally(() => {
      st.inflight.delete(check.id);
      allInflight.delete(p);
    });
  st.inflight.set(check.id, p);
  allInflight.add(p);
}

/** Resolves when no background refresh is running. */
export async function whenIdle(): Promise<void> {
  while (allInflight.size > 0) await Promise.all([...allInflight]);
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

function baseVitals(ctx: HealthContext): HealthVitals {
  const root = ctx.system.storage.volumes.find((v) => v.mount === '/');
  const p = ctx.system.memory.pressure;
  return {
    memFreePct: null,
    swapUsedBytes: ctx.system.memory.swap.usedBytes,
    pressure: p === 'unknown' ? null : p,
    loadAvg1: ctx.system.cpu.loadAvg[0],
    uptimeSec: ctx.system.host.uptimeSeconds > 0 ? ctx.system.host.uptimeSeconds : null,
    processCount: ctx.system.processes.total || null,
    thermalWarning: null,
    batteryCycles: null,
    batteryHealthPct: null,
    diskFreeBytes: root ? root.availBytes : null,
    diskTotalBytes: root ? root.totalBytes : null,
    localSnapshots: null,
    crashes7d: null,
  };
}

let lastReport: HealthReport | null = null;

/** The most recent report produced by either path (quick or full), if any. */
export function getLastReport(): HealthReport | null {
  return lastReport;
}

export async function collectHealth(opts: CollectOptions): Promise<HealthReport> {
  const started = Date.now();
  const { mode } = opts;
  const checks = opts.checks ?? ALL_CHECKS;
  const cache = opts.cache ?? defaultCache();
  const ctx = opts.ctx ?? (await makeContext());
  const st = stateFor(cache);

  // Findings are bucketed per check and flattened in registry order, so the report
  // does not depend on which check happened to finish first.
  const buckets = new Map<string, HealthFinding[]>();
  const bucket = (check: HealthCheck): HealthFinding[] => {
    let b = buckets.get(check.id);
    if (!b) buckets.set(check.id, (b = []));
    return b;
  };
  const skipped: HealthReport['skipped'] = [];
  const refreshing: string[] = [];
  const patches: Partial<HealthVitals>[] = [];

  let done = 0;
  // Progress counts the checks that actually run; full checks still show cached findings in quick mode.
  const disabled = skipIds();
  const wanted = (c: HealthCheck): boolean => (c.optIn ? Boolean(opts.include?.includes(c.id)) : mode === 'full' || c.scope === 'quick');
  const total = checks.filter((c) => !disabled.has(c.id) && wanted(c)).length;
  const progress = (current: string): void => opts.onProgress?.({ done, total, current });
  let storedInline = false;
  let fullScanOk = true;

  const useEntry = (check: HealthCheck, e: CacheEntry): void => {
    for (const f of e.findings) bucket(check).push({ ...f, asOf: e.at });
    if (e.vitals) patches.push(e.vitals);
    if (e.skipped) skipped.push(...e.skipped);
  };

  /** Run now. Cached/full checks store the result; a failure keeps the previous entry and says so. */
  const runNow = async (check: HealthCheck, store: boolean): Promise<void> => {
    // A background refresh of the same check may be running: wait for it, don't start a second one.
    const running = st.inflight.get(check.id);
    if (running && store && mode === 'quick') {
      await running;
      const fresh = cache.get(check.id);
      if (fresh && ctx.now - fresh.at < (check.ttlMs ?? 0) && !opts.noCache) {
        useEntry(check, fresh);
        return;
      }
    }
    progress(check.id);
    const r = await runCheck(check, ctx, (cur) => progress(cur));
    if (r.result) {
      bucket(check).push(...r.result.findings);
      if (r.result.vitals) patches.push(r.result.vitals);
      if (r.result.skipped) skipped.push(...r.result.skipped);
      if (store) {
        cache.set(check.id, entryFrom(r));
        cache.setFailure(check.id, null);
        storedInline = true;
      }
    } else {
      skipped.push({ id: check.id, reason: r.skipped ?? 'failed' });
      if (check.scope === 'full') fullScanOk = false;
      if (store) {
        cache.setFailure(check.id, { at: Date.now(), reason: r.skipped ?? 'failed' });
        storedInline = true;
      }
      const old = store ? cache.get(check.id) : undefined;
      if (old) useEntry(check, old); // never overwrite good data with nothing
    }
  };

  const inline: { check: HealthCheck; store: boolean }[] = [];
  for (const check of checks) {
    const cached = check.ttlMs !== undefined;
    if (disabled.has(check.id)) {
      skipped.push({ id: check.id, reason: SKIP_REASON });
    } else if (check.optIn) {
      // Never on its own: only when the user asked for it in this request.
      if (opts.include?.includes(check.id)) inline.push({ check, store: true });
      else {
        const e = cache.get(check.id);
        if (e) useEntry(check, e);
        else skipped.push({ id: check.id, reason: `on demand — not run yet (${check.optIn.note})` });
      }
    } else if (check.scope === 'full') {
      if (mode === 'full') inline.push({ check, store: true });
      else {
        const e = cache.get(check.id);
        if (e) useEntry(check, e);
      }
    } else if (!cached) {
      inline.push({ check, store: false });
    } else if (mode === 'full') {
      inline.push({ check, store: true });
    } else {
      const e = opts.noCache ? undefined : cache.get(check.id);
      if (e && ctx.now - e.at < check.ttlMs!) {
        useEntry(check, e);
        continue;
      }
      // A check that failed or timed out recently is not retried on every request.
      const failure = opts.noCache ? undefined : cache.getFailure(check.id);
      if (failure && ctx.now - failure.at < backoffMs(check)) {
        if (e) useEntry(check, e);
        skipped.push({
          id: check.id,
          reason: `${failure.reason} — not retried yet${e ? ', showing the previous result' : ''} (a full scan or --no-cache retries now)`,
        });
      } else if (opts.awaitCached || opts.noCache) {
        inline.push({ check, store: true });
      } else {
        // Serve what we have and refresh in the background; never await a slow check here.
        if (e) useEntry(check, e);
        else skipped.push({ id: check.id, reason: 'warming — first result in under a minute' });
        refreshing.push(check.id);
        startRefresh(check, ctx, cache);
      }
    }
  }

  // Longest timeouts first so the slow checks overlap with everything else.
  inline.sort((a, b) => b.check.timeoutMs - a.check.timeoutMs);
  await runPool(inline, QUICK_POOL, async ({ check, store }) => {
    await runNow(check, store);
    done++;
    progress(check.id);
  });

  if (mode === 'full' && fullScanOk) cache.lastFullScanAt = Date.now();
  if (storedInline || mode === 'full') await cache.flush();

  const vitals = baseVitals(ctx);
  for (const patch of patches) {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (vitals as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // Which items the clean-up layer may offer. Stamped on copies, never on the cached objects, so
  // the flag cannot outlive the kill-switch or the sandbox it was computed under.
  const actions = actionsConfig();
  const sorted = stampActionable(
    sortFindings(checks.flatMap((c) => buckets.get(c.id) ?? [])),
    ctx.home,
    actions.sandbox,
    actions.enabled,
  );
  const reclaimable = computeReclaimable(sorted);
  const { verdict, reason } = computeVerdict(sorted, reclaimable, vitals);
  const at = Date.now();
  const lastFull = cache.lastFullScanAt;
  const report: HealthReport = {
    at,
    scope: mode,
    durationMs: at - started,
    verdict,
    verdictReason: reason,
    vitals,
    findings: sorted,
    reclaimable,
    skipped,
    fullScan: { at: lastFull, stale: lastFull == null ? false : at - lastFull > DAY },
    refreshing,
    onDemand: checks
      .filter((c) => c.optIn && !disabled.has(c.id))
      .map((c) => ({ id: c.id, category: c.category, label: c.optIn!.label, note: c.optIn!.note, at: cache.get(c.id)?.at ?? null })),
  };
  lastReport = report;
  return report;
}

// ---------------------------------------------------------------------------
// Full-scan job
// ---------------------------------------------------------------------------

const jobs = new Map<string, HealthScanJob>();
let currentJob: HealthScanJob | null = null;

/**
 * Start the full scan as one in-process job. A second call while it runs returns
 * the same job. The last few finished jobs stay in memory.
 */
export function startFullScan(opts: Partial<CollectOptions> = {}): HealthScanJob {
  if (currentJob && currentJob.state === 'running') return currentJob;
  const job: HealthScanJob = { id: randomUUID(), state: 'running', progress: { done: 0, total: 0, current: 'starting' } };
  currentJob = job;
  jobs.set(job.id, job);
  while (jobs.size > 5) jobs.delete(jobs.keys().next().value as string);

  collectHealth({
    ...opts,
    mode: 'full',
    awaitCached: true,
    onProgress: (p) => {
      job.progress = p;
    },
  }).then(
    (report) => {
      job.report = report;
      job.state = 'done';
    },
    (err) => {
      job.error = err instanceof Error ? err.message : String(err);
      job.state = 'failed';
    },
  );
  return job;
}

export function getScanJob(id: string): HealthScanJob | undefined {
  return jobs.get(id);
}

// ---------------------------------------------------------------------------
// After a clean-up
// ---------------------------------------------------------------------------

/**
 * Drop the given paths (and anything inside them) from findings. A finding left without items
 * is dropped; one that keeps some gets its reclaimable bytes, severity and title recomputed
 * from the items that remain. Pure.
 */
export function pruneFindings(findings: HealthFinding[], gone: string[]): HealthFinding[] {
  const isGone = (p: string): boolean => gone.some((g) => p === g || p.startsWith(`${g}/`));
  const out: HealthFinding[] = [];
  for (const f of findings) {
    if (!f.items) {
      out.push(f);
      continue;
    }
    const items = f.items.filter((i) => !isGone(i.path));
    if (items.length === f.items.length) out.push(f);
    else if (items.length > 0) {
      const total = items.reduce((s, i) => s + i.bytes, 0);
      const reclaimable = items
        .filter((i) => i.safety === 'regenerates' || i.safety === 'orphan' || i.safety === 'ask')
        .reduce((s, i) => s + i.bytes, 0);
      out.push({
        ...f,
        items,
        reclaimableBytes: reclaimable,
        ...(f.checkId === 'disk-clutter'
          ? {
              severity: reclaimable >= GIB ? ('advice' as const) : ('info' as const),
              title: `${itemLabel(f)}: ${fmtBytes(total)}${items.length > 1 ? ` in ${items.length} items` : ''}`,
            }
          : {}),
      });
    }
  }
  return out;
}

/** Remove trashed paths from the cached disk-clutter entry, so the next report no longer lists them. */
export function pruneTargets(paths: string[], cache: HealthCacheStore = defaultCache()): void {
  const e = cache.get('disk-clutter');
  if (!e || paths.length === 0) return;
  const findings = pruneFindings(e.findings, paths);
  if (findings.length !== e.findings.length || findings.some((f, i) => f !== e.findings[i])) cache.set('disk-clutter', { ...e, findings });
}

/**
 * Update the cache after an execution: trashed paths leave the cached survey and a brew
 * cleanup invalidates the cached brew finding. Flushes, so a later process sees it.
 */
export async function applyResultToCache(result: ActionResult, cache: HealthCacheStore = defaultCache()): Promise<void> {
  if (result.method === 'trash') {
    pruneTargets(result.targets.filter((t) => t.ok).map((t) => t.path), cache);
  }
  if (result.actionId === 'brew-cleanup') cache.remove('brew');
  await cache.flush();
}

/**
 * {@link applyResultToCache}, then a fresh quick report becomes the current one (so a second
 * plan for the same path is refused).
 */
export async function refreshAfterAction(
  result: ActionResult,
  opts: { cache?: HealthCacheStore; checks?: HealthCheck[]; ctx?: HealthContext } = {},
): Promise<HealthReport> {
  const cache = opts.cache ?? defaultCache();
  await applyResultToCache(result, cache);
  return collectHealth({
    mode: 'quick',
    awaitCached: false,
    cache,
    ...(opts.checks ? { checks: opts.checks } : {}),
    ...(opts.ctx ? { ctx: opts.ctx } : {}),
  });
}
