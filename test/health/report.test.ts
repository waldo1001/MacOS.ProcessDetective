import { describe, expect, it } from 'vitest';
import { buildHealthMarkdown, buildHealthPrompt, buildHealthReport } from '../../src/report/health.js';
import { fmtBytes } from '../../src/render/format.js';
import type { HealthFinding, HealthReport } from '../../src/types.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0).getTime();
const H = 3_600_000;

const finding = (over: Partial<HealthFinding>): HealthFinding => ({
  id: 'x', checkId: 'x', category: 'tooling', severity: 'info', title: 'a title', detail: 'a detail', evidence: [], ...over,
});

function report(over: Partial<HealthReport> = {}): HealthReport {
  const findings: HealthFinding[] = [
    finding({
      id: 'memory-pressure', category: 'vitals', title: 'Memory: 91 % free, swap 0 B, pressure normal',
      evidence: [{ command: 'sysctl -n kern.memorystatus_level', excerpt: '91' }],
    }),
    finding({
      id: 'software-update', category: 'updates', severity: 'warn', asOf: NOW - 2 * H, title: 'macOS 26.7.1 is available',
      evidence: [{ command: 'softwareupdate -l', excerpt: '* Label: macOS 26.7.1' }],
      manualSteps: ['System Settings → General → Software Update'],
    }),
    finding({
      id: 'xcode-deriveddata', checkId: 'disk-clutter', category: 'clutter', severity: 'advice', title: 'Xcode DerivedData: 9.9 GB',
      evidence: [{ command: 'du -k -d 1 -P -x -- ~/Library/Developer/Xcode/DerivedData', excerpt: '10380000\t/x' }],
      items: [{ path: '/Users/test/Library/Developer/Xcode/DerivedData/App-abc', bytes: 10_630_000_000, lastModified: NOW - 86_400_000 * 3, safety: 'regenerates', note: 'App' }],
      reclaimableBytes: 10_630_000_000,
    }),
  ];
  return {
    at: NOW, scope: 'quick', durationMs: 3800, verdict: 'cluttered', verdictReason: 'no vitals or stability problem; 1 startup/tooling/update warning',
    vitals: {
      memFreePct: 91, swapUsedBytes: 0, pressure: 'normal', loadAvg1: 1.5, uptimeSec: 90_000, processCount: 500, thermalWarning: false,
      batteryCycles: 79, batteryHealthPct: 95, diskFreeBytes: 1.4 * 1024 ** 4, diskTotalBytes: 1.8 * 1024 ** 4, localSnapshots: 1, crashes7d: 2,
    },
    findings,
    reclaimable: { total: 10_630_000_000, byClass: { regenerates: 10_630_000_000, orphan: 0, ask: 0, keep: 0, manual: 0 } },
    skipped: [{ id: 'login-items', reason: 'failed: timed out' }],
    fullScan: { at: NOW - 2 * H, stale: false },
    refreshing: [],
    onDemand: [],
    ...over,
  };
}

describe('fmtBytes', () => {
  it('is 1024-based with one decimal below 10, and never rounds 9.9 GB up to 10', () => {
    expect(fmtBytes(10_630_000_000)).toBe('9.9 GB');
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(113 * 1024 ** 3)).toBe('113 GB');
    expect(fmtBytes(1.3 * 1024 ** 4)).toBe('1.3 TB');
    expect(fmtBytes(Math.round(9.96 * 1024 ** 3))).toBe('10 GB'); // 9.96 rounds to 10, but is never printed "10.0"
    expect(fmtBytes(Math.round(9.94 * 1024 ** 3))).toBe('9.9 GB');
    expect(fmtBytes(1024 * 1024 - 1)).toBe('1.0 MB');
  });
});

