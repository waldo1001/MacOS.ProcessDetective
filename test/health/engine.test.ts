import { describe, expect, it } from 'vitest';
import type { HealthCheck, HealthContext } from '../../src/health/context.js';
import { fileCache, healthCachePath, memoryCache, parseCacheFile } from '../../src/health/cache.js';
import { collectHealth, getLastReport, getScanJob, startFullScan, whenIdle } from '../../src/health/engine.js';
import type { HealthFinding } from '../../src/types.js';
import { memoryPressureCheck } from '../../src/health/checks/memory-pressure.js';
import { diskSpaceCheck } from '../../src/health/checks/disk-space.js';
import { fakeContext, ok, scriptedRun } from './helpers.js';

const HOUR = 3_600_000;
const f = (id: string, over: Partial<HealthFinding> = {}): HealthFinding => ({
  id, checkId: id, category: 'tooling', severity: 'info', title: `${id} title`, detail: '', evidence: [], ...over,
});

interface Counted extends HealthCheck { runs: number }
function check(id: string, over: Partial<HealthCheck> & { fail?: boolean; delay?: number; findings?: HealthFinding[] } = {}): Counted {
  const c: Counted = {
    id, category: 'tooling', scope: 'quick', timeoutMs: 1000, runs: 0,
    ...over,
    async run(_ctx: HealthContext, onProgress) {
      c.runs++;
      onProgress?.(`working on ${id}`);
      if (over.delay) await new Promise((r) => setTimeout(r, over.delay));
      if (over.fail) throw new Error('refresh failed');
      return { findings: over.findings ?? [f(id)], vitals: id === 'vitals-check' ? { crashes7d: 4 } : undefined };
    },
  };
  return c;
}
const ctx = () => fakeContext({ now: Date.now() });

describe('collectHealth: which checks run', () => {
  it('quick mode runs quick checks and never a full check', async () => {
    const quick = check('q');
    const full = check('big', { scope: 'full' });
    const r = await collectHealth({ mode: 'quick', checks: [quick, full], ctx: ctx(), cache: memoryCache() });
    expect(quick.runs).toBe(1);
    expect(full.runs).toBe(0);
    expect(r.scope).toBe('quick');
    expect(r.findings.map((x) => x.id)).toEqual(['q']);
    expect(r.fullScan).toEqual({ at: null, stale: false });
  });

  it('quick mode shows the cached findings of a full check, marked asOf', async () => {
    const cache = memoryCache();
    const full = check('big', { scope: 'full' });
    cache.set('big', { at: 1234, durationMs: 5, findings: [f('big')] });
    const r = await collectHealth({ mode: 'quick', checks: [full], ctx: ctx(), cache });
    expect(full.runs).toBe(0);
    expect(r.findings[0]!.asOf).toBe(1234);
  });

  it('full mode runs everything, stores cached checks and sets fullScan.at', async () => {
    const cache = memoryCache();
    const q = check('q');
    const slow = check('slow', { ttlMs: HOUR });
    const full = check('big', { scope: 'full' });
    const r = await collectHealth({ mode: 'full', checks: [q, slow, full], ctx: ctx(), cache });
    expect([q.runs, slow.runs, full.runs]).toEqual([1, 1, 1]);
    expect(r.scope).toBe('full');
    expect(r.fullScan.at).not.toBeNull();
    expect(r.fullScan.stale).toBe(false);
    expect(cache.get('slow')).toBeDefined();
    expect(cache.get('big')).toBeDefined();
  });

  it('full mode force-refreshes a check whose cache is still fresh', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR });
    cache.set('slow', { at: Date.now(), durationMs: 1, findings: [f('old')] });
    const r = await collectHealth({ mode: 'full', checks: [slow], ctx: ctx(), cache });
    expect(slow.runs).toBe(1);
    expect(r.findings.map((x) => x.id)).toEqual(['slow']);
  });

  it('fullScan is stale after 24 h', async () => {
    const cache = memoryCache();
    cache.lastFullScanAt = Date.now() - 25 * HOUR;
    const r = await collectHealth({ mode: 'quick', checks: [], ctx: ctx(), cache });
    expect(r.fullScan.stale).toBe(true);
  });
});

