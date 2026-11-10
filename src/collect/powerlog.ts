import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import os from 'node:os';
import { run } from '../util/exec.js';

/**
 * Battery history from the macOS power log. The powerlog database is world-readable (no sudo)
 * and holds, per minute, the battery level and power draw and, per ~40 s interval, the energy
 * every app ("coalition") used. `pmset -g log` holds the sleep/wake history. Everything here is
 * read after the fact; the original files are never opened — only temp copies.
 *
 * Pure functions (parse / detect / rank) are exported and unit-tested; the I/O half
 * (`loadPowerlog`) is a thin layer over `/usr/bin/sqlite3` and `pmset`.
 */

// ---------- types ----------

export interface BatterySample {
  /** ms since epoch */
  t: number;
  level: number;
  onBattery: boolean;
  charging: boolean;
  watts: number | null;
  rawCapMah: number | null;
  voltageMv: number | null;
}

export type PowerEventKind = 'sleep' | 'wake' | 'darkwake' | 'low-power-sleep' | 'battery-empty';
export interface PowerEvent {
  t: number;
  kind: PowerEventKind;
  reason: string;
  onBattery: boolean | null;
  chargePct: number | null;
}

export interface AppBucketRow {
  /** bucket start, seconds */
  b: number;
  bid: string;
  ln: string;
  /** nanojoules */
  e: number;
  cpu: number;
  gpu: number;
  wk: number;
}

export interface DischargeSession {
  id: string;
  start: number;
  end: number;
  startLevel: number;
  endLevel: number;
  durationMin: number;
  drainPctPerHour: number;
  avgWatts: number | null;
  peakWatts: number | null;
  drainedWh: number | null;
  endedBy: 'ac' | 'empty' | 'ongoing' | 'data-end';
  asleepMin: number | null;
  /** Level drop per hour counting only awake time; null without sleep data or < 5 awake min. */
  awakeDrainPctPerHour: number | null;
  darkWakes: number;
  topDarkWakeReasons: { reason: string; count: number }[];
}

export interface AppEnergy {
  key: string;
  name: string;
  /** Plain-English one-liner for system daemons; null for ordinary apps. */
  description: string | null;
  energyWh: number;
  sharePct: number;
  cpuSec: number;
  gpuWh: number;
  wakeups: number;
}

export interface AppLabel {
  name: string;
  description: string | null;
}

export const BUCKET_SEC = 900;
const NJ_PER_WH = 3.6e12;
const MIN = 60_000;

// ---------- small helpers ----------

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- battery samples ----------

export interface BatteryRow {
  timestamp?: unknown;
  Level?: unknown;
  ExternalConnected?: unknown;
  IsCharging?: unknown;
  SystemPower?: unknown;
  InstantAmperage?: unknown;
  Voltage?: unknown;
  AppleRawCurrentCapacity?: unknown;
}

