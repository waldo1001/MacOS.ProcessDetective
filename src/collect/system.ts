import { run } from '../util/exec.js';

/** A labelled slice of physical memory (tiles the RAM bar). */
export interface MemSegment { label: string; bytes: number; }

export interface SystemStats {
  at: number;
  host: { model: string; chip: string; memBytes: number; uptimeSeconds: number };
  cpu: {
    usagePct: number; user: number; sys: number; idle: number;
    loadAvg: [number, number, number];
    cores: { total: number; physical: number; performance: number; efficiency: number };
  };
  processes: { total: number; running: number; threads: number };
  memory: {
    totalBytes: number; usedBytes: number; usedPct: number;
    pressure: 'normal' | 'warning' | 'critical' | 'unknown';
    cachedBytes: number; segments: MemSegment[];
    swap: { totalBytes: number; usedBytes: number };
  };
  network: {
    rxBytesPerSec: number; txBytesPerSec: number;
    rxTotalBytes: number; txTotalBytes: number;
    connections: { established: number; listen: number; udp: number };
    interfaces: { name: string; rxBytes: number; txBytes: number }[];
    ports: { port: number; pid: number; command: string }[];
  };
  disk: {
    readBytesPerSec: number; writeBytesPerSec: number;
    readTotalBytes: number; writeTotalBytes: number;
  };
  storage: {
    volumes: {
      name: string; mount: string; totalBytes: number;
      /** For `/`: `total − Available` (the APFS container's usage). Elsewhere: the `Used` column. */
      usedBytes: number; usedPct: number;
      /** The `Available` column of `df -k` (the real free space; `total − Used` over-reports it on APFS). */
      availBytes: number;
    }[];
  };
  /** The detective's own server footprint — watch this for leaks over long uptimes. */
  server: { rssBytes: number; uptimeSeconds: number };
  power: {
    hasBattery: boolean; batteryPct: number | null; charging: boolean | null;
    source: string | null; thermalNominal: boolean;
  };
}

const PAGE = 16384; // overridden from vm_stat header when present

// Rate-based metrics remember the previous cumulative counters.
let lastNet: { t: number; rx: number; tx: number } | null = null;
let lastDisk: { t: number; r: number; w: number } | null = null;

/** Convert a top-style size token ("320G", "2754M") to bytes. */
function unitBytes(v: string, unit: string): number {
  const n = parseFloat(v);
  const m: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return n * (m[unit.toUpperCase()] ?? 1);
}

function parsePorts(out: string): { port: number; pid: number; command: string }[] {
  const seen = new Set<number>();
  const ports: { port: number; pid: number; command: string }[] = [];
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('COMMAND')) continue;
    const c = line.trim().split(/\s+/);
    if (c.length < 9) continue;
    // The address token ("*:7000" / "127.0.0.1:5432") is followed by "(LISTEN)";
    // scan from the end for the first field ending in :<port>.
    let port = 0;
    for (let i = c.length - 1; i >= 0; i--) {
      const pm = c[i]!.match(/:(\d+)$/);
      if (pm) { port = parseInt(pm[1]!, 10); break; }
    }
    if (!port || seen.has(port)) continue;
    seen.add(port);
    ports.push({ port, pid: parseInt(c[1]!, 10) || 0, command: c[0]!.replace(/\\x20/g, ' ') });
  }
  return ports.sort((a, b) => a.port - b.port);
}

