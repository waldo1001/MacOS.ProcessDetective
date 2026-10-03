import type { RawProcess } from '../types.js';
import { color } from '../util/color.js';
import { fmtElapsed, fmtPct, shorten } from './format.js';

export interface TopOptions {
  limit?: number;
  /** CPU% at/above which a row is highlighted red. 0 disables highlighting. */
  threshold?: number;
}

/** Render the top CPU consumers as an aligned table. */
export function renderTop(procs: RawProcess[], opts: TopOptions = {}): string {
  const { limit = 15, threshold = 0 } = opts;
  const rows = [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, limit);

  const lines = [
    color.bold(
      `${'PID'.padStart(7)} ${'CPU'.padStart(7)} ${'MEM'.padStart(6)} ` +
        `${'TIME'.padStart(7)}  ${'NAME'.padEnd(16)} COMMAND`,
    ),
  ];

  for (const p of rows) {
    const hot = threshold > 0 && p.cpu >= threshold;
    const cpuCell = fmtPct(p.cpu).padStart(7);
    const cpu = hot ? color.red(color.bold(cpuCell)) : color.green(cpuCell);
    lines.push(
      `${String(p.pid).padStart(7)} ${cpu} ${fmtPct(p.mem).padStart(6)} ` +
        `${fmtElapsed(p.elapsedSeconds).padStart(7)}  ` +
        `${color.cyan(shorten(p.name, 16).padEnd(16))} ` +
        `${color.dim(shorten(p.command, 70))}`,
    );
  }
  return lines.join('\n');
}
