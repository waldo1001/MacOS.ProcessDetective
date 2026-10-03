import type { ProcessNode, RawProcess } from '../types.js';

/** Format a CPU/MEM percentage. */
export function fmtPct(p: number): string {
  return `${p.toFixed(1)}%`;
}

/** Compact elapsed time, e.g. "3d4h", "2h15m", "5m02s", "37s". */
export function fmtElapsed(totalSec: number): string {
  let sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86400);
  sec %= 86400;
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Truncate with an ellipsis; returns "unknown" for null/empty. */
export function shorten(s: string | null | undefined, max = 80): string {
  if (!s) return 'unknown';
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** Replace a leading $HOME with "~" for compact, copy-friendly paths. */
export function homePath(p: string | null | undefined): string | null {
  if (!p) return p ?? null;
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * A short, friendly name for a node in a chain — turns raw commands into the
 * readable labels you'd want in a report ("npm run dev", "node …/vite.js",
 * "Visual Studio Code").
 */
export function friendlyNodeName(node: ProcessNode): string {
  const { name, command, execPath } = node.proc;
  const lower = name.toLowerCase();
  const cmd = command ?? '';

  const run = cmd.match(/\b(?:run|run-script)\s+([\w:.@/-]+)/);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(lower) && run) {
    return `${name} run ${run[1]}`;
  }
  if (lower === 'node') {
    const scriptArg = cmd
      .split(/\s+/)
      .slice(1)
      .find((t) => t && !t.startsWith('-'));
    if (scriptArg) return `node ${scriptArg}`;
  }
  // App bundles: /Applications/Foo.app/Contents/MacOS/Bar -> "Foo"
  const app = (execPath ?? '').match(/\/([^/]+)\.app\//);
  if (app) return app[1]!;
  return name;
}

/** One-line identity string used across renderers. */
export function describe(proc: RawProcess): string {
  return `${proc.name} (PID ${proc.pid})`;
}

/**
 * Human byte size — 1024-based, labelled B/KB/MB/GB/TB, one decimal below 10
 * (like the page's `fmtBytes`): 10_630_000_000 bytes is "9.9 GB", never "10 GB".
 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  // 1023.7 KB would print as "1024 KB"; promote it instead of lying about the unit.
  if (v >= 1023.5 && i < units.length - 1) return `1.0 ${units[i + 1]}`;
  const shown = v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${shown === '10.0' ? '10' : shown} ${units[i]}`;
}
