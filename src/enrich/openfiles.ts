import type { OpenFile } from '../types.js';

export type OpenFileClass = 'signal' | 'noise' | 'neutral';

export interface RankedOpenFile {
  file: OpenFile;
  score: number;
  cls: OpenFileClass;
  notable: boolean;
}

// ---------------------------------------------------------------------------
// classifyOpenFile — PURE, exported for unit tests
// ---------------------------------------------------------------------------

/** Data-store extensions that are always SIGNAL regardless of path. */
const SIGNAL_DATA_EXT = /\.(sqlite3?|sqlite-wal|sqlite-shm|db|realm|mdb|leveldb|ldb)$/i;

/** Extensions that are NOISE (system incidentals). */
const NOISE_EXT = /\.(loctable|strings|nib|car|ttf|otf|woff2?|icns|dylib|so|plist-cache)$/i;

/** Path fragments that mark NOISE locations. */
function isNoisePath(path: string): boolean {
  return (
    path.includes('linkd') ||
    path.includes('metadatastore') ||
    path.includes('plist-cache') || // incl. atomic-write temps like .plist-cache.aVgDOXsB
    path.includes('/Caches/') ||
    path.includes('.cache') ||
    path.includes('TemporaryItems') ||
    path.includes('/var/folders/') ||
    path.includes('/System/') ||
    path.includes('/usr/lib') ||
    path.includes('/usr/share') ||
    path.includes('/Library/Fonts') ||
    path.includes('/private/var/db/') ||
    path.includes('.framework/') ||
    path.includes('.dSYM/')
  );
}

/** Path fragments under the home dir that are SIGNAL (user content). */
function isSignalPath(path: string, home: string): boolean {
  if (!path.startsWith(home)) return false;
  const rel = path.slice(home.length);
  return (
    rel.includes('/Library/Shortcuts/') ||
    rel.includes('/Library/Application Support/') ||
    rel.includes('/Library/Containers/') ||
    rel.includes('/Library/Messages/') ||
    rel.includes('/Library/Mail/') ||
    rel.startsWith('/Documents/') ||
    rel.startsWith('/Desktop/') ||
    rel.startsWith('/Developer/') ||
    rel.startsWith('/Projects/') ||
    rel.startsWith('/src/') ||
    rel.startsWith('/code/') ||
    rel.startsWith('/SourceCode/')
  );
}

/** User log files under home dir (not system paths). */
function isSignalLog(path: string, home: string): boolean {
  return (
    /\.log$/i.test(path) &&
    path.startsWith(home) &&
    !path.includes('/System/') &&
    !path.includes('/usr/')
  );
}

/**
 * Classify a file path as 'signal', 'noise', or 'neutral'.
 *
 * Order of checks (per spec):
 *   1. SIGNAL by data-extension (wins even under Caches)
 *   2. NOISE by extension
 *   3. NOISE by path
 *   4. SIGNAL by path (user content dirs)
 *   5. SIGNAL by log extension under home
 *   6. neutral
 */
export function classifyOpenFile(path: string, home: string): OpenFileClass {
  // 1. Data-store extension → always SIGNAL
  if (SIGNAL_DATA_EXT.test(path)) return 'signal';

  // 2. Noise extension
  if (NOISE_EXT.test(path)) return 'noise';

  // 3. Noise path fragments
  if (isNoisePath(path)) return 'noise';

  // 4. Signal by user-content path
  if (isSignalPath(path, home)) return 'signal';

  // 5. Signal by log extension under home
  if (isSignalLog(path, home)) return 'signal';

  return 'neutral';
}

// ---------------------------------------------------------------------------
// rankOpenFiles — PURE, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Score and sort open files by signal/noise classification.
 *
 * Scoring:
 *   signal   → +2
 *   neutral  → 0
 *   noise    → -1
 *   dirs     → additional -0.5 penalty (keeps real data files above dirs)
 *   sockets  → additional -0.25 penalty (keep visible but ranked below files)
 *   hotspot  → additional +3 when file.path starts with `<hotspotDir>/` for any
 *              entry in hotspotDirs (outranks an unrelated signal file — this is
 *              the fix for the misdiagnosis this tool once caused).
 *
 * Stable-sorts by score desc, preserving original order within equal scores.
 * Sets `notable:true` on the single highest-scoring file when its class is 'signal'.
 * If nothing is 'signal', no file is notable.
 */
export function rankOpenFiles(
  files: OpenFile[],
  home: string,
  hotspotDirs: string[] = [],
): RankedOpenFile[] {
  const scored: RankedOpenFile[] = files.map((file) => {
    const cls = classifyOpenFile(file.path, home);
    let score = cls === 'signal' ? 2 : cls === 'noise' ? -1 : 0;
    if (file.type === 'dir') score -= 0.5;
    if (file.type === 'socket') score -= 0.25;
    if (hotspotDirs.some((dir) => file.path.startsWith(`${dir}/`))) score += 3;
    return { file, score, cls, notable: false };
  });

  // Stable sort by score desc (Array.sort is stable in modern JS/Node)
  scored.sort((a, b) => b.score - a.score);

  // Mark the single highest-scoring signal file as notable
  const topSignal = scored.find((r) => r.cls === 'signal');
  if (topSignal) topSignal.notable = true;

  return scored;
}
