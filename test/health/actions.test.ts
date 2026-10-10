import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIONS, ActionError, MAX_PLANS, PLAN_TTL_MS, actionsEnabled, clearPlans, executePlan, findAction, offeredCommands, planAction, planToken,
  resolveTargets, selectTargets, storePlan, takePlan,
} from '../../src/health/actions.js';
import { memoryCache } from '../../src/health/cache.js';
import { collectHealth, pruneFindings, pruneTargets, refreshAfterAction, getLastReport } from '../../src/health/engine.js';
import type { HealthCheck } from '../../src/health/context.js';
import type { ActionPlan, ClutterItem, HealthFinding, HealthReport, HealthVitals, SafetyClass } from '../../src/types.js';
import { fail, fakeContext, fakeFs, NOW, ok, proc, scriptedRun, type FakeNode } from './helpers.js';

const HOME = '/Users/test';
const CACHES = `${HOME}/Library/Caches`;
const MB = 1024 ** 2;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NULL_VITALS: HealthVitals = {
  memFreePct: null, swapUsedBytes: null, pressure: null, loadAvg1: null, uptimeSec: null, processCount: null, thermalWarning: null,
  batteryCycles: null, batteryHealthPct: null, diskFreeBytes: null, diskTotalBytes: null, localSnapshots: null, crashes7d: null,
};
const item = (path: string, safety: SafetyClass = 'regenerates', bytes = 5 * MB, note?: string): ClutterItem => ({
  path, bytes, lastModified: null, safety, ...(note ? { note } : {}),
});
const clutter = (id: string, items: ClutterItem[]): HealthFinding => ({
  id, checkId: 'disk-clutter', category: 'clutter', severity: 'advice', title: `${id}: ${items.length} items`, detail: '', evidence: [],
  items, reclaimableBytes: items.reduce((s, i) => s + i.bytes, 0),
});
const mkReport = (findings: HealthFinding[], vitals: Partial<HealthVitals> = {}): HealthReport => ({
  at: NOW, scope: 'full', durationMs: 1, verdict: 'healthy', verdictReason: '', vitals: { ...NULL_VITALS, ...vitals }, findings,
  reclaimable: { total: 0, byClass: { regenerates: 0, orphan: 0, ask: 0, keep: 0, manual: 0 } },
  skipped: [], fullScan: { at: NOW, stale: false }, refreshing: [], onDemand: [],
});
const fsWith = (tree: Record<string, FakeNode>, real: Record<string, string> = {}) => ({ ...fakeFs(tree), realpath: async (p: string) => real[p] ?? p });
const trashLine = (p: string, good = true): string =>
  JSON.stringify({ path: p, ok: good, trashedTo: good ? `${HOME}/.Trash/${p.split('/').pop()}` : null, error: good ? null : 'Operation not permitted' });
const dfOut = (availKb: number): string =>
  `Filesystem     1024-blocks      Used  Available Capacity iused       ifree %iused  Mounted on\n/dev/disk3s1s1  1948404040  12337068 ${availKb}     1%  458732  4293266919    0%   /\n`;
const GB_KB = 1024 ** 2;

// ---------------------------------------------------------------------------
// Isolation: nothing here may touch the real data dir, the real audit log or the real environment.
// ---------------------------------------------------------------------------

