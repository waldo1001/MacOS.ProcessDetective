import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding, HealthSeverity } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { evidence } from '../util.js';

const GIB = 1024 ** 3;

/** Parse `sysctl -n kern.memorystatus_level` (percent of memory free); null when unreadable. */
export function parseMemoryLevel(stdout: string): number | null {
  const n = parseInt(stdout.trim(), 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Severity for the memory vitals. `freePct` is the kernel's own free-memory level
 * (identical to `memory_pressure`), NOT 100 − usedPct — inactive pages count as used there.
 */
export function classifyMemory(
  pressure: string,
  swapBytes: number,
  freePct: number | null,
): { severity: HealthSeverity; why: string } {
  if (pressure === 'critical') return { severity: 'risk', why: 'memory pressure is critical' };
  if (swapBytes > 4 * GIB && freePct !== null && freePct < 10) {
    return { severity: 'risk', why: `${fmtBytes(swapBytes)} of swap in use and only ${freePct} % free` };
  }
  if (pressure === 'warning') return { severity: 'warn', why: 'memory pressure is at warning level' };
  if (swapBytes > GIB && freePct !== null && freePct < 25) {
    return { severity: 'warn', why: `${fmtBytes(swapBytes)} of swap in use and only ${freePct} % free` };
  }
  if (swapBytes > GIB) {
    return {
      severity: 'advice',
      why: 'swap in use but no pressure — normal after long uptime; a restart clears it',
    };
  }
  return { severity: 'info', why: '' };
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const r = await ctx.run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], 2000);
  const free = parseMemoryLevel(r.stdout);
  const { pressure, swap } = ctx.system.memory;
  const swapBytes = swap.usedBytes;
  const { severity, why } = classifyMemory(pressure, swapBytes, free);

  const freeText = free === null ? 'free % unknown' : `${free} % free`;
  const summary = `Memory: ${freeText}, swap ${fmtBytes(swapBytes)}, pressure ${pressure}`;
  const finding: HealthFinding = {
    id: 'memory-pressure',
    checkId: 'memory-pressure',
    category: 'vitals',
    severity,
    title: severity === 'info' ? summary : `${summary} — ${why}`,
    detail:
      severity === 'info'
        ? 'Free memory comes from the kernel level (`kern.memorystatus_level`), which is what memory_pressure reports; inactive pages are reclaimable and are not counted as used.'
        : `${why}. Free memory is the kernel level (\`kern.memorystatus_level\`), not 100 − used %.`,
    evidence: [
      evidence('sysctl -n kern.memorystatus_level', r.stdout.trim() || '(no output)'),
      evidence(
        'sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level',
        `(from the system snapshot) swap used ${fmtBytes(swapBytes)} of ${fmtBytes(swap.totalBytes)}; pressure ${pressure}`,
      ),
    ],
  };
  return {
    findings: [finding],
    vitals: {
      memFreePct: free,
      swapUsedBytes: swapBytes,
      pressure: pressure === 'unknown' ? null : pressure,
    },
  };
}

export const memoryPressureCheck: HealthCheck = {
  id: 'memory-pressure',
  category: 'vitals',
  scope: 'quick',
  timeoutMs: 4000,
  run,
};
