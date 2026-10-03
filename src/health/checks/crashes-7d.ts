import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { CrashGroup, HealthFinding } from '../../types.js';
import { ageText, evidence, plural, slug } from '../util.js';

const DAY = 86_400_000;

/** Classify one crash group: looping within the last 24 h is a risk, a repeat offender a warning. */
export function classifyCrashGroup(g: CrashGroup, now: number): 'risk' | 'warn' | null {
  if (g.looping && now - g.lastAt <= DAY) return 'risk';
  if (g.count >= 3) return 'warn';
  return null;
}

/** Turn crash groups into findings (pure). */
export function crashFindings(groups: CrashGroup[], now: number): HealthFinding[] {
  const out: HealthFinding[] = [];
  for (const g of groups) {
    const severity = classifyCrashGroup(g, now);
    if (!severity) continue;
    const when = `last ${ageText(now - g.lastAt)} ago`;
    out.push({
      id: `crashes-7d:${slug(g.process)}`,
      checkId: 'crashes-7d',
      category: 'stability',
      severity,
      title: g.looping
        ? `${g.process} is crash-looping (${plural(g.count, 'crash', 'crashes')} in 7 days, ${when})`
        : `${g.process} crashed ${plural(g.count, 'time')} in 7 days (${when})`,
      detail: g.looping
        ? `${g.process} crashed 3 or more times within 10 minutes. A crash loop burns CPU in ReportCrash and the crashing process itself; find out what restarts it.`
        : `${g.process} is a repeat offender: ${plural(g.count, 'distinct crash event')} in the last 7 days.`,
      evidence: [
        evidence('ls -lt ~/Library/Logs/DiagnosticReports /Library/Logs/DiagnosticReports', [
          `${g.process}: ${plural(g.count, 'crash event')}, first ${new Date(g.firstAt).toISOString()}, last ${new Date(g.lastAt).toISOString()}`,
        ]),
      ],
    });
  }
  return out;
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const groups = await ctx.crashes(7 * DAY);
  const total = groups.reduce((s, g) => s + g.count, 0);
  const findings = crashFindings(groups, ctx.now);
  if (findings.length === 0) {
    findings.push({
      id: 'crashes-7d',
      checkId: 'crashes-7d',
      category: 'stability',
      severity: 'info',
      title: total === 0 ? '0 crash reports in 7 days' : `${plural(total, 'crash report')} in 7 days, no repeat offender`,
      detail:
        total === 0
          ? 'No crash reports were written to the DiagnosticReports folders in the last 7 days.'
          : 'No process crashed 3 or more times, and none is looping.',
      evidence: [
        evidence(
          'ls -lt ~/Library/Logs/DiagnosticReports /Library/Logs/DiagnosticReports',
          groups.length ? groups.map((g) => `${g.process}: ${plural(g.count, 'crash event')}`) : ['(no crash reports)'],
        ),
      ],
    });
  }
  return { findings, vitals: { crashes7d: total } };
}

export const crashes7dCheck: HealthCheck = {
  id: 'crashes-7d',
  category: 'stability',
  scope: 'quick',
  timeoutMs: 5000,
  run,
};
