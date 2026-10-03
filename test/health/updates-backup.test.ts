import { describe, expect, it } from 'vitest';
import { classifyUpdates, parseSoftwareUpdate, softwareUpdateCheck } from '../../src/health/checks/software-update.js';
import { classifyBackupAge, parseBackupTime, parseDestinationInfo, parseTmStatus, timeMachineCheck } from '../../src/health/checks/time-machine.js';
import { brewCheck, parseBrewCleanup, parseBrewOutdated } from '../../src/health/checks/brew.js';
import { fail, fakeContext, fixture, NOW, ok, scriptedRun } from './helpers.js';

describe('parseSoftwareUpdate', () => {
  const text = fixture('softwareupdate-l.txt');

  it('finds 3 entries and flags only the same-major macOS point release that needs a restart', () => {
    const entries = parseSoftwareUpdate(text, '26.6.2');
    expect(entries.map((e) => e.version)).toEqual(['27.0', '26.7.1', '27.0.1']);
    expect(entries.map((e) => e.sameMajorRestart)).toEqual([false, true, false]);
    expect(entries[1]!.action).toBe('restart');
    expect(entries[0]!.isMacOS).toBe(false);
  });

  it('26.7.1 is a warn, the rest one advice', () => {
    const f = classifyUpdates(parseSoftwareUpdate(text, '26.6.2'), '26.6.2', text);
    const warns = f.filter((x) => x.severity === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.title).toBe('macOS 26.7.1 is available — same major, security content, needs a restart');
    expect(warns[0]!.manualSteps![0]).toContain('Software Update');
    const advice = f.filter((x) => x.severity === 'advice');
    expect(advice).toHaveLength(1);
    expect(advice[0]!.title).toContain('Safari');
    expect(advice[0]!.title).toContain('macOS 27.0.1');
  });

  it('"No new software available." is an info', async () => {
    const f = classifyUpdates(parseSoftwareUpdate('No new software available.\n', '26.6.2'), '26.6.2');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('info');

    const run = scriptedRun([
      ['softwareupdate -l', ok('', 'Software Update Tool\n\nFinding available software\nNo new software available.\n')],
      ['sw_vers', ok('26.6.2\n')],
    ]);
    const r = await softwareUpdateCheck.run(fakeContext({ run }));
    expect(r.findings[0]!.severity).toBe('info');
  });

  it('with an unknown OS version nothing is claimed to be same-major', () => {
    expect(parseSoftwareUpdate(text, null).some((e) => e.sameMajorRestart)).toBe(false);
  });

  it('an unusable answer fails (keeps the cache) instead of reporting "up to date"', async () => {
    await expect(softwareUpdateCheck.run(fakeContext({ run: async () => fail('', '') }))).rejects.toThrow(/no usable answer/);
  });

  it('is a cached check (6 h) and never installs: only -l is ever run', async () => {
    expect(softwareUpdateCheck.ttlMs).toBe(6 * 3_600_000);
    const run = scriptedRun([
      ['softwareupdate', ok(text)],
      ['sw_vers', ok('26.6.2\n')],
    ]);
    await softwareUpdateCheck.run(fakeContext({ run }));
    expect(run.calls.filter((c) => c.includes('softwareupdate')).every((c) => c.endsWith(' -l'))).toBe(true);
  });
});

