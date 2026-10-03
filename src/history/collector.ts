/**
 * Runtime history collector: timer-driven, file I/O, lockfile management.
 * Wraps src/history/store.ts pure functions with actual side effects.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectSystem } from '../collect/system.js';
import {
  type HistorySample,
  dayFileName,
  encodeSample,
  parseJsonl,
  prunable,
  filterSince,
  downsample,
  RANGES,
} from './store.js';

// ---------- config ----------

export interface HistoryConfig {
  dataDir: string;
  intervalMs: number;
  retentionDays: number;
}

function defaultDataDir(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'ProcessDetective',
    'history',
  );
}

export function resolveConfig(overrides?: Partial<HistoryConfig>): HistoryConfig {
  const dataDir =
    overrides?.dataDir ??
    process.env['PD_DATA_DIR'] ??
    defaultDataDir();

  const intervalMs =
    overrides?.intervalMs ??
    (process.env['PD_HISTORY_INTERVAL_MS']
      ? parseInt(process.env['PD_HISTORY_INTERVAL_MS']!, 10)
      : 15_000);

  const retentionDays =
    overrides?.retentionDays ??
    (process.env['PD_HISTORY_RETENTION_DAYS']
      ? parseInt(process.env['PD_HISTORY_RETENTION_DAYS']!, 10)
      : 14);

  return { dataDir, intervalMs, retentionDays };
}

// ---------- HistoryStore ----------

export class HistoryStore {
  private cfg: HistoryConfig;
  private samples: HistorySample[] = [];
  private maxSamples: number;
  private writerMode = false;
  private currentFile: string | null = null;
  private currentDay: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private diskErrorLogged = false;

  constructor(cfg?: Partial<HistoryConfig>) {
    this.cfg = resolveConfig(cfg);
    // Cap in-memory buffer: retention window + 10% slack
    this.maxSamples =
      Math.ceil((this.cfg.retentionDays * 24 * 60 * 60 * 1000) / this.cfg.intervalMs) +
      Math.ceil(0.1 * (this.cfg.retentionDays * 24 * 60 * 60 * 1000) / this.cfg.intervalMs);
  }

  get config(): HistoryConfig {
    return this.cfg;
  }

  get isWriter(): boolean {
    return this.writerMode;
  }

  /** Start the collector: acquire lock, load history from disk, start timer. */
  async start(): Promise<void> {
    try {
      await fsp.mkdir(this.cfg.dataDir, { recursive: true });
    } catch (err) {
      this.logDiskError('mkdir', err);
    }

    // Acquire writer lock
    const lockPath = path.join(this.cfg.dataDir, '.writer.lock');
    this.writerMode = await this.acquireLock(lockPath);

    // Release the lock on real exit. CRITICAL: the SIGINT/SIGTERM handlers must
    // actually terminate — a bare listener overrides Node's default "exit on
    // signal" behavior and leaves the process unkillable (the collection timer
    // keeps the event loop alive). So they call process.exit(), which fires the
    // 'exit' handler that releases the lock.
    if (this.writerMode) {
      process.on('exit', () => this.releaseLock(lockPath));
    }
    const onSignal = (): void => process.exit(0);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // Load existing history
    await this.loadHistory();

    // Prune expired files
    if (this.writerMode) {
      await this.pruneOldFiles();
    }

    // Start the collection timer
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.intervalMs);

    const approxMbPerDay =
      ((24 * 60 * 60 * 1000) / this.cfg.intervalMs) * 110 / (1024 * 1024);
    const totalMb = approxMbPerDay * this.cfg.retentionDays;
    console.log(
      `[history] ${this.writerMode ? 'writer' : 'read-only'} · ` +
        `dir=${this.cfg.dataDir} · ` +
        `cadence=${this.cfg.intervalMs / 1000}s · ` +
        `retention=${this.cfg.retentionDays}d · ` +
        `bound≈${totalMb.toFixed(1)} MB · ` +
        `samples-in-mem=${this.samples.length}`,
    );
  }

  /** Stop the timer. Does not release the lockfile (handled by process exit handlers). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Close any open file stream (the append path uses appendFile, not a stream)
  }

  /**
   * Return downsampled samples, optionally filtered by sinceMs.
   * @param sinceMs - filter to samples at or after this epoch ms. If null, return all.
   * @param maxPoints - max number of samples to return (default 600, clamped 50–2000).
   */
  getSamples(sinceMs?: number | null, maxPoints = 600): HistorySample[] {
    const clampedMax = Math.max(50, Math.min(2000, maxPoints));
    let result = this.samples;
    if (sinceMs != null) {
      result = filterSince(result, sinceMs);
    }
    return downsample(result, clampedMax);
  }

  // ---------- internal ----------

  private async tick(): Promise<void> {
    let sys: Awaited<ReturnType<typeof collectSystem>>;
    try {
      sys = await collectSystem();
    } catch {
      return; // don't crash the timer
    }

    const sample: HistorySample = {
      t:       sys.at,
      cpu:     sys.cpu.usagePct,
      cpuUser: sys.cpu.user,
      mem:     sys.memory.usedPct,
      netRx:   sys.network.rxBytesPerSec,
      netTx:   sys.network.txBytesPerSec,
      diskR:   sys.disk.readBytesPerSec,
      diskW:   sys.disk.writeBytesPerSec,
      load:    sys.cpu.loadAvg[0],
    };

    // Day rollover check
    const nowDate = new Date(sample.t);
    const todayKey = dayFileName(nowDate);
    if (todayKey !== this.currentDay) {
      this.currentDay = todayKey;
      this.currentFile = path.join(this.cfg.dataDir, todayKey);
      if (this.writerMode) {
        await this.pruneOldFiles();
      }
    }

    // Push to in-memory buffer (bounded)
    this.samples.push(sample);
    while (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    // Append to disk (writer only)
    if (this.writerMode && this.currentFile) {
      try {
        await fsp.appendFile(this.currentFile, encodeSample(sample) + '\n', 'utf8');
      } catch (err) {
        if (!this.diskErrorLogged) {
          console.error('[history] disk write error (continuing in-memory):', err);
          this.diskErrorLogged = true;
        }
      }
    }
  }

  private async loadHistory(): Promise<void> {
    const sinceMs = Date.now() - this.cfg.retentionDays * 24 * 60 * 60 * 1000;
    let files: string[];
    try {
      const entries = await fsp.readdir(this.cfg.dataDir);
      files = entries
        .filter((f) => /^history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch {
      return;
    }

    const all: HistorySample[] = [];
    for (const f of files) {
      try {
        const text = await fsp.readFile(path.join(this.cfg.dataDir, f), 'utf8');
        const parsed = parseJsonl(text);
        all.push(...parsed);
      } catch {
        // corrupt or unreadable file — skip
      }
    }

    // Filter to retention window and cap
    this.samples = filterSince(all, sinceMs);
    while (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    // Prime the current day/file
    const nowDate = new Date();
    this.currentDay = dayFileName(nowDate);
    this.currentFile = path.join(this.cfg.dataDir, this.currentDay);
  }

  private async pruneOldFiles(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.cfg.dataDir);
      const jsonlFiles = entries.filter((f) =>
        /^history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f),
      );
      const toDelete = prunable(jsonlFiles, new Date(), this.cfg.retentionDays);
      for (const f of toDelete) {
        try {
          await fsp.unlink(path.join(this.cfg.dataDir, f));
          console.log(`[history] pruned ${f}`);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore readdir errors
    }
  }

  private async acquireLock(lockPath: string): Promise<boolean> {
    // Try to read an existing lock
    try {
      const existing = await fsp.readFile(lockPath, 'utf8');
      const existingPid = parseInt(existing.trim(), 10);
      if (existingPid && existingPid !== process.pid) {
        // Check if that pid is still alive
        try {
          process.kill(existingPid, 0);
          // Process is alive → run read-only
          console.log(
            `[history] lock held by PID ${existingPid} — running read-only`,
          );
          return false;
        } catch {
          // Process is dead → take the lock
        }
      }
    } catch {
      // No lock file or unreadable → proceed to write
    }

    // Write our PID
    try {
      await fsp.writeFile(lockPath, String(process.pid), 'utf8');
      return true;
    } catch (err) {
      this.logDiskError('write-lock', err);
      return false;
    }
  }

  private releaseLock(lockPath: string): void {
    try {
      // Only remove the lock if it's still ours
      const content = fs.readFileSync(lockPath, 'utf8');
      if (parseInt(content.trim(), 10) === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // ignore
    }
  }

  private logDiskError(ctx: string, err: unknown): void {
    console.error(`[history] ${ctx} error:`, err);
  }
}

/** Convenience: build + start a HistoryStore from partial config. */
export async function startHistoryStore(
  cfg?: Partial<HistoryConfig>,
): Promise<HistoryStore> {
  const store = new HistoryStore(cfg);
  await store.start();
  return store;
}

// Re-export for consumers
export { RANGES };