let dataDir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['PD_NO_ACTIONS', 'PD_ACTIONS_SANDBOX', 'PD_DATA_DIR']) saved[k] = process.env[k];
  delete process.env['PD_NO_ACTIONS'];
  delete process.env['PD_ACTIONS_SANDBOX'];
  dataDir = mkdtempSync(join(tmpdir(), 'pd-actions-test-'));
  process.env['PD_DATA_DIR'] = dataDir;
  clearPlans();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
  vi.useRealTimers();
});
const auditLines = (): Record<string, unknown>[] => {
  const f = join(dataDir, 'actions.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

const JUNK = `${CACHES}/com.example.junk`;
const OTHER = `${CACHES}/com.example.other`;
const tree: Record<string, FakeNode> = {
  [HOME]: { kind: 'dir', children: ['Library'] },
  [CACHES]: { kind: 'dir', children: ['com.example.junk', 'com.example.other'] },
  [JUNK]: { kind: 'dir', mtimeMs: NOW },
  [OTHER]: { kind: 'dir', mtimeMs: NOW },
};
const cachesReport = (): HealthReport => mkReport([clutter('user-caches', [item(JUNK), item(OTHER, 'ask')])]);
const T = (p: string, findingId = 'user-caches') => ({ findingId, path: p });

// ---------------------------------------------------------------------------

describe('planToken', () => {
  it('is the same for the same action and paths in any order', () => {
    expect(planToken('trash-paths', ['/a', '/b'])).toBe(planToken('trash-paths', ['/b', '/a']));
    expect(planToken('trash-paths', ['/a', '/b'])).toMatch(/^[0-9a-f]{16}$/);
  });
  it('differs with one more path or another action, and does not depend on sizes', () => {
    expect(planToken('trash-paths', ['/a', '/b'])).not.toBe(planToken('trash-paths', ['/a', '/b', '/c']));
    expect(planToken('trash-paths', ['/a'])).not.toBe(planToken('brew-cleanup', ['/a']));
    expect(planToken('thin-snapshots', [])).toBe(planToken('thin-snapshots', []));
  });
});

describe('the plan store', () => {
  const plan = (token: string, createdAt = 1_000): ActionPlan => ({
    token, actionId: 'trash-paths', method: 'trash', createdAt, reportAt: 0, targets: [], refused: [], totalBytes: 0, explain: '', needsAck: false,
  });
  it('hands a plan out once', () => {
    storePlan(plan('aaaa'));
    expect(takePlan('aaaa', 1_001)?.token).toBe('aaaa');
    expect(takePlan('aaaa', 1_002)).toBeUndefined();
    expect(takePlan('never-stored')).toBeUndefined();
  });
  it('forgets a plan after 5 minutes', () => {
    storePlan(plan('bbbb', 1_000));
    expect(takePlan('bbbb', 1_000 + PLAN_TTL_MS + 1)).toBeUndefined();
    storePlan(plan('cccc', 1_000));
    expect(takePlan('cccc', 1_000 + PLAN_TTL_MS)?.token).toBe('cccc');
  });
  it('keeps at most 20 plans: the 21st evicts the oldest', () => {
    for (let i = 0; i <= MAX_PLANS; i++) storePlan(plan(`t${i}`, 1_000 + i));
    expect(takePlan('t0', 2_000)).toBeUndefined();
    expect(takePlan('t1', 2_000)?.token).toBe('t1');
    expect(takePlan(`t${MAX_PLANS}`, 2_000)?.token).toBe(`t${MAX_PLANS}`);
  });
});

describe('resolveTargets (rules 1-3)', () => {
  const base = () => ({ ctx: fakeContext({ home: HOME }), report: cachesReport(), fs: fsWith(tree) });

  it('a path that is not in the report is refused', async () => {
    const r = await resolveTargets([T(`${CACHES}/not-reported`)], base());
    expect(r.ok).toEqual([]);
    expect(r.refused[0]!.reason).toContain('not in the current report');
    const r2 = await resolveTargets([T(JUNK, 'some-other-finding')], base());
    expect(r2.refused[0]!.reason).toContain('not in the current report');
  });

  it('a reported item that is not actionable is refused with the rule that applies', async () => {
    const deps = { ...base(), report: mkReport([clutter('user-caches', [item(JUNK, 'keep')])]) };
    expect((await resolveTargets([T(JUNK)], deps)).refused[0]!.reason).toContain('keep items are never cleaned');
  });

  it('a symlink target is refused, and so is a path whose realpath leaves the folder it was found in', async () => {
    const link: Record<string, FakeNode> = { ...tree, [JUNK]: { kind: 'symlink' } };
    const a = await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(link) });
    expect(a.refused[0]!.reason).toContain('symlink');
    const b = await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(tree, { [JUNK]: `${HOME}/Documents/important` }) });
    expect(b.ok).toEqual([]);
    expect(b.refused[0]!.reason).toContain('outside');
    const c = await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(tree, { [JUNK]: '/Volumes/elsewhere/junk' }) });
    expect(c.refused[0]!.reason).toContain('outside your home folder');
  });

  it('a base folder that is a symlink (the survey would not follow it) refuses everything in it', async () => {
    const linked: Record<string, FakeNode> = { ...tree, [CACHES]: { kind: 'symlink' } };
    const r = await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(linked) });
    expect(r.ok).toEqual([]);
    expect(r.refused[0]!.reason).toContain('symlink');
    const noRoot = { ...tree };
    delete noRoot[CACHES];
    expect((await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(noRoot) })).refused[0]!.reason).toContain('could not be read');
  });

  it('a path that vanished is refused, marked as changed', async () => {
    const gone = { ...tree };
    delete gone[JUNK];
    const r = await resolveTargets([T(JUNK)], { ...base(), fs: fsWith(gone) });
    expect(r.refused[0]).toMatchObject({ reason: 'it no longer exists', changed: true });
  });

  it('a running runningHint process refuses its entry', async () => {
    const OB = `${HOME}/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw`;
    const t: Record<string, FakeNode> = { [OB]: { kind: 'file', blocks: 4096 }, [`${HOME}/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data`]: { kind: 'dir' } };
    const report = mkReport([clutter('orbstack-disk', [item(OB, 'ask', 10 * MB, 'OrbStack is running')])]);
    const run = scriptedRun([['/usr/sbin/lsof', fail()]]);
    const running = await resolveTargets([T(OB, 'orbstack-disk')], { ctx: fakeContext({ home: HOME, run, processes: [proc({ pid: 5, name: 'OrbStack' })] }), report, fs: fsWith(t) });
    expect(running.refused[0]!.reason).toBe('OrbStack is running — quit it first');
    expect(run.calls).toEqual([]); // refused before asking lsof
    const quiet = await resolveTargets([T(OB, 'orbstack-disk')], { ctx: fakeContext({ home: HOME, run, processes: [] }), report, fs: fsWith(t) });
    expect(quiet.ok).toHaveLength(1);
  });

  describe('an open disk image', () => {
    const IMG = `${HOME}/Downloads/win.dmg`;
    const t: Record<string, FakeNode> = { [IMG]: { kind: 'file', blocks: 100_000 }, [`${HOME}/Downloads`]: { kind: 'dir' } };
    const report = mkReport([clutter('downloads-installers', [item(IMG, 'ask', 50 * MB)])]);
    const go = (run: ReturnType<typeof scriptedRun>) => resolveTargets([T(IMG, 'downloads-installers')], { ctx: fakeContext({ home: HOME, run }), report, fs: fsWith(t) });

    it('is refused when lsof prints a data row on stdout', async () => {
      const r = await go(scriptedRun([['/usr/sbin/lsof -- ' + IMG, ok('COMMAND PID USER FD TYPE\nhdiejectd 99 test 3r REG /x\n')]]));
      expect(r.ok).toEqual([]);
      expect(r.refused[0]!.reason).toBe('it is open in hdiejectd — quit it first');
    });
    it('lsof warnings on stderr alone are not a holder', async () => {
      const r = await go(scriptedRun([['/usr/sbin/lsof', fail('', "lsof: WARNING: can't stat() smbfs file system /Volumes/.timemachine")]]));
      expect(r.refused).toEqual([]);
      expect(r.ok).toHaveLength(1);
    });
    it('a header line alone is not a holder', async () => {
      expect((await go(scriptedRun([['/usr/sbin/lsof', ok('COMMAND PID USER\n')]]))).ok).toHaveLength(1);
    });
    it('a lsof that timed out is never read as "not open"', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const run = scriptedRun([['/usr/sbin/lsof', fail()]]);
      const slow = (async (...a: Parameters<typeof run>) => (vi.setSystemTime(Date.now() + 10_000), run(...a))) as typeof run;
      const r = await go(Object.assign(slow, { calls: run.calls }));
      expect(r.ok).toEqual([]);
      expect(r.refused[0]!.reason).toContain('timed out');
    });
    it('a missing lsof binary refuses too', async () => {
      const r = await resolveTargets([T(IMG, 'downloads-installers')], { ctx: fakeContext({ home: HOME, exists: (p) => p !== '/usr/sbin/lsof' }), report, fs: fsWith(t) });
      expect(r.ok).toEqual([]);
      expect(r.refused[0]!.reason).toContain('lsof is not available');
    });
    it('lsof is only asked about disk images, not about folders or other files', async () => {
      const run = scriptedRun([['/usr/sbin/lsof', ok('COMMAND\nx 1 test\n')]]);
      const r = await resolveTargets([T(JUNK)], { ctx: fakeContext({ home: HOME, run }), report: cachesReport(), fs: fsWith(tree) });
      expect(r.ok).toHaveLength(1);
      expect(run.calls).toEqual([]);
    });
  });

  it('a target inside another selected target is refused (the parent takes it along)', async () => {
    const parent = `${HOME}/Library/Logs/ElgatoStreamDeck`;
    const log = `${parent}/big.log`;
    const t: Record<string, FakeNode> = { [`${HOME}/Library/Logs`]: { kind: 'dir' }, [parent]: { kind: 'dir' }, [log]: { kind: 'file', blocks: 100 } };
    const logsFinding: HealthFinding = { ...clutter('runaway-logs:elgato', [item(log)]), checkId: 'runaway-logs' };
    const report = mkReport([clutter('user-logs', [item(parent)]), logsFinding]);
    const r = await resolveTargets([T(parent, 'user-logs'), T(log, 'runaway-logs:elgato')], { ctx: fakeContext({ home: HOME }), report, fs: fsWith(t) });
    expect(r.ok.map((x) => x.path)).toEqual([parent]);
    expect(r.refused[0]).toMatchObject({ path: log });
    expect(r.refused[0]!.reason).toContain('also selected');
  });

  it('measure re-measures folders with du -sk -P -x and files by lstat blocks', async () => {
    const f = `${HOME}/Downloads/a.zip`;
    const t: Record<string, FakeNode> = { ...tree, [`${HOME}/Downloads`]: { kind: 'dir' }, [f]: { kind: 'file', blocks: 8192 } };
    const report = mkReport([clutter('user-caches', [item(JUNK)]), clutter('downloads-installers', [item(f, 'ask', 1)])]);
    const run = scriptedRun([[`du -sk -P -x -- ${JUNK}`, ok(`4096\t${JUNK}\n`)]]);
    const r = await resolveTargets([T(JUNK), T(f, 'downloads-installers')], { ctx: fakeContext({ home: HOME, run }), report, fs: fsWith(t) }, { measure: true });
    expect(r.ok.find((x) => x.path === JUNK)!.bytes).toBe(4096 * 1024);
    expect(r.ok.find((x) => x.path === f)!.bytes).toBe(8192 * 512);
  });

  it('keeps the reported size and says so when du gives nothing', async () => {
    const run = scriptedRun([['du -sk', fail('', 'du: Operation not permitted')]]);
    const r = await resolveTargets([T(JUNK)], { ctx: fakeContext({ home: HOME, run }), report: cachesReport(), fs: fsWith(tree) }, { measure: true });
    expect(r.ok[0]).toMatchObject({ bytes: 5 * MB });
    expect(r.ok[0]!.note).toContain('size not re-measured');
  });
});

