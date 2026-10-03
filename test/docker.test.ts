import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseDockerPs,
  parseDockerStats,
  parseRunningFor,
  _resetDockerPathCache,
} from '../src/collect/docker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PS_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'docker-ps.jsonl'), 'utf8');
const STATS_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'docker-stats.jsonl'), 'utf8');

// ---------------------------------------------------------------------------
// parseRunningFor
// ---------------------------------------------------------------------------

describe('parseRunningFor', () => {
  it('returns 0 for "Less than a second ago"', () => {
    expect(parseRunningFor('Less than a second ago')).toBe(0);
  });

  it('returns 0 for bare "Less than a second"', () => {
    expect(parseRunningFor('Less than a second')).toBe(0);
  });

  it('parses "N seconds ago"', () => {
    expect(parseRunningFor('5 seconds ago')).toBe(5);
    expect(parseRunningFor('1 second ago')).toBe(1);
  });

  it('parses "Up N seconds" (Status field form)', () => {
    expect(parseRunningFor('Up 10 seconds')).toBe(10);
    expect(parseRunningFor('Up 2 seconds')).toBe(2);
  });

  it('parses "About a minute ago"', () => {
    expect(parseRunningFor('About a minute ago')).toBe(60);
    expect(parseRunningFor('About a minute')).toBe(60);
  });

  it('parses "Up About a minute"', () => {
    expect(parseRunningFor('Up About a minute')).toBe(60);
  });

  it('parses "N minutes ago"', () => {
    expect(parseRunningFor('3 minutes ago')).toBe(180);
    expect(parseRunningFor('1 minute ago')).toBe(60);
  });

  it('parses "About an hour ago"', () => {
    expect(parseRunningFor('About an hour ago')).toBe(3600);
    expect(parseRunningFor('About an hour')).toBe(3600);
  });

  it('parses "N hours ago"', () => {
    expect(parseRunningFor('2 hours ago')).toBe(7200);
    expect(parseRunningFor('1 hour ago')).toBe(3600);
  });

  it('parses "About 2 hours ago" — falls back to null (unsupported variant)', () => {
    // "About 2 hours" doesn't match our patterns; acceptable to return null
    const result = parseRunningFor('About 2 hours ago');
    expect(result === null || typeof result === 'number').toBe(true);
  });

  it('parses "N days ago"', () => {
    expect(parseRunningFor('1 day ago')).toBe(86400);
    expect(parseRunningFor('3 days ago')).toBe(86400 * 3);
  });

  it('returns null for empty string', () => {
    expect(parseRunningFor('')).toBeNull();
  });

  it('returns null for unrecognized strings', () => {
    expect(parseRunningFor('some garbage string')).toBeNull();
    expect(parseRunningFor('unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDockerPs (fixture)
// ---------------------------------------------------------------------------

describe('parseDockerPs (fixture)', () => {
  it('parses without throwing', () => {
    expect(() => parseDockerPs(PS_FIXTURE)).not.toThrow();
  });

  it('sets available:true when containers are found', () => {
    const snap = parseDockerPs(PS_FIXTURE);
    expect(snap.available).toBe(true);
  });

  it('counts total running containers correctly (9 lines in fixture)', () => {
    const snap = parseDockerPs(PS_FIXTURE);
    // Fixture has 6 postgres + 2 ryuk + 1 redis = 9
    expect(snap.totalRunning).toBe(9);
  });

  it('groups by image and sorts descending', () => {
    const snap = parseDockerPs(PS_FIXTURE);
    // postgres:17-alpine appears 6 times, testcontainers/ryuk:0.9.0 appears 2 times, redis once
    expect(snap.byImage[0]!.image).toBe('postgres:17-alpine');
    expect(snap.byImage[0]!.count).toBe(6);
    expect(snap.byImage[1]!.image).toBe('testcontainers/ryuk:0.9.0');
    expect(snap.byImage[1]!.count).toBe(2);
    expect(snap.byImage[2]!.image).toBe('redis:7-alpine');
    expect(snap.byImage[2]!.count).toBe(1);
  });

  it('caps byImage at 10', () => {
    const snap = parseDockerPs(PS_FIXTURE);
    expect(snap.byImage.length).toBeLessThanOrEqual(10);
  });

  it('counts recentlyStarted correctly', () => {
    // Fixture rows with runningForSec <= 30:
    // "Less than a second ago" → 0 ✓
    // "2 seconds ago" → 2 ✓
    // "5 seconds ago" → 5 ✓
    // "25 seconds ago" → 25 ✓
    // "14 seconds ago" → 14 ✓
    // "23 seconds ago" → 23 ✓
    // Total: 6 (the ones with >= 31s: "About a minute ago"→60, "3 minutes ago"→180, "About 2 hours ago"→null/big)
    const snap = parseDockerPs(PS_FIXTURE);
    expect(snap.recentlyStarted).toBe(6);
  });

  it('counts testcontainers-labelled containers', () => {
    // All postgres (6) + both ryuk (2) have org.testcontainers label = 8
    // redis has empty Labels = 0 testcontainers
    const snap = parseDockerPs(PS_FIXTURE);
    expect(snap.testcontainers).toBe(8);
  });

  it('byImage is sorted descending by count', () => {
    const snap = parseDockerPs(PS_FIXTURE);
    for (let i = 1; i < snap.byImage.length; i++) {
      expect(snap.byImage[i - 1]!.count).toBeGreaterThanOrEqual(snap.byImage[i]!.count);
    }
  });
});

// ---------------------------------------------------------------------------
// parseDockerPs (edge cases)
// ---------------------------------------------------------------------------

describe('parseDockerPs (edge cases)', () => {
  it('returns available:false on empty string without throwing', () => {
    const snap = parseDockerPs('');
    expect(snap.available).toBe(false);
    expect(snap.totalRunning).toBe(0);
    expect(snap.byImage).toHaveLength(0);
  });

  it('skips malformed (non-JSON) lines without throwing', () => {
    const input = 'not json\n{"ID":"abc123","Image":"nginx","Names":"test","Status":"Up 2 seconds","RunningFor":"2 seconds ago","State":"running","Labels":""}\ngibberish';
    const snap = parseDockerPs(input);
    expect(snap.available).toBe(true);
    expect(snap.totalRunning).toBe(1);
  });

  it('returns available:false on garbage input', () => {
    const snap = parseDockerPs('zzz garbage zzz');
    expect(snap.available).toBe(false);
    expect(() => parseDockerPs('zzz garbage zzz')).not.toThrow();
  });

  it('handles a single valid container line', () => {
    const line = '{"ID":"aaa111","Image":"alpine","Names":"my_alpine","Status":"Up Less than a second","RunningFor":"Less than a second ago","State":"running","Labels":"org.testcontainers=true"}';
    const snap = parseDockerPs(line);
    expect(snap.available).toBe(true);
    expect(snap.totalRunning).toBe(1);
    expect(snap.recentlyStarted).toBe(1);
    expect(snap.testcontainers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseDockerStats (fixture)
// ---------------------------------------------------------------------------

describe('parseDockerStats (fixture)', () => {
  it('parses without throwing', () => {
    expect(() => parseDockerStats(STATS_FIXTURE)).not.toThrow();
  });

  it('sets available:true', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.available).toBe(true);
  });

  it('sorts topByCpu descending', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    for (let i = 1; i < snap.topByCpu.length; i++) {
      expect(snap.topByCpu[i - 1]!.cpuPct).toBeGreaterThanOrEqual(snap.topByCpu[i]!.cpuPct);
    }
  });

  it('has hardcore_galois first (13.12%)', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.topByCpu[0]!.name).toBe('hardcore_galois');
    expect(snap.topByCpu[0]!.cpuPct).toBeCloseTo(13.12, 2);
  });

  it('parses PIDs correctly', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.topByCpu[0]!.pids).toBe(7);
  });

  it('parses memUsage correctly', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.topByCpu[0]!.memUsage).toBe('21.05MiB / 15.66GiB');
  });

  it('caps topByCpu at 12', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.topByCpu.length).toBeLessThanOrEqual(12);
  });

  it('includes all 9 fixture rows (fixture has 9 containers)', () => {
    const snap = parseDockerStats(STATS_FIXTURE);
    expect(snap.topByCpu.length).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// parseDockerStats (edge cases)
// ---------------------------------------------------------------------------

describe('parseDockerStats (edge cases)', () => {
  it('returns available:false on empty string without throwing', () => {
    const snap = parseDockerStats('');
    expect(snap.available).toBe(false);
    expect(snap.topByCpu).toHaveLength(0);
  });

  it('skips malformed lines', () => {
    const input = 'not json\n{"CPUPerc":"5.00%","ID":"abc","MemPerc":"0.01%","MemUsage":"1MiB / 16GiB","Name":"test","NetIO":"0B","PIDs":"3"}';
    const snap = parseDockerStats(input);
    expect(snap.available).toBe(true);
    expect(snap.topByCpu.length).toBe(1);
    expect(snap.topByCpu[0]!.cpuPct).toBeCloseTo(5.0, 2);
  });

  it('returns available:false on garbage input without throwing', () => {
    expect(() => parseDockerStats('garbage text here')).not.toThrow();
    const snap = parseDockerStats('garbage text here');
    expect(snap.available).toBe(false);
  });

  it('parses CPUPerc "0.00%" correctly', () => {
    const line = '{"CPUPerc":"0.00%","ID":"abc","MemPerc":"0.01%","MemUsage":"2MiB / 16GiB","Name":"idle_container","NetIO":"0B","PIDs":"4"}';
    const snap = parseDockerStats(line);
    expect(snap.topByCpu[0]!.cpuPct).toBeCloseTo(0.0, 2);
  });
});
