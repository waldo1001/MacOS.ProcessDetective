import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { run } from '../util/exec.js';
import type { ContainerCpu, ContainerSummary, DockerSnapshot, DockerStatsSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// findDocker — locates the docker CLI without depending on shell PATH
// ---------------------------------------------------------------------------

const FALLBACK_PATHS = [
  `${homedir()}/.orbstack/bin/docker`,
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
];

let _cachedPath: string | null | undefined = undefined; // undefined = not yet resolved

/**
 * Find the docker CLI. First tries `command -v docker`, then absolute fallback
 * paths. Returns null if docker is unavailable. Result is cached after the first
 * call (pure-ish: performs fs checks).
 */
export function findDocker(): string | null {
  if (_cachedPath !== undefined) return _cachedPath;

  // Check fallback absolute paths (fs check, no subprocess needed yet)
  for (const p of FALLBACK_PATHS) {
    if (existsSync(p)) {
      _cachedPath = p;
      return _cachedPath;
    }
  }

  // Also accept 'docker' if it happens to be on the PATH embedded in this process
  const pathDirs = (process.env.PATH ?? '').split(':');
  for (const dir of pathDirs) {
    const candidate = `${dir}/docker`;
    if (candidate !== '/docker' && existsSync(candidate)) {
      _cachedPath = candidate;
      return _cachedPath;
    }
  }

  _cachedPath = null;
  return null;
}

// Exported for unit tests only
export function _resetDockerPathCache(): void {
  _cachedPath = undefined;
}

// ---------------------------------------------------------------------------
// parseRunningFor — best-effort seconds from docker's human-readable strings
// ---------------------------------------------------------------------------

/**
 * Parse a docker "RunningFor" or "Status" field into seconds.
 * Tolerates: "Less than a second ago", "N seconds ago", "About a minute ago",
 * "N minutes ago", "About an hour ago", "N hours ago", "N days ago",
 * and the "Up …" prefix variants from the Status field.
 *
 * Returns null when the string cannot be parsed.
 */
export function parseRunningFor(s: string): number | null {
  if (!s) return null;

  // Strip leading "Up " (from Status field like "Up 2 seconds")
  let str = s.replace(/^Up\s+/i, '').trim();
  // Strip trailing " ago" if present
  str = str.replace(/\s+ago\s*$/i, '').trim();

  // "Less than a second"
  if (/^less than a second$/i.test(str)) return 0;

  // "About a minute"
  if (/^about a minute$/i.test(str)) return 60;

  // "About an hour"
  if (/^about an hour$/i.test(str)) return 3600;

  // "N second(s)"
  const secM = str.match(/^(\d+)\s+seconds?$/i);
  if (secM) return parseInt(secM[1]!, 10);

  // "N minute(s)"
  const minM = str.match(/^(\d+)\s+minutes?$/i);
  if (minM) return parseInt(minM[1]!, 10) * 60;

  // "N hour(s)"
  const hrM = str.match(/^(\d+)\s+hours?$/i);
  if (hrM) return parseInt(hrM[1]!, 10) * 3600;

  // "N day(s)"
  const dayM = str.match(/^(\d+)\s+days?$/i);
  if (dayM) return parseInt(dayM[1]!, 10) * 86400;

  return null;
}

// ---------------------------------------------------------------------------
// parseDockerPs — PURE parser for docker ps --format '{{json .}}' output
// ---------------------------------------------------------------------------

/**
 * Parse NDJSON output of `docker ps --format '{{json .}}'` into a DockerSnapshot.
 * Skips malformed lines. Never throws.
 */
export function parseDockerPs(stdout: string): DockerSnapshot {
  const containers: ContainerSummary[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // skip malformed lines
    }

    const id = String(obj['ID'] ?? obj['Id'] ?? '');
    const name = String(obj['Names'] ?? obj['Name'] ?? '');
    const image = String(obj['Image'] ?? '');
    const status = String(obj['Status'] ?? '');
    const runningFor = String(obj['RunningFor'] ?? '');
    const labels = String(obj['Labels'] ?? '');

    if (!id) continue;

    const runningForSec = parseRunningFor(runningFor || status);
    const testcontainers = labels.includes('org.testcontainers');

    containers.push({ id, name, image, status, runningForSec, testcontainers });
  }

  if (containers.length === 0) {
    return {
      available: false,
      dockerPath: null,
      totalRunning: 0,
      byImage: [],
      recentlyStarted: 0,
      testcontainers: 0,
      note: 'no containers running',
    };
  }

  // Group by image, count, sort desc, cap at 10
  const imageCounts = new Map<string, number>();
  for (const c of containers) {
    imageCounts.set(c.image, (imageCounts.get(c.image) ?? 0) + 1);
  }
  const byImage = [...imageCounts.entries()]
    .map(([image, count]) => ({ image, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentlyStarted = containers.filter(
    (c) => c.runningForSec !== null && c.runningForSec <= 30,
  ).length;

  const testcontainersCount = containers.filter((c) => c.testcontainers).length;

  return {
    available: true,
    dockerPath: null, // filled in by dockerPs()
    totalRunning: containers.length,
    byImage,
    recentlyStarted,
    testcontainers: testcontainersCount,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// parseDockerStats — PURE parser for docker stats --no-stream output
// ---------------------------------------------------------------------------

/**
 * Parse NDJSON output of `docker stats --no-stream --format '{{json .}}'`
 * into a DockerStatsSnapshot. Skips malformed lines. Never throws.
 */
export function parseDockerStats(stdout: string): DockerStatsSnapshot {
  const cpuList: ContainerCpu[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const name = String(obj['Name'] ?? '');
    const cpuPercStr = String(obj['CPUPerc'] ?? '');
    const memUsage = String(obj['MemUsage'] ?? '');
    const pidsStr = String(obj['PIDs'] ?? '0');

    if (!name) continue;

    // "13.12%" → 13.12
    const cpuPct = parseFloat(cpuPercStr.replace('%', ''));
    if (isNaN(cpuPct)) continue;

    const pids = parseInt(pidsStr, 10) || 0;

    cpuList.push({ name, cpuPct, memUsage, pids });
  }

  if (cpuList.length === 0) {
    return { available: false, topByCpu: [], note: 'no data' };
  }

  const topByCpu = [...cpuList].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 12);

  return { available: true, topByCpu, note: null };
}

// ---------------------------------------------------------------------------
// dockerPs — async runner (fast, ~100-300ms)
// ---------------------------------------------------------------------------

/**
 * Run `docker ps --format '{{json .}}'` and return a DockerSnapshot.
 * Fast enough to run on every inspect call for container-runtime processes.
 * Never throws.
 */
export async function dockerPs(): Promise<DockerSnapshot> {
  const dockerPath = findDocker();
  if (!dockerPath) {
    return {
      available: false,
      dockerPath: null,
      totalRunning: 0,
      byImage: [],
      recentlyStarted: 0,
      testcontainers: 0,
      note: 'docker CLI not found',
    };
  }

  const res = await run(dockerPath, ['ps', '--format', '{{json .}}'], 5000);

  if (res.failed) {
    const errMsg = (res.stderr + res.stdout).trim().slice(0, 200);
    return {
      available: false,
      dockerPath,
      totalRunning: 0,
      byImage: [],
      recentlyStarted: 0,
      testcontainers: 0,
      note: errMsg || 'docker ps failed',
    };
  }

  const snapshot = parseDockerPs(res.stdout);
  snapshot.dockerPath = dockerPath;
  return snapshot;
}

// ---------------------------------------------------------------------------
// dockerStats — async runner (~1-2s, on-demand ONLY)
// ---------------------------------------------------------------------------

/**
 * Run `docker stats --no-stream --format '{{json .}}'` and return a snapshot.
 * Takes ~1-2 seconds — ONLY call this from the on-demand POST /api/docker endpoint.
 * Never on /api/inspect or any polled path.
 * Never throws.
 */
export async function dockerStats(): Promise<DockerStatsSnapshot> {
  const dockerPath = findDocker();
  if (!dockerPath) {
    return { available: false, topByCpu: [], note: 'docker CLI not found' };
  }

  const res = await run(dockerPath, ['stats', '--no-stream', '--format', '{{json .}}'], 8000);

  if (res.failed) {
    const errMsg = (res.stderr + res.stdout).trim().slice(0, 200);
    return { available: false, topByCpu: [], note: errMsg || 'docker stats failed' };
  }

  return parseDockerStats(res.stdout);
}
