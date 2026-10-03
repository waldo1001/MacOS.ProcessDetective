import type { HealthCheck, HealthContext, CheckResult } from './context.js';
import { runPool } from './util.js';
import { memoryPressureCheck } from './checks/memory-pressure.js';
import { diskSpaceCheck } from './checks/disk-space.js';
import { thermalCheck } from './checks/thermal.js';
import { batteryCheck } from './checks/battery.js';
import { uptimeLoadCheck } from './checks/uptime-load.js';
import { crashes7dCheck } from './checks/crashes-7d.js';
import { runawayLogsCheck } from './checks/runaway-logs.js';
import { apfsSnapshotsCheck } from './checks/apfs-snapshots.js';
import { launchAgentsCheck } from './checks/launch-agents.js';
import { duplicateHelpersCheck } from './checks/duplicate-helpers.js';
import { nodeInstallsCheck } from './checks/node-installs.js';
import { loginItemsCheck } from './checks/login-items.js';
import { softwareUpdateCheck } from './checks/software-update.js';
import { timeMachineCheck } from './checks/time-machine.js';
import { brewCheck } from './checks/brew.js';
import { diskClutterCheck } from './checks/disk-clutter.js';

export { runPool };

export const ALL_CHECKS: HealthCheck[] = [
  // fresh on every request
  memoryPressureCheck, diskSpaceCheck, thermalCheck, batteryCheck, uptimeLoadCheck, crashes7dCheck,
  runawayLogsCheck, apfsSnapshotsCheck, launchAgentsCheck, duplicateHelpersCheck, nodeInstallsCheck,
  // cached (slow): refreshed in the background
  loginItemsCheck, softwareUpdateCheck, timeMachineCheck, brewCheck,
  // full scan only
  diskClutterCheck,
];

export interface CheckRun {
  result: CheckResult | null;
  skipped: string | null;
  durationMs: number;
}

/**
 * Run one check with a timeout. Never throws: a rejection or a timeout becomes a
 * `skipped` reason. Every subprocess a check starts has its own, shorter timeout,
 * so nothing keeps running after the race is lost.
 */
export async function runCheck(
  check: HealthCheck,
  ctx: HealthContext,
  onProgress?: (current: string) => void,
): Promise<CheckRun> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), check.timeoutMs);
  });
  try {
    const raced = await Promise.race([check.run(ctx, onProgress), timeout]);
    if (raced === 'timeout') {
      return { result: null, skipped: `timed out after ${Math.round(check.timeoutMs / 1000)} s`, durationMs: Date.now() - t0 };
    }
    return { result: raced, skipped: null, durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      result: null,
      skipped: `failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
  }
}