describe('collectHealth: cached checks', () => {
  it('no entry + awaitCached:false → skipped "warming", listed as refreshing; the next call has the findings', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR, delay: 20 });
    const first = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, awaitCached: false });
    expect(first.skipped).toEqual([{ id: 'slow', reason: 'warming — first result in under a minute' }]);
    expect(first.refreshing).toEqual(['slow']);
    expect(first.findings).toEqual([]);

    await whenIdle();
    const second = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, awaitCached: false });
    expect(second.findings.map((x) => x.id)).toEqual(['slow']);
    expect(second.findings[0]!.asOf).toBeTypeOf('number');
    expect(second.skipped).toEqual([]);
    expect(second.refreshing).toEqual([]);
    expect(slow.runs).toBe(1);
  });

  it('awaitCached:true runs the check inline and stores it', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR });
    const r = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, awaitCached: true });
    expect(slow.runs).toBe(1);
    expect(r.findings.map((x) => x.id)).toEqual(['slow']);
    expect(r.findings[0]!.asOf).toBeUndefined(); // fresh, not from cache
    expect(r.refreshing).toEqual([]);
    const again = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, awaitCached: true });
    expect(slow.runs).toBe(1); // served from the fresh cache
    expect(again.findings[0]!.asOf).toBeTypeOf('number');
  });

  it('noCache re-runs and awaits a cached check even when its entry is fresh', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR });
    cache.set('slow', { at: Date.now(), durationMs: 1, findings: [f('old')] });
    const r = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, noCache: true });
    expect(slow.runs).toBe(1);
    expect(r.findings.map((x) => x.id)).toEqual(['slow']);
  });

  it('a stale entry is served (asOf) while a background refresh replaces it', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR, findings: [f('slow', { title: 'new' })] });
    cache.set('slow', { at: Date.now() - 2 * HOUR, durationMs: 1, findings: [f('slow', { title: 'old' })] });
    const r = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache });
    expect(r.findings[0]!.title).toBe('old');
    expect(r.findings[0]!.asOf).toBeTypeOf('number');
    expect(r.refreshing).toEqual(['slow']);
    await whenIdle();
    expect(cache.get('slow')!.findings[0]!.title).toBe('new');
  });

  it('a failing background refresh keeps the old entry and is not retried on every request', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR, fail: true });
    const old = { at: Date.now() - 2 * HOUR, durationMs: 1, findings: [f('slow', { title: 'old' })] };
    cache.set('slow', old);
    await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache });
    await whenIdle();
    expect(cache.get('slow')).toBe(old);
    expect(cache.getFailure('slow')!.reason).toContain('refresh failed');

    const again = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache });
    await whenIdle();
    expect(slow.runs).toBe(1); // backed off
    expect(again.findings[0]!.title).toBe('old');
    expect(again.skipped[0]!.reason).toContain('not retried yet');
    expect(again.refreshing).toEqual([]);

    // an explicit --no-cache / full scan retries now
    await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, noCache: true });
    expect(slow.runs).toBe(2);
  });

  it('a failing inline run keeps the old entry, shows it, and adds a skipped line', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR, fail: true });
    const old = { at: Date.now() - 2 * HOUR, durationMs: 1, findings: [f('slow', { title: 'old' })] };
    cache.set('slow', old);
    const r = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache, awaitCached: true });
    expect(cache.get('slow')).toBe(old);
    expect(r.findings[0]!.title).toBe('old');
    expect(r.skipped).toEqual([{ id: 'slow', reason: 'failed: refresh failed' }]);
  });

  it('concurrent requests share one background refresh (single flight)', async () => {
    const cache = memoryCache();
    const slow = check('slow', { ttlMs: HOUR, delay: 30 });
    await Promise.all([
      collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache }),
      collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache }),
    ]);
    await whenIdle();
    expect(slow.runs).toBe(1);
  });
});

describe('collectHealth: on-demand checks (they raise a macOS authorization dialog)', () => {
  const optIn = { label: 'Check it', note: 'needs Touch ID' };

  it('never runs on its own: not quick, not awaited, not noCache, not in a full scan, not in the background', async () => {
    const od = check('od', { optIn });
    const cache = memoryCache();
    for (const o of [
      { mode: 'quick' as const },
      { mode: 'quick' as const, awaitCached: true },
      { mode: 'quick' as const, noCache: true },
      { mode: 'full' as const },
    ]) {
      const r = await collectHealth({ ...o, checks: [od], ctx: ctx(), cache });
      expect(r.refreshing).toEqual([]);
      expect(r.findings).toEqual([]);
      expect(r.skipped).toEqual([{ id: 'od', reason: 'on demand — not run yet (needs Touch ID)' }]);
      expect(r.onDemand).toEqual([{ id: 'od', category: 'tooling', label: 'Check it', note: 'needs Touch ID', at: null }]);
    }
    await whenIdle();
    expect(od.runs).toBe(0);
  });

  it('runs when included, is stored, and later requests show the stored result with asOf', async () => {
    const od = check('od', { optIn });
    const cache = memoryCache();
    const first = await collectHealth({ mode: 'quick', include: ['od'], checks: [od], ctx: ctx(), cache });
    expect(od.runs).toBe(1);
    expect(first.findings.map((x) => x.id)).toEqual(['od']);
    expect(first.findings[0]!.asOf).toBeUndefined();
    expect(first.onDemand[0]!.at).toBeGreaterThan(0);

    const later = await collectHealth({ mode: 'full', checks: [od], ctx: ctx(), cache });
    expect(od.runs).toBe(1);
    expect(later.findings[0]!.asOf).toBe(first.onDemand[0]!.at);
    expect(later.skipped).toEqual([]);
  });

  it('a failed on-demand run is skipped with its reason and keeps the previous result', async () => {
    const cache = memoryCache();
    await collectHealth({ mode: 'quick', include: ['od'], checks: [check('od', { optIn })], ctx: ctx(), cache });
    const failing = check('od', { optIn, fail: true });
    const r = await collectHealth({ mode: 'quick', include: ['od'], checks: [failing], ctx: ctx(), cache });
    expect(r.skipped).toEqual([{ id: 'od', reason: 'failed: refresh failed' }]);
    expect(r.findings.map((x) => x.id)).toEqual(['od']);
    expect(r.findings[0]!.asOf).toBeGreaterThan(0);
  });

  it('include cannot start a check that is not on demand twice, and ignores unknown ids', async () => {
    const plain = check('plain');
    const r = await collectHealth({ mode: 'quick', include: ['plain', 'nope'], checks: [plain], ctx: ctx(), cache: memoryCache() });
    expect(plain.runs).toBe(1);
    expect(r.onDemand).toEqual([]);
  });
});

