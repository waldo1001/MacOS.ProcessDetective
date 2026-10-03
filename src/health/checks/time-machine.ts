import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding, HealthSeverity } from '../../types.js';
import { ageText, evidence } from '../util.js';

export interface TmDestination {
  name: string | null;
  kind: string | null;
  /** Only local destinations report one, and only while the disk is connected. */
  mountPoint: string | null;
}

/** Parse `tmutil destinationinfo` (blocks separated by `====` lines). */
export function parseDestinationInfo(text: string): TmDestination[] {
  const dests: TmDestination[] = [];
  let cur: TmDestination | null = null;
  for (const line of text.split('\n')) {
    if (/^=+\s*$/.test(line)) {
      if (cur) dests.push(cur);
      cur = null;
      continue;
    }
    const m = line.match(/^(Name|Kind|Mount Point)\s*:\s*(.*)$/);
    if (!m) continue;
    cur ??= { name: null, kind: null, mountPoint: null };
    if (m[1] === 'Name') cur.name = m[2]!.trim();
    else if (m[1] === 'Kind') cur.kind = m[2]!.trim();
    else cur.mountPoint = m[2]!.trim() || null;
  }
  if (cur) dests.push(cur);
  return dests.filter((d) => d.name || d.kind);
}

export interface TmStatus {
  running: boolean;
  phase: string | null;
  /** True when the backup volume is mounted right now (a `DestinationMountPoint` is reported). */
  mounted: boolean;
}

/** Parse `tmutil status` (an old-style plist dump). */
export function parseTmStatus(text: string): TmStatus {
  const phase = text.match(/BackupPhase\s*=\s*"?([A-Za-z]+)"?\s*;/);
  return {
    running: /\bRunning\s*=\s*1\s*;/.test(text),
    phase: phase ? phase[1]! : null,
    mounted: /DestinationMountPoint\s*=\s*"?\S/.test(text),
  };
}

/** Timestamp (local time) of the `YYYY-MM-DD-HHMMSS` in a backup path; null when absent. */
export function parseBackupTime(text: string): number | null {
  const m = text.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
}

/** Severity by backup age: info < 48 h, advice 48 h – 7 d, warn > 7 d. */
export function classifyBackupAge(ageMs: number): HealthSeverity {
  const h = ageMs / 3_600_000;
  if (h < 48) return 'info';
  if (h <= 24 * 7) return 'advice';
  return 'warn';
}

type Out = { stdout: string; stderr: string; failed: boolean };
const WHERE_TO_LOOK = ['System Settings → General → Time Machine shows the date of the last backup'];

/**
 * Build the finding from the tmutil answers (pure). `latest` is null when the
 * backup volume was not mounted and the question was therefore never asked.
 * An unverifiable backup is the normal state away from the NAS: `advice`, never `warn`.
 */
