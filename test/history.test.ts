import { describe, expect, it } from 'vitest';
import {
  encodeSample,
  parseLine,
  parseJsonl,
  downsample,
  filterSince,
  dayFileName,
  isExpired,
  prunable,
  RANGES,
  type HistorySample,
} from '../src/history/store.js';

// ---------- fixtures ----------

function makeSample(t: number, cpu = 10): HistorySample {
  return { t, cpu, cpuUser: cpu * 0.8, mem: 50, netRx: 1000, netTx: 500, diskR: 200, diskW: 100, load: 1.5 };
}

// ---------- JSONL round-trip ----------

describe('encodeSample / parseLine', () => {
  it('round-trips a sample', () => {
    const s = makeSample(Date.now(), 42.5);
    const line = encodeSample(s);
    expect(typeof line).toBe('string');
    expect(line).not.toContain('\n');
    const parsed = parseLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(s);
  });

  it('parseLine returns null for empty string', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('parseLine returns null for corrupt JSON', () => {
    expect(parseLine('{not json')).toBeNull();
  });

  it('parseLine returns null for JSON without .t field', () => {
    expect(parseLine('{"cpu":10}')).toBeNull();
  });

  it('parseLine fills missing numeric fields with 0', () => {
    const parsed = parseLine('{"t":12345}');
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe(12345);
    expect(parsed!.cpu).toBe(0);
    expect(parsed!.load).toBe(0);
  });
});

describe('parseJsonl', () => {
  it('parses multiple valid lines', () => {
    const s1 = makeSample(1000, 10);
    const s2 = makeSample(2000, 20);
    const text = encodeSample(s1) + '\n' + encodeSample(s2) + '\n';
    const result = parseJsonl(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(s1);
    expect(result[1]).toEqual(s2);
  });

  it('skips blank lines', () => {
    const s = makeSample(1000, 5);
    const text = '\n' + encodeSample(s) + '\n\n';
    const result = parseJsonl(text);
    expect(result).toHaveLength(1);
  });

  it('skips corrupt lines without failing', () => {
    const s = makeSample(1000, 5);
    const text = encodeSample(s) + '\n{corrupt\n' + encodeSample(s) + '\n';
    const result = parseJsonl(text);
    expect(result).toHaveLength(2);
  });

  it('handles a partial/truncated last line', () => {
    const s = makeSample(1000, 5);
    const text = encodeSample(s) + '\n{"t":999,"cpu":1'; // truncated
    const result = parseJsonl(text);
    expect(result).toHaveLength(1); // truncated line skipped
  });
});

// ---------- downsample ----------

describe('downsample', () => {
  it('returns input when already ≤ maxPoints', () => {
    const samples = [makeSample(1000), makeSample(2000), makeSample(3000)];
    const result = downsample(samples, 10);
    expect(result).toBe(samples); // same reference
  });

  it('returns ≤ maxPoints samples', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => makeSample(i * 1000, i % 100));
    const result = downsample(samples, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('never exceeds maxPoints', () => {
    for (const n of [50, 100, 200, 500, 999, 1000]) {
      const samples = Array.from({ length: n }, (_, i) => makeSample(i * 1000, i % 100));
      const result = downsample(samples, 50);
      expect(result.length).toBeLessThanOrEqual(50);
    }
  });

  it('averages numeric fields within buckets', () => {
    // Two samples, maxPoints=1 → should average into one bucket
    const s1 = makeSample(1000, 10);
    const s2 = makeSample(2000, 30);
    const result = downsample([s1, s2], 1);
    expect(result).toHaveLength(1);
    // cpu avg of 10 and 30 = 20
    expect(result[0]!.cpu).toBeCloseTo(20, 5);
  });

  it('preserves order (oldest → newest)', () => {
    const samples = Array.from({ length: 200 }, (_, i) => makeSample(i * 1000, i));
    const result = downsample(samples, 50);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.t).toBeGreaterThanOrEqual(result[i - 1]!.t);
    }
  });

  it('handles empty input', () => {
    expect(downsample([], 100)).toEqual([]);
  });
});

// ---------- filterSince ----------

describe('filterSince', () => {
  const samples = [makeSample(1000), makeSample(2000), makeSample(3000), makeSample(4000)];

  it('returns all samples when sinceMs is before the first', () => {
    const result = filterSince(samples, 500);
    expect(result).toHaveLength(4);
  });

  it('filters out samples before sinceMs', () => {
    const result = filterSince(samples, 2000);
    expect(result).toHaveLength(3);
    expect(result[0]!.t).toBe(2000);
  });

  it('returns empty when sinceMs is after the last', () => {
    const result = filterSince(samples, 5000);
    expect(result).toHaveLength(0);
  });

  it('includes the exact boundary', () => {
    const result = filterSince(samples, 3000);
    expect(result).toHaveLength(2);
    expect(result[0]!.t).toBe(3000);
  });
});

// ---------- file-name helpers ----------

describe('dayFileName', () => {
  it('formats a UTC date correctly', () => {
    expect(dayFileName(new Date('2025-01-05T12:00:00Z'))).toBe('history-2025-01-05.jsonl');
  });

  it('zero-pads month and day', () => {
    expect(dayFileName(new Date('2025-03-01T00:00:00Z'))).toBe('history-2025-03-01.jsonl');
  });
});

describe('isExpired', () => {
  const now = new Date('2025-01-20T12:00:00Z');

  it('returns false for a file within retention (14 days)', () => {
    // 14 days ago relative to now = 2025-01-06 — should NOT be expired
    expect(isExpired('history-2025-01-06.jsonl', now, 14)).toBe(false);
  });

  it('returns true for a file older than retention', () => {
    // 15 days before 2025-01-20 = 2025-01-05 — should be expired
    expect(isExpired('history-2025-01-05.jsonl', now, 14)).toBe(true);
  });

  it('returns false for today', () => {
    expect(isExpired('history-2025-01-20.jsonl', now, 14)).toBe(false);
  });

  it('returns false for a non-matching filename', () => {
    expect(isExpired('.writer.lock', now, 14)).toBe(false);
    expect(isExpired('something.txt', now, 14)).toBe(false);
  });
});

describe('prunable', () => {
  const now = new Date('2025-01-20T12:00:00Z');
  const files = [
    'history-2025-01-01.jsonl',  // expired (19 days ago)
    'history-2025-01-05.jsonl',  // expired (15 days ago)
    'history-2025-01-06.jsonl',  // boundary (14 days ago = first non-expired)
    'history-2025-01-15.jsonl',  // within retention
    'history-2025-01-20.jsonl',  // today
    '.writer.lock',              // should be ignored
  ];

  it('returns only the expired files', () => {
    const result = prunable(files, now, 14);
    expect(result).toContain('history-2025-01-01.jsonl');
    expect(result).toContain('history-2025-01-05.jsonl');
    expect(result).not.toContain('history-2025-01-06.jsonl');
    expect(result).not.toContain('history-2025-01-15.jsonl');
    expect(result).not.toContain('history-2025-01-20.jsonl');
    expect(result).not.toContain('.writer.lock');
  });

  it('returns empty when all files are within retention', () => {
    const recent = ['history-2025-01-15.jsonl', 'history-2025-01-20.jsonl'];
    expect(prunable(recent, now, 14)).toHaveLength(0);
  });

  it('returns all when all files are expired', () => {
    const old = ['history-2025-01-01.jsonl', 'history-2024-12-01.jsonl'];
    const result = prunable(old, now, 14);
    expect(result).toHaveLength(2);
  });
});

// ---------- RANGES ----------

describe('RANGES', () => {
  it('15m maps to 900000 ms', () => {
    expect(RANGES['15m']).toBe(15 * 60 * 1000);
  });

  it('1h maps to 3600000 ms', () => {
    expect(RANGES['1h']).toBe(60 * 60 * 1000);
  });

  it('6h maps to 6 * 3600000 ms', () => {
    expect(RANGES['6h']).toBe(6 * 60 * 60 * 1000);
  });

  it('24h maps to 86400000 ms', () => {
    expect(RANGES['24h']).toBe(24 * 60 * 60 * 1000);
  });

  it('7d maps to 7 days in ms', () => {
    expect(RANGES['7d']).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('all maps to null', () => {
    expect(RANGES['all']).toBeNull();
  });

  it('contains exactly the expected keys', () => {
    expect(Object.keys(RANGES).sort()).toEqual(['15m', '1h', '24h', '6h', '7d', 'all'].sort());
  });
});
