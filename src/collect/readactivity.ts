import { dirname } from 'node:path';
import { run } from '../util/exec.js';
import type { ReadActivitySnapshot } from '../types.js';

/** PURE. Parse `lsof -o -p <pid>` stdout into fd-key → offset string. */
export function parseLsofOffsets(stdout: string): Map<string, { offset: string; path: string }> {
  const result = new Map<string, { offset: string; path: string }>();

  for (const line of stdout.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue;
    // With -o, columns are: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;

    const fd = cols[3]!;
    const typeCol = cols[4]!.toUpperCase();
    if (typeCol !== 'REG') continue;

    const offset = cols[6]!;
    const path = cols.slice(8).join(' ').trim();
    if (!path) continue;

    const key = `${fd}:${path}`;
    result.set(key, { offset, path });
  }

  return result;
}

/** Longest common directory prefix across paths; null when fewer than 3 segments shared. */
function longestCommonDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const dirs = paths.map((p) => dirname(p).split('/'));
  const first = dirs[0]!;
  let common = first;
  for (const d of dirs.slice(1)) {
    const next: string[] = [];
    for (let i = 0; i < Math.min(common.length, d.length); i++) {
      if (common[i] !== d[i]) break;
      next.push(common[i]!);
    }
    common = next;
    if (common.length === 0) break;
  }
  const dir = common.join('/');
  const segs = dir.split('/').filter(Boolean).length;
  return segs >= 3 ? dir : null;
}

/** PURE. Diff two offset snapshots and produce the result fields (excluding availability). */
export function diffOffsets(
  before: Map<string, { offset: string; path: string }>,
  after: Map<string, { offset: string; path: string }>,
  gapMs: number,
): ReadActivitySnapshot {
  const beforeKeys = new Set(before.keys());
  const afterKeys = new Set(after.keys());

  const addedKeys = [...afterKeys].filter((k) => !beforeKeys.has(k));
  const removedKeys = [...beforeKeys].filter((k) => !afterKeys.has(k));
  const advancedKeys = [...afterKeys].filter(
    (k) => beforeKeys.has(k) && before.get(k)!.offset !== after.get(k)!.offset,
  );

  const fdsAdded = addedKeys.length;
  const fdsRemoved = removedKeys.length;
  const offsetsAdvanced = advancedKeys.length;

  const sampleAdded = addedKeys
    .map((k) => after.get(k)!.path)
    .sort()
    .slice(0, 3);

  const unionPaths = [
    ...new Set([
      ...addedKeys.map((k) => after.get(k)!.path),
      ...advancedKeys.map((k) => after.get(k)!.path),
    ]),
  ];
  const commonDir = longestCommonDir(unionPaths);

  let verdict: string;
  if (fdsAdded + fdsRemoved >= 3) {
    verdict = 'churning file handles — actively streaming through many files';
  } else if (offsetsAdvanced >= 1) {
    verdict = 'actively reading — file offsets are advancing';
  } else if (fdsAdded + fdsRemoved >= 1) {
    verdict = 'some file activity — a few descriptors changed';
  } else {
    verdict = 'file descriptors idle over this window';
  }

  return {
    available: true,
    gapMs,
    fdsBefore: before.size,
    fdsAfter: after.size,
    fdsAdded,
    fdsRemoved,
    offsetsAdvanced,
    sampleAdded,
    commonDir,
    verdict,
    note: null,
  };
}

/** Take two `lsof -o` snapshots gapMs apart and diff them. Never throws. */
export async function getReadActivity(pid: number, gapMs = 1500): Promise<ReadActivitySnapshot> {
  const clampedGap = Math.max(500, Math.min(3000, gapMs));

  const t0 = Date.now();
  const before = await run('lsof', ['-o', '-p', String(pid)], 5000);
  await new Promise((resolve) => setTimeout(resolve, clampedGap));
  const after = await run('lsof', ['-o', '-p', String(pid)], 5000);
  const measuredGap = Date.now() - t0;

  if (!before.stdout || !after.stdout) {
    return {
      available: false,
      gapMs: measuredGap,
      fdsBefore: 0,
      fdsAfter: 0,
      fdsAdded: 0,
      fdsRemoved: 0,
      offsetsAdvanced: 0,
      sampleAdded: [],
      commonDir: null,
      verdict: 'unknown',
      note: 'lsof returned no output (process gone or access restricted)',
    };
  }

  const beforeMap = parseLsofOffsets(before.stdout);
  const afterMap = parseLsofOffsets(after.stdout);
  return diffOffsets(beforeMap, afterMap, measuredGap);
}