function num(s: string | undefined): number {
  const n = parseFloat((s ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Parse `vm_stat` into a page-count map keyed by the human label. */
function parseVmStat(out: string): { pageSize: number; pages: Record<string, number> } {
  const pages: Record<string, number> = {};
  let pageSize = PAGE;
  const head = out.match(/page size of (\d+) bytes/);
  if (head) pageSize = parseInt(head[1]!, 10);
  for (const line of out.split('\n')) {
    const m = line.match(/^(.*?):\s+(\d+)\.?\s*$/);
    if (m) pages[m[1]!.trim().toLowerCase()] = parseInt(m[2]!, 10);
  }
  return { pageSize, pages };
}

function parseSwap(out: string): { totalBytes: number; usedBytes: number } {
  // total = 3072.00M  used = 2239.31M  free = 832.69M
  const mb = (re: RegExp): number => {
    const m = out.match(re);
    if (!m) return 0;
    const v = parseFloat(m[1]!);
    const unit = m[2]!.toUpperCase();
    const mult = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : unit === 'K' ? 1024 : 1;
    return v * mult;
  };
  return {
    totalBytes: mb(/total = ([\d.]+)([KMG])/),
    usedBytes: mb(/used = ([\d.]+)([KMG])/),
  };
}

export function parseDf(out: string): SystemStats['storage']['volumes'] {
  const vols: SystemStats['storage']['volumes'] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 9 || !c[0]!.startsWith('/dev/')) continue;
    const totalBytes = num(c[1]) * 1024;
    const availBytes = num(c[3]) * 1024;
    const mount = c.slice(8).join(' ');
    // APFS volumes share a container; collapse to the most useful mounts only.
    if (!(mount === '/' || mount.startsWith('/Volumes/'))) continue;
    if (seen.has(mount) || totalBytes === 0) continue;
    seen.add(mount);
    // `/` is the sealed system snapshot: its `Used` column (~12 GB) leaves out the Data volume
    // and every other volume in the container. `total − Available` is the container's real
    // usage (what Finder and `diskutil apfs list` show). Not for /Volumes/*: a sparse disk
    // image (Time Machine on a NAS) reports its virtual size as total, so there it would
    // claim terabytes used — keep the `Used` column.
    const usedBytes = mount === '/' ? Math.max(0, totalBytes - availBytes) : num(c[2]) * 1024;
    vols.push({
      name: mount === '/' ? 'Macintosh HD' : mount.replace('/Volumes/', ''),
      mount,
      totalBytes,
      usedBytes,
      usedPct: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
      availBytes,
    });
  }
  return vols;
}

/** Sum cumulative rx/tx bytes per interface (first row per name avoids double counting). */
function parseNetInterfaces(out: string): { name: string; rxBytes: number; txBytes: number }[] {
  const seen = new Set<string>();
  const ifs: { name: string; rxBytes: number; txBytes: number }[] = [];
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[0]!;
    if (seen.has(name) || /^lo\d/.test(name)) continue;
    // Columns from the right are stable: Coll Obytes Oerrs Opkts Ibytes ...
    const obytes = num(f[f.length - 2]);
    const ibytes = num(f[f.length - 5]);
    if (ibytes === 0 && obytes === 0) continue;
    seen.add(name);
    ifs.push({ name, rxBytes: ibytes, txBytes: obytes });
  }
  return ifs;
}

function parseConnections(out: string): { established: number; listen: number; udp: number } {
  let established = 0;
  let listen = 0;
  let udp = 0;
  for (const line of out.split('\n')) {
    if (/^udp/.test(line)) udp++;
    else if (/ESTABLISHED\s*$/.test(line)) established++;
    else if (/LISTEN\s*$/.test(line)) listen++;
  }
  return { established, listen, udp };
}

function parseTop(out: string) {
  const cpu = out.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
  const proc = out.match(/Processes:\s*(\d+) total,\s*(\d+) running/);
  const threads = out.match(/(\d+) threads/);
  const user = cpu ? parseFloat(cpu[1]!) : 0;
  const sys = cpu ? parseFloat(cpu[2]!) : 0;
  const idle = cpu ? parseFloat(cpu[3]!) : 0;
  return {
    user, sys, idle, usagePct: Math.max(0, 100 - idle),
    total: proc ? parseInt(proc[1]!, 10) : 0,
    running: proc ? parseInt(proc[2]!, 10) : 0,
    threads: threads ? parseInt(threads[1]!, 10) : 0,
  };
}

function parseBattery(out: string): SystemStats['power'] {
  const hasBattery = /InternalBattery/.test(out);
  const srcM = out.match(/Now drawing from '([^']+)'/);
  const source = srcM ? srcM[1]! : null;
  let batteryPct: number | null = null;
  let charging: boolean | null = null;
  if (hasBattery) {
    const pm = out.match(/(\d+)%/);
    batteryPct = pm ? parseInt(pm[1]!, 10) : null;
    charging = /charging/i.test(out) && !/discharging/i.test(out);
  }
  return { hasBattery, batteryPct, charging, source, thermalNominal: true };
}

function bootSeconds(boottime: string): number {
  const m = boottime.match(/sec = (\d+)/);
  if (!m) return 0;
  return Math.max(0, Math.floor(Date.now() / 1000) - parseInt(m[1]!, 10));
}

const PRESSURE: Record<string, SystemStats['memory']['pressure']> = {
  '1': 'normal', '2': 'warning', '4': 'critical',
};

