import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import { evidence } from '../util.js';

export interface BatteryHealth {
  cycles: number;
  condition: string | null;
  capacityPct: number | null;
}

/**
 * Parse `system_profiler SPPowerDataType`. Returns null when there is no
 * `Cycle Count` line (a desktop Mac has no battery).
 */
export function parseBattery(text: string): BatteryHealth | null {
  const cycles = text.match(/^\s*Cycle Count:\s*(\d+)/m);
  if (!cycles) return null;
  const condition = text.match(/^\s*Condition:\s*(.+?)\s*$/m);
  const capacity = text.match(/^\s*Maximum Capacity:\s*(\d+)\s*%/m);
  return {
    cycles: parseInt(cycles[1]!, 10),
    condition: condition ? condition[1]! : null,
    capacityPct: capacity ? parseInt(capacity[1]!, 10) : null,
  };
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const r = await ctx.run('/usr/sbin/system_profiler', ['SPPowerDataType'], 8000);
  const b = parseBattery(r.stdout);
  if (!b) return { findings: [] }; // desktop Mac: no finding, vitals stay null

  const lines = r.stdout
    .split('\n')
    .filter((l) => /Cycle Count:|Condition:|Maximum Capacity:/.test(l))
    .map((l) => l.trim());
  const bad = (b.condition !== null && b.condition !== 'Normal') || (b.capacityPct !== null && b.capacityPct < 80);
  const summary = `Battery: ${b.cycles} cycles, ${b.capacityPct ?? '?'} % capacity, ${b.condition ?? 'condition unknown'}`;
  return {
    findings: [
      {
        id: 'battery',
        checkId: 'battery',
        category: 'vitals',
        severity: bad ? 'warn' : 'info',
        title: summary,
        detail: bad
          ? 'The battery is worn: macOS reports a condition other than Normal or a maximum capacity below 80 %. Runtime and peak performance on battery will be reduced; consider a battery service.'
          : 'macOS reports the battery condition as Normal.',
        evidence: [evidence('system_profiler SPPowerDataType | grep -E "Cycle Count|Condition|Maximum Capacity"', lines)],
      },
    ],
    vitals: { batteryCycles: b.cycles, batteryHealthPct: b.capacityPct },
  };
}

export const batteryCheck: HealthCheck = {
  id: 'battery',
  category: 'vitals',
  scope: 'quick',
  timeoutMs: 10_000,
  run,
};
