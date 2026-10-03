import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import { thinSnapshotsSteps } from '../manual.js';
import { clockText, evidence, plural } from '../util.js';

export interface LocalSnapshots {
  count: number;
  names: string[];
  /** Time of the newest snapshot (parsed from the `…YYYY-MM-DD-HHMMSS.local` name), local time. */
  newestAt: number | null;
}

/** Parse `tmutil listlocalsnapshots /`. */
export function parseLocalSnapshots(text: string): LocalSnapshots {
  const names = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('com.apple.TimeMachine.'));
  let newestAt: number | null = null;
  for (const n of names) {
    const m = n.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!m) continue;
    const t = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
    if (newestAt === null || t > newestAt) newestAt = t;
  }
  return { count: names.length, names, newestAt };
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const r = await ctx.run('/usr/bin/tmutil', ['listlocalsnapshots', '/'], 5000);
  if (r.failed && !r.stdout.trim()) throw new Error(`tmutil listlocalsnapshots failed: ${r.stderr.trim().split('\n')[0] ?? 'no output'}`);
  const s = parseLocalSnapshots(r.stdout);
  const vitals = { localSnapshots: s.count };
  if (s.count === 0) return { findings: [], vitals };

  const newest = s.newestAt ? ` Newest: ${clockText(s.newestAt)}.` : '';
  return {
    findings: [
      {
        id: 'apfs-snapshots',
        checkId: 'apfs-snapshots',
        category: 'backup',
        severity: 'advice',
        title: `${plural(s.count, 'local snapshot')} — deleted files stay allocated until ${s.count === 1 ? 'it thins' : 'they thin'}`,
        detail: `APFS local Time Machine snapshots hold on to files you deleted, so free space (\`df\`) does not move after a clean-up until the snapshots thin out.${newest}`,
        evidence: [evidence('tmutil listlocalsnapshots /', r.stdout)],
        safety: 'manual',
        manualSteps: thinSnapshotsSteps(),
        actionId: 'thin-snapshots',
      },
    ],
    vitals,
  };
}

export const apfsSnapshotsCheck: HealthCheck = {
  id: 'apfs-snapshots',
  category: 'backup',
  scope: 'quick',
  timeoutMs: 7000,
  run,
};
