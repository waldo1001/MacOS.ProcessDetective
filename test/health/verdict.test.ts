import { describe, expect, it } from 'vitest';
import { computeReclaimable, computeVerdict, flattenItems, sortFindings } from '../../src/health/verdict.js';
import type { ClutterItem, HealthCategory, HealthFinding, HealthSeverity, HealthVitals, SafetyClass } from '../../src/types.js';

const GIB = 1024 ** 3;

const vitals = (p: Partial<HealthVitals> = {}): HealthVitals => ({
  memFreePct: 91, swapUsedBytes: 0, pressure: 'normal', loadAvg1: 1, uptimeSec: 100, processCount: 500,
  thermalWarning: false, batteryCycles: 79, batteryHealthPct: 95, diskFreeBytes: 1.4 * 1024 ** 4,
  diskTotalBytes: 1.8 * 1024 ** 4, localSnapshots: 0, crashes7d: 0, ...p,
});

function finding(id: string, category: HealthCategory, severity: HealthSeverity, extra: Partial<HealthFinding> = {}): HealthFinding {
  return { id, checkId: id.split(':')[0]!, category, severity, title: `${id} title`, detail: '', evidence: [], ...extra };
}
const item = (path: string, bytes: number, safety: SafetyClass): ClutterItem => ({ path, bytes, lastModified: null, safety });
const clutter = (id: string, items: ClutterItem[]): HealthFinding =>
  finding(id, 'clutter', 'advice', { items, reclaimableBytes: items.reduce((s, i) => s + i.bytes, 0) });

const verdictOf = (fs: HealthFinding[], v = vitals()) => computeVerdict(fs, computeReclaimable(fs), v);

describe('computeReclaimable', () => {
  it('counts leaves only: a parent folder and the log files inside it are counted once, with the leaf class', () => {
    const fs = [
      clutter('user-logs', [item('/h/Library/Logs/ElgatoStreamDeck', 7_200, 'ask')]),
      finding('runaway-logs:elgatostreamdeck', 'stability', 'warn', {
        items: [item('/h/Library/Logs/ElgatoStreamDeck/a.log', 4_000, 'regenerates'), item('/h/Library/Logs/ElgatoStreamDeck/b.log', 3_000, 'regenerates')],
      }),
    ];
    const r = computeReclaimable(fs);
    expect(r.byClass.regenerates).toBe(7_000);
    expect(r.byClass.ask).toBe(0);
    expect(r.total).toBe(7_000);
    const rows = flattenItems(fs);
    expect(rows.find((x) => x.item.path.endsWith('ElgatoStreamDeck'))!.leaf).toBe(false);
    expect(rows.filter((x) => x.leaf)).toHaveLength(2);
  });

  it('a sibling with a common name prefix is not "inside"', () => {
    const r = computeReclaimable([clutter('c', [item('/a/b', 10, 'regenerates'), item('/a/b2', 20, 'regenerates')])]);
    expect(r.total).toBe(30);
  });

  it('total excludes keep and manual; byClass has all five keys', () => {
    const r = computeReclaimable([
      clutter('c', [item('/1', 1, 'regenerates'), item('/2', 2, 'orphan'), item('/3', 4, 'ask'), item('/4', 8, 'keep'), item('/5', 16, 'manual')]),
    ]);
    expect(r.byClass).toEqual({ regenerates: 1, orphan: 2, ask: 4, keep: 8, manual: 16 });
    expect(r.total).toBe(7);
  });

  it('identical paths collapse to one row with the more conservative class', () => {
    const r = computeReclaimable([clutter('a', [item('/x', 5, 'regenerates')]), clutter('b', [item('/x', 5, 'keep')])]);
    expect(r.byClass).toMatchObject({ regenerates: 0, keep: 5 });
  });
});

