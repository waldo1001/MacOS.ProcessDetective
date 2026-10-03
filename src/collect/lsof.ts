import { run } from '../util/exec.js';
import type { OpenFile, OwnerAttribution, Port, DirHotspot } from '../types.js';
import { computeDirHotspots } from '../enrich/dirs.js';
import { attributeOwners } from '../enrich/owner.js';

/**
 * Resolve a process's current working directory via `lsof -d cwd`.
 * Returns null when restricted (no sudo) or the process is gone.
 */
export async function getCwd(pid: number): Promise<string | null> {
  const res = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (!res.stdout) return null;
  // -Fn output: records prefixed by field type; "n<path>" is the name field.
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('n')) {
      const v = line.slice(1).trim();
      if (v) return v;
    }
  }
  return null;
}

/** Count a process's open file descriptors via `lsof`. 0 when restricted. */
export async function getFdCount(pid: number): Promise<number> {
  const res = await run('lsof', ['-p', String(pid)]);
  if (!res.stdout) return 0;
  const lines = res.stdout.split('\n').filter((l) => l.trim());
  // Subtract the header row when present.
  return Math.max(0, lines.length - (lines[0]?.startsWith('COMMAND') ? 1 : 0));
}

/** Patterns that indicate library/cache paths — noise unless nothing else exists. */
const NOISE_PATTERNS = [
  /\.dylib$/,
  /\.framework\//,
  /\/usr\/lib\//,
  /\/System\/Library\//,
  /\/usr\/share\//,
];
const CACHE_PATTERNS = [/dyld_shared_cache/, /\.atlas$/];

/**
 * Return true if a path is a noisy library/system entry we should normally hide.
 */
function isNoisyPath(p: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(p));
}

/** One raw row from `lsof -p <pid>` default-format output. */
export interface LsofRow {
  fd: string;
  type: 'file' | 'dir' | 'socket';
  path: string;
}

/**
 * Parse default-format `lsof -p` stdout into typed rows.
 * Keeps EVERY row (no noise filtering, no cap) — callers filter.
 * De-duplicates on `fd:type:path`.
 */
export function parseLsofRows(stdout: string): LsofRow[] {
  const rows: LsofRow[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue;
    // lsof columns (default format):
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;

    const fd = cols[3]!;
    const typeCol = cols[4]!.toUpperCase();
    const path = cols.slice(8).join(' ').trim();
    if (!path) continue;

    let type: 'file' | 'dir' | 'socket';
    if (typeCol === 'REG') {
      type = 'file';
    } else if (typeCol === 'DIR') {
      type = 'dir';
    } else if (typeCol === 'IPV4' || typeCol === 'IPV6' || typeCol === 'UNIX') {
      type = 'socket';
    } else {
      continue;
    }

    const key = `${fd}:${type}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({ fd, type, path });
  }

  return rows;
}

/** Apply the existing noise-filter + cap-12 rules to already-parsed rows. */
function filterOpenFiles(rows: LsofRow[]): OpenFile[] {
  const interesting: OpenFile[] = [];
  const cacheEntries: OpenFile[] = [];

  for (const row of rows) {
    const { type, path: name } = row;
    const entry: OpenFile = { type, path: name };

    // Check if this is a cache/dyld entry (interesting only as fallback)
    if (CACHE_PATTERNS.some((re) => re.test(name))) {
      cacheEntries.push(entry);
      continue;
    }

    // Skip noisy system/library paths
    if (type === 'file' && isNoisyPath(name)) continue;

    interesting.push(entry);
  }

  // If we have nothing interesting, fall back to cache entries (the ReportCrash clue)
  const result = interesting.length > 0 ? interesting : cacheEntries;
  return result.slice(0, 12);
}

/**
 * List a process's interesting open files and sockets via `lsof -p`.
 * Returns ≤12 de-duplicated entries, most interesting first.
 * Degrades to an empty array on permission errors.
 */
export async function getOpenFiles(pid: number): Promise<OpenFile[]> {
  const res = await run('lsof', ['-p', String(pid)]);
  if (!res.stdout) return [];
  const rows = parseLsofRows(res.stdout);
  return filterOpenFiles(rows);
}

/** One `lsof -p` run → open files, directory hotspots and owner attribution. */
export interface OpenFileIntel {
  files: OpenFile[]; // identical to getOpenFiles() output
  hotspots: DirHotspot[]; // Part A
  owners: OwnerAttribution | null; // Part C
}

/** One `lsof -p` run → open files, directory hotspots and owner attribution. */
export async function getOpenFileIntel(pid: number, home: string): Promise<OpenFileIntel> {
  const res = await run('lsof', ['-p', String(pid)]);
  if (!res.stdout) return { files: [], hotspots: [], owners: null };

  const rows = parseLsofRows(res.stdout);
  const [files, hotspots] = await Promise.all([
    Promise.resolve(filterOpenFiles(rows)),
    computeDirHotspots(rows, home),
  ]);
  const owners = attributeOwners(rows.map((r) => r.path));

  return { files, hotspots, owners };
}

/**
 * List a process's open network endpoints via `lsof -i`. Best-effort; returns
 * an empty array when nothing is listening or access is denied.
 */
export async function getPorts(pid: number): Promise<Port[]> {
  const res = await run('lsof', ['-Pan', '-p', String(pid), '-i']);
  const seen = new Set<string>();
  const ports: Port[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue;
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const protocol = cols[7]!; // TCP / UDP
    const name = cols.slice(8).join(' '); // e.g. "127.0.0.1:5173 (LISTEN)"
    const stateMatch = name.match(/\(([A-Z]+)\)\s*$/);
    const address = name.replace(/\s*\([A-Z]+\)\s*$/, '').trim();
    const key = `${protocol} ${address} ${stateMatch?.[1] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ protocol, address, state: stateMatch?.[1] ?? null });
  }
  return ports;
}