describe('planAction', () => {
  const run = () => scriptedRun([[`du -sk -P -x -- ${JUNK}`, ok(`2048\t${JUNK}\n`)]]);

  it('builds a trash plan from reported items, stores it and keys it by action + paths', async () => {
    const plan = await planAction('trash-paths', [T(JUNK)], { ctx: fakeContext({ home: HOME, run: run() }), report: cachesReport(), fs: fsWith(tree), now: 5_000 });
    expect(plan).toMatchObject({ actionId: 'trash-paths', method: 'trash', createdAt: 5_000, reportAt: NOW, totalBytes: 2048 * 1024, needsAck: false, refused: [] });
    expect(plan.token).toBe(planToken('trash-paths', [JUNK]));
    expect(plan.targets).toEqual([{ findingId: 'user-caches', path: JUNK, bytes: 2048 * 1024, safety: 'regenerates' }]);
    expect(takePlan(plan.token, 5_001)).toEqual(plan);
  });

  it('an ask target makes the plan need an acknowledgement', async () => {
    const run2 = scriptedRun([['du -sk', ok(`2048\t${OTHER}\n`)]]);
    const plan = await planAction('trash-paths', [T(OTHER)], { ctx: fakeContext({ home: HOME, run: run2 }), report: cachesReport(), fs: fsWith(tree) });
    expect(plan.needsAck).toBe(true);
  });

  it('a plan with nothing left is returned, with the reasons, but not stored', async () => {
    const plan = await planAction('trash-paths', [T(`${CACHES}/ghost`)], { ctx: fakeContext({ home: HOME }), report: cachesReport(), fs: fsWith(tree) });
    expect(plan.targets).toEqual([]);
    expect(plan.refused).toHaveLength(1);
    expect(takePlan(plan.token)).toBeUndefined();
  });

  it('rejects an unknown action, an empty selection and a command action with targets', async () => {
    const deps = { ctx: fakeContext({ home: HOME }), report: cachesReport(), fs: fsWith(tree) };
    await expect(planAction('rm-everything', [], deps)).rejects.toMatchObject({ status: 400 });
    await expect(planAction('trash-paths', [], deps)).rejects.toMatchObject({ status: 400 });
    await expect(planAction('thin-snapshots', [T(JUNK)], deps)).rejects.toMatchObject({ status: 400 });
  });

  it('PD_NO_ACTIONS=1 refuses to plan (403)', async () => {
    process.env['PD_NO_ACTIONS'] = '1';
    await expect(planAction('trash-paths', [T(JUNK)], { ctx: fakeContext({ home: HOME }), report: cachesReport(), fs: fsWith(tree) })).rejects.toMatchObject({
      status: 403, message: 'actions disabled (PD_NO_ACTIONS=1)',
    });
  });

  describe('in a sandbox', () => {
    let sb: string;
    beforeEach(() => {
      sb = mkdtempSync(join(tmpdir(), 'pd-sbx-'));
      process.env['PD_ACTIONS_SANDBOX'] = sb;
    });
    afterEach(() => rmSync(sb, { recursive: true, force: true }));

    it('a real item is refused as "outside the sandbox" without any command touching it', async () => {
      const r = scriptedRun([]);
      const plan = await planAction('trash-paths', [T(JUNK)], { ctx: fakeContext({ home: HOME, run: r }), report: cachesReport(), fs: fsWith(tree) });
      expect(plan.targets).toEqual([]);
      expect(plan.refused[0]).toMatchObject({ path: JUNK, reason: 'outside the sandbox' });
      expect(r.calls).toEqual([]);
      expect(takePlan(plan.token)).toBeUndefined();
    });

    it('an item directly in the sandbox is planned; one that resolves outside it is refused', async () => {
      const a = `${sb}/pd-sandbox-junk-a`;
      const b = `${sb}/pd-sandbox-junk-b`;
      const t: Record<string, FakeNode> = { [sb]: { kind: 'dir' }, [a]: { kind: 'dir' }, [b]: { kind: 'dir' } };
      const report = mkReport([clutter('sandbox', [item(a), item(b)])]);
      const r = scriptedRun([[`du -sk -P -x -- ${a}`, ok(`2048\t${a}\n`)]]);
      const plan = await planAction('trash-paths', [T(a, 'sandbox'), T(b, 'sandbox')], {
        ctx: fakeContext({ home: HOME, run: r }), report, fs: fsWith(t, { [b]: '/Users/test/Documents' }),
      });
      expect(plan.targets.map((x) => x.path)).toEqual([a]);
      expect(plan.refused).toEqual([{ findingId: 'sandbox', path: b, reason: 'outside the sandbox' }]);
    });

    it('a command action can still be planned', async () => {
      const report = mkReport([{ id: 'apfs-snapshots', checkId: 'apfs-snapshots', category: 'backup', severity: 'advice', title: 't', detail: '', evidence: [], actionId: 'thin-snapshots' }]);
      const plan = await planAction('thin-snapshots', [], { ctx: fakeContext({ home: HOME }), report });
      expect(plan.command).toBe('/usr/bin/tmutil thinlocalsnapshots / 999999999999 4');
    });
  });
});

