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
