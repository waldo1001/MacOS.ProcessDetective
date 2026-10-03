import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding } from '../../types.js';
import { softwareUpdateSteps } from '../manual.js';
import { evidence, plural } from '../util.js';

export interface UpdateEntry {
  label: string;
  title: string;
  version: string | null;
  action: string | null;
  isMacOS: boolean;
  /** A macOS point release for the running major version that needs a restart (security content). */
  sameMajorRestart: boolean;
}

const major = (v: string | null): string | null => (v ? v.split('.')[0]! : null);

/**
 * Parse `softwareupdate -l` (pass stdout + stderr: "No new software available."
 * goes to stderr). Each `* Label:` line is followed by a `Title: …, Version: …` line.
 */
export function parseSoftwareUpdate(text: string, currentVersion: string | null): UpdateEntry[] {
  const entries: UpdateEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\*\s*Label:\s*(.+?)\s*$/);
    if (!m) continue;
    const meta = lines[i + 1] ?? '';
    const field = (name: string): string | null => {
      const f = meta.match(new RegExp(`${name}:\\s*([^,]+?)\\s*(?:,|$)`));
      return f ? f[1]!.trim() : null;
    };
    const title = field('Title') ?? m[1]!;
    const version = field('Version');
    const action = field('Action');
    const isMacOS = /^macOS\b/i.test(title) || /^macOS\b/i.test(m[1]!);
    entries.push({
      label: m[1]!,
      title,
      version,
      action,
      isMacOS,
      sameMajorRestart: isMacOS && currentVersion !== null && major(version) === major(currentVersion) && action === 'restart',
    });
  }
  return entries;
}

/** Classify the pending updates against the running macOS version (pure). */
export function classifyUpdates(entries: UpdateEntry[], currentVersion: string | null, rawOutput = ''): HealthFinding[] {
  const ev = evidence('softwareupdate -l', rawOutput || entries.map((e) => `* ${e.label}`));
  if (entries.length === 0) {
    return [
      {
        id: 'software-update',
        checkId: 'software-update',
        category: 'updates',
        severity: 'info',
        title: 'No software updates pending',
        detail: 'softwareupdate reports nothing new for this Mac.',
        evidence: [ev],
      },
    ];
  }
  const findings: HealthFinding[] = [];
  const others: UpdateEntry[] = [];
  for (const e of entries) {
    if (e.sameMajorRestart) {
      findings.push({
        id: `software-update:macos-${(e.version ?? e.label).replace(/[^0-9a-z]+/gi, '-')}`,
        checkId: 'software-update',
        category: 'updates',
        severity: 'warn',
        title: `macOS ${e.version} is available — same major, security content, needs a restart`,
        detail: `${e.title} is a point release for the version you run (${currentVersion}); these carry security fixes. It installs only when you start it, and needs a restart.`,
        evidence: [ev],
        safety: 'manual',
        manualSteps: softwareUpdateSteps(),
      });
    } else {
      others.push(e);
    }
  }
  if (others.length) {
    const names = others.map((e) => (e.isMacOS && e.version ? `macOS ${e.version}` : e.title));
    findings.push({
      id: 'software-update',
      checkId: 'software-update',
      category: 'updates',
      severity: 'advice',
      title: `${plural(others.length, 'other update')} available: ${names.join(', ')}`,
      detail: 'These are optional or a major upgrade. Nothing here installs automatically.',
      evidence: [ev],
      manualSteps: softwareUpdateSteps(),
    });
  }
  return findings;
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const [su, sw] = await Promise.all([
    ctx.run('/usr/sbin/softwareupdate', ['-l'], 60_000),
    ctx.run('/usr/bin/sw_vers', ['-productVersion'], 3000),
  ]);
  const text = `${su.stdout}\n${su.stderr}`;
  const current = sw.stdout.trim() || null;
  const entries = parseSoftwareUpdate(text, current);
  if (entries.length === 0 && !/No new software available/i.test(text)) {
    throw new Error(`softwareupdate -l gave no usable answer${su.failed ? ' (failed or timed out)' : ''}`);
  }
  return { findings: classifyUpdates(entries, current, text) };
}

export const softwareUpdateCheck: HealthCheck = {
  id: 'software-update',
  category: 'updates',
  scope: 'quick',
  ttlMs: 6 * 3_600_000,
  timeoutMs: 65_000,
  run,
};
