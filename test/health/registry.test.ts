import { describe, expect, it } from 'vitest';
import type { HealthCheck } from '../../src/health/context.js';
import { ALL_CHECKS, runCheck, runPool } from '../../src/health/registry.js';
import { fakeContext } from './helpers.js';

const check = (over: Partial<HealthCheck>): HealthCheck => ({
  id: 'x', category: 'vitals', scope: 'quick', timeoutMs: 1000, run: async () => ({ findings: [] }), ...over,
});

describe('runCheck', () => {
  it('returns the result of a healthy check', async () => {
    const r = await runCheck(check({ run: async () => ({ findings: [], vitals: { crashes7d: 1 } }) }), fakeContext());
    expect(r.result).toEqual({ findings: [], vitals: { crashes7d: 1 } });
    expect(r.skipped).toBeNull();
  });

  it('a check that throws becomes skipped, never a throw', async () => {
    const r = await runCheck(check({ run: async () => { throw new Error('boom'); } }), fakeContext());
    expect(r.result).toBeNull();
    expect(r.skipped).toBe('failed: boom');
  });

  it('a synchronous throw is also contained', async () => {
    const r = await runCheck(check({ run: (() => { throw new Error('sync'); }) as HealthCheck['run'] }), fakeContext());
    expect(r.skipped).toBe('failed: sync');
  });

  it('a check that exceeds its timeout becomes skipped', async () => {
    const r = await runCheck(check({ timeoutMs: 30, run: () => new Promise(() => {}) }), fakeContext());
    expect(r.result).toBeNull();
    expect(r.skipped).toBe('timed out after 0 s');
  });

  it('a late rejection after the timeout does not surface as an unhandled rejection', async () => {
    const r = await runCheck(
      check({ timeoutMs: 20, run: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 50)) }),
      fakeContext(),
    );
    expect(r.skipped).toMatch(/timed out/);
    await new Promise((res) => setTimeout(res, 80));
  });
});

describe('runPool', () => {
  it('keeps the input order and never exceeds the limit', async () => {
    let live = 0;
    let peak = 0;
    const out = await runPool([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
  it('handles an empty list', async () => {
    expect(await runPool([], 3, async () => 1)).toEqual([]);
  });
});

describe('ALL_CHECKS', () => {
  it('lists every documented check once, with the documented scope and caching', () => {
    const byId = Object.fromEntries(ALL_CHECKS.map((c) => [c.id, c]));
    expect(Object.keys(byId)).toEqual([
      'memory-pressure', 'disk-space', 'thermal', 'battery', 'uptime-load', 'crashes-7d', 'runaway-logs', 'apfs-snapshots',
      'launch-agents', 'duplicate-helpers', 'node-installs', 'login-items', 'software-update', 'time-machine', 'brew', 'disk-clutter',
    ]);
    expect(ALL_CHECKS.filter((c) => c.ttlMs !== undefined).map((c) => [c.id, c.ttlMs])).toEqual([
      ['software-update', 21_600_000], ['time-machine', 900_000], ['brew', 3_600_000],
    ]);
    expect(ALL_CHECKS.filter((c) => c.scope === 'full').map((c) => c.id)).toEqual(['disk-clutter']);
    expect(ALL_CHECKS.every((c) => c.timeoutMs > 0)).toBe(true);
  });
});
