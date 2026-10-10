import { describe, expect, it } from 'vitest';
import { parseDf } from '../../src/collect/system.js';
import { diskSpaceCheck, classifyDisk } from '../../src/health/checks/disk-space.js';
import { parseTherm, thermalCheck } from '../../src/health/checks/thermal.js';
import { parseBattery, batteryCheck } from '../../src/health/checks/battery.js';
import { classifyMemory, memoryPressureCheck, parseMemoryLevel } from '../../src/health/checks/memory-pressure.js';
import { uptimeLoadCheck } from '../../src/health/checks/uptime-load.js';
import { crashes7dCheck, crashFindings } from '../../src/health/checks/crashes-7d.js';
import { apfsSnapshotsCheck, parseLocalSnapshots } from '../../src/health/checks/apfs-snapshots.js';
import { fail, fakeContext, fakeSystem, fixture, NOW, ok, scriptedRun } from './helpers.js';

const GIB = 1024 ** 3;

describe('parseDf / disk-space', () => {
  it('reads the Available column of the root volume', () => {
    const vols = parseDf(fixture('df-k.txt'));
    expect(vols.map((v) => v.mount)).toEqual(['/']);
    expect(vols[0]!.availBytes).toBe(1433398200 * 1024);
  });

  it('reports the APFS container usage for /, not the sealed system volume\'s Used column', () => {
    const v = parseDf(fixture('df-k.txt'))[0]!;
    // Used column is 12337068 KB (0.6 %); the Data volume alone holds 491912708 KB.
    expect(v.usedBytes).toBe((1948404040 - 1433398200) * 1024);
    expect(v.usedBytes).not.toBe(12337068 * 1024);
    expect(v.usedPct).toBeCloseTo(26.43, 2);
    expect(v.totalBytes - v.usedBytes).toBe(v.availBytes);
  });

  it('keeps the Used column for /Volumes/* (a sparse image\'s total is virtual)', () => {
    // Real rows: a Time Machine sparse bundle on a NAS (15.6 TB virtual, 382 GB left on the
    // share) and an external single-volume disk.
    const df = [
      'Filesystem     1024-blocks      Used  Available Capacity iused       ifree %iused  Mounted on',
      '/dev/disk3s1s1  1948404040  12337068 1423628692     1%  458732  4293266919    0%   /',
      '/dev/disk7s1   15625000000 577043568  382227920    61% 5705275  3822279200    0%   /Volumes/Backups of Mac',
      '/dev/disk9s1     976490576 400000000  576490576    41%  100000  5764905760    0%   /Volumes/External',
    ].join('\n');
    const [, backups, external] = parseDf(df);
    expect(backups!.name).toBe('Backups of Mac');
    expect(backups!.usedBytes).toBe(577043568 * 1024);
    expect(backups!.availBytes).toBe(382227920 * 1024);
    expect(backups!.usedPct).toBeCloseTo(3.69, 2);
    expect(external!.usedBytes).toBe(400000000 * 1024);
  });

  it('sets diskFreeBytes from Available, not from total − the Used column', async () => {
    const volumes = parseDf(fixture('df-k.txt'));
    const ctx = fakeContext({ system: { storage: { volumes } } });
    const r = await diskSpaceCheck.run(ctx);
    const v = volumes[0]!;
    expect(r.vitals!.diskFreeBytes).toBe(1433398200 * 1024);
    expect(r.vitals!.diskFreeBytes).not.toBe((1948404040 - 12337068) * 1024);
    expect(r.vitals!.diskTotalBytes).toBe(v.totalBytes);
    expect(r.findings[0]!.severity).toBe('info');
    expect(r.findings[0]!.title).toBe('1.3 TB free of 1.8 TB');
  });

  it('classifies free space: risk < 5 % or < 10 GiB, warn < 10 % or < 25 GiB', () => {
    const total = 1000 * GIB;
    expect(classifyDisk(40 * GIB, total)).toBe('risk');      // 4 %
    expect(classifyDisk(8 * GIB, 100 * GIB)).toBe('risk');   // < 10 GiB although 8 %
    expect(classifyDisk(90 * GIB, total)).toBe('warn');      // 9 %
    expect(classifyDisk(20 * GIB, 100 * GIB)).toBe('warn');  // 20 % but < 25 GiB
    expect(classifyDisk(300 * GIB, total)).toBe('info');
  });

  it('asks `df -k /` alone when the shared snapshot has no / volume (a stalled network mount blanks `df -k`)', async () => {
    const seen: string[] = [];
    const run = async (cmd: string, args: string[]) => { seen.push(`${cmd} ${args.join(' ')}`); return ok(fixture('df-k.txt')); };
    const r = await diskSpaceCheck.run(fakeContext({ system: { storage: { volumes: [] } }, run }));
    expect(seen).toEqual(['/bin/df -k /']);
    expect(r.vitals!.diskFreeBytes).toBe(1433398200 * 1024);
  });

  it('fails (becomes skipped) when even `df -k /` has no / volume', async () => {
    const ctx = fakeContext({ system: { storage: { volumes: [] } }, run: async () => fail('', '') });
    await expect(diskSpaceCheck.run(ctx)).rejects.toThrow(/no volume/);
  });
});

