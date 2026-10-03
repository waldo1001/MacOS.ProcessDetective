import { runElevated } from './elevated.js';
import type { FsChurnSnapshot, FsChurnProcess } from '../types.js';

// Processes that are observers, not churn sources — exclude from attribution.
const EXCLUDED = new Set(['fseventsd', 'fs_usage', 'sh', 'mktemp', 'osascript']);

// Regex for validating the built command shape (only integer varies).
const CMD_SHAPE =
  /^\/bin\/sh -c 'f=\$\(mktemp \/tmp\/pd_fsusage\.XXXXXX\); \/usr\/bin\/fs_usage -w -f filesys >\$f 2>\/dev\/null & p=\$!; sleep \d+; kill \$p 2>\/dev\/null; sleep 1; kill -9 \$p 2>\/dev\/null; head -c 4000000 \$f; rm -f \$f'$/;

// Patterns for known churn source directories.
// Regexes match either a path component followed by / or at the end of the string.
const CHURN_PATTERNS: Array<{ re: RegExp; label: (dir: string) => string }> = [
  { re: /\/node_modules(\/|$)/, label: (d) => `${d} (dependency install or file watcher)` },
  { re: /\/\.git(\/|$)/, label: (d) => `${d} (git operation)` },
  { re: /\.orbstack/, label: (d) => `${d} (OrbStack VM)` },
  { re: /\/Library\/Developer(\/|$)/, label: (d) => `${d} (Xcode/developer tools)` },
  { re: /\/DiagnosticReports(\/|$)/, label: (d) => `${d} (crash reporting)` },
  { re: /\/Caches(\/|$)/, label: (d) => `${d} (cache writes)` },
  {
    re: /\/(?:bin|obj|target|dist|build)(\/|$)/,
    label: (d) => `${d} (build output)`,
  },
];

/**
 * Build the privileged fs_usage shell command. PURE — unit-tested.
 *
 * fs_usage streams forever, so the inner command backgrounds it to a temp file,
 * sleeps N seconds, kills it, prints a byte-capped slice, then cleans up.
 * Uses NO double-quotes so runElevated's AppleScript escaping has nothing to touch.
 *
 * @throws if the resulting command does not match the expected shape.
 */
export function buildFsUsageCommand(seconds: number): string {
  const safeSecs = Math.max(2, Math.min(5, Math.floor(seconds)));
  const cmd =
    `/bin/sh -c 'f=$(mktemp /tmp/pd_fsusage.XXXXXX); /usr/bin/fs_usage -w -f filesys >$f 2>/dev/null & p=$!; sleep ${safeSecs}; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null; head -c 4000000 $f; rm -f $f'`;
  if (!CMD_SHAPE.test(cmd)) {
    throw new Error(`Unexpected fs_usage command shape: ${cmd}`);
  }
  return cmd;
}

/** Return the top N most-common values from an array. */
function topN<T>(arr: T[], n: number): T[] {
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([v]) => v);
}

/**
 * Derive a 4-level-deep common parent directory for a set of paths.
 * Falls back to the longest common prefix.
 */
function commonDir(paths: string[]): string | null {
  if (paths.length === 0) return null;

  // Build 4-level ancestor for each path.
  const ancestors = paths.map((p) => {
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.slice(0, 4).join('/');
  });

  // Most common 4-level ancestor.
  const best = topN(ancestors, 1)[0];
  if (best) return best;

  // Fallback: longest common prefix.
  let prefix = paths[0]!;
  for (const p of paths.slice(1)) {
    while (!p.startsWith(prefix)) {
      const last = prefix.lastIndexOf('/');
      if (last <= 0) return null;
      prefix = prefix.slice(0, last);
    }
  }
  return prefix || null;
}

/**
 * Parse `fs_usage -w -f filesys` stdout into a FsChurnSnapshot.
 * Pure function — no side effects, unit-tested.
 *
 * fs_usage -w line shape (relevant columns):
 *   <timestamp>  <syscall>  [<args>]  <path-starting-with-/>  <elapsed>  [W]  <procname>.<threadid>
 *
 * The last whitespace-delimited token is <procname>.<threadid>.
 * The path is the longest token starting with '/'.
 */
