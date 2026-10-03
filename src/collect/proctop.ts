import { run } from '../util/exec.js';

export interface ProcStat { threads: number; energy: number; }

/**
 * Per-process thread count and energy impact via a single `top` sample.
 * Covers the top N processes (by energy); others simply won't appear in the map
 * and callers fall back to "unknown". Read-only, no sudo.
 */
export async function collectProcStats(limit = 300): Promise<Map<number, ProcStat>> {
  const res = await run('top', ['-l1', '-n', String(limit), '-stats', 'pid,th,power', '-o', 'power']);
  const map = new Map<number, ProcStat>();
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)/);
    if (!m) continue;
    map.set(parseInt(m[1]!, 10), { threads: parseInt(m[2]!, 10), energy: parseFloat(m[3]!) });
  }
  return map;
}