// ---------------------------------------------------------------------------

describe('executePlan: trash', () => {
  const df = (before: number, after: number) => {
    let n = 0;
    return () => ok(dfOut(n++ === 0 ? before : after));
  };
  /** A ctx whose run answers du, df and the Trash helper from a script. */
  const ctxFor = (paths: string[], goods: boolean[] = paths.map(() => true), dfFn = df(100 * GB_KB, 100 * GB_KB)) => {
    const run = scriptedRun([
      ['/bin/df', () => dfFn()],
      ['/usr/bin/osascript', () => ok(paths.map((p, i) => trashLine(p, goods[i])).join('\n'))],
    ]);
    return { ctx: fakeContext({ home: HOME, run }), run };
  };
  const planFor = (paths: string[], safety: SafetyClass = 'regenerates'): ActionPlan => ({
    token: planToken('trash-paths', paths), actionId: 'trash-paths', method: 'trash', createdAt: NOW, reportAt: NOW, refused: [],
    targets: paths.map((p) => ({ findingId: 'user-caches', path: p, bytes: 5 * MB, safety })), totalBytes: 5 * MB * paths.length, explain: '', needsAck: safety === 'ask',
  });
  const report = (): HealthReport => mkReport([clutter('user-caches', [item(JUNK), item(OTHER)])], { localSnapshots: 0 });

  it('all trashed → ok; trashedTo is recorded, exactly one audit line, and the note tells the truth about the space', async () => {
    const { ctx, run } = ctxFor([JUNK, OTHER]);
    const res = await executePlan(planFor([JUNK, OTHER]), { ctx, report: report(), fs: fsWith(tree), now: 9_000 });
    expect(res).toMatchObject({ result: 'ok', method: 'trash', actionId: 'trash-paths', at: 9_000, bytesPlanned: 10 * MB, bytesFreed: 0 });
    expect(res.targets).toEqual([
      { path: JUNK, ok: true, trashedTo: `${HOME}/.Trash/com.example.junk` },
      { path: OTHER, ok: true, trashedTo: `${HOME}/.Trash/com.example.other` },
    ]);
    expect(res.note).toContain('2 items (10 MB) are now in the Trash');
    expect(res.note).toContain('freed when you empty the Trash in Finder');
    expect(res.note).toContain('local Time Machine snapshots can hold it after that (Thin snapshots)');
    expect(run.calls.filter((c) => c.includes('osascript'))).toHaveLength(1);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actionId: 'trash-paths', method: 'trash', result: 'ok', paths: [JUNK, OTHER], bytesPlanned: 10 * MB, trashedTo: [`${HOME}/.Trash/com.example.junk`, `${HOME}/.Trash/com.example.other`] });
  });

  it('reports what df moved, not what was planned', async () => {
    const { ctx } = ctxFor([JUNK], [true], df(100 * GB_KB, 101 * GB_KB));
    const res = await executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(tree) });
    expect(res.bytesFreed).toBe(GB_KB * 1024);
    expect(res.bytesPlanned).toBe(5 * MB);
  });

  it('one failed → partial; all failed → failed; neither throws', async () => {
    const some = ctxFor([JUNK, OTHER], [true, false]);
    const partial = await executePlan(planFor([JUNK, OTHER]), { ctx: some.ctx, report: report(), fs: fsWith(tree) });
    expect(partial.result).toBe('partial');
    expect(partial.targets[1]).toEqual({ path: OTHER, ok: false, error: 'Operation not permitted' });
    expect(partial.note).toContain('1 of 2 could not be moved');

    const none = ctxFor([JUNK, OTHER], [false, false]);
    const failed = await executePlan(planFor([JUNK, OTHER]), { ctx: none.ctx, report: report(), fs: fsWith(tree) });
    expect(failed.result).toBe('failed');
    expect(failed.note).toContain('0 items');
    expect(failed.note).toContain('now in the Trash'); // the Trash note is always there
    expect(auditLines().map((l) => l['result'])).toEqual(['partial', 'failed']);
  });

  it('never throws when the Trash helper itself blows up', async () => {
    const run = scriptedRun([['/bin/df', ok(dfOut(1))], ['/usr/bin/osascript', () => { throw new Error('spawn EAGAIN'); }]]);
    const res = await executePlan(planFor([JUNK]), { ctx: fakeContext({ home: HOME, run }), report: report(), fs: fsWith(tree) });
    expect(res.result).toBe('failed');
    expect(res.targets[0]!.error).toContain('spawn EAGAIN');
  });

  it('needsAck without ack throws ActionError 400 and nothing is run; with ack it goes ahead', async () => {
    const { ctx, run } = ctxFor([OTHER]);
    const plan = planFor([OTHER], 'ask');
    await expect(executePlan(plan, { ctx, report: report(), fs: fsWith(tree) })).rejects.toMatchObject({ status: 400 });
    expect(run.calls).toEqual([]);
    expect((await executePlan(plan, { ctx, report: report(), fs: fsWith(tree), ack: true })).result).toBe('ok');
  });

  it('PD_NO_ACTIONS=1 throws ActionError 403 and nothing is run', async () => {
    process.env['PD_NO_ACTIONS'] = '1';
    const { ctx, run } = ctxFor([JUNK]);
    const err = await executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(tree) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err).toMatchObject({ status: 403 });
    expect(run.calls).toEqual([]);
    expect(auditLines()).toEqual([]);
  });

  it('re-checks every target before acting: one that vanished is skipped as "changed since the dry run", the rest go ahead', async () => {
    const gone = { ...tree };
    delete gone[OTHER];
    const { ctx, run } = ctxFor([JUNK]);
    const res = await executePlan(planFor([JUNK, OTHER]), { ctx, report: report(), fs: fsWith(gone) });
    expect(res.result).toBe('partial');
    expect(res.targets[1]).toMatchObject({ path: OTHER, ok: false });
    expect(res.targets[1]!.error).toContain('changed since the dry run');
    const trashed = run.calls.find((c) => c.includes('osascript'))!;
    expect(trashed).toContain(JUNK);
    expect(trashed).not.toContain(OTHER);
  });

  it('a target that became a symlink, or whose realpath left its root, is skipped and nothing is trashed', async () => {
    const link: Record<string, FakeNode> = { ...tree, [JUNK]: { kind: 'symlink' } };
    const { ctx, run } = ctxFor([JUNK]);
    const res = await executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(link) });
    expect(res.result).toBe('failed');
    expect(res.targets[0]!.error).toContain('symlink');
    const res2 = await executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(tree, { [JUNK]: '/Users/other/stuff' }) });
    expect(res2.result).toBe('failed');
    expect(run.calls.some((c) => c.includes('osascript'))).toBe(false);
  });

  it('a target that is no longer in the current report is skipped', async () => {
    const { ctx, run } = ctxFor([JUNK]);
    const res = await executePlan(planFor([JUNK]), { ctx, report: mkReport([]), fs: fsWith(tree) });
    expect(res.result).toBe('failed');
    expect(res.targets[0]!.error).toContain('not in the current report');
    expect(run.calls.some((c) => c.includes('osascript'))).toBe(false);
  });

  it('a second execution while one is running is refused (409), so two plans cannot trample each other', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = scriptedRun([['/bin/df', ok(dfOut(1))], ['/usr/bin/osascript', async () => { await gate; return ok(trashLine(JUNK)); }]]);
    // scriptedRun handlers are sync; wrap to allow an async answer
    const slow = (async (...a: Parameters<typeof run>) => {
      if (a[0] === '/usr/bin/osascript') await gate;
      return run(...a);
    }) as typeof run;
    const ctx = fakeContext({ home: HOME, run: Object.assign(slow, { calls: run.calls }) });
    const first = executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(tree) });
    await new Promise((r) => setTimeout(r, 5));
    await expect(executePlan(planFor([OTHER]), { ctx, report: report(), fs: fsWith(tree) })).rejects.toMatchObject({ status: 409 });
    release();
    expect((await first).result).toBe('ok');
    // and the lock is released afterwards
    expect((await executePlan(planFor([OTHER]), { ctx: ctxFor([OTHER]).ctx, report: report(), fs: fsWith(tree) })).result).toBe('ok');
  });

  describe('in a sandbox', () => {
    let sb: string;
    beforeEach(() => {
      sb = mkdtempSync(join(tmpdir(), 'pd-sbx-'));
      process.env['PD_ACTIONS_SANDBOX'] = sb;
    });
    afterEach(() => rmSync(sb, { recursive: true, force: true }));

    it('a target outside it is refused at execution too, and the Trash helper is never called', async () => {
      const { ctx, run } = ctxFor([JUNK]);
      const res = await executePlan(planFor([JUNK]), { ctx, report: report(), fs: fsWith(tree) });
      expect(res.result).toBe('failed');
      expect(res.targets[0]!.error).toBe('outside the sandbox');
      expect(run.calls).toEqual([]);
    });

    it('a target inside it is trashed', async () => {
      const a = `${sb}/pd-sandbox-junk-a`;
      const { ctx } = ctxFor([a]);
      const rep = mkReport([clutter('sandbox', [item(a)])]);
      const plan = { ...planFor([a]), targets: [{ findingId: 'sandbox', path: a, bytes: 2 * MB, safety: 'regenerates' as const }] };
      const res = await executePlan(plan, { ctx, report: rep, fs: fsWith({ [sb]: { kind: 'dir' }, [a]: { kind: 'dir' } }) });
      expect(res.result).toBe('ok');
    });

    it('a command action is refused with ActionError 403 and nothing is run', async () => {
      const run = scriptedRun([]);
      const rep = mkReport([{ id: 'apfs-snapshots', checkId: 'apfs-snapshots', category: 'backup', severity: 'advice', title: 't', detail: '', evidence: [], actionId: 'thin-snapshots' }]);
      const plan = await planAction('thin-snapshots', [], { ctx: fakeContext({ home: HOME, run }), report: rep });
      const err = await executePlan(plan, { ctx: fakeContext({ home: HOME, run }), report: rep, ack: true }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 403 });
      expect(run.calls).toEqual([]);
      // thin-snapshots needs an acknowledgement, but the sandbox refusal wins either way
      const noAck = await executePlan(plan, { ctx: fakeContext({ home: HOME, run }), report: rep }).catch((e: unknown) => e);
      expect(noAck).toMatchObject({ status: 403 });
      expect(run.calls).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------

describe('command actions', () => {
  const ctxWith = (exists: (p: string) => boolean = () => true) => fakeContext({ home: HOME, exists });

  it('there are exactly four actions: the generic Trash action and three fixed commands', () => {
    expect(ACTIONS.map((a) => a.id)).toEqual(['trash-paths', 'brew-cleanup', 'thin-snapshots', 'simctl-delete-unavailable']);
    expect(ACTIONS.filter((a) => a.method === 'command').map((a) => a.findingId)).toEqual(['brew', 'apfs-snapshots', 'coresimulator']);
    expect(ACTIONS.find((a) => a.id === 'thin-snapshots')!.needsAck).toBe(true);
    expect(ACTIONS.filter((a) => a.needsAck).length).toBe(1);
  });

  it("every command's argv joined matches its pattern, and no single-character mutation does", () => {
    for (const a of ACTIONS.filter((x) => x.method === 'command')) {
      const joined = a.argv!(ctxWith())!.join(' ');
      expect(a.pattern!.test(joined), a.id).toBe(true);
      for (let i = 0; i < joined.length; i++) {
        const mutated = `${joined.slice(0, i)}${joined[i] === 'X' ? 'Y' : 'X'}${joined.slice(i + 1)}`;
        expect(a.pattern!.test(mutated), `${a.id} @${i}`).toBe(false);
      }
      expect(a.pattern!.test(`${joined} --extra`)).toBe(false);
      expect(a.pattern!.test(`${joined}; rm -r ~`)).toBe(false);
    }
  });

  it('no argv element comes from the plan or the request: argv takes only the context', () => {
    for (const a of ACTIONS.filter((x) => x.method === 'command')) {
      expect(a.argv!.length).toBeLessThanOrEqual(1);
      const argv = a.argv!(ctxWith());
      expect(argv!.every((p) => typeof p === 'string')).toBe(true);
    }
  });

  it('brew-cleanup uses the probed absolute brew path and the two environment variables; no brew → unavailable', () => {
    const brew = findAction('brew-cleanup')!;
    expect(brew.argv!(ctxWith((p) => p === '/opt/homebrew/bin/brew'))).toEqual(['/usr/bin/env', 'HOMEBREW_NO_AUTO_UPDATE=1', 'HOMEBREW_NO_ANALYTICS=1', '/opt/homebrew/bin/brew', 'cleanup']);
    expect(brew.argv!(ctxWith((p) => p === '/usr/local/bin/brew'))![3]).toBe('/usr/local/bin/brew');
    expect(brew.argv!(ctxWith(() => false))).toBeNull();
  });

  const brewFinding = (): HealthFinding => ({ id: 'brew', checkId: 'brew', category: 'tooling', severity: 'advice', title: 'Homebrew', detail: '', evidence: [], actionId: 'brew-cleanup', reclaimableBytes: 100 * MB });
  const snapFinding = (): HealthFinding => ({ id: 'apfs-snapshots', checkId: 'apfs-snapshots', category: 'backup', severity: 'advice', title: 'snaps', detail: '', evidence: [], actionId: 'thin-snapshots' });

  it('a command action is offered only when its finding (with that actionId) is in the report', async () => {
    const ctx = ctxWith();
    await expect(planAction('brew-cleanup', [], { ctx, report: mkReport([]) })).rejects.toMatchObject({ status: 409 });
    // an up-to-date brew finding carries no actionId, so nothing is offered
    const idle = { ...brewFinding(), actionId: undefined };
    await expect(planAction('brew-cleanup', [], { ctx, report: mkReport([idle]) })).rejects.toMatchObject({ status: 409 });
    expect(offeredCommands(mkReport([brewFinding(), snapFinding()]), ctx).map((a) => a.id)).toEqual(['brew-cleanup', 'thin-snapshots']);
    expect(offeredCommands(mkReport([brewFinding()]), ctxWith(() => false))).toEqual([]);
    await expect(planAction('brew-cleanup', [], { ctx: ctxWith(() => false), report: mkReport([brewFinding()]) })).rejects.toMatchObject({ status: 409 });
  });

  it('the plan shows the exact command, the size the finding reports and whether it needs an acknowledgement', async () => {
    const ctx = ctxWith();
    const b = await planAction('brew-cleanup', [], { ctx, report: mkReport([brewFinding()]) });
    expect(b).toMatchObject({ method: 'command', targets: [], refused: [], totalBytes: 100 * MB, needsAck: false });
    expect(b.command).toBe('/usr/bin/env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 /opt/homebrew/bin/brew cleanup');
    const t = await planAction('thin-snapshots', [], { ctx, report: mkReport([snapFinding()]) });
    expect(t).toMatchObject({ needsAck: true, totalBytes: 0, command: '/usr/bin/tmutil thinlocalsnapshots / 999999999999 4' });
  });

  const dfSeq = (...avail: number[]) => {
    let i = 0;
    return () => ok(dfOut(avail[Math.min(i++, avail.length - 1)]!));
  };

  it('executes the fixed argv through ctx.run, keeps the last 12 output lines and audits it', async () => {
    const report = mkReport([brewFinding()], { localSnapshots: 0 });
    const out = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const run = scriptedRun([['/bin/df', dfSeq(100 * GB_KB, 101 * GB_KB)], ['/usr/bin/env', ok(out)]]);
    const ctx = fakeContext({ home: HOME, run });
    const plan = await planAction('brew-cleanup', [], { ctx, report });
    const res = await executePlan(plan, { ctx, report });
    expect(res).toMatchObject({ result: 'ok', method: 'command', targets: [], bytesPlanned: 100 * MB, bytesFreed: GB_KB * 1024 });
    expect(res.output!.split('\n')).toHaveLength(12);
    expect(res.output!.endsWith('line 20')).toBe(true);
    expect(run.calls.filter((c) => c.startsWith('/usr/bin/env'))).toEqual(['/usr/bin/env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 /opt/homebrew/bin/brew cleanup']);
    expect(auditLines()[0]).toMatchObject({ actionId: 'brew-cleanup', method: 'command', result: 'ok', paths: [] });
  });

  it('a failing command is "failed", not a throw', async () => {
    const report = mkReport([brewFinding()]);
    const run = scriptedRun([['/bin/df', ok(dfOut(5))], ['/usr/bin/env', fail('', 'Error: boom')]]);
    const ctx = fakeContext({ home: HOME, run });
    const res = await executePlan(await planAction('brew-cleanup', [], { ctx, report }), { ctx, report });
    expect(res.result).toBe('failed');
    expect(res.note).toContain('failed');
    expect(res.output).toContain('boom');
  });

  it('adds the snapshot note when df moved less than half of the plan and local snapshots exist', async () => {
    const mk = async (snapshots: number, availAfter: number) => {
      const report = mkReport([brewFinding()], { localSnapshots: snapshots });
      const run = scriptedRun([['/bin/df', dfSeq(100 * GB_KB, availAfter)], ['/usr/bin/env', ok('done')]]);
      const ctx = fakeContext({ home: HOME, run });
      return executePlan(await planAction('brew-cleanup', [], { ctx, report }), { ctx, report });
    };
    expect((await mk(2, 100 * GB_KB)).note).toContain('held by local Time Machine snapshots — run Thin snapshots');
    expect((await mk(0, 100 * GB_KB)).note).not.toContain('Thin snapshots');
    expect((await mk(2, 100 * GB_KB + 100 * MB / 1024)).note).not.toContain('Thin snapshots'); // df moved the planned amount
  });

  it('thin-snapshots needs the acknowledgement and never recommends itself', async () => {
    const report = mkReport([snapFinding()], { localSnapshots: 3 });
    const run = scriptedRun([['/bin/df', ok(dfOut(5))], ['/usr/bin/tmutil', ok('Thinned local snapshots')]]);
    const ctx = fakeContext({ home: HOME, run });
    const plan = await planAction('thin-snapshots', [], { ctx, report });
    await expect(executePlan(plan, { ctx, report })).rejects.toMatchObject({ status: 400 });
    expect(run.calls.some((c) => c.includes('tmutil'))).toBe(false);
    const res = await executePlan(plan, { ctx, report, ack: true });
    expect(res.result).toBe('ok');
    expect(res.note).not.toContain('run Thin snapshots');
    expect(run.calls.filter((c) => c.includes('tmutil'))).toEqual(['/usr/bin/tmutil thinlocalsnapshots / 999999999999 4']);
  });

  it('refuses to run a command whose plan no longer matches (changed command, finding gone)', async () => {
    const report = mkReport([brewFinding()]);
    const run = scriptedRun([['/bin/df', ok(dfOut(5))]]);
    const ctx = fakeContext({ home: HOME, run });
    const plan = await planAction('brew-cleanup', [], { ctx, report });
    const tampered = await executePlan({ ...plan, command: '/bin/sh -c "rm -r ~"' }, { ctx, report });
    expect(tampered.result).toBe('failed');
    const stale = await executePlan(plan, { ctx, report: mkReport([]) });
    expect(stale.result).toBe('failed');
    expect(run.calls.filter((c) => !c.includes('/bin/df'))).toEqual([]);
  });
});

describe('actionsEnabled', () => {
  it('is on by default and off for the kill-switch, a bad sandbox, or a non-loopback bind', () => {
    expect(actionsEnabled('127.0.0.1').enabled).toBe(true);
    expect(actionsEnabled('0.0.0.0')).toMatchObject({ enabled: false });
    expect(actionsEnabled('0.0.0.0').reason).toContain('loopback');
    expect(actionsEnabled('').enabled).toBe(false);
    expect(actionsEnabled().enabled).toBe(true);
    process.env['PD_NO_ACTIONS'] = '1';
    expect(actionsEnabled('127.0.0.1')).toEqual({ enabled: false, reason: 'PD_NO_ACTIONS=1', sandbox: null });
    delete process.env['PD_NO_ACTIONS'];
    process.env['PD_ACTIONS_SANDBOX'] = '/no/such/dir/anywhere';
    expect(actionsEnabled('127.0.0.1').enabled).toBe(false);
  });
});

describe('selectTargets', () => {
  const report = mkReport([clutter('user-caches', [item(JUNK), item(OTHER, 'ask'), item(`${CACHES}/kept`, 'keep')])]);
  it('--finding selects actionable regenerates/orphan items, ask only with includeAsk, never keep', () => {
    expect(selectTargets(report, { findingIds: ['user-caches'] }, HOME, null).targets.map((t) => t.path)).toEqual([JUNK]);
    expect(selectTargets(report, { findingIds: ['user-caches'], includeAsk: true }, HOME, null).targets.map((t) => t.path)).toEqual([JUNK, OTHER]);
  });
  it('--path selects an exact actionable item and reports anything else', () => {
    const r = selectTargets(report, { paths: [JUNK, `${CACHES}/kept`, '/etc/hosts'] }, HOME, null);
    expect(r.targets).toEqual([{ findingId: 'user-caches', path: JUNK }]);
    expect(r.problems).toHaveLength(2);
  });
  it('an unknown finding is a problem and selects nothing; duplicates collapse', () => {
    const r = selectTargets(report, { findingIds: ['nope', 'user-caches'], paths: [JUNK] }, HOME, null);
    expect(r.problems).toEqual(['no finding "nope" in the current report']);
    expect(r.targets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('pruneTargets / pruneFindings', () => {
  const derived = (): HealthFinding => ({
    ...clutter('xcode-deriveddata', [item(`${HOME}/Library/Developer/Xcode/DerivedData/A`, 'regenerates', 600 * MB), item(`${HOME}/Library/Developer/Xcode/DerivedData/B`, 'regenerates', 700 * MB)]),
    title: 'Xcode DerivedData: 1.3 GB in 2 items', severity: 'advice',
  });

  it('a trashed item disappears from the cached finding; its reclaimable bytes, title and severity follow', () => {
    const [f] = pruneFindings([derived()], [`${HOME}/Library/Developer/Xcode/DerivedData/A`]);
    expect(f!.items!.map((i) => i.path.split('/').pop())).toEqual(['B']);
    expect(f!.reclaimableBytes).toBe(700 * MB);
    expect(f!.title).toBe('Xcode DerivedData: 700 MB');
    expect(f!.severity).toBe('info'); // below 1 GiB now
  });

  it('a finding left without items is dropped; anything inside a trashed folder goes with it', () => {
    expect(pruneFindings([derived()], [`${HOME}/Library/Developer/Xcode/DerivedData/A`, `${HOME}/Library/Developer/Xcode/DerivedData/B`])).toEqual([]);
    expect(pruneFindings([derived()], [`${HOME}/Library/Developer/Xcode/DerivedData`])).toEqual([]);
    const untouched = derived();
    expect(pruneFindings([untouched], ['/somewhere/else'])[0]).toBe(untouched);
  });

  it('findings without items pass through', () => {
    const f: HealthFinding = { id: 'x', checkId: 'x', category: 'tooling', severity: 'info', title: 'x', detail: '', evidence: [] };
    expect(pruneFindings([f], ['/a'])).toEqual([f]);
  });

  it('pruneTargets edits the cached disk-clutter entry in place of the store, keeping its timestamp', () => {
    const cache = memoryCache();
    cache.set('disk-clutter', { at: 123, durationMs: 4, findings: [derived()] });
    pruneTargets([`${HOME}/Library/Developer/Xcode/DerivedData/A`], cache);
    const e = cache.get('disk-clutter')!;
    expect(e.at).toBe(123);
    expect(e.findings[0]!.items).toHaveLength(1);
    pruneTargets([`${HOME}/Library/Developer/Xcode/DerivedData/B`], cache);
    expect(cache.get('disk-clutter')!.findings).toEqual([]);
    expect(() => pruneTargets(['/x'], memoryCache())).not.toThrow();
  });
});

describe('after an execution: the cache and the current report', () => {
  it('a trashed item is gone from the next report, so a second plan for it is refused', async () => {
    const cache = memoryCache();
    const f = clutter('user-caches', [item(JUNK), item(OTHER)]);
    cache.set('disk-clutter', { at: NOW, durationMs: 1, findings: [f] });
    const check: HealthCheck = { id: 'disk-clutter', category: 'clutter', scope: 'full', timeoutMs: 1000, run: async () => ({ findings: [] }) };
    const ctx = fakeContext({ home: HOME, now: Date.now() });
    const before = await collectHealth({ mode: 'quick', checks: [check], ctx, cache });
    expect(before.findings[0]!.items!.map((i) => i.path)).toEqual([JUNK, OTHER]);
    expect(before.findings[0]!.items!.every((i) => i.actionable === true || i.path === OTHER)).toBe(true);
    expect(before.findings[0]!.items![0]!.actionable).toBe(true);

    const result = { token: 't', actionId: 'trash-paths', method: 'trash' as const, at: 1, result: 'ok' as const, targets: [{ path: JUNK, ok: true, trashedTo: '/x' }, { path: OTHER, ok: false, error: 'no' }], bytesPlanned: 1, bytesFreed: 0, note: '' };
    const fresh = await refreshAfterAction(result, { cache, checks: [check], ctx });
    expect(fresh.findings[0]!.items!.map((i) => i.path)).toEqual([OTHER]);
    expect(getLastReport()).toBe(fresh);

    const plan = await planAction('trash-paths', [T(JUNK)], { ctx, report: fresh, fs: fsWith(tree) });
    expect(plan.targets).toEqual([]);
    expect(plan.refused[0]!.reason).toContain('not in the current report');
  });

  it('a brew cleanup drops the cached brew entry', async () => {
    const cache = memoryCache();
    cache.set('brew', { at: NOW, durationMs: 1, findings: [] });
    const result = { token: 't', actionId: 'brew-cleanup', method: 'command' as const, at: 1, result: 'ok' as const, targets: [], bytesPlanned: 0, bytesFreed: 0, note: '' };
    await refreshAfterAction(result, { cache, checks: [], ctx: fakeContext({ now: Date.now() }) });
    expect(cache.get('brew')).toBeUndefined();
  });

  it('the stamp never reaches the cache, and a kill-switch removes it from the next report', async () => {
    const cache = memoryCache();
    const check: HealthCheck = {
      id: 'disk-clutter', category: 'clutter', scope: 'full', timeoutMs: 1000,
      run: async () => ({ findings: [clutter('user-caches', [item(JUNK)])] }),
    };
    const ctx = fakeContext({ home: HOME, now: Date.now() });
    const full = await collectHealth({ mode: 'full', checks: [check], ctx, cache });
    expect(full.findings[0]!.items![0]!.actionable).toBe(true);
    expect(cache.get('disk-clutter')!.findings[0]!.items![0]!.actionable).toBeUndefined();
    process.env['PD_NO_ACTIONS'] = '1';
    const off = await collectHealth({ mode: 'quick', checks: [check], ctx, cache });
    expect(off.findings[0]!.items![0]!.actionable).toBeUndefined();
  });
});
