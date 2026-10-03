/**
 * Pure, unit-testable functions for the history persistence layer.
 * No timers, no side effects beyond what's passed in explicitly.
 */

export interface HistorySample {
  t: number;        // ms epoch
  cpu: number;      // cpu.usagePct
  cpuUser: number;  // cpu.user
  mem: number;      // memory.usedPct
  netRx: number;    // network.rxBytesPerSec
  netTx: number;    // network.txBytesPerSec
  diskR: number;    // disk.readBytesPerSec
  diskW: number;    // disk.writeBytesPerSec
  load: number;     // cpu.loadAvg[0]
}

/** Range label → duration in ms (null = all available history). */
export const RANGES: Record<string, number | null> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  all: null,
};

// ---------- JSONL helpers ----------

/** Encode a sample as a compact JSON line (no trailing newline). */
export function encodeSample(s: HistorySample): string {
  return JSON.stringify(s);
}

/** Parse one JSONL line. Returns null on blank or corrupt input. */
export function parseLine(line: string): HistorySample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.t !== 'number') return null;
    return {
      t:       typeof obj.t       === 'number' ? obj.t       : 0,
      cpu:     typeof obj.cpu     === 'number' ? obj.cpu     : 0,
      cpuUser: typeof obj.cpuUser === 'number' ? obj.cpuUser : 0,
      mem:     typeof obj.mem     === 'number' ? obj.mem     : 0,
      netRx:   typeof obj.netRx   === 'number' ? obj.netRx   : 0,
      netTx:   typeof obj.netTx   === 'number' ? obj.netTx   : 0,
      diskR:   typeof obj.diskR   === 'number' ? obj.diskR   : 0,
      diskW:   typeof obj.diskW   === 'number' ? obj.diskW   : 0,
      load:    typeof obj.load    === 'number' ? obj.load    : 0,
    };
  } catch {
    return null;
  }
}

/** Parse a full JSONL string, skipping blank/corrupt lines. */
export function parseJsonl(text: string): HistorySample[] {
  return text
    .split('\n')
    .map(parseLine)
    .filter((s): s is HistorySample => s !== null);
}

// ---------- query helpers ----------

/** Return samples with t >= sinceMs (preserves order). */
export function filterSince(samples: HistorySample[], sinceMs: number): HistorySample[] {
  return samples.filter((s) => s.t >= sinceMs);
}

/**
 * Downsample to at most maxPoints by time-bucketing.
 * If already ≤ maxPoints, returns the input array as-is.
 * Numeric fields are averaged within each bucket.
 * Output order is oldest→newest.
 */
export function downsample(samples: HistorySample[], maxPoints: number): HistorySample[] {
  if (samples.length <= maxPoints) return samples;
  if (samples.length === 0) return [];

  const tMin = samples[0]!.t;
  const tMax = samples[samples.length - 1]!.t;
  const span = tMax - tMin || 1;
  const buckets: HistorySample[][] = Array.from({ length: maxPoints }, () => []);

  for (const s of samples) {
    const idx = Math.min(
      maxPoints - 1,
      Math.floor(((s.t - tMin) / span) * maxPoints),
    );
    buckets[idx]!.push(s);
  }

  const result: HistorySample[] = [];
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const n = bucket.length;
    result.push({
      t:       bucket[bucket.length - 1]!.t, // use latest t in bucket
      cpu:     bucket.reduce((a, s) => a + s.cpu,     0) / n,
      cpuUser: bucket.reduce((a, s) => a + s.cpuUser, 0) / n,
      mem:     bucket.reduce((a, s) => a + s.mem,     0) / n,
      netRx:   bucket.reduce((a, s) => a + s.netRx,   0) / n,
      netTx:   bucket.reduce((a, s) => a + s.netTx,   0) / n,
      diskR:   bucket.reduce((a, s) => a + s.diskR,   0) / n,
      diskW:   bucket.reduce((a, s) => a + s.diskW,   0) / n,
      load:    bucket.reduce((a, s) => a + s.load,    0) / n,
    });
  }
  return result;
}

// ---------- file-rotation helpers ----------

/**
 * Returns the JSONL file name for a given Date (UTC day).
 * e.g. "history-2025-01-15.jsonl"
 */
export function dayFileName(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `history-${y}-${m}-${d}.jsonl`;
}

/**
 * Returns true if the file is older than retentionDays relative to `now`.
 * A file for day D is expired if D < (now - retentionDays days in UTC).
 */
export function isExpired(fileName: string, now: Date, retentionDays: number): boolean {
  const m = fileName.match(/^history-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m) return false;
  // Parse the date as UTC midnight.
  const fileDay = new Date(`${m[1]}T00:00:00.000Z`);
  // Cut-off: the earliest day still within retention (exclusive lower bound).
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  // A file for day D covers [D, D+1day). It's expired when D+1day <= cutoff, i.e.
  // D < cutoff - but we use a whole-day comparison: the day itself must be before
  // the earliest retained day.
  const cutoffDay = new Date(cutoffMs);
  const cutoffDayStart = Date.UTC(
    cutoffDay.getUTCFullYear(),
    cutoffDay.getUTCMonth(),
    cutoffDay.getUTCDate(),
  );
  return fileDay.getTime() < cutoffDayStart;
}

/**
 * Returns the subset of `fileNames` that should be deleted (expired).
 */
export function prunable(fileNames: string[], now: Date, retentionDays: number): string[] {
  return fileNames.filter((f) => isExpired(f, now, retentionDays));
}
