import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import { evidence } from '../util.js';

export interface ThermStatus {
  cpuSpeedLimit: number | null;
  cpuSchedulerLimit: number | null;
  /** Lines that report a recorded warning level (the "Note: No …" lines are not warnings). */
  warningLines: string[];
  /** True when the CPU is being throttled or a warning level was recorded. */
  thermalWarning: boolean;
}

/**
 * Parse `pmset -g therm`. `CPU_Speed_Limit = 100` is normal (Intel Macs always
 * print it); only a value below 100 or a recorded "warning level" is a problem.
 */
export function parseTherm(text: string): ThermStatus {
  const num = (re: RegExp): number | null => {
    const m = text.match(re);
    return m ? parseInt(m[1]!, 10) : null;
  };
  const cpuSpeedLimit = num(/CPU_Speed_Limit\s*=\s*(\d+)/);
  const cpuSchedulerLimit = num(/CPU_Scheduler_Limit\s*=\s*(\d+)/);
  const warningLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /warning level/i.test(l) && !l.startsWith('Note: No '));
  const throttled =
    (cpuSpeedLimit !== null && cpuSpeedLimit < 100) || (cpuSchedulerLimit !== null && cpuSchedulerLimit < 100);
  return { cpuSpeedLimit, cpuSchedulerLimit, warningLines, thermalWarning: throttled || warningLines.length > 0 };
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const r = await ctx.run('/usr/bin/pmset', ['-g', 'therm'], 3000);
  if (!r.stdout.trim()) throw new Error('pmset -g therm printed nothing');
  const t = parseTherm(r.stdout);
  const ev = evidence('pmset -g therm', r.stdout);
  if (t.thermalWarning) {
    const limits = [
      t.cpuSpeedLimit !== null ? `CPU_Speed_Limit = ${t.cpuSpeedLimit}` : null,
      t.cpuSchedulerLimit !== null ? `CPU_Scheduler_Limit = ${t.cpuSchedulerLimit}` : null,
    ].filter(Boolean);
    return {
      findings: [
        {
          id: 'thermal',
          checkId: 'thermal',
          category: 'vitals',
          severity: 'risk',
          title: 'The Mac is thermally throttling',
          detail: `${limits.join(', ') || t.warningLines.join('; ')}. macOS is slowing the CPU to shed heat — check for a runaway process, blocked vents or a hot environment.`,
          evidence: [ev],
        },
      ],
      vitals: { thermalWarning: true },
    };
  }
  return {
    findings: [
      {
        id: 'thermal',
        checkId: 'thermal',
        category: 'vitals',
        severity: 'info',
        title: 'Thermal: no throttling, no warning recorded',
        detail: 'No CPU speed limit and no thermal warning level has been recorded since boot.',
        evidence: [ev],
      },
    ],
    vitals: { thermalWarning: false },
  };
}

export const thermalCheck: HealthCheck = {
  id: 'thermal',
  category: 'vitals',
  scope: 'quick',
  timeoutMs: 5000,
  run,
};
