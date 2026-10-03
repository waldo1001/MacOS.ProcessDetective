import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import { evidence } from '../util.js';

const DAY = 86_400;

async function run(ctx: HealthContext): Promise<CheckResult> {
  const { uptimeSeconds } = ctx.system.host;
  const vitals = {
    uptimeSec: uptimeSeconds > 0 ? uptimeSeconds : null,
    loadAvg1: ctx.system.cpu.loadAvg[0],
    processCount: ctx.system.processes.total || null,
  };
  if (uptimeSeconds <= 30 * DAY) return { findings: [], vitals };
  const days = Math.floor(uptimeSeconds / DAY);
  return {
    findings: [
      {
        id: 'uptime-load',
        checkId: 'uptime-load',
        category: 'vitals',
        severity: 'advice',
        title: `Up for ${days} days — a restart is overdue`,
        detail:
          'Long uptimes accumulate swap, leaked helper processes and pending updates that only apply on restart. Nothing is broken, but a restart is the cheapest cleanup.',
        evidence: [evidence('sysctl -n kern.boottime', `(from the system snapshot) uptime ${days} d`)],
      },
    ],
    vitals,
  };
}

export const uptimeLoadCheck: HealthCheck = {
  id: 'uptime-load',
  category: 'vitals',
  scope: 'quick',
  timeoutMs: 2000,
  run,
};