/** Collect a full system-vitals snapshot. All commands are read-only and run without sudo. */
export async function collectSystem(): Promise<SystemStats> {
  const [top, sc, perf, vm, swap, df, netib, netan, batt, therm, lsofL] = await Promise.all([
    run('top', ['-l1', '-n0']),
    run('sysctl', ['-n', 'vm.loadavg', 'hw.ncpu', 'hw.physicalcpu', 'hw.memsize', 'hw.model', 'machdep.cpu.brand_string', 'kern.boottime', 'kern.memorystatus_vm_pressure_level']),
    run('sysctl', ['-n', 'hw.perflevel0.logicalcpu', 'hw.perflevel1.logicalcpu']),
    run('vm_stat', []),
    run('sysctl', ['-n', 'vm.swapusage']),
    run('df', ['-k']),
    run('netstat', ['-ib']),
    run('netstat', ['-an']),
    run('pmset', ['-g', 'batt']),
    run('pmset', ['-g', 'therm']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']),
  ]);

  const t = parseTop(top.stdout);
  const sl = sc.stdout.split('\n').map((s) => s.trim());
  const load = sl[0]!.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const loadAvg: [number, number, number] = load
    ? [parseFloat(load[1]!), parseFloat(load[2]!), parseFloat(load[3]!)]
    : [0, 0, 0];
  const ncpu = parseInt(sl[1] || '0', 10);
  const physical = parseInt(sl[2] || '0', 10);
  const memBytes = parseInt(sl[3] || '0', 10);
  const model = sl[4] || 'Mac';
  const chip = sl[5] || 'CPU';
  const uptimeSeconds = bootSeconds(sl[6] || '');
  const pressure = PRESSURE[(sl[7] || '').trim()] ?? 'unknown';

  const pl = perf.stdout.split('\n');
  const performance = parseInt(pl[0] || '0', 10) || 0;
  const efficiency = parseInt(pl[1] || '0', 10) || 0;

  const { pageSize, pages } = parseVmStat(vm.stdout);
  const px = (k: string) => (pages[k] ?? 0) * pageSize;
  const wired = px('pages wired down');
  const compressed = px('pages occupied by compressor');
  const active = px('pages active');
  const inactive = px('pages inactive');
  const cachedBytes = px('file-backed pages');
  const usedBytes = wired + compressed + active + inactive;
  const freeBytes = Math.max(0, memBytes - usedBytes);
  const segments: MemSegment[] = [
    { label: 'Wired', bytes: wired },
    { label: 'Compressed', bytes: compressed },
    { label: 'Active', bytes: active },
    { label: 'Inactive', bytes: inactive },
    { label: 'Free', bytes: freeBytes },
  ];

  const interfaces = parseNetInterfaces(netib.stdout);
  const rxTotal = interfaces.reduce((s, i) => s + i.rxBytes, 0);
  const txTotal = interfaces.reduce((s, i) => s + i.txBytes, 0);
  const now = Date.now();
  let rxRate = 0;
  let txRate = 0;
  if (lastNet) {
    const dt = (now - lastNet.t) / 1000;
    if (dt > 0) {
      rxRate = Math.max(0, (rxTotal - lastNet.rx) / dt);
      txRate = Math.max(0, (txTotal - lastNet.tx) / dt);
    }
  }
  lastNet = { t: now, rx: rxTotal, tx: txTotal };

  // Disk cumulative bytes come from the `top` header ("Disks: N/320G read, M/2754G written").
  const dm = top.stdout.match(/Disks:\s*\d+\/([\d.]+)([KMGT]) read,\s*\d+\/([\d.]+)([KMGT]) written/);
  const readTotal = dm ? unitBytes(dm[1]!, dm[2]!) : 0;
  const writeTotal = dm ? unitBytes(dm[3]!, dm[4]!) : 0;
  let dr = 0;
  let dw = 0;
  if (lastDisk) {
    const dt = (now - lastDisk.t) / 1000;
    if (dt > 0) {
      dr = Math.max(0, (readTotal - lastDisk.r) / dt);
      dw = Math.max(0, (writeTotal - lastDisk.w) / dt);
    }
  }
  lastDisk = { t: now, r: readTotal, w: writeTotal };

  return {
    at: now,
    host: { model, chip, memBytes, uptimeSeconds },
    cpu: {
      usagePct: t.usagePct, user: t.user, sys: t.sys, idle: t.idle,
      loadAvg,
      cores: { total: ncpu, physical, performance, efficiency },
    },
    processes: { total: t.total, running: t.running, threads: t.threads },
    memory: {
      totalBytes: memBytes, usedBytes, usedPct: memBytes ? (usedBytes / memBytes) * 100 : 0,
      pressure, cachedBytes, segments, swap: parseSwap(swap.stdout),
    },
    network: {
      rxBytesPerSec: rxRate, txBytesPerSec: txRate,
      rxTotalBytes: rxTotal, txTotalBytes: txTotal,
      connections: parseConnections(netan.stdout),
      interfaces,
      ports: parsePorts(lsofL.stdout),
    },
    disk: {
      readBytesPerSec: dr, writeBytesPerSec: dw,
      readTotalBytes: readTotal, writeTotalBytes: writeTotal,
    },
    storage: { volumes: parseDf(df.stdout) },
    server: { rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(process.uptime()) },
    power: { ...parseBattery(batt.stdout), thermalNominal: !/CPU_Speed_Limit\s*=\s*[0-9]/.test(therm.stdout) || /= 100/.test(therm.stdout) },
  };
}
