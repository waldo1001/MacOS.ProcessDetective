import fsp from 'node:fs/promises';
import type { HealthEvidence } from '../types.js';

const MAX_EXCERPT_LINES = 12;
const MAX_LINE = 220;

/**
 * Build an evidence block: the copy-pasteable command plus the trimmed output
 * lines that justify the finding (blank lines dropped, long lines cut, ≤ 12 lines).
 */
export function evidence(command: string, output: string | string[], maxLines = MAX_EXCERPT_LINES): HealthEvidence {
  const raw = Array.isArray(output) ? output : output.split('\n');
  const lines = raw
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l));
  const cap = Math.min(maxLines, MAX_EXCERPT_LINES);
  const shown = lines.length > cap ? [...lines.slice(0, cap - 1), `… (+${lines.length - cap + 1} more lines)`] : lines;
  return { command, excerpt: shown.join('\n') };
}

/** Lower-case kebab slug for finding ids. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'item';
}

/** "3 h", "2 d", "45 min" — coarse age for sentences. */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "2026-10-03 10:29" in local time. */
export function clockText(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Pluralise a count: plural(1, 'snapshot') → "1 snapshot", plural(2, 'snapshot') → "2 snapshots". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Replace a leading home directory with "~" for readable text. */
export function tilde(p: string, home: string): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/**
 * Tiny promise pool: run `fn` over `items` with at most `limit` in flight,
 * resolving to the results in input order. `fn` must not throw (callers wrap
 * their own failures into a result value).
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Read-only filesystem seam — checks read through this so tests need no real tree.
// ---------------------------------------------------------------------------

export interface StatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  blocks: number;
  mtimeMs: number;
}
export interface DirentLike {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface FsLike {
  readdir(dir: string): Promise<DirentLike[]>;
  lstat(p: string): Promise<StatLike>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
}

export const realFs: FsLike = {
  readdir: (dir) => fsp.readdir(dir, { withFileTypes: true }),
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  readFile: (p) => fsp.readFile(p, 'utf8'),
};

/** On-disk bytes of a stat result (sparse files report far less than their apparent size). */
export function onDiskBytes(st: StatLike): number {
  return st.blocks * 512;
}

/** Reject after `ms` — used around fs calls that can block on a permission prompt. */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Ids listed in PD_HEALTH_SKIP (comma-separated check ids or clutter-catalog ids) never run. */
export function skipIds(): Set<string> {
  return new Set((process.env['PD_HEALTH_SKIP'] ?? '').split(',').map((x) => x.trim()).filter(Boolean));
}
export const SKIP_REASON = 'disabled by PD_HEALTH_SKIP';
