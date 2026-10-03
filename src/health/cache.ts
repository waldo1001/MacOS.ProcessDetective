import fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HealthFinding, HealthVitals } from '../types.js';

export interface CacheEntry {
  at: number;
  durationMs: number;
  findings: HealthFinding[];
  vitals?: Partial<HealthVitals>;
  /** Per-part skips of the run that produced this entry (kept so a cached survey never hides them). */
  skipped?: { id: string; reason: string }[];
}

/** A cached check's last failed run (timeout, error, a prompt nobody answered). */
export interface CacheFailure {
  at: number;
  reason: string;
}

export interface HealthCacheStore {
  get(id: string): CacheEntry | undefined;
  set(id: string, e: CacheEntry): void;       // schedules a flush
  /** Last failed run of a cached check; the engine backs off from re-running it for a while. */
  getFailure(id: string): CacheFailure | undefined;
  setFailure(id: string, f: CacheFailure | null): void;
  lastFullScanAt: number | null;
  flush(): Promise<void>;
}

/** `<PD_DATA_DIR ?? ~/Library/Application Support/ProcessDetective>/health-cache.json` */
export function healthCachePath(): string {
  const dir =
    process.env['PD_DATA_DIR'] ?? path.join(os.homedir(), 'Library', 'Application Support', 'ProcessDetective');
  return path.join(dir, 'health-cache.json');
}

/** In-memory store for tests. */
export function memoryCache(): HealthCacheStore {
  const entries = new Map<string, CacheEntry>();
  const failures = new Map<string, CacheFailure>();
  return {
    get: (id) => entries.get(id),
    set: (id, e) => void entries.set(id, e),
    getFailure: (id) => failures.get(id),
    setFailure: (id, f) => void (f ? failures.set(id, f) : failures.delete(id)),
    lastFullScanAt: null,
    flush: async () => {},
  };
}

interface CacheFile {
  version: 1;
  lastFullScanAt: number | null;
  entries: Record<string, CacheEntry>;
  failures: Record<string, CacheFailure>;
}

/**
 * Parse the cache file text. A missing, corrupt or foreign file yields an empty cache, and
 * individual entries that do not look like cache entries are dropped, so a damaged file
 * can never make a report throw.
 */
export function parseCacheFile(text: string | null): CacheFile {
  const empty: CacheFile = { version: 1, lastFullScanAt: null, entries: {}, failures: {} };
  if (text === null) return empty;
  try {
    const parsed = JSON.parse(text) as Partial<CacheFile> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return empty;
    const entries: Record<string, CacheEntry> = {};
    for (const [id, e] of Object.entries(parsed.entries)) {
      if (e && typeof e.at === 'number' && Array.isArray(e.findings)) entries[id] = e;
    }
    const failures: Record<string, CacheFailure> = {};
    for (const [id, f] of Object.entries(typeof parsed.failures === 'object' && parsed.failures !== null ? parsed.failures : {})) {
      if (f && typeof f.at === 'number' && typeof f.reason === 'string') failures[id] = f;
    }
    return {
      version: 1,
      lastFullScanAt: typeof parsed.lastFullScanAt === 'number' ? parsed.lastFullScanAt : null,
      entries,
      failures,
    };
  } catch {
    return empty;
  }
}

function loadFile(file: string): CacheFile {
  try {
    return parseCacheFile(readFileSync(file, 'utf8'));
  } catch {
    return parseCacheFile(null); // missing or unreadable: start cold
  }
}

/**
 * JSON file store. Loads once, tolerates a missing/corrupt file. Writes are atomic
 * (tmp + rename), serialised through one promise chain, and never throw — a
 * read-only data dir just means no cache. This file is the only thing the health
 * check writes.
 */
export function fileCache(file: string): HealthCacheStore {
  const data = loadFile(file);
  let chain: Promise<void> = Promise.resolve();
  let dirty = false;

  const writeOnce = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
      await fsp.rename(tmp, file);
    } catch {
      /* read-only dir etc.: degrade to no cache */
    }
  };
  const schedule = (): void => {
    dirty = true;
    chain = chain.then(writeOnce);
  };

  return {
    get: (id) => data.entries[id],
    set: (id, e) => {
      data.entries[id] = e;
      schedule();
    },
    getFailure: (id) => data.failures[id],
    setFailure: (id, f) => {
      if (f) data.failures[id] = f;
      else delete data.failures[id];
      schedule();
    },
    get lastFullScanAt() {
      return data.lastFullScanAt;
    },
    set lastFullScanAt(v: number | null) {
      data.lastFullScanAt = v;
      schedule();
    },
    flush: () => chain,
  };
}

const defaults = new Map<string, HealthCacheStore>();

/** The process-wide store for the current data dir (one instance, so server requests share state). */
export function defaultCache(): HealthCacheStore {
  const p = healthCachePath();
  let c = defaults.get(p);
  if (!c) {
    c = fileCache(p);
    defaults.set(p, c);
  }
  return c;
}