describe('PD_HEALTH_SKIP', () => {
  it('a listed check never runs and says why', async () => {
    const before = process.env['PD_HEALTH_SKIP'];
    process.env['PD_HEALTH_SKIP'] = 'b, od';
    try {
      const a = check('a'), b = check('b'), od = check('od', { optIn: { label: 'x', note: 'y' } });
      const r = await collectHealth({ mode: 'full', include: ['od'], checks: [a, b, od], ctx: ctx(), cache: memoryCache() });
      expect([a.runs, b.runs, od.runs]).toEqual([1, 0, 0]);
      expect(r.skipped).toEqual([
        { id: 'b', reason: 'disabled by PD_HEALTH_SKIP' },
        { id: 'od', reason: 'disabled by PD_HEALTH_SKIP' },
      ]);
      expect(r.onDemand).toEqual([]);
    } finally {
      if (before === undefined) delete process.env['PD_HEALTH_SKIP']; else process.env['PD_HEALTH_SKIP'] = before;
    }
  });
});

describe('collectHealth: report assembly', () => {
  it('a check that throws is skipped and does not fail the report', async () => {
    const bad = check('bad', { fail: true });
    const good = check('good');
    const r = await collectHealth({ mode: 'quick', checks: [bad, good], ctx: ctx(), cache: memoryCache() });
    expect(r.skipped).toEqual([{ id: 'bad', reason: 'failed: refresh failed' }]);
    expect(r.findings.map((x) => x.id)).toEqual(['good']);
  });

  it('a check that times out is skipped', async () => {
    const slow = check('hang', { timeoutMs: 20, delay: 200 });
    const r = await collectHealth({ mode: 'quick', checks: [slow], ctx: ctx(), cache: memoryCache() });
    expect(r.skipped[0]!.id).toBe('hang');
    expect(r.skipped[0]!.reason).toMatch(/timed out/);
  });

  it('merges vitals: the base comes from the system snapshot, check patches win', async () => {
    const v = check('vitals-check', { category: 'vitals' });
    const r = await collectHealth({ mode: 'quick', checks: [v], ctx: ctx(), cache: memoryCache() });
    expect(r.vitals.crashes7d).toBe(4);
    expect(r.vitals.loadAvg1).toBe(1.5);
    expect(r.vitals.diskFreeBytes).toBe(1400 * 1e9); // Available column, from the snapshot
    expect(r.vitals.memFreePct).toBeNull();
  });

  it('findings come back sorted and in registry order within equal rank; verdict and reclaimable are computed', async () => {
    const a = check('a', { category: 'clutter', findings: [f('a', { category: 'clutter', items: [{ path: '/x', bytes: 30 * 1024 ** 3, lastModified: null, safety: 'regenerates' }] })] });
    const b = check('b', { category: 'vitals' });
    const r = await collectHealth({ mode: 'quick', checks: [a, b], ctx: ctx(), cache: memoryCache() });
    expect(r.findings.map((x) => x.id)).toEqual(['b', 'a']); // vitals before clutter, whatever the input order
    expect(r.reclaimable.total).toBe(30 * 1024 ** 3);
    expect(r.verdict).toBe('cluttered');
  });

  it('reports progress and remembers the last report', async () => {
    const seen: string[] = [];
    const r = await collectHealth({
      mode: 'quick', checks: [check('one'), check('two')], ctx: ctx(), cache: memoryCache(),
      onProgress: (p) => seen.push(`${p.done}/${p.total}`),
    });
    expect(seen.at(-1)).toBe('2/2');
    expect(getLastReport()).toBe(r);
  });
});