export function toBatterySamples(rows: BatteryRow[]): BatterySample[] {
  const out: BatterySample[] = [];
  for (const r of rows) {
    const ts = num(r.timestamp);
    const level = num(r.Level);
    if (ts === null || level === null) continue;
    const onBattery = num(r.ExternalConnected) === 0;
    const sysPower = num(r.SystemPower);
    const amps = num(r.InstantAmperage);
    const volts = num(r.Voltage);
    let watts: number | null = null;
    if (sysPower !== null && sysPower > 0) watts = sysPower;
    else if (onBattery && amps !== null && volts !== null) watts = (Math.abs(amps) * volts) / 1e6;
    out.push({
      t: Math.round(ts * 1000),
      level,
      onBattery,
      charging: num(r.IsCharging) === 1,
      watts,
      rawCapMah: num(r.AppleRawCurrentCapacity),
      voltageMv: volts,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- pmset -g log ----------

const PMSET_HEAD = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\s+(.+?)\s*$/;

export function parsePmsetLog(text: string): PowerEvent[] {
  const out: PowerEvent[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const m = PMSET_HEAD.exec(line.slice(0, tab));
    if (!m) continue;
    const type = m[4]!;
    if (type !== 'Sleep' && type !== 'Wake' && type !== 'DarkWake') continue;
    const off = m[3]!;
    const t = Date.parse(`${m[1]}T${m[2]}${off.slice(0, 3)}:${off.slice(3)}`);
    if (!Number.isFinite(t)) continue;
    const msg = line.slice(tab + 1);

    let kind: PowerEventKind;
    let reason = '';
    if (type === 'Sleep') {
      reason = /due to '([^']*)'/.exec(msg)?.[1] ?? '';
      kind = reason === 'Low Power Sleep' ? 'low-power-sleep' : 'sleep';
    } else {
      kind = type === 'Wake' ? 'wake' : 'darkwake';
      reason = /due to (.*?)(?: Using (?:batt|ac)\b|$)/i.exec(msg)?.[1]?.trim() ?? '';
    }
    const onBattery = /Using batt/i.test(msg) ? true : /Using AC/i.test(msg) ? false : null;
    const cp = /Charge:(\d+)%/.exec(msg);
    out.push({
      t,
      kind,
      reason: reason.slice(0, 120),
      onBattery,
      chargePct: cp ? Number(cp[1]) : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- discharge sessions ----------

function normaliseDarkWakeReason(r: string): string {
  return r.replace(/\(0x[0-9a-fA-F]+\)/g, '').replace(/\s+/g, ' ').trim();
}

/** [start, end] ms spans the machine was asleep (Sleep → next Wake; dark wakes do not end sleep). */
function sleepSpans(events: PowerEvent[]): [number, number][] {
  const ev = events
    .filter((e) => e.kind === 'sleep' || e.kind === 'low-power-sleep' || e.kind === 'wake')
    .sort((a, b) => a.t - b.t);
  const spans: [number, number][] = [];
  let start: number | null = null;
  for (const e of ev) {
    if (e.kind === 'wake') {
      if (start !== null) {
        spans.push([start, e.t]);
        start = null;
      }
    } else if (start === null) {
      start = e.t;
    }
  }
  if (start !== null) spans.push([start, Infinity]);
  return spans;
}

export function detectSessions(
  samples: BatterySample[],
  events: PowerEvent[],
  now: number,
): DischargeSession[] {
  const s = [...samples].sort((a, b) => a.t - b.t);
  const spans = sleepSpans(events);
  const sessions: DischargeSession[] = [];

  let i = 0;
  while (i < s.length) {
    if (!s[i]!.onBattery) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < s.length && s[j + 1]!.onBattery) j++;
    const run = s.slice(i, j + 1);
    const next = s[j + 1];
    i = j + 1;

    const first = run[0]!;
    const last = run[run.length - 1]!;
    const start = first.t;
    const end = last.t;
    const durationMin = (end - start) / MIN;
    const drop = first.level - last.level;
    if (!(durationMin >= 10 || drop >= 3)) continue;

    const watts = run.map((x) => x.watts).filter((w): w is number => w !== null);
    const caps = run.filter((x) => x.rawCapMah !== null);
    const volts = run.map((x) => x.voltageMv).filter((v): v is number => v !== null);
    let drainedWh: number | null = null;
    if (caps.length >= 1 && volts.length > 0) {
      const meanV = volts.reduce((a, b) => a + b, 0) / volts.length;
      drainedWh = ((caps[0]!.rawCapMah! - caps[caps.length - 1]!.rawCapMah!) * meanV) / 1e6;
    }

    const emptyNear = events.some(
      (e) =>
        (e.kind === 'battery-empty' || e.kind === 'low-power-sleep') &&
        e.t >= end - 10 * MIN &&
        e.t <= end + 10 * MIN,
    );
    let endedBy: DischargeSession['endedBy'];
    if (emptyNear || last.level <= 2) endedBy = 'empty';
    else if (next && !next.onBattery) endedBy = 'ac';
    else if (now - end < 5 * MIN) endedBy = 'ongoing';
    else endedBy = 'data-end';

    let asleepMs = 0;
    for (const [a, b] of spans) {
      const lo = Math.max(a, start);
      const hi = Math.min(b, end);
      if (hi > lo) asleepMs += hi - lo;
    }
    const inSession = events.filter(
      (e) => e.kind !== 'battery-empty' && e.t >= start && e.t <= end,
    );
    const asleepMin = inSession.length > 0 || asleepMs > 0 ? asleepMs / MIN : null;

    // Awake drain: sum the level drop over sample pairs that are mostly outside a sleep span.
    let awakeDrainPctPerHour: number | null = null;
    const awakeMin = asleepMin === null ? 0 : durationMin - asleepMin;
    if (asleepMin !== null && awakeMin >= 5) {
      let awakeDrop = 0;
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1]!.t;
        const b = run[i]!.t;
        let slept = 0;
        for (const [sa, sb] of spans) slept += Math.max(0, Math.min(b, sb) - Math.max(a, sa));
        if (b > a && slept / (b - a) > 0.5) continue;
        awakeDrop += run[i - 1]!.level - run[i]!.level;
      }
      awakeDrainPctPerHour = Math.max(0, awakeDrop) / (awakeMin / 60);
    }

    const counts = new Map<string, number>();
    let darkWakes = 0;
    for (const e of events) {
      if (e.kind !== 'darkwake' || e.t < start || e.t > end) continue;
      darkWakes++;
      const r = normaliseDarkWakeReason(e.reason) || '(no reason given)';
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const topDarkWakeReasons = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([reason, count]) => ({ reason, count }));

    sessions.push({
      id: String(start),
      start,
      end,
      startLevel: first.level,
      endLevel: last.level,
      durationMin,
      drainPctPerHour: durationMin > 0 ? Math.max(0, drop) / (durationMin / 60) : 0,
      avgWatts: watts.length ? watts.reduce((a, b) => a + b, 0) / watts.length : null,
      peakWatts: watts.length ? Math.max(...watts) : null,
      drainedWh,
      endedBy,
      asleepMin,
      awakeDrainPctPerHour,
      darkWakes,
      topDarkWakeReasons,
    });
  }
  return sessions.sort((a, b) => b.start - a.start);
}

// ---------- app identity ----------

/** The stable key an app is grouped under. */
export function appKey(bid: string, ln: string): string {
  if (bid && bid.trim()) return bid.trim();
  let k = (ln ?? '').trim();
  k = k.replace(/^application\./, '');
  k = k.replace(/\.\d+\.\d+$/, '');
  k = k.replace(/\.[0-9A-Fa-f-]{20,}$/, '');
  return k;
}

/**
 * Curated names for system daemons that have no app name of their own. Descriptions say what
 * the thing is and why it costs energy; keep them <= 80 chars.
 */
export const SYSTEM_LABELS: Record<string, AppLabel> = {
  'com.apple.security.syspolicy': {
    name: 'Gatekeeper malware scanning',
    description: 'checks programs the first time they run; spikes when many new binaries appear',
  },
  'com.apple.XprotectFramework.AnalysisService': {
    name: 'XProtect malware scanning',
    description: 'scans new or changed files for known malware',
  },
  'com.apple.XprotectFramework.PluginService': {
    name: 'XProtect malware scanning',
    description: 'scans new or changed files for known malware',
  },
  'com.apple.WindowServer': { name: 'WindowServer', description: 'draws the screen' },
  'com.apple.kernel_task': {
    name: 'macOS kernel',
    description: 'core of macOS: drivers, memory, thermal management',
  },
  'com.apple.Spotlight': {
    name: 'Spotlight indexing',
    description: 'search and the index of your files and mail',
  },
  'com.apple.mds': { name: 'Spotlight indexing', description: 'keeps the file search index up to date' },
  'com.apple.mds_stores': { name: 'Spotlight indexing', description: 'keeps the file search index up to date' },
  'com.apple.spotlightknowledged': {
    name: 'Spotlight suggestions',
    description: 'builds knowledge for Siri and Spotlight suggestions',
  },
  'com.apple.spotlightknowledged.updater': {
    name: 'Spotlight suggestions',
    description: 'builds knowledge for Siri and Spotlight suggestions',
  },
  'com.apple.corespotlightd': {
    name: 'Spotlight app indexing',
    description: 'indexes content that apps hand to Spotlight',
  },
  'com.apple.backupd': { name: 'Time Machine', description: 'backs up your files' },
  'com.apple.backup.launcher': { name: 'Time Machine', description: 'starts and schedules backups' },
  'com.apple.photoanalysisd': {
    name: 'Photos analysis',
    description: 'finds faces and scenes in your photo library',
  },
  'com.apple.mediaanalysisd': {
    name: 'Media analysis',
    description: 'scans photos and videos for faces, objects and text',
  },
  'com.apple.cloudd': { name: 'iCloud sync', description: 'syncs iCloud data for apps' },
  'com.apple.bird': { name: 'iCloud Drive sync', description: 'syncs iCloud Drive files' },
  'com.apple.fseventsd': {
    name: 'File change tracking',
    description: 'records which files changed, for Spotlight and backups',
  },
  'com.apple.controlcenter': { name: 'Control Center', description: 'menu bar controls and status' },
  'com.apple.SystemUIServer.agent': { name: 'Menu bar', description: 'draws menu bar items (SystemUIServer)' },
  'com.apple.duetexpertd': {
    name: 'Siri suggestions',
    description: 'predicts which apps you use, for suggestions and battery features',
  },
  'com.apple.suggestd': { name: 'Siri suggestions', description: 'learns from mail, messages and contacts' },
  'com.apple.textunderstandingd': {
    name: 'Text understanding',
    description: 'analyses on-screen and in-app text for suggestions',
  },
  'com.apple.sysmond': { name: 'System monitor', description: 'collects process statistics for Activity Monitor' },
  'com.apple.notifyd': { name: 'Notifications daemon', description: 'delivers system notifications' },
  'com.apple.driver.AppleCentauriAlpha': {
    name: 'Wireless chip driver',
    description: 'Wi-Fi and Bluetooth hardware driver',
  },
  'com.apple.airportd': { name: 'Wi-Fi', description: 'manages Wi-Fi connections and scans' },
  'com.apple.audio.coreaudiod': { name: 'Core Audio', description: 'plays and routes all sound' },
  'com.apple.coreservices.launchservicesd': {
    name: 'Launch Services',
    description: 'tracks which app opens which file',
  },
  'com.apple.opendirectoryd': { name: 'Directory services', description: 'user accounts and login lookups' },
  'com.apple.logd': { name: 'System logging', description: 'writes the unified system log' },
  'com.apple.trustd': { name: 'Certificate checks', description: 'verifies certificates for secure connections' },
  'com.apple.trustd.agent': { name: 'Certificate checks', description: 'verifies certificates for secure connections' },
  'com.apple.symptomsd': { name: 'Network diagnostics', description: 'watches network quality and problems' },
  'com.apple.loginwindow': { name: 'Login window', description: 'the login screen and session handling' },
  'com.microsoft.VSCode': { name: 'Visual Studio Code', description: null },
  'com.microsoft.update.agent': { name: 'Microsoft AutoUpdate', description: 'checks for Office and Teams updates' },
};

function prettify(key: string): string {
  const seg = key.split('.').filter(Boolean).pop() ?? key;
  const out = seg.replace(/[-_]+/g, ' ').trim();
  return out || key || 'Unknown';
}

/** Resolve a human name (and optional description) for an app key. Never returns an empty name. */
export function appLabel(key: string, names: Record<string, string> = {}): AppLabel {
  const curated = SYSTEM_LABELS[key];
  if (curated) return curated;
  const n = names[key]?.trim();
  if (n) return { name: n, description: null };
  return { name: prettify(key), description: null };
}

/**
 * Merge the two powerlog name sources into one map. App info (LSDisplayName / CFDisplayName /
 * Name per bundle id) beats the process-name fallback (most frequent ProcessName per bundle id).
 */
export function buildNameMap(
  appInfo: Record<string, string>,
  processCounts: { bid: string; name: string; c: number }[],
): Record<string, string> {
  const best = new Map<string, Map<string, number>>();
  for (const r of processCounts) {
    const name = r.name.trim();
    if (!r.bid || !name) continue;
    const m = best.get(r.bid) ?? new Map<string, number>();
    m.set(name, (m.get(name) ?? 0) + r.c);
    best.set(r.bid, m);
  }
  const out: Record<string, string> = {};
  for (const [bid, m] of best) {
    const top = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) out[bid] = top[0];
  }
  for (const [bid, name] of Object.entries(appInfo)) {
    if (bid && name.trim()) out[bid] = name.trim();
  }
  return out;
}

// ---------- app energy ranking ----------

export function rankApps(
  rows: AppBucketRow[],
  fromS: number,
  toS: number,
  topN = 25,
  names: Record<string, string> = {},
): { attributedWh: number; apps: AppEnergy[] } {
  const groups = new Map<string, { e: number; cpu: number; gpu: number; wk: number }>();
  for (const r of rows) {
    if (!(r.b >= fromS && r.b < toS)) continue;
    const k = appKey(r.bid, r.ln) || '(unknown)';
    const g = groups.get(k) ?? { e: 0, cpu: 0, gpu: 0, wk: 0 };
    g.e += r.e;
    g.cpu += r.cpu;
    g.gpu += r.gpu;
    g.wk += r.wk;
    groups.set(k, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].e - a[1].e);
  const attributedWh = sorted.reduce((s, [, g]) => s + g.e, 0) / NJ_PER_WH;
  const share = (wh: number) => (attributedWh > 0 ? (wh / attributedWh) * 100 : 0);

  const toApp = (key: string, g: { e: number; cpu: number; gpu: number; wk: number }): AppEnergy => {
    const label = appLabel(key, names);
    const energyWh = g.e / NJ_PER_WH;
    return {
      key,
      name: label.name,
      description: label.description,
      energyWh,
      sharePct: share(energyWh),
      cpuSec: g.cpu,
      gpuWh: g.gpu / NJ_PER_WH,
      wakeups: g.wk,
    };
  };
  const apps = sorted.slice(0, topN).map(([k, g]) => toApp(k, g));
  const rest = sorted.slice(topN);
  if (rest.length) {
    const sum = rest.reduce(
      (a, [, g]) => ({ e: a.e + g.e, cpu: a.cpu + g.cpu, gpu: a.gpu + g.gpu, wk: a.wk + g.wk }),
      { e: 0, cpu: 0, gpu: 0, wk: 0 },
    );
    const o = toApp('other', sum);
    o.name = `Other (${rest.length} apps)`;
    o.description = null;
    apps.push(o);
  }
  return { attributedWh, apps };
}

export interface AppBucket {
  /** ms */
  t: number;
  totalWh: number;
  byApp: Record<string, number>;
}

export function bucketApps(
  rows: AppBucketRow[],
  fromS: number,
  toS: number,
  topKeys: string[],
): AppBucket[] {
  const top = new Set(topKeys);
  const start = Math.floor(fromS / BUCKET_SEC) * BUCKET_SEC;
  const buckets = new Map<number, AppBucket>();
  for (let b = start; b < toS; b += BUCKET_SEC) {
    const byApp: Record<string, number> = { other: 0 };
    for (const k of topKeys) byApp[k] = 0;
    buckets.set(b, { t: b * 1000, totalWh: 0, byApp });
  }
  for (const r of rows) {
    const bk = buckets.get(r.b);
    if (!bk) continue;
    const key = appKey(r.bid, r.ln) || '(unknown)';
    const wh = r.e / NJ_PER_WH;
    const slot = top.has(key) ? key : 'other';
    bk.byApp[slot] = (bk.byApp[slot] ?? 0) + wh;
    bk.totalWh += wh;
  }
  return [...buckets.values()];
}

// ---------- downsampling ----------

export function downsample(samples: BatterySample[], max = 720): BatterySample[] {
  const n = samples.length;
  if (n <= max) return [...samples];
  const must = new Set<number>([0, n - 1]);
  for (let i = 1; i < n; i++) {
    if (samples[i]!.onBattery !== samples[i - 1]!.onBattery) {
      must.add(i - 1);
      must.add(i);
    }
  }
  let required = [...must].sort((a, b) => a - b);
  if (required.length > max) {
    // Pathological flip count: thin the required set uniformly, always keeping first and last.
    const keep: number[] = [];
    for (let k = 0; k < max; k++) keep.push(required[Math.round((k * (required.length - 1)) / (max - 1))]!);
    required = [...new Set(keep)];
  }
  const chosen = new Set(required);
  const budget = max - chosen.size;
  for (let k = 1; k <= budget; k++) chosen.add(Math.round((k * (n - 1)) / (budget + 1)));
  return [...chosen]
    .sort((a, b) => a - b)
    .slice(0, max)
    .map((i) => samples[i]!);
}

// ---------- endpoint payloads (pure) ----------

export interface BatteryPayload {
  available: boolean;
  note?: string;
  hasBattery: boolean;
  coverage: { from: number; to: number } | null;
  samples: BatterySample[];
  sessions: DischargeSession[];
  events: PowerEvent[];
}

export function buildBatteryPayload(data: PowerlogData, dir: string, now: number): BatteryPayload {
  if (!data.available) {
    return {
      available: false,
      note: data.notes[0] ?? `macOS power log not readable at ${dir}`,
      hasBattery: false,
      coverage: null,
      samples: [],
      sessions: [],
      events: [],
    };
  }
  const hasBattery = data.samples.length > 0;
  const cov = data.coverage;
  return {
    available: true,
    ...(data.notes.length ? { note: data.notes.join(' · ') } : {}),
    hasBattery,
    coverage: cov,
    samples: downsample(data.samples, 720),
    sessions: hasBattery ? detectSessions(data.samples, data.events, now) : [],
    events: data.events.filter(
      (e) => e.kind !== 'darkwake' && (!cov || (e.t >= cov.from && e.t <= cov.to)),
    ),
  };
}

export const MAX_RANGE_MS = 8 * 86_400_000;

/** Validate ?from=&to= (ms). Returns the parsed range or an error message for a 400. */
export function parseRange(
  fromStr: string | null,
  toStr: string | null,
): { from: number; to: number } | { error: string } {
  if (fromStr === null || toStr === null) return { error: 'from and to (ms since epoch) are required' };
  if (!/^\d+(\.\d+)?$/.test(fromStr) || !/^\d+(\.\d+)?$/.test(toStr)) {
    return { error: 'from and to must be numbers (ms since epoch)' };
  }
  const from = Number(fromStr);
  const to = Number(toStr);
  if (!(from < to)) return { error: 'from must be earlier than to' };
  if (to - from > MAX_RANGE_MS) return { error: 'range is longer than 8 days' };
  return { from, to };
}

export interface AppsPayload {
  from: number;
  to: number;
  bucketSec: number;
  attributedWh: number;
  apps: AppEnergy[];
  buckets: AppBucket[];
}

export function buildAppsPayload(data: PowerlogData, from: number, to: number): AppsPayload {
  // Rows are keyed by the START of a 15-minute bucket; snap `from` down so the bucket the window
  // opens in is included (otherwise the first, often busiest, minutes of a session are lost).
  const fromS = Math.floor(from / 1000 / BUCKET_SEC) * BUCKET_SEC;
  const toS = to / 1000;
  const { attributedWh, apps } = rankApps(data.appRows, fromS, toS, 25, data.names);
  const topKeys = apps.filter((a) => a.key !== 'other').slice(0, 5).map((a) => a.key);
  return {
    from,
    to,
    bucketSec: BUCKET_SEC,
    attributedWh,
    apps,
    buckets: bucketApps(data.appRows, fromS, toS, topKeys),
  };
}

// ---------- I/O ----------

export const DEFAULT_POWERLOG_DIR = '/var/db/powerlog/Library/BatteryLife';
const SQLITE = '/usr/bin/sqlite3';

export interface PowerlogData {
  available: boolean;
  notes: string[];
  samples: BatterySample[];
  events: PowerEvent[];
  appRows: AppBucketRow[];
  names: Record<string, string>;
  coverage: { from: number; to: number } | null;
}

interface DbData {
  ok: boolean;
  error?: string;
  samples: BatterySample[];
  appRows: AppBucketRow[];
  shutdowns: number[];
  appInfo: Record<string, string>;
  processCounts: { bid: string; name: string; c: number }[];
}

const emptyDb = (): DbData => ({
  ok: true,
  samples: [],
  appRows: [],
  shutdowns: [],
  appInfo: {},
  processCounts: [],
});

type Row = Record<string, unknown>;

async function sqliteJson(db: string, sql: string): Promise<{ rows: Row[]; error?: string }> {
  const r = await run(SQLITE, ['-json', db, sql], 20_000);
  if (r.failed) return { rows: [], error: (r.stderr || `sqlite3 exited with code ${r.code}`).trim() };
  const out = r.stdout.trim();
  if (!out) return { rows: [] };
  try {
    return { rows: JSON.parse(out) as Row[] };
  } catch {
    return { rows: [], error: 'sqlite3 returned unparseable output' };
  }
}

const T_BATTERY = 'PLBatteryAgent_EventBackward_Battery';
const T_COALITION = 'PLCoalitionAgent_EventInterval_CoalitionInterval';
const T_SHUTDOWN = 'PLBatteryAgent_EventPoint_BatteryShutdown';
const T_APPINFO = 'PLApplicationAgent_EventNone_AppInfo';
const T_PROCMON = 'PLProcessMonitorAgent_EventInterval_ProcessMonitorInterval_Dynamic';

/** Query one (already copied) powerlog database. Missing tables/columns degrade to empty parts. */
async function readDb(db: string): Promise<DbData> {
  const out = emptyDb();
  const schemaSql =
    "select m.name as tbl, p.name as col from sqlite_master m, pragma_table_info(m.name) p " +
    "where m.type='table' and m.name in (" +
    [T_BATTERY, T_COALITION, T_SHUTDOWN, T_APPINFO, T_PROCMON].map((t) => `'${t}'`).join(',') +
    ')';
  const schema = await sqliteJson(db, schemaSql);
  if (schema.error) return { ...out, ok: false, error: schema.error };
  const cols = new Map<string, Set<string>>();
  for (const r of schema.rows) {
    const t = String(r.tbl);
    if (!cols.has(t)) cols.set(t, new Set());
    cols.get(t)!.add(String(r.col));
  }
  const has = (t: string, c: string) => cols.get(t)?.has(c) ?? false;
  const errors: string[] = [];

  if (has(T_BATTERY, 'timestamp') && has(T_BATTERY, 'Level')) {
    const want = [
      'ExternalConnected',
      'IsCharging',
      'SystemPower',
      'InstantAmperage',
      'Voltage',
      'AppleRawCurrentCapacity',
    ];
    const sel = want.map((c) => (has(T_BATTERY, c) ? c : `null as ${c}`)).join(', ');
    const r = await sqliteJson(db, `select timestamp, Level, ${sel} from ${T_BATTERY} order by timestamp`);
    if (r.error) errors.push(r.error);
    else out.samples = toBatterySamples(r.rows as BatteryRow[]);
  }

  if (has(T_COALITION, 'timestamp') && has(T_COALITION, 'energy')) {
    const col = (c: string, fallback: string) => (has(T_COALITION, c) ? c : fallback);
    const sql =
      `select cast(timestamp/${BUCKET_SEC} as int)*${BUCKET_SEC} as b, ` +
      `${has(T_COALITION, 'BundleId') ? "coalesce(BundleId,'')" : "''"} as bid, ` +
      `${has(T_COALITION, 'LaunchdName') ? "coalesce(LaunchdName,'')" : "''"} as ln, ` +
      `coalesce(sum(energy),0) as e, coalesce(sum(${col('cpu_time', '0')}),0) as cpu, ` +
      `coalesce(sum(${col('gpu_energy_nj', '0')}),0) as gpu, coalesce(sum(${col('interrupt_wakeups', '0')}),0) as wk ` +
      `from ${T_COALITION} group by 1,2,3`;
    const r = await sqliteJson(db, sql);
    if (r.error) errors.push(r.error);
    else {
      out.appRows = r.rows.map((x) => ({
        b: num(x.b) ?? 0,
        bid: String(x.bid ?? ''),
        ln: String(x.ln ?? ''),
        e: num(x.e) ?? 0,
        cpu: num(x.cpu) ?? 0,
        gpu: num(x.gpu) ?? 0,
        wk: num(x.wk) ?? 0,
      }));
    }
  }

  if (has(T_SHUTDOWN, 'BatteryShutdownTimestamp')) {
    const r = await sqliteJson(db, `select BatteryShutdownTimestamp as ts from ${T_SHUTDOWN}`);
    if (!r.error) out.shutdowns = r.rows.map((x) => num(x.ts)).filter((v): v is number => v !== null && v > 0);
  }

  if (has(T_APPINFO, 'BundleID')) {
    const parts = ['LSDisplayName', 'CFDisplayName', 'Name']
      .filter((c) => has(T_APPINFO, c))
      .map((c) => `nullif(${c},'')`);
    if (parts.length) {
      const order = has(T_APPINFO, 'timestamp') ? 'max(timestamp)' : '0';
      const sql =
        `select BundleID as bid, coalesce(${parts.join(',')}) as nm, ${order} as ts from ${T_APPINFO} ` +
        `where BundleID is not null and BundleID<>'' and coalesce(${parts.join(',')}) is not null group by BundleID`;
      const r = await sqliteJson(db, sql);
      if (!r.error) {
        for (const x of r.rows) {
          const bid = String(x.bid ?? '');
          const nm = String(x.nm ?? '').trim();
          if (bid && nm) out.appInfo[bid] = nm;
        }
      }
    }
  }

  if (has(T_PROCMON, 'BundleID') && has(T_PROCMON, 'ProcessName')) {
    const sql =
      `select BundleID as bid, ProcessName as pn, count(*) as c from ${T_PROCMON} ` +
      `where BundleID is not null and BundleID<>'' and ProcessName is not null group by 1,2`;
    const r = await sqliteJson(db, sql);
    if (!r.error) {
      out.processCounts = r.rows.map((x) => ({
        bid: String(x.bid ?? ''),
        name: String(x.pn ?? ''),
        c: num(x.c) ?? 0,
      }));
    }
  }

  if (errors.length) return { ...out, ok: false, error: errors[0] };
  return out;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(os.tmpdir(), 'pd-powerlog-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Copy the live DB (+ WAL and SHM, whichever exist) to a temp dir and read the copy. Retries once. */
async function readCurrent(dir: string): Promise<DbData> {
  const src = join(dir, 'CurrentPowerlog.PLSQL');
  let last: DbData = { ...emptyDb(), ok: false, error: 'not attempted' };
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await withTempDir(async (tmp) => {
      try {
        const dst = join(tmp, 'CurrentPowerlog.PLSQL');
        await copyFile(src, dst);
        for (const ext of ['-wal', '-shm']) {
          if (await exists(src + ext)) await copyFile(src + ext, dst + ext).catch(() => undefined);
        }
        return await readDb(dst);
      } catch (err) {
        return { ...emptyDb(), ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    if (last.ok) return last;
  }
  return last;
}

async function readArchive(file: string): Promise<DbData> {
  return withTempDir(async (tmp) => {
    try {
      const dst = join(tmp, 'archive.PLSQL');
      await pipeline(createReadStream(file), createGunzip(), createWriteStream(dst));
      return await readDb(dst);
    } catch (err) {
      return { ...emptyDb(), ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

const archiveCache = new Map<string, Promise<DbData>>();
const LIVE_TTL_MS = 60_000;
const liveCache = new Map<string, { at: number; p: Promise<PowerlogData> }>();

/** Test hook. */
export function clearPowerlogCache(): void {
  archiveCache.clear();
  liveCache.clear();
}

function cachedArchive(file: string): Promise<DbData> {
  let p = archiveCache.get(file);
  if (!p) {
    p = readArchive(file);
    archiveCache.set(file, p);
    // Archives are immutable, so a good result is kept forever; a failure is retried next time.
    void p.then((d) => {
      if (!d.ok) archiveCache.delete(file);
    });
  }
  return p;
}

export interface LoadOptions {
  dir?: string;
  now?: number;
  /** Supply `pmset -g log` output instead of running it (tests). Also bypasses the 60 s cache. */
  pmsetText?: string;
}

export function powerlogDir(opts: LoadOptions = {}): string {
  return opts.dir ?? process.env.PD_POWERLOG_DIR ?? DEFAULT_POWERLOG_DIR;
}

async function loadUncached(dir: string, pmsetText: string | undefined): Promise<PowerlogData> {
  const notes: string[] = [];
  const hasCurrent = await exists(join(dir, 'CurrentPowerlog.PLSQL'));
  let archives: string[] = [];
  try {
    archives = (await readdir(join(dir, 'Archives')))
      .filter((f) => /^powerlog_.*\.PLSQL\.gz$/.test(f))
      .sort()
      .map((f) => join(dir, 'Archives', f));
  } catch {
    /* no archives */
  }
  if (!hasCurrent && archives.length === 0) {
    return {
      available: false,
      notes: [`macOS power log not readable at ${dir}`],
      samples: [],
      events: [],
      appRows: [],
      names: {},
      coverage: null,
    };
  }

  const pmsetP: Promise<string> =
    pmsetText !== undefined
      ? Promise.resolve(pmsetText)
      : run('/usr/bin/pmset', ['-g', 'log'], 30_000).then((r) => {
          if (r.failed && !r.stdout) notes.push('pmset -g log failed — sleep/wake history unavailable');
          return r.stdout;
        });
  const currentP = hasCurrent ? readCurrent(dir) : Promise.resolve(emptyDb());
  const archiveDbs: DbData[] = [];
  for (const a of archives) archiveDbs.push(await cachedArchive(a));
  const [current, pmset] = await Promise.all([currentP, pmsetP]);

  // Oldest first, current last, so the newest data wins on duplicates / names.
  const dbs = [...archiveDbs, current];
  if (!current.ok) notes.push(`current power log unreadable (${current.error ?? 'unknown error'})`);
  const badArchives = archiveDbs.filter((d) => !d.ok).length;
  if (badArchives) notes.push(`${badArchives} archived power log(s) could not be read`);

  const sampleMap = new Map<number, BatterySample>();
  const rowMap = new Map<string, AppBucketRow>();
  const appInfo: Record<string, string> = {};
  const procCounts: { bid: string; name: string; c: number }[] = [];
  const shutdowns = new Set<number>();
  for (const d of dbs) {
    for (const s of d.samples) sampleMap.set(s.t, s);
    for (const r of d.appRows) {
      const k = `${r.b}|${r.bid}|${r.ln}`;
      const e = rowMap.get(k);
      if (e) {
        e.e += r.e;
        e.cpu += r.cpu;
        e.gpu += r.gpu;
        e.wk += r.wk;
      } else rowMap.set(k, { ...r });
    }
    Object.assign(appInfo, d.appInfo);
    procCounts.push(...d.processCounts);
    for (const s of d.shutdowns) shutdowns.add(Math.round(s * 1000));
  }

  const samples = [...sampleMap.values()].sort((a, b) => a.t - b.t);
  const appRows = [...rowMap.values()];
  const events: PowerEvent[] = parsePmsetLog(pmset);
  for (const t of shutdowns) {
    events.push({ t, kind: 'battery-empty', reason: 'Battery ran empty', onBattery: true, chargePct: null });
  }
  events.sort((a, b) => a.t - b.t);

  let coverage: { from: number; to: number } | null = null;
  if (samples.length) coverage = { from: samples[0]!.t, to: samples[samples.length - 1]!.t };
  else if (appRows.length) {
    const bs = appRows.map((r) => r.b);
    coverage = { from: Math.min(...bs) * 1000, to: (Math.max(...bs) + BUCKET_SEC) * 1000 };
  }

  return {
    available: (hasCurrent && current.ok) || archiveDbs.some((d) => d.ok),
    notes,
    samples,
    events,
    appRows,
    names: buildNameMap(appInfo, procCounts),
    coverage,
  };
}

/**
 * Read the macOS power log (current DB + archives) and `pmset -g log`. Never throws: problems
 * come back as `notes` with whatever partial data could be read. The live DB and pmset results
 * are cached for 60 s (concurrent callers share one in-flight promise); archives forever.
 */
export function loadPowerlog(opts: LoadOptions = {}): Promise<PowerlogData> {
  const dir = powerlogDir(opts);
  const guarded = (): Promise<PowerlogData> =>
    loadUncached(dir, opts.pmsetText).catch((err) => ({
      available: false,
      notes: [`power log failed: ${err instanceof Error ? err.message : String(err)}`],
      samples: [],
      events: [],
      appRows: [],
      names: {},
      coverage: null,
    }));
  if (opts.pmsetText !== undefined) return guarded();
  const now = opts.now ?? Date.now();
  const hit = liveCache.get(dir);
  if (hit && now - hit.at < LIVE_TTL_MS) return hit.p;
  const p = guarded();
  liveCache.set(dir, { at: now, p });
  return p;
}
