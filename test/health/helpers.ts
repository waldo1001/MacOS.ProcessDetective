import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthContext } from '../../src/health/context.js';
import type { SystemStats } from '../../src/collect/system.js';
import type { RunResult } from '../../src/util/exec.js';
import type { DirentLike, FsLike, StatLike } from '../../src/health/util.js';
import type { RawProcess } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read a fixture from test/fixtures/health. */
export function fixture(name: string): string {
  return readFileSync(join(__dirname, '..', 'fixtures', 'health', name), 'utf8');
}

export const NOW = new Date(2026, 9, 3, 12, 0, 0).getTime();

export function ok(stdout = '', stderr = ''): RunResult {
  return { stdout, stderr, code: 0, failed: false };
}
/** A command that failed (or timed out): non-zero exit, whatever output it managed. */
export function fail(stdout = '', stderr = ''): RunResult {
  return { stdout, stderr, code: 1, failed: true };
}

export function fakeSystem(patch: Partial<SystemStats> = {}): SystemStats {
  const base: SystemStats = {
    at: NOW,
    host: { model: 'Mac16,5', chip: 'Apple M5 Max', memBytes: 128 * 1024 ** 3, uptimeSeconds: 3600 },
    cpu: {
      usagePct: 5, user: 3, sys: 2, idle: 95, loadAvg: [1.5, 1.2, 1.1],
      cores: { total: 18, physical: 18, performance: 12, efficiency: 6 },
    },
    processes: { total: 500, running: 3, threads: 3000 },
    memory: {
      totalBytes: 128 * 1024 ** 3, usedBytes: 40 * 1024 ** 3, usedPct: 31, pressure: 'normal',
      cachedBytes: 0, segments: [], swap: { totalBytes: 0, usedBytes: 0 },
    },
    network: {
      rxBytesPerSec: 0, txBytesPerSec: 0, rxTotalBytes: 0, txTotalBytes: 0,
      connections: { established: 0, listen: 0, udp: 0 }, interfaces: [], ports: [],
    },
    disk: { readBytesPerSec: 0, writeBytesPerSec: 0, readTotalBytes: 0, writeTotalBytes: 0 },
    storage: {
      volumes: [
        {
          name: 'Macintosh HD', mount: '/', totalBytes: 2000 * 1e9, usedBytes: 500 * 1e9, usedPct: 25,
          availBytes: 1400 * 1e9,
        },
      ],
    },
    server: { rssBytes: 0, uptimeSeconds: 0 },
    power: { hasBattery: true, batteryPct: 80, charging: false, source: 'Battery Power', thermalNominal: true },
  };
  return { ...base, ...patch };
}

export interface FakeOpts extends Partial<Omit<HealthContext, 'system'>> {
  system?: Partial<SystemStats>;
  memory?: Partial<SystemStats['memory']>;
}

/** A HealthContext that touches nothing: every command succeeds with empty output unless overridden. */
export function fakeContext(o: FakeOpts = {}): HealthContext {
  const system = fakeSystem(o.system);
  if (o.memory) system.memory = { ...system.memory, ...o.memory };
  return {
    home: '/Users/test',
    uid: 501,
    now: NOW,
    system,
    processes: [],
    run: async () => ok(),
    exists: () => true,
    crashes: async () => [],
    ...(o.home !== undefined ? { home: o.home } : {}),
    ...(o.uid !== undefined ? { uid: o.uid } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.processes ? { processes: o.processes } : {}),
    ...(o.run ? { run: o.run } : {}),
    ...(o.exists ? { exists: o.exists } : {}),
    ...(o.crashes ? { crashes: o.crashes } : {}),
  };
}

export type Handler = [match: string | RegExp, result: RunResult | ((cmd: string, args: string[]) => RunResult)];

/** Build a fake `run`: the first handler whose pattern matches "cmd arg arg…" answers; unmatched commands fail. */
export function scriptedRun(handlers: Handler[]): HealthContext['run'] & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: string[] = []) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    for (const [m, r] of handlers) {
      if (typeof m === 'string' ? line.includes(m) : m.test(line)) return typeof r === 'function' ? r(cmd, args) : r;
    }
    return fail('', `unexpected command: ${line}`);
  }) as HealthContext['run'] & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function proc(p: Partial<RawProcess> & { pid: number }): RawProcess {
  return {
    ppid: 100, cpu: 0, mem: 0.1, elapsedSeconds: 7200, elapsedRaw: '02:00:00', user: 'test',
    execPath: '/usr/local/bin/node', name: 'node', command: 'node /srv/app.js', ...p,
  };
}

// ---------------------------------------------------------------------------
// A tiny in-memory filesystem for the checks that read through FsLike
// ---------------------------------------------------------------------------

export interface FakeNode {
  kind: 'file' | 'dir' | 'symlink';
  blocks?: number;      // 512-byte blocks (on-disk size)
  mtimeMs?: number;
  children?: string[];  // dir entries
  content?: string;     // file text
}

export function fakeFs(tree: Record<string, FakeNode>): FsLike {
  const stat = (p: string): StatLike => {
    const n = tree[p];
    if (!n) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return {
      isFile: () => n.kind === 'file',
      isDirectory: () => n.kind === 'dir',
      isSymbolicLink: () => n.kind === 'symlink',
      size: (n.blocks ?? 0) * 512,
      blocks: n.blocks ?? 0,
      mtimeMs: n.mtimeMs ?? NOW - 86_400_000,
    };
  };
  return {
    lstat: async (p) => stat(p),
    readdir: async (p): Promise<DirentLike[]> => {
      const n = tree[p];
      if (!n || n.kind !== 'dir') throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return (n.children ?? []).map((name) => {
        const c = tree[`${p}/${name}`];
        return {
          name,
          isFile: () => c?.kind === 'file',
          isDirectory: () => c?.kind === 'dir',
          isSymbolicLink: () => c?.kind === 'symlink',
        };
      });
    },
    realpath: async (p) => p,
    readFile: async (p) => {
      const n = tree[p];
      if (!n || n.kind !== 'file') throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return n.content ?? '';
    },
  };
}