describe('parseTherm / thermal', () => {
  it('the ok fixture is not a warning', () => {
    const t = parseTherm(fixture('pmset-therm-ok.txt'));
    expect(t.thermalWarning).toBe(false);
    expect(t.warningLines).toEqual([]);
  });

  it('CPU_Speed_Limit below 100 is a risk', async () => {
    const out = `${fixture('pmset-therm-ok.txt')}CPU_Scheduler_Limit\t= 100\nCPU_Speed_Limit \t= 60\n`;
    expect(parseTherm(out).thermalWarning).toBe(true);
    const r = await thermalCheck.run(fakeContext({ run: async () => ok(out) }));
    expect(r.findings[0]!.severity).toBe('risk');
    expect(r.vitals!.thermalWarning).toBe(true);
  });

  it('CPU_Speed_Limit = 100 (Intel always prints it) is not a risk', async () => {
    const out = `${fixture('pmset-therm-ok.txt')}CPU_Scheduler_Limit\t= 100\nCPU_Speed_Limit \t= 100\n`;
    const r = await thermalCheck.run(fakeContext({ run: async () => ok(out) }));
    expect(r.findings.some((f) => f.severity === 'risk')).toBe(false);
    expect(r.vitals!.thermalWarning).toBe(false);
  });

  it('a recorded "warning level" line (not "Note: No …") is a risk', () => {
    expect(parseTherm('Thermal warning level: 70\n').thermalWarning).toBe(true);
  });
});

describe('parseBattery / battery', () => {
  it('parses cycles, condition and capacity', () => {
    expect(parseBattery(fixture('system-profiler-power.txt'))).toEqual({ cycles: 79, condition: 'Normal', capacityPct: 95 });
  });

  it('returns null without a Cycle Count line (desktop Mac)', async () => {
    expect(parseBattery('Power:\n\n    System Power Settings:\n')).toBeNull();
    const r = await batteryCheck.run(fakeContext({ run: async () => ok('Power:\n') }));
    expect(r.findings).toEqual([]);
    expect(r.vitals).toBeUndefined();
  });

  it('is info when healthy and warn when worn', async () => {
    const good = await batteryCheck.run(fakeContext({ run: async () => ok(fixture('system-profiler-power.txt')) }));
    expect(good.findings[0]!.severity).toBe('info');
    expect(good.findings[0]!.title).toBe('Battery: 79 cycles, 95 % capacity, Normal');
    expect(good.vitals).toEqual({ batteryCycles: 79, batteryHealthPct: 95 });

    const worn = fixture('system-profiler-power.txt').replace('Maximum Capacity: 95%', 'Maximum Capacity: 74%');
    expect((await batteryCheck.run(fakeContext({ run: async () => ok(worn) }))).findings[0]!.severity).toBe('warn');
    const svc = fixture('system-profiler-power.txt').replace('Condition: Normal', 'Condition: Service Recommended');
    expect((await batteryCheck.run(fakeContext({ run: async () => ok(svc) }))).findings[0]!.severity).toBe('warn');
  });
});

describe('memory-pressure', () => {
  it('parses the kernel free-memory level', () => {
    expect(parseMemoryLevel('91\n')).toBe(91);
    expect(parseMemoryLevel('')).toBeNull();
    expect(parseMemoryLevel('garbage')).toBeNull();
  });

  it('classifies pressure and swap', () => {
    expect(classifyMemory('critical', 0, 90).severity).toBe('risk');
    expect(classifyMemory('normal', 5 * GIB, 8).severity).toBe('risk');
    expect(classifyMemory('warning', 0, 50).severity).toBe('warn');
    expect(classifyMemory('normal', 2 * GIB, 20).severity).toBe('warn');
    expect(classifyMemory('normal', 2 * GIB, 60).severity).toBe('advice');
    expect(classifyMemory('normal', 0, 91).severity).toBe('info');
    expect(classifyMemory('normal', 5 * GIB, null).severity).toBe('advice'); // free % unknown: cannot call it risk
  });

  it('reports free % from the kernel level, not 100 − used %', async () => {
    const ctx = fakeContext({
      memory: { usedPct: 99 },
      run: scriptedRun([['kern.memorystatus_level', ok('91\n')]]),
    });
    const r = await memoryPressureCheck.run(ctx);
    expect(r.vitals!.memFreePct).toBe(91);
    expect(r.findings[0]!.title).toBe('Memory: 91 % free, swap 0 B, pressure normal');
  });
});

