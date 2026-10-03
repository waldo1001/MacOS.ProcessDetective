import { dirname, basename } from 'node:path';
import { run } from '../util/exec.js';
import type { DirHotspot } from '../types.js';
import type { LsofRow } from '../collect/lsof.js';
import { classifyOpenFile } from './openfiles.js';

/** Shallow roots that never qualify as a directory hotspot. */
const SHALLOW_ROOTS = new Set([
  '/Applications',
  '/System',
  '/Library',
  '/usr',
  '/opt',
  '/private/var',
  '/private/tmp',
  '/tmp',
]);

function segmentCount(dir: string): number {
  return dir.split('/').filter(Boolean).length;
}

/** True when the walk must stop *before* including this directory. */
function isStopDir(dir: string, home: string): boolean {
  if (segmentCount(dir) < 3) return true;
  if (dir === home) return true;
  if (SHALLOW_ROOTS.has(dir)) return true;
  return false;
}

/** Lowercased extension (no dot) of a basename, or null when there is none. */
function extOf(path: string): string | null {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  if (i <= 0) return null;
  return b.slice(i + 1).toLowerCase();
}

/** Most common value in an array; ties broken alphabetically. Null on empty input. */
function dominantValue(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = -1;
  for (const [v, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

/** PURE. Group file paths by ancestor directory and return the hot ones. */
export function dirHotspots(
  paths: string[],
  home: string,
  opts?: { minFiles?: number; maxHotspots?: number },
): Omit<DirHotspot, 'sizeKb'>[] {
  const minFiles = opts?.minFiles ?? 3;
  const maxHotspots = opts?.maxHotspots ?? 3;

  // 1. Filter inputs: drop noise paths, de-duplicate.
  const survivors = [...new Set(paths.filter((p) => classifyOpenFile(p, home) !== 'noise'))];

  // 2. Count ancestors.
  const byDir = new Map<string, Set<string>>();
  for (const path of survivors) {
    let cur = dirname(path);
    while (!isStopDir(cur, home)) {
      let set = byDir.get(cur);
      if (!set) {
        set = new Set();
        byDir.set(cur, set);
      }
      set.add(path);
      const parent = dirname(cur);
      if (parent === cur) break; // safety guard against non-terminating walks
      cur = parent;
    }
  }

  // 3. Candidates.
  const candidates = [...byDir.entries()].filter(([, set]) => set.size >= minFiles);

  // 4. Sort by size desc, depth desc, path asc.
  candidates.sort(([dirA, setA], [dirB, setB]) => {
    if (setB.size !== setA.size) return setB.size - setA.size;
    const depthA = segmentCount(dirA);
    const depthB = segmentCount(dirB);
    if (depthB !== depthA) return depthB - depthA;
    return dirA < dirB ? -1 : dirA > dirB ? 1 : 0;
  });

  // 5. Collapse related branches (greedy).
  const accepted: [string, Set<string>][] = [];
  for (const entry of candidates) {
    const [dir] = entry;
    const dirSlash = `${dir}/`;
    const overlaps = accepted.some(([acceptedDir]) => {
      const acceptedSlash = `${acceptedDir}/`;
      return dirSlash.startsWith(acceptedSlash) || acceptedSlash.startsWith(dirSlash);
    });
    if (!overlaps) accepted.push(entry);
  }

  // 6. Truncate.
  const truncated = accepted.slice(0, maxHotspots);

  // 7. Compute fields.
  return truncated.map(([dir, set]) => {
    const files = [...set];
    const sampleFiles = files.map((f) => basename(f)).sort().slice(0, 3);
    const exts = files.map(extOf).filter((e): e is string => e !== null);
    return {
      dir,
      fdCount: set.size,
      sampleFiles,
      dominantExt: dominantValue(exts),
    };
  });
}

/** Runs `du -sk` for the top hotspots; returns fully-populated DirHotspots. */
export async function computeDirHotspots(rows: LsofRow[], home: string): Promise<DirHotspot[]> {
  const paths = rows.filter((r) => r.type === 'file').map((r) => r.path);
  const base = dirHotspots(paths, home);

  const sizes = await Promise.all(
    base.map(async (h, i): Promise<number | null> => {
      if (i >= 2) return null;
      const res = await run('du', ['-sk', h.dir], 1500);
      if (res.failed) return null;
      const firstToken = res.stdout.trim().split(/\s+/)[0];
      const parsed = firstToken ? parseInt(firstToken, 10) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    }),
  );

  return base.map((h, i) => ({ ...h, sizeKb: sizes[i] ?? null }));
}
