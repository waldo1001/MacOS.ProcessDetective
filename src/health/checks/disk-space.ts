import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthSeverity } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { evidence } from '../util.js';
import { parseDf } from '../../collect/system.js';

const GIB = 1024 ** 3;

/** Severity from the free fraction/size of the boot volume. */
export function classifyDisk(availBytes: number, totalBytes: number): HealthSeverity {
  const freePct = totalBytes > 0 ? (availBytes / totalBytes) * 100 : 100;
  if (freePct < 5 || availBytes < 10 * GIB) return 'risk';
  if (freePct < 10 || availBytes < 25 * GIB) return 'warn';
  return 'info';
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  // The shared system snapshot runs `df -k` over every mount, and one stalled network
  // mount makes that time out. Ask for `/` alone then: it never touches other volumes.
  let root = ctx.system.storage.volumes.find((v) => v.mount === '/');
  if (!root) {
    const r = await ctx.run('/bin/df', ['-k', '/'], 2500);
    root = parseDf(r.stdout).find((v) => v.mount === '/');
  }
  if (!root) throw new Error('no volume mounted at / in the df output');

  // Free space is the `Available` column; `total − used` over-reports it on APFS
  // because the sealed system volume's "used" excludes the Data volume.
  const avail = root.availBytes;
  const severity = classifyDisk(avail, root.totalBytes);
  const freePct = root.totalBytes > 0 ? (avail / root.totalBytes) * 100 : 0;
  const base = `${fmtBytes(avail)} free of ${fmtBytes(root.totalBytes)}`;
  return {
    findings: [
      {
        id: 'disk-space',
        checkId: 'disk-space',
        category: 'vitals',
        severity,
        title: severity === 'info' ? base : `Only ${base} (${freePct.toFixed(1)} %)`,
        detail:
          severity === 'info'
            ? 'Free space is the `Available` column of `df -k /`, which is what the system will actually let you write.'
            : 'Low free space slows the system (swap, caches, updates) and can make updates fail. Free space comes from the `Available` column; deleted files may stay allocated until local snapshots thin.',
        evidence: [
          evidence('df -k /', `(from the system snapshot) Available ${Math.round(avail / 1024)} KB of ${Math.round(root.totalBytes / 1024)} KB`),
        ],
      },
    ],
    vitals: { diskFreeBytes: avail, diskTotalBytes: root.totalBytes },
  };
}

export const diskSpaceCheck: HealthCheck = {
  id: 'disk-space',
  category: 'vitals',
  scope: 'quick',
  timeoutMs: 3000,
  run,
};