export function parseFsUsage(stdout: string, seconds: number): FsChurnSnapshot {
  const safeSecs = Math.max(2, Math.min(5, Math.floor(seconds)));

  if (!stdout || stdout.trim().length === 0) {
    return {
      available: false,
      windowSeconds: safeSecs,
      totalEvents: 0,
      topProcesses: [],
      truncated: false,
      note: 'no filesystem activity captured',
    };
  }

  const truncated = Buffer.byteLength(stdout, 'utf8') >= 3_900_000;

  // Per-process aggregation: process name → { count, paths }
  const byProcess = new Map<string, { count: number; paths: string[] }>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 3) continue;

    // Last token is <procname>.<threadid> — strip trailing .<digits>
    const lastToken = tokens[tokens.length - 1]!;
    const procName = lastToken.replace(/\.\d+$/, '');

    if (!procName || EXCLUDED.has(procName)) continue;

    // Path: the longest token starting with '/'
    let path: string | null = null;
    let longestLen = 0;
    for (const tok of tokens) {
      if (tok.startsWith('/') && tok.length > longestLen) {
        path = tok;
        longestLen = tok.length;
      }
    }

    const entry = byProcess.get(procName) ?? { count: 0, paths: [] };
    entry.count += 1;
    if (path) entry.paths.push(path);
    byProcess.set(procName, entry);
  }

  if (byProcess.size === 0) {
    return {
      available: false,
      windowSeconds: safeSecs,
      totalEvents: 0,
      topProcesses: [],
      truncated,
      note: 'no filesystem activity captured',
    };
  }

  // Build sorted topProcesses, cap at 8.
  const sorted = [...byProcess.entries()].sort((a, b) => b[1].count - a[1].count);
  const totalEvents = sorted.reduce((sum, [, v]) => sum + v.count, 0);

  const topProcesses: FsChurnProcess[] = sorted.slice(0, 8).map(([process, { count, paths }]) => ({
    process,
    count,
    samplePaths: topN(paths, 3),
    commonDir: commonDir(paths),
  }));

  // Build concentration note for the top process.
  let note: string | null = null;
  const top = topProcesses[0];
  if (top) {
    const dir = top.commonDir ?? top.samplePaths[0] ?? '';
    for (const { re, label } of CHURN_PATTERNS) {
      if (re.test(dir)) {
        const count = top.count.toLocaleString();
        note = `Top driver: ${top.process} — ${count} events under ${dir} — ${label(dir)}`;
        break;
      }
    }
  }

  if (truncated) {
    const truncNote = '(output truncated — capture window may be larger than 4 MB)';
    note = note ? `${note}. ${truncNote}` : truncNote;
  }

  return {
    available: true,
    windowSeconds: safeSecs,
    totalEvents,
    topProcesses,
    truncated,
    note,
  };
}

/**
 * Run `fs_usage -w -f filesys` as root for `seconds` seconds and return
 * a churn attribution snapshot.
 *
 * Never throws — returns available:false with a descriptive note on any failure.
 * Respects PD_NO_ELEVATED=1 (enforced inside runElevated).
 */
export async function getFsChurn(seconds = 3): Promise<FsChurnSnapshot> {
  let inner: string;
  try {
    inner = buildFsUsageCommand(seconds);
  } catch (err) {
    return {
      available: false,
      windowSeconds: Math.max(2, Math.min(5, Math.floor(seconds))),
      totalEvents: 0,
      topProcesses: [],
      truncated: false,
      note: `fs_usage command build failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const timeoutMs = (seconds + 8) * 1000;
  const r = await runElevated(inner, timeoutMs);

  if (!r.ok) {
    return {
      available: false,
      windowSeconds: Math.max(2, Math.min(5, Math.floor(seconds))),
      totalEvents: 0,
      topProcesses: [],
      truncated: false,
      note: r.note,
    };
  }

  return parseFsUsage(r.stdout, seconds);
}