describe('time-machine', () => {
  const dest = fixture('tmutil-destinationinfo.txt');
  const idle = fixture('tmutil-status-idle.txt');
  const running = fixture('tmutil-status-running.txt');
  const localDest = [
    '====================================================',
    'Name          : TM Disk',
    'Kind          : Local',
    'Mount Point   : /Volumes/TM Disk',
    'ID            : 00000000-0000-0000-0000-000000000000',
  ].join('\n');
  const stamp = (t: number): string => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `/Volumes/TM Disk/Backups.backupdb/Mac/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  /** A connected local backup disk: the only state in which latestbackup may be asked. */
  const mountedRun = (latest: ReturnType<typeof ok>) =>
    scriptedRun([
      ['destinationinfo', ok(localDest)],
      ['status', ok(idle)],
      ['latestbackup', latest],
    ]);
  const mounted = (latest: ReturnType<typeof ok>) => fakeContext({ run: mountedRun(latest), exists: (p) => p === '/Volumes/TM Disk' });

  it('parses destinations, status and backup times', () => {
    expect(parseDestinationInfo(dest)).toEqual([{ name: 'Time Machine', kind: 'Network', mountPoint: null }]);
    expect(parseDestinationInfo(localDest)).toEqual([{ name: 'TM Disk', kind: 'Local', mountPoint: '/Volumes/TM Disk' }]);
    expect(parseTmStatus(running)).toEqual({ running: true, phase: 'FindingChanges', mounted: true });
    expect(parseTmStatus(idle)).toEqual({ running: false, phase: null, mounted: false });
    expect(parseBackupTime('/x/2026-10-03-102932.backup')).toBe(new Date(2026, 9, 3, 10, 29, 32).getTime());
    expect(parseBackupTime('no date here')).toBeNull();
  });

  it('classifies age: info < 48 h, advice up to 7 d, warn beyond', () => {
    expect(classifyBackupAge(3 * 3_600_000)).toBe('info');
    expect(classifyBackupAge(60 * 3_600_000)).toBe('advice');
    expect(classifyBackupAge(9 * 86_400_000)).toBe('warn');
  });

  it('NEVER asks for the latest backup when the destination is not mounted (that would mount the NAS)', async () => {
    const run = scriptedRun([
      ['destinationinfo', ok(dest)],
      ['status', ok(idle)],
      ['latestbackup', ok(stamp(NOW))],
    ]);
    const r = await timeMachineCheck.run(fakeContext({ run }));
    expect(run.calls.some((c) => c.includes('latestbackup'))).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe('advice');
    expect(r.findings[0]!.title).toBe('Last backup not verified — the backup destination is not mounted');
    expect(r.findings[0]!.detail).toContain('Time Machine (Network)');
  });

  it('a local disk that is configured but not connected is not asked either', async () => {
    const run = mountedRun(ok(stamp(NOW)));
    const r = await timeMachineCheck.run(fakeContext({ run, exists: () => false }));
    expect(run.calls.some((c) => c.includes('latestbackup'))).toBe(false);
    expect(r.findings[0]!.severity).toBe('advice');
  });

  it('a running backup is info and is not interrupted with a latestbackup query', async () => {
    const run = scriptedRun([
      ['destinationinfo', ok(dest)],
      ['status', ok(running)],
      ['latestbackup', ok(stamp(NOW))],
    ]);
    const r = await timeMachineCheck.run(fakeContext({ run }));
    expect(run.calls.some((c) => c.includes('latestbackup'))).toBe(false);
    expect(r.findings[0]!.severity).toBe('info');
    expect(r.findings[0]!.title).toBe('Time Machine backup in progress (FindingChanges)');
  });

  it('mounted: a backup 3 h old is info, 9 days old is warn', async () => {
    const recent = await timeMachineCheck.run(mounted(ok(stamp(NOW - 3 * 3_600_000))));
    expect(recent.findings[0]!.severity).toBe('info');
    const old = await timeMachineCheck.run(mounted(ok(stamp(NOW - 9 * 86_400_000))));
    expect(old.findings[0]!.severity).toBe('warn');
  });

  it('mounted but no Full Disk Access is advice with the steps, never warn', async () => {
    const r = await timeMachineCheck.run(mounted(fail('', fixture('tmutil-latestbackup-no-fda.txt'))));
    expect(r.findings[0]!.severity).toBe('advice');
    expect(r.findings[0]!.title).toMatch(/Full Disk Access/);
    expect(r.findings[0]!.manualSteps!.join('\n')).toContain('Full Disk Access');
  });

  it('mounted but failing to mount or timing out is advice, never warn', async () => {
    for (const latest of [fail(fixture('tmutil-latestbackup-unmounted.txt')), fail('', '')]) {
      const r = await timeMachineCheck.run(mounted(latest));
      expect(r.findings[0]!.severity).toBe('advice');
      expect(r.findings[0]!.title).toBe('Last backup unverifiable — Time Machine did not answer');
    }
  });

  it('no destination configured is advice and asks nothing else', async () => {
    const run = scriptedRun([['destinationinfo', ok('No destinations configured.\n')]]);
    const r = await timeMachineCheck.run(fakeContext({ run }));
    expect(r.findings[0]!.title).toBe('Time Machine is not configured');
    expect(run.calls).toHaveLength(1);
  });

  it('bounds latestbackup at 12 s and caches for 15 min', async () => {
    let timeout = 0;
    const run = (async (_cmd: string, args: string[], ms?: number) => {
      if (args[0] === 'latestbackup') timeout = ms ?? 0;
      return args[0] === 'destinationinfo' ? ok(localDest) : args[0] === 'status' ? ok(idle) : fail('', '');
    }) as ReturnType<typeof scriptedRun>;
    await timeMachineCheck.run(fakeContext({ run, exists: () => true }));
    expect(timeout).toBe(12_000);
    expect(timeMachineCheck.ttlMs).toBe(900_000);
  });
});

describe('brew', () => {
  it('parses outdated names (formulae + casks) and the cleanup size', () => {
    expect(parseBrewOutdated(fixture('brew-outdated.json'))).toEqual(['dotnet-sdk', 'dotnet-sdk@8', 'git-credential-manager']);
    expect(parseBrewOutdated('not json')).toEqual([]);
    expect(parseBrewCleanup(fixture('brew-cleanup-n.txt'))).toBe(Math.round(248.6 * 1024 * 1024));
    expect(parseBrewCleanup(fixture('brew-cleanup-n-nothing.txt'))).toBe(0);
    expect(parseBrewCleanup('==> This operation would free approximately 1.5GB of disk space.')).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it('no brew installed: no finding', async () => {
    const r = await brewCheck.run(fakeContext({ exists: () => false }));
    expect(r.findings).toEqual([]);
  });

  it('one advice with outdated + cleanup, no items, and brew never auto-updates', async () => {
    const run = scriptedRun([
      ['outdated --json=v2', ok(fixture('brew-outdated.json'))],
      ['cleanup -n', ok(fixture('brew-cleanup-n.txt'))],
    ]);
    const r = await brewCheck.run(fakeContext({ run, exists: (p) => p === '/opt/homebrew/bin/brew' }));
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.severity).toBe('advice');
    expect(f.title).toBe('Homebrew: 3 outdated; `brew cleanup` would free 249 MB');
    expect(f.actionId).toBe('brew-cleanup');
    expect(f.items).toBeUndefined();
    expect(run.calls.every((c) => c.includes('HOMEBREW_NO_AUTO_UPDATE=1') && c.includes('HOMEBREW_NO_ANALYTICS=1'))).toBe(true);
    expect(run.calls.some((c) => c.includes('doctor'))).toBe(false);
  });

  it('nothing outdated and nothing to free is info', async () => {
    const run = scriptedRun([
      ['outdated --json=v2', ok('{"formulae":[],"casks":[]}')],
      ['cleanup -n', ok(fixture('brew-cleanup-n-nothing.txt'))],
    ]);
    const r = await brewCheck.run(fakeContext({ run, exists: () => true }));
    expect(r.findings[0]!.severity).toBe('info');
  });
});
