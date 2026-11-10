import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_LABELS,
  appKey,
  appLabel,
  buildAppsPayload,
  buildBatteryPayload,
  buildNameMap,
  bucketApps,
  clearPowerlogCache,
  detectSessions,
  downsample,
  loadPowerlog,
  parsePmsetLog,
  parseRange,
  rankApps,
  toBatterySamples,
  type AppBucketRow,
  type BatterySample,
  type PowerEvent,
} from '../src/collect/powerlog.js';
import { run } from '../src/util/exec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'powerlog');
const PMSET = readFileSync(join(FIX, 'pmset-log.txt'), 'utf8');

const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

// ---- parsePmsetLog ----

describe('parsePmsetLog', () => {
  const events = parsePmsetLog(PMSET);

  it('keeps only Sleep / Wake / DarkWake lines and ignores noise', () => {
    expect(events).toHaveLength(10);
    expect(new Set(events.map((e) => e.kind))).toEqual(
      new Set(['sleep', 'wake', 'darkwake', 'low-power-sleep']),
    );
  });

  it('parses a +0100 line as an explicit offset', () => {
    const e = events.find((x) => x.t === Date.parse('2026-11-10T06:33:25Z'))!;
    expect(e.kind).toBe('sleep');
    expect(e.reason).toBe('Clamshell Sleep');
    expect(e.onBattery).toBe(true);
    expect(e.chargePct).toBe(100);
  });

  it('parses a -0700 line as an explicit offset', () => {
    const e = events.find((x) => x.t === Date.parse('2026-11-04T19:00:00Z'))!;
    expect(e.kind).toBe('sleep');
    expect(e.reason).toBe('Idle Sleep');
    expect(e.onBattery).toBe(false);
    expect(e.chargePct).toBe(87);
  });

  it('recognises Low Power Sleep as its own kind', () => {
    const e = events.find((x) => x.kind === 'low-power-sleep')!;
    expect(e.t).toBe(Date.parse('2026-11-10T09:42:50Z'));
    expect(e.chargePct).toBe(1);
    expect(e.reason).toBe('Low Power Sleep');
  });

  it('extracts the dark-wake and wake reasons up to " Using"', () => {
    const dw = events.find((x) => x.t === Date.parse('2026-11-10T06:41:39Z'))!;
    expect(dw.kind).toBe('darkwake');
    expect(dw.reason).toBe(
      'smc.sysState.Wake(0x70070000) wifibt SMC.OutboxNotEmpty centauri-alpha E_CONNECTION_LOSS ARPT/',
    );
    const w = events.find((x) => x.kind === 'wake' && x.chargePct === 100)!;
    expect(w.reason).toBe('UserActivity Assertion');
    const wAc = events.find((x) => x.kind === 'wake' && x.chargePct === 1)!;
    expect(wAc.onBattery).toBe(false);
  });

  it('returns events sorted by time', () => {
    const ts = events.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('caps the reason at 120 characters', () => {
    const long = `2026-11-10 07:41:39 +0100 DarkWake             \tDarkWake from Deep Idle : due to ${'x'.repeat(300)} Using BATT (Charge:5%)\n`;
    expect(parsePmsetLog(long)[0]!.reason).toHaveLength(120);
  });
});

// ---- toBatterySamples ----

describe('toBatterySamples', () => {
  it('uses SystemPower when positive', () => {
    const [s] = toBatterySamples([
      { timestamp: 100.5, Level: 50, ExternalConnected: 0, IsCharging: 0, SystemPower: 12.5, InstantAmperage: -500, Voltage: 11000 },
    ]);
    expect(s!.watts).toBe(12.5);
    expect(s!.t).toBe(100500);
    expect(s!.onBattery).toBe(true);
  });

  it('falls back to |amperage| x voltage on battery', () => {
    const [s] = toBatterySamples([
      { timestamp: 1, Level: 50, ExternalConnected: 0, SystemPower: 0, InstantAmperage: -1000, Voltage: 11000 },
    ]);
    expect(s!.watts).toBeCloseTo(11, 6);
  });

  it('is null on AC without SystemPower, or without amperage', () => {
    const rows = toBatterySamples([
      { timestamp: 1, Level: 50, ExternalConnected: 1, IsCharging: 1, SystemPower: null, InstantAmperage: 2000, Voltage: 11000 },
      { timestamp: 2, Level: 50, ExternalConnected: 0, SystemPower: null, InstantAmperage: null, Voltage: 11000 },
    ]);
    expect(rows.map((r) => r.watts)).toEqual([null, null]);
    expect(rows[0]!.onBattery).toBe(false);
    expect(rows[0]!.charging).toBe(true);
  });

  it('drops rows without a Level and sorts by time', () => {
    const rows = toBatterySamples([
      { timestamp: 3, Level: 30, ExternalConnected: 0 },
      { timestamp: 2, Level: null, ExternalConnected: 0 },
      { timestamp: 1, Level: 10, ExternalConnected: 0 },
    ]);
    expect(rows.map((r) => r.level)).toEqual([10, 30]);
  });
});

// ---- detectSessions ----

function sample(min: number, level: number, onBattery: boolean, extra: Partial<BatterySample> = {}): BatterySample {
  return {
    t: T0 + min * MIN,
    level,
    onBattery,
    charging: !onBattery,
    watts: onBattery ? 10 : null,
    rawCapMah: null,
    voltageMv: null,
    ...extra,
  };
}
const ev = (min: number, kind: PowerEvent['kind'], reason = ''): PowerEvent => ({
  t: T0 + min * MIN, kind, reason, onBattery: true, chargePct: null,
});

describe('detectSessions', () => {
  it('finds AC -> battery -> AC and ends it "ac"', () => {
    const s = [sample(0, 100, false), sample(1, 100, true), sample(31, 70, true), sample(32, 70, false)];
    const [sess] = detectSessions(s, [], T0 + 100 * MIN);
    expect(sess!.start).toBe(T0 + MIN);
    expect(sess!.end).toBe(T0 + 31 * MIN);
    expect(sess!.startLevel).toBe(100);
    expect(sess!.endLevel).toBe(70);
    expect(sess!.durationMin).toBe(30);
    expect(sess!.drainPctPerHour).toBeCloseTo(60, 6);
    expect(sess!.avgWatts).toBe(10);
    expect(sess!.peakWatts).toBe(10);
    expect(sess!.endedBy).toBe('ac');
    expect(sess!.id).toBe(String(T0 + MIN));
  });

  it('the user case: drain to 1 % with a Low Power Sleep, then AC, is "empty"', () => {
    const s = [sample(0, 100, true), sample(60, 20, true), sample(110, 1, true), sample(111, 1, false)];
    const events = [ev(110.8, 'low-power-sleep', 'Low Power Sleep')];
    const [sess] = detectSessions(s, events, T0 + 500 * MIN);
    expect(sess!.endedBy).toBe('empty');
  });

  it('is "empty" at <= 2 % even without events, and via a battery-empty event', () => {
    const lowEnd = [sample(0, 50, true), sample(20, 2, true), sample(21, 2, false)];
    expect(detectSessions(lowEnd, [], T0 + 500 * MIN)[0]!.endedBy).toBe('empty');
    const mid = [sample(0, 50, true), sample(20, 30, true), sample(21, 30, false)];
    expect(detectSessions(mid, [ev(25, 'battery-empty')], T0 + 500 * MIN)[0]!.endedBy).toBe('empty');
    expect(detectSessions(mid, [ev(45, 'battery-empty')], T0 + 500 * MIN)[0]!.endedBy).toBe('ac');
  });

  it('drops a short, shallow blip (3 min, same level)', () => {
    const s = [sample(0, 1, false), sample(1, 1, true), sample(4, 1, true), sample(5, 1, false)];
    expect(detectSessions(s, [], T0 + 100 * MIN)).toEqual([]);
  });

  it('keeps a short session that dropped >= 3 %', () => {
    const s = [sample(0, 90, true), sample(5, 86, true), sample(6, 86, false)];
    expect(detectSessions(s, [], T0 + 100 * MIN)).toHaveLength(1);
  });

  it('trailing on-battery run: "ongoing" within 5 min, "data-end" later', () => {
    const s = [sample(0, 90, true), sample(30, 70, true)];
    expect(detectSessions(s, [], T0 + 32 * MIN)[0]!.endedBy).toBe('ongoing');
    expect(detectSessions(s, [], T0 + 150 * MIN)[0]!.endedBy).toBe('data-end');
  });

  it('computes drainedWh from raw capacity and mean voltage', () => {
    const s = [
      sample(0, 100, true, { rawCapMah: 5000, voltageMv: 11000 }),
      sample(10, 90, true, { rawCapMah: 4500, voltageMv: 12000 }),
      sample(20, 80, true, { rawCapMah: 4000, voltageMv: 11000 }),
    ];
    const [sess] = detectSessions(s, [], T0 + 500 * MIN);
    // (5000 - 4000) mAh x mean(11000, 12000, 11000) mV / 1e6
    expect(sess!.drainedWh).toBeCloseTo((1000 * (34000 / 3)) / 1e6, 6);
  });

  it('drainedWh is null without capacity data', () => {
    const s = [sample(0, 100, true), sample(20, 80, true)];
    expect(detectSessions(s, [], T0 + 500 * MIN)[0]!.drainedWh).toBeNull();
  });

  it('computes asleepMin (dark wakes do not end sleep) and darkWakes from events', () => {
    const s = [sample(0, 100, true), sample(120, 60, true)];
    const events = [
      ev(10, 'sleep', 'Clamshell Sleep'),
      ev(20, 'darkwake', 'smc.sysState.Wake(0x70070000) wifibt'),
      ev(21, 'sleep', 'Maintenance Sleep'),
      ev(40, 'darkwake', 'smc.sysState.Wake(0x70070001) wifibt'),
      ev(41, 'darkwake', 'EC.LidOpen/'),
      ev(70, 'wake', 'UserActivity Assertion'),
    ];
    const [sess] = detectSessions(s, events, T0 + 500 * MIN);
    expect(sess!.asleepMin).toBeCloseTo(60, 6);
    expect(sess!.darkWakes).toBe(3);
    expect(sess!.topDarkWakeReasons).toEqual([
      { reason: 'smc.sysState.Wake wifibt', count: 2 },
      { reason: 'EC.LidOpen/', count: 1 },
    ]);
  });

  it('computes awakeDrainPctPerHour from the level drop outside sleep only', () => {
    // asleep 10→70; awake 0→10 (100→98) and 70→130 (97→40): 59 % over 70 awake minutes
    const s = [sample(0, 100, true), sample(10, 98, true), sample(70, 97, true), sample(130, 40, true)];
    const events = [ev(10, 'sleep', 'Clamshell Sleep'), ev(70, 'wake', 'UserActivity Assertion')];
    const [sess] = detectSessions(s, events, T0 + 500 * MIN);
    expect(sess!.drainPctPerHour).toBeCloseTo(60 / (130 / 60), 6);
    expect(sess!.awakeDrainPctPerHour).toBeCloseTo(59 / (70 / 60), 6);
  });

  it('awakeDrainPctPerHour is null without sleep data or with under 5 awake minutes', () => {
    const s = [sample(0, 100, true), sample(60, 70, true)];
    expect(detectSessions(s, [], T0 + 500 * MIN)[0]!.awakeDrainPctPerHour).toBeNull();
    const events = [ev(2, 'sleep'), ev(59, 'wake')];
    expect(detectSessions(s, events, T0 + 500 * MIN)[0]!.awakeDrainPctPerHour).toBeNull();
  });

  it('clips sleep to the session and returns null asleepMin without any events', () => {
    const s = [sample(30, 100, true), sample(90, 70, true)];
    const events = [ev(0, 'sleep'), ev(50, 'wake')];
    expect(detectSessions(s, events, T0 + 500 * MIN)[0]!.asleepMin).toBeCloseTo(20, 6);
    expect(detectSessions(s, [], T0 + 500 * MIN)[0]!.asleepMin).toBeNull();
  });

  it('returns newest first', () => {
    const s = [
      sample(0, 100, true), sample(30, 80, true), sample(31, 80, false),
      sample(60, 80, true), sample(90, 60, true),
    ];
    const r = detectSessions(s, [], T0 + 500 * MIN);
    expect(r.map((x) => x.start)).toEqual([T0 + 60 * MIN, T0]);
  });
});

// ---- appKey / appLabel ----

describe('appKey', () => {
  it('bundle id wins', () => {
    expect(appKey('com.example.agents', 'application.com.example.agents.1.2')).toBe('com.example.agents');
  });
  it('strips application. prefix and the instance suffix', () => {
    expect(appKey('', 'application.com.apple.Terminal.1152921500311914148.1152921500311914153')).toBe(
      'com.apple.Terminal',
    );
  });
  it('strips a UUID-like suffix', () => {
    expect(appKey('', 'com.apple.mdworker.shared.4A9D3C1E-1234-5678-9ABC-DEF012345678')).toBe(
      'com.apple.mdworker.shared',
    );
  });
  it('leaves plain daemon names alone', () => {
    expect(appKey('', 'com.apple.security.syspolicy')).toBe('com.apple.security.syspolicy');
  });
});

describe('appLabel', () => {
  it('curated map beats powerlog names', () => {
    const l = appLabel('com.apple.security.syspolicy', { 'com.apple.security.syspolicy': 'syspolicyd' });
    expect(l.name).toBe('Gatekeeper malware scanning');
    expect(l.description).toMatch(/first time/);
  });
  it('powerlog name is used when not curated', () => {
    expect(appLabel('com.example.agents', { 'com.example.agents': 'Example Agents' })).toEqual({
      name: 'Example Agents',
      description: null,
    });
  });
  it('prettified fallback is never empty and never the raw dotted id', () => {
    expect(appLabel('com.example.foo-bar', {}).name).toBe('foo bar');
    expect(appLabel('com.example.some_thing', {}).name).toBe('some thing');
    expect(appLabel('standalone', {}).name).toBe('standalone');
    for (const k of ['com.example.', '', 'a.b.c']) {
      const n = appLabel(k, {}).name;
      expect(n.length).toBeGreaterThan(0);
      if (k.includes('.') && k.replace(/\./g, '')) expect(n).not.toContain('.');
    }
  });
  it('the curated map stays small and its descriptions short', () => {
    const entries = Object.entries(SYSTEM_LABELS);
    expect(entries.length).toBeGreaterThanOrEqual(25);
    for (const [, l] of entries) expect((l.description ?? '').length).toBeLessThanOrEqual(80);
    expect(SYSTEM_LABELS['com.apple.WindowServer']!.name).toBe('WindowServer');
  });
});

describe('buildNameMap', () => {
  it('app info beats the most frequent process name', () => {
    const m = buildNameMap(
      { 'com.example.agents': 'Example Agents' },
      [
        { bid: 'com.example.agents', name: 'AgentsProcess', c: 9 },
        { bid: 'com.example.browser', name: 'Helper', c: 1 },
        { bid: 'com.example.browser', name: 'ExampleBrowser ', c: 2 },
        { bid: 'com.example.browser', name: 'ExampleBrowser', c: 2 },
        { bid: '', name: 'ignored', c: 100 },
      ],
    );
    expect(m).toEqual({ 'com.example.agents': 'Example Agents', 'com.example.browser': 'ExampleBrowser' });
  });
});

// ---- rankApps / bucketApps ----

const NJ = 3.6e12;
const row = (b: number, bid: string, ln: string, wh: number, extra: Partial<AppBucketRow> = {}): AppBucketRow => ({
  b, bid, ln, e: wh * NJ, cpu: 0, gpu: 0, wk: 0, ...extra,
});
const B0 = Math.floor(T0 / 1000);

describe('rankApps', () => {
  const rows = [
    row(B0, 'com.example.agents', 'application.com.example.agents.1.2', 6, { cpu: 100, gpu: 0.5 * NJ, wk: 1000 }),
    row(B0 + 900, 'com.example.agents', 'application.com.example.agents.1.2', 2),
    row(B0, '', 'com.apple.security.syspolicy', 1.5),
    row(B0, 'com.example.browser', 'x', 0.4),
    row(B0, '', 'application.com.example.Terminal.11.22', 0.1),
    row(B0 + 99_000, 'com.example.late', 'x', 50),
  ];

  it('converts nanojoules to Wh and names the apps', () => {
    const { attributedWh, apps } = rankApps(rows, B0, B0 + 1800, 25, { 'com.example.agents': 'Example Agents' });
    expect(attributedWh).toBeCloseTo(10, 9);
    expect(apps[0]!.key).toBe('com.example.agents');
    expect(apps[0]!.name).toBe('Example Agents');
    expect(apps[0]!.energyWh).toBeCloseTo(8, 9);
    expect(apps[0]!.gpuWh).toBeCloseTo(0.5, 9);
    expect(apps[0]!.cpuSec).toBe(100);
    expect(apps[0]!.wakeups).toBe(1000);
    expect(apps[1]!.name).toBe('Gatekeeper malware scanning');
    expect(apps[1]!.description).not.toBeNull();
    expect(apps.find((a) => a.key === 'com.example.Terminal')!.name).toBe('Terminal');
  });

  it('shares sum to 100', () => {
    const { apps } = rankApps(rows, B0, B0 + 1800);
    expect(apps.reduce((s, a) => s + a.sharePct, 0)).toBeGreaterThan(99.9);
    expect(apps.reduce((s, a) => s + a.sharePct, 0)).toBeLessThan(100.1);
  });

  it('filters by bucket start: fromS <= b < toS', () => {
    const { apps } = rankApps(rows, B0 + 900, B0 + 1800);
    expect(apps.map((a) => a.key)).toEqual(['com.example.agents']);
    expect(apps[0]!.energyWh).toBeCloseTo(2, 9);
  });

  it('rolls the rest into "other"', () => {
    const { apps, attributedWh } = rankApps(rows, B0, B0 + 1800, 2);
    expect(apps).toHaveLength(3);
    const other = apps[2]!;
    expect(other.key).toBe('other');
    expect(other.name).toBe('Other (2 apps)');
    expect(other.energyWh).toBeCloseTo(0.5, 9);
    expect(apps.reduce((s, a) => s + a.energyWh, 0)).toBeCloseTo(attributedWh, 9);
  });

  it('handles an empty range', () => {
    expect(rankApps(rows, 0, 10)).toEqual({ attributedWh: 0, apps: [] });
  });
});

describe('bucketApps', () => {
  const rows = [
    row(B0, 'com.example.agents', 'x', 3),
    row(B0, 'com.example.other1', 'x', 1),
    row(B0 + 1800, 'com.example.agents', 'x', 2),
  ];

  it('zero-fills every 15-minute bucket in the range', () => {
    const b = bucketApps(rows, B0, B0 + 2700, ['com.example.agents']);
    expect(b.map((x) => x.t)).toEqual([B0 * 1000, (B0 + 900) * 1000, (B0 + 1800) * 1000]);
    expect(b[1]!.totalWh).toBe(0);
    expect(b[1]!.byApp).toEqual({ 'com.example.agents': 0, other: 0 });
  });

  it('puts apps outside topKeys under "other"', () => {
    const b = bucketApps(rows, B0, B0 + 2700, ['com.example.agents']);
    expect(b[0]!.byApp['com.example.agents']).toBeCloseTo(3, 9);
    expect(b[0]!.byApp.other).toBeCloseTo(1, 9);
    expect(b[0]!.totalWh).toBeCloseTo(4, 9);
    expect(b[2]!.totalWh).toBeCloseTo(2, 9);
  });
});

// ---- downsample ----

describe('downsample', () => {
  const many = (n: number, flipAt: number[] = []): BatterySample[] => {
    let on = false;
    return Array.from({ length: n }, (_, i) => {
      if (flipAt.includes(i)) on = !on;
      return sample(i, 50, on);
    });
  };

  it('returns everything when under the limit', () => {
    expect(downsample(many(10), 720)).toHaveLength(10);
  });

  it('is <= max and keeps first and last', () => {
    const s = many(5000);
    const d = downsample(s, 720);
    expect(d.length).toBeLessThanOrEqual(720);
    expect(d[0]).toBe(s[0]);
    expect(d[d.length - 1]).toBe(s[s.length - 1]);
  });

  it('keeps every onBattery flip', () => {
    const s = many(5000, [1234, 2500, 4001]);
    const d = downsample(s, 100);
    expect(d.length).toBeLessThanOrEqual(100);
    for (const i of [1234, 2500, 4001]) {
      expect(d).toContain(s[i]);
      expect(d).toContain(s[i - 1]);
    }
  });

  it('stays <= max even with a pathological number of flips', () => {
    const s = many(1000, Array.from({ length: 900 }, (_, i) => i + 1));
    const d = downsample(s, 50);
    expect(d.length).toBeLessThanOrEqual(50);
    expect(d[0]).toBe(s[0]);
    expect(d[d.length - 1]).toBe(s[s.length - 1]);
  });
});

// ---- parseRange ----

describe('parseRange', () => {
  it('accepts a valid range', () => {
    expect(parseRange('1000', '2000')).toEqual({ from: 1000, to: 2000 });
  });
  it('rejects missing, non-numeric, inverted and > 8 day ranges', () => {
    expect('error' in parseRange(null, '1')).toBe(true);
    expect('error' in parseRange('abc', '1')).toBe(true);
    expect('error' in parseRange('5', '5')).toBe(true);
    expect('error' in parseRange('9', '5')).toBe(true);
    expect('error' in parseRange('0', String(9 * 86_400_000))).toBe(true);
    expect('error' in parseRange('0', String(8 * 86_400_000))).toBe(false);
  });
});

// ---- integration against a fixture powerlog ----

const HAVE_SQLITE = existsSync('/usr/bin/sqlite3');

describe('loadPowerlog (fixture databases)', () => {
  it.skipIf(!HAVE_SQLITE)('merges current DB + archive and exposes sessions, names and ranking', async () => {
    clearPowerlogCache();
    const dir = await mkdtemp(join(tmpdir(), 'pd-test-powerlog-'));
    try {
      await mkdir(join(dir, 'Archives'));
      const build = async (sqlFile: string, dbPath: string) => {
        const r = await run('/usr/bin/sqlite3', [dbPath, `.read ${join(FIX, sqlFile)}`], 20_000);
        expect(r.failed).toBe(false);
      };
      await build('fixture.sql', join(dir, 'CurrentPowerlog.PLSQL'));
      const arcDb = join(dir, 'archive-src.PLSQL');
      await build('fixture-archive.sql', arcDb);
      await writeFile(join(dir, 'Archives', 'powerlog_2026-01-01_ABCD.PLSQL.gz'), gzipSync(readFileSync(arcDb)));
      await rm(arcDb);

      const t = (m: number) => new Date(T0 + m * MIN).toISOString().slice(0, 19).replace('T', ' ') + ' +0000';
      const pmset =
        `${t(10)} Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:90%) 5 secs\n` +
        `${t(12)} DarkWake            \tDarkWake from Deep Idle [CDNP] : due to smc.sysState.Wake(0x70070000) wifibt Using BATT (Charge:90%) 5 secs\n` +
        `${t(15)} Wake                \tWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using BATT (Charge:89%)\n`;

      const now = T0 + 40 * MIN;
      const data = await loadPowerlog({ dir, now, pmsetText: pmset });

      expect(data.available).toBe(true);
      expect(data.notes).toEqual([]);
      expect(data.samples).toHaveLength(30); // 0..29, sample 9 is in both DBs
      expect(data.coverage).toEqual({ from: T0 + 500, to: T0 + 29 * MIN + 500 });
      // archive sample (no SystemPower column) uses the amperage x voltage fallback
      expect(data.samples[5]!.watts).toBeCloseTo(11, 6);
      expect(data.samples[15]!.watts).toBe(10);

      const payload = buildBatteryPayload(data, dir, now);
      expect(payload.hasBattery).toBe(true);
      expect(payload.sessions).toHaveLength(1);
      const s = payload.sessions[0]!;
      expect(s.startLevel).toBe(100);
      expect(s.endLevel).toBe(80);
      expect(s.endedBy).toBe('ac');
      expect(s.drainedWh).toBeCloseTo(11, 6);
      expect(s.asleepMin).toBeCloseTo(5, 6);
      expect(s.darkWakes).toBe(1);
      // the shutdown row sits after the covered samples: read as an event, but outside the payload window
      expect(data.events.some((e) => e.kind === 'battery-empty' && e.t === T0 + 3_000_000)).toBe(true);
      expect(payload.events.some((e) => e.kind === 'battery-empty')).toBe(false);
      expect(payload.events.some((e) => e.kind === 'darkwake')).toBe(false);

      expect(data.names['com.example.agents']).toBe('Example Agents'); // current DB beats archive
      expect(data.names['com.example.browser']).toBe('ExampleBrowser'); // process-name fallback

      const apps = buildAppsPayload(data, T0, T0 + 60 * MIN);
      expect(apps.attributedWh).toBeCloseTo(6.5, 9);
      expect(apps.apps.map((a) => [a.key, a.name])).toEqual([
        ['com.example.agents', 'Example Agents'],
        ['com.example.browser', 'ExampleBrowser'],
        ['com.apple.security.syspolicy', 'Gatekeeper malware scanning'],
        ['com.example.Terminal', 'Terminal'],
      ]);
      expect(apps.apps[0]!.energyWh).toBeCloseTo(3, 9); // archive + current rows of one bucket summed
      expect(apps.apps[0]!.sharePct).toBeCloseTo((3 / 6.5) * 100, 6);
      expect(apps.buckets).toHaveLength(4);
      expect(apps.buckets[0]!.byApp['com.example.agents']).toBeCloseTo(3, 9);
      for (const a of apps.apps) expect(a.name).not.toMatch(/^[a-z]+\.[a-z]+\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect((await readdir(tmpdir())).filter((f) => f.startsWith('pd-powerlog-'))).toEqual([]);
  });

  it('reports a missing directory as unavailable, without throwing', async () => {
    const data = await loadPowerlog({ dir: join(tmpdir(), 'pd-does-not-exist'), pmsetText: '' });
    expect(data.available).toBe(false);
    const p = buildBatteryPayload(data, '/x', 0);
    expect(p.available).toBe(false);
    expect(p.note).toMatch(/not readable/);
  });
});