describe('computeVerdict', () => {
  it('clutter-only: 30 GiB regenerates is cluttered', () => {
    const v = verdictOf([clutter('c', [item('/a', 30 * GIB, 'regenerates')])]);
    expect(v.verdict).toBe('cluttered');
    expect(v.reason).toBe('no vitals or stability problem; 30 GB reclaimable clutter');
  });
  it('ask-only 200 GiB is healthy: only regenerates + orphan count toward the threshold', () => {
    expect(verdictOf([clutter('c', [item('/a', 200 * GIB, 'ask')])]).verdict).toBe('healthy');
  });
  it('swap 5 GiB + free 8 % is sick', () => {
    const f = [finding('memory-pressure', 'vitals', 'risk', { title: 'Memory: 8 % free' })];
    const v = verdictOf(f);
    expect(v.verdict).toBe('sick');
    expect(v.reason).toBe('Memory: 8 % free');
  });
  it('a looping crash today is sick; a 4-day-old loop (warn) is degraded', () => {
    expect(verdictOf([finding('crashes-7d:x', 'stability', 'risk')]).verdict).toBe('sick');
    expect(verdictOf([finding('crashes-7d:y', 'stability', 'warn')]).verdict).toBe('degraded');
  });
  it('Time Machine unverifiable alone is healthy (advice)', () => {
    expect(verdictOf([finding('time-machine', 'backup', 'advice')]).verdict).toBe('healthy');
  });
  it('a dangling login item alone is cluttered', () => {
    const v = verdictOf([finding('login-items:warp', 'startup', 'warn')]);
    expect(v.verdict).toBe('cluttered');
    expect(v.reason).toBe('no vitals or stability problem; 1 startup/tooling/update warning');
  });
  it('leaked helpers are degraded; a stale backup (warn) is degraded', () => {
    expect(verdictOf([finding('duplicate-helpers:orphans', 'processes', 'warn')]).verdict).toBe('degraded');
    expect(verdictOf([finding('time-machine', 'backup', 'warn')]).verdict).toBe('degraded');
  });
  it('disk 3 % free is sick', () => {
    expect(verdictOf([finding('disk-space', 'vitals', 'risk')]).verdict).toBe('sick');
  });
  it('clutter can never produce degraded or sick', () => {
    const v = verdictOf([clutter('c', [item('/a', 5000 * GIB, 'regenerates')])]);
    expect(v.verdict).toBe('cluttered');
  });
  it('degraded/sick reasons list at most 3 titles', () => {
    const fs = ['a', 'b', 'c', 'd'].map((n) => finding(n, 'vitals', 'risk', { title: n }));
    expect(verdictOf(fs).reason).toBe('a; b; c');
  });
  it('healthy reason is built from the non-null vitals', () => {
    expect(verdictOf([]).reason).toBe('no memory pressure, no crash loop, 1.4 TB free');
    expect(verdictOf([], vitals({ pressure: null, crashes7d: null, diskFreeBytes: null })).reason).toBe('no problems found');
  });
  it('both clutter and warnings are named in a cluttered reason', () => {
    const v = verdictOf([clutter('c', [item('/a', 25 * GIB, 'orphan')]), finding('node-installs', 'tooling', 'warn'), finding('software-update', 'updates', 'warn')]);
    expect(v.reason).toBe('no vitals or stability problem; 25 GB reclaimable clutter and 2 startup/tooling/update warnings');
  });
});

describe('sortFindings', () => {
  it('orders by category, then severity, then reclaimable bytes — without mutating', () => {
    const input = [
      finding('c1', 'clutter', 'advice', { reclaimableBytes: 5 }),
      finding('v-info', 'vitals', 'info'),
      finding('t-warn', 'tooling', 'warn'),
      finding('c2', 'clutter', 'advice', { reclaimableBytes: 50 }),
      finding('v-risk', 'vitals', 'risk'),
      finding('s-advice', 'startup', 'advice'),
      finding('s-warn', 'startup', 'warn'),
    ];
    const copy = [...input];
    expect(sortFindings(input).map((f) => f.id)).toEqual(['v-risk', 'v-info', 's-warn', 's-advice', 't-warn', 'c2', 'c1']);
    expect(input).toEqual(copy);
  });
});
