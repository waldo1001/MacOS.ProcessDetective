import { existsSync } from 'node:fs';
import os from 'node:os';
import { run } from '../util/exec.js';
import { collectSystem, type SystemStats } from '../collect/system.js';
import { collectProcesses } from '../collect/ps.js';
import { getRecentCrashes } from '../collect/crashes.js';
import type { CrashGroup, HealthCategory, HealthFinding, HealthVitals, RawProcess } from '../types.js';

/**
 * Everything a check may touch. One instance is built per request and shared by
 * all checks, so the machine is sampled once; `run`, `exists` and `crashes` are
 * injectable so every check is unit-testable without a shell.
 */
export interface HealthContext {
  home: string;                   // os.homedir()
  uid: number;                    // process.getuid()
  now: number;
  system: SystemStats;            // ONE collectSystem() call shared by all checks
  processes: RawProcess[];        // ONE collectProcesses() call
  run: typeof run;                // every subprocess goes through this
  exists(p: string): boolean;     // fs.existsSync
  crashes(windowMs: number): Promise<CrashGroup[]>;   // getRecentCrashes
}

export interface CheckResult {
  findings: HealthFinding[];
  vitals?: Partial<HealthVitals>;
  /** Per-part skips the check chose to report (e.g. one clutter entry without permission). */
  skipped?: { id: string; reason: string }[];
}

export interface HealthCheck {
  id: string;
  category: HealthCategory;
  scope: 'quick' | 'full';        // 'full' checks run only inside a full scan
  ttlMs?: number;                 // quick + ttlMs = "cached check": served from cache, refreshed in background
  /**
   * On-demand check: it needs the user at the keyboard (macOS raises a Touch ID /
   * password dialog), so it NEVER runs on its own — not on a quick request, not in
   * the background, not in a full scan. It runs only when explicitly included, and
   * its last result is served from the cache.
   */
  optIn?: { label: string; note: string };
  timeoutMs: number;
  run(ctx: HealthContext, onProgress?: (current: string) => void): Promise<CheckResult>;
}

/** Build the shared context: ONE system sample + ONE process listing. */
export async function makeContext(): Promise<HealthContext> {
  const [system, processes] = await Promise.all([collectSystem(), collectProcesses()]);
  return {
    home: os.homedir(),
    uid: process.getuid?.() ?? -1,
    now: Date.now(),
    system,
    processes,
    run,
    exists: (p) => existsSync(p),
    crashes: (windowMs) => getRecentCrashes(windowMs),
  };
}