export function classifyTimeMachine(dest: Out, status: Out, latest: Out | null, now: number): HealthFinding[] {
  const destText = `${dest.stdout}\n${dest.stderr}`;
  const destEv = evidence('tmutil destinationinfo', destText);
  const base = { checkId: 'time-machine', category: 'backup' as const, id: 'time-machine' };

  if (/No destinations configured/i.test(destText)) {
    return [
      {
        ...base,
        severity: 'advice',
        title: 'Time Machine is not configured',
        detail: 'No backup destination is set, so nothing is protecting this Mac from disk loss or a bad update.',
        evidence: [destEv],
      },
    ];
  }

  const dests = parseDestinationInfo(destText);
  const destName = dests.length ? dests.map((d) => `${d.name ?? '?'} (${d.kind ?? 'unknown kind'})`).join(', ') : 'the configured destination';
  const st = parseTmStatus(status.stdout);
  const statusEv = evidence('tmutil status', status.stdout.trim() || '(no output)');

  if (st.running) {
    return [
      {
        ...base,
        severity: 'info',
        title: `Time Machine backup in progress${st.phase ? ` (${st.phase})` : ''}`,
        detail: `A backup to ${destName} is running right now.`,
        evidence: [destEv, statusEv],
      },
    ];
  }

  if (!latest) {
    return [
      {
        ...base,
        severity: 'advice',
        title: 'Last backup not verified — the backup destination is not mounted',
        detail: `Asking Time Machine for the latest backup would make macOS mount ${destName} (connect to the share and attach the backup image). A health check must not mount volumes, so the age of the last backup is unknown. That is the normal state away from the backup disk or NAS.`,
        evidence: [destEv, statusEv],
        manualSteps: WHERE_TO_LOOK,
      },
    ];
  }

  const latestText = `${latest.stdout}\n${latest.stderr}`;
  const latestEv = evidence('tmutil latestbackup', latestText.trim() || '(no output — timed out)');
  const at = parseBackupTime(latest.stdout);

  if (at !== null) {
    const age = now - at;
    const severity = classifyBackupAge(age);
    return [
      {
        ...base,
        severity,
        title: `Last Time Machine backup ${ageText(age)} ago`,
        detail:
          severity === 'info'
            ? `The latest backup to ${destName} is recent.`
            : `The latest backup to ${destName} is ${ageText(age)} old${severity === 'warn' ? ' — more than a week without a completed backup' : ''}.`,
        evidence: [destEv, latestEv],
      },
    ];
  }
  if (/Full Disk Access/i.test(latestText)) {
    return [
      {
        ...base,
        severity: 'advice',
        title: 'Last backup unverifiable — macOS only tells apps with Full Disk Access',
        detail: `${destName} is mounted, but macOS refuses to report the latest backup to an app without Full Disk Access.`,
        evidence: [destEv, latestEv],
        manualSteps: [
          ...WHERE_TO_LOOK,
          'or: System Settings → Privacy & Security → Full Disk Access → add Process Detective, then Re-check',
        ],
      },
    ];
  }
  if (/no backups|no machine directory/i.test(latestText)) {
    return [
      {
        ...base,
        severity: 'advice',
        title: 'Time Machine has no completed backup yet',
        detail: `${destName} is configured but holds no completed backup for this Mac.`,
        evidence: [destEv, latestEv],
      },
    ];
  }
  return [
    {
      ...base,
      severity: 'advice',
      title: 'Last backup unverifiable — Time Machine did not answer',
      detail: `${destName} is mounted, but the question timed out or failed, so the age of the last backup is unknown.`,
      evidence: [destEv, latestEv],
      manualSteps: WHERE_TO_LOOK,
    },
  ];
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const none: Out = { stdout: '', stderr: '', failed: false };
  const dest = await ctx.run('/usr/bin/tmutil', ['destinationinfo'], 5000);
  if (/No destinations configured/i.test(`${dest.stdout}\n${dest.stderr}`)) {
    return { findings: classifyTimeMachine(dest, none, null, ctx.now) };
  }
  const status = await ctx.run('/usr/bin/tmutil', ['status'], 5000);
  const st = parseTmStatus(status.stdout);
  // `tmutil latestbackup` makes macOS MOUNT an unmounted destination (it connects to the
  // NAS share and attaches the backup image — measured on 2026-10-03, and a backup then
  // started). So it is asked only when the backup volume is already mounted, and never
  // while a backup is running.
  const mounted = st.mounted || parseDestinationInfo(dest.stdout).some((d) => d.mountPoint !== null && ctx.exists(d.mountPoint));
  const latest = !st.running && mounted ? await ctx.run('/usr/bin/tmutil', ['latestbackup'], 12_000) : null;
  return { findings: classifyTimeMachine(dest, status, latest, ctx.now) };
}

export const timeMachineCheck: HealthCheck = {
  id: 'time-machine',
  category: 'backup',
  scope: 'quick',
  ttlMs: 15 * 60_000,
  timeoutMs: 25_000,
  run,
};