describe('itemLabel', () => {
  it('drops the aggregate size from a finding title', async () => {
    const { itemLabel } = await import('../../src/health/verdict.js');
    expect(itemLabel(finding({ title: 'Xcode DerivedData: 113 GB in 14 items' }))).toBe('Xcode DerivedData');
    expect(itemLabel(finding({ title: 'Homebrew cache: 1.5 GB' }))).toBe('Homebrew cache');
    expect(itemLabel(finding({ title: 'Stream Deck is writing a runaway log (7.2 GB, 5 files)' }))).toBe('Stream Deck is writing a runaway log (7.2 GB, 5 files)');
  });
});

describe('buildHealthReport', () => {
  const text = buildHealthReport(report(), NOW);
  it('opens with the verdict line, then vitals, findings with severity tags, and marks cached findings', () => {
    const lines = text.split('\n');
    expect(lines[2]).toBe('Verdict: CLUTTERED — no vitals or stability problem; 1 startup/tooling/update warning');
    expect(text).toContain('Memory free');
    expect(text).toContain('[INFO] Memory: 91 % free');
    expect(text).toContain('[WARN] macOS 26.7.1 is available (as of 2 h ago)');
    expect(text).toContain('$ softwareupdate -l');
  });
  it('lists the reclaimable table with sizes and safety class, then Skipped and Manual steps', () => {
    expect(text).toMatch(/9\.9 GB\s+regenerates\s+~?.*DerivedData\/App-abc/);
    expect(text).toContain('Skipped (NOT checked');
    expect(text).toContain('login-items: failed: timed out');
    expect(text).toContain('Manual steps:');
    expect(text).toContain('System Settings → General → Software Update');
  });
  it('an unsurveyed machine says so instead of printing an empty table', () => {
    const t = buildHealthReport(report({ findings: [], reclaimable: { total: 0, byClass: { regenerates: 0, orphan: 0, ask: 0, keep: 0, manual: 0 } }, fullScan: { at: null, stale: false } }), NOW);
    expect(t).toContain('not surveyed yet');
  });
});

describe('buildHealthPrompt', () => {
  it('wraps the report between the snapshot markers and carries the "Skipped" warning', () => {
    const p = buildHealthPrompt(report(), NOW);
    expect(p).toContain('--- health snapshot ---');
    expect(p).toContain('--- end snapshot ---');
    expect(p).toContain(buildHealthReport(report(), NOW));
    expect(p).toContain("Anything under 'Skipped' was NOT checked — do not treat it as clean.");
    expect(p).toContain('Which three items would you act on first');
    expect(p).toContain('sudo or a restart');
  });
  it('a cached finding shows "as of"', () => {
    expect(buildHealthPrompt(report(), NOW)).toContain('as of 2 h ago');
  });
});

describe('buildHealthMarkdown', () => {
  const md = buildHealthMarkdown(report(), NOW);
  it('has the dated title, the verdict table and prints 9.9 GB (not 10 GB) for 10_630_000_000 bytes', () => {
    expect(md.startsWith('# Mac health check — 2026-10-03')).toBe(true);
    expect(md).toContain('| Area | State | Evidence |');
    expect(md).toContain('| Updates | warn |');
    expect(md).toContain('| 9.9 GB |');
    expect(md).not.toContain('10 GB');
  });
  it('lists what is worth fixing with manual steps, the commands used (de-duplicated) and the Phase 1 clean-up line', () => {
    expect(md).toContain('### [WARN] macOS 26.7.1 is available');
    expect(md).toContain('System Settings → General → Software Update');
    expect(md).toContain('## Commands used');
    expect(md.match(/softwareupdate -l/g)!.length).toBe(1);
    expect(md).toContain('## Clean-ups executed');
    expect(md).toContain('none — Phase 1 is read-only');
    expect(md).toContain('## Skipped (not checked)');
  });
  it('the clutter table has Size / Where / What / Safe? columns', () => {
    expect(md).toContain('| Size | Where | What | Safe? |');
    expect(md).toContain('regenerates |');
    expect(md).toContain('| Xcode DerivedData — App |'); // the row's own label, not the group total
  });
});