describe('collectHealth: real vitals checks decide the verdict', () => {
  const GIB = 1024 ** 3;
  const run = (level: string) => scriptedRun([['kern.memorystatus_level', ok(`${level}\n`)]]);
  const verdict = async (c: HealthContext) =>
    (await collectHealth({ mode: 'quick', checks: [memoryPressureCheck, diskSpaceCheck], ctx: c, cache: memoryCache() })).verdict;

  it('swap 5 GiB with 8 % free is sick; the same swap with 60 % free is only advice (healthy)', async () => {
    const memory = { swap: { totalBytes: 8 * GIB, usedBytes: 5 * GIB } };
    expect(await verdict(fakeContext({ now: Date.now(), memory, run: run('8') }))).toBe('sick');
    expect(await verdict(fakeContext({ now: Date.now(), memory, run: run('60') }))).toBe('healthy');
  });

  it('disk 3 % free is sick; 1.3 TB free is healthy', async () => {
    const vol = (avail: number) => ({ volumes: [{ name: 'Macintosh HD', mount: '/', totalBytes: 1000 * GIB, usedBytes: 0, usedPct: 0, availBytes: avail }] });
    expect(await verdict(fakeContext({ now: Date.now(), system: { storage: vol(30 * GIB) }, run: run('90') }))).toBe('sick');
    expect(await verdict(fakeContext({ now: Date.now(), system: { storage: vol(700 * GIB) }, run: run('90') }))).toBe('healthy');
  });
});

describe('startFullScan', () => {
  it('is one job: a second call while it runs returns the same job; it finishes with a report', async () => {
    const cache = memoryCache();
    const opts = { checks: [check('q', { delay: 30 }), check('big', { scope: 'full' })], ctx: ctx(), cache };
    const job = startFullScan(opts);
    const again = startFullScan(opts);
    expect(again).toBe(job);
    expect(job.state).toBe('running');
    expect(getScanJob(job.id)).toBe(job);
    for (let i = 0; i < 100 && job.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(job.state).toBe('done');
    expect(job.report!.scope).toBe('full');
    expect(job.progress.done).toBe(2);
    expect(getScanJob('nope')).toBeUndefined();
    // a finished job lets the next call start a new one
    expect(startFullScan(opts)).not.toBe(job);
  });
});

describe('cache', () => {
  it('lives under PD_DATA_DIR when set, else Application Support', () => {
    const saved = process.env['PD_DATA_DIR'];
    process.env['PD_DATA_DIR'] = '/somewhere/pd';
    expect(healthCachePath()).toBe('/somewhere/pd/health-cache.json');
    delete process.env['PD_DATA_DIR'];
    expect(healthCachePath()).toMatch(/Library\/Application Support\/ProcessDetective\/health-cache\.json$/);
    if (saved !== undefined) process.env['PD_DATA_DIR'] = saved;
  });

  it('parseCacheFile: a damaged file yields an empty cache and bad entries are dropped', () => {
    const empty = { version: 1, lastFullScanAt: null, entries: {}, failures: {} };
    expect(parseCacheFile(null)).toEqual(empty);
    expect(parseCacheFile('not json')).toEqual(empty);
    expect(parseCacheFile('{"version":2,"entries":{}}')).toEqual(empty);
    expect(parseCacheFile('null')).toEqual(empty);
    const good = { at: 5, durationMs: 1, findings: [] };
    const r = parseCacheFile(JSON.stringify({
      version: 1, lastFullScanAt: 9, entries: { good, bad: { at: 'x', findings: [] }, worse: { at: 1, findings: 'no' } },
      failures: { a: { at: 3, reason: 'timed out' }, b: { at: 'x' } },
    }));
    expect(Object.keys(r.entries)).toEqual(['good']);
    expect(r.lastFullScanAt).toBe(9);
    expect(r.failures).toEqual({ a: { at: 3, reason: 'timed out' } });
  });

  it('tolerates a missing or corrupt file and never throws on an unwritable directory', async () => {
    const missing = fileCache('/nonexistent-pd-dir/health-cache.json');
    expect(missing.get('x')).toBeUndefined();
    expect(missing.lastFullScanAt).toBeNull();
    missing.set('x', { at: 1, durationMs: 1, findings: [] });
    missing.lastFullScanAt = 5;
    await expect(missing.flush()).resolves.toBeUndefined();
    expect(missing.get('x')!.at).toBe(1); // still served from memory

    const corrupt = fileCache(new URL('../../README.md', import.meta.url).pathname); // exists, is not a cache (read only)
    expect(corrupt.get('x')).toBeUndefined();
  });
});