describe('uptime-load', () => {
  it('advises a restart after 30 days and always reports the vitals', async () => {
    const old = fakeContext({ system: { host: { ...fakeSystem().host, uptimeSeconds: 31 * 86_400 } } });
    const r = await uptimeLoadCheck.run(old);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe('advice');
    expect(r.vitals).toMatchObject({ uptimeSec: 31 * 86_400, loadAvg1: 1.5, processCount: 500 });

    const fresh = await uptimeLoadCheck.run(fakeContext());
    expect(fresh.findings).toEqual([]);
    expect(fresh.vitals!.uptimeSec).toBe(3600);
  });
});

describe('crashes-7d', () => {
  const H = 3_600_000;
  it('looping within 24 h is a risk, an older loop and a repeat offender are warnings', () => {
    const f = crashFindings(
      [
        { process: 'Chrome Helper', count: 7, firstAt: NOW - 3 * H, lastAt: NOW - 2 * H, looping: true },
        { process: 'OldLoop', count: 4, firstAt: NOW - 4 * 86_400_000, lastAt: NOW - 4 * 86_400_000 + 60_000, looping: true },
        { process: 'Repeat', count: 3, firstAt: NOW - 5 * H, lastAt: NOW - H, looping: false },
        { process: 'Once', count: 1, firstAt: NOW - H, lastAt: NOW - H, looping: false },
      ],
      NOW,
    );
    expect(f.map((x) => [x.id, x.severity])).toEqual([
      ['crashes-7d:chrome-helper', 'risk'],
      ['crashes-7d:oldloop', 'warn'],
      ['crashes-7d:repeat', 'warn'],
    ]);
  });

  it('emits one info line otherwise and sums the counts into the vital', async () => {
    const none = await crashes7dCheck.run(fakeContext());
    expect(none.findings[0]!.title).toBe('0 crash reports in 7 days');
    expect(none.vitals!.crashes7d).toBe(0);

    const some = await crashes7dCheck.run(
      fakeContext({
        crashes: async () => [
          { process: 'A', count: 2, firstAt: NOW - H, lastAt: NOW - H, looping: false },
          { process: 'B', count: 2, firstAt: NOW - H, lastAt: NOW - H, looping: false },
        ],
      }),
    );
    expect(some.findings).toHaveLength(1);
    expect(some.findings[0]!.title).toBe('4 crash reports in 7 days, no repeat offender');
    expect(some.vitals!.crashes7d).toBe(4);
  });
});

describe('apfs-snapshots', () => {
  it('parses the snapshot list', () => {
    const s = parseLocalSnapshots(fixture('tmutil-listlocalsnapshots.txt'));
    expect(s.count).toBe(1);
    expect(s.newestAt).toBe(new Date(2026, 9, 3, 10, 29, 32).getTime());
  });

  it('advises with the thin command and fills the vital', async () => {
    const r = await apfsSnapshotsCheck.run(fakeContext({ run: async () => ok(fixture('tmutil-listlocalsnapshots.txt')) }));
    expect(r.vitals!.localSnapshots).toBe(1);
    const f = r.findings[0]!;
    expect(f.severity).toBe('advice');
    expect(f.actionId).toBe('thin-snapshots');
    expect(f.manualSteps).toEqual(['tmutil thinlocalsnapshots / 999999999999 4']);
    expect(f.title).toContain('1 local snapshot');
  });

  it('no snapshots: no finding, vital 0; a failed tmutil is skipped, not "0"', async () => {
    const none = await apfsSnapshotsCheck.run(fakeContext({ run: async () => ok('Snapshots for disk /:\n') }));
    expect(none.findings).toEqual([]);
    expect(none.vitals!.localSnapshots).toBe(0);
    await expect(apfsSnapshotsCheck.run(fakeContext({ run: async () => fail('', 'boom') }))).rejects.toThrow(/tmutil/);
  });
});
