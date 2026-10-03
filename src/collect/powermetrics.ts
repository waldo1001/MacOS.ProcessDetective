import { runElevated } from './elevated.js';

export interface TaskPower {
  name: string;
  cpuMsPerS: number;
  gpuMsPerS: number;
}

export interface PowerSnapshot {
  available: boolean;
  topCpu: TaskPower[];      // ranked desc by cpuMsPerS, ≤12
  topGpu: TaskPower[];      // ranked desc by gpuMsPerS, ≤12 (only tasks with gpu>0)
  gpuActiveResidencyPct: number | null;
  gpuPowerMw: number | null;
  note: string | null;      // "requires admin" / "disabled" / "cancelled"
  raw?: string;             // trimmed raw output for collapsible fallback view
}

/**
 * Build the powermetrics command string. PURE — unit-tested.
 * Clamps seconds to [1, 3], converts to ms, returns EXACTLY the expected form.
 * @throws if the resulting string does not match the expected regex (belt-and-suspenders).
 */
export function buildPowermetricsCommand(seconds: number): string {
  const safeSecs = Math.max(1, Math.min(3, Math.floor(seconds)));
  const ms = safeSecs * 1000;
  const cmd = `/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i ${ms}`;
  if (!/^\/usr\/bin\/powermetrics --samplers tasks,gpu_power -n 1 -i \d+$/.test(cmd)) {
    throw new Error(`Unexpected powermetrics command shape: ${cmd}`);
  }
  return cmd;
}

/**
 * Parse powermetrics output text into a PowerSnapshot.
 * Pure function — tolerant of layout variations across macOS versions.
 * Always keeps `raw` so the UI can degrade to showing the raw text.
 */
export function parsePowermetrics(text: string): PowerSnapshot {
  const raw = text.trim();

  if (!raw) {
    return {
      available: false,
      topCpu: [],
      topGpu: [],
      gpuActiveResidencyPct: null,
      gpuPowerMw: null,
      note: 'empty output',
      raw,
    };
  }

  const lines = raw.split('\n');

  // ---- Parse Tasks table ----
  // The header always has "CPU ms/s"; "GPU ms/s" is OPTIONAL (absent on Apple
  // Silicon `tasks` output — there is no per-process GPU column there). Columns
  // after Name are: ID, CPU ms/s, User%, Deadlines…, Wakeups… [, GPU ms/s].
  // Parse the name by the ID column position; CPU ms/s is the 2nd token after it.
  let headerIdx = -1;
  let idCol = -1;
  let gpuCol = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes('CPU ms/s')) {
      headerIdx = i;
      const idm = line.search(/\bID\b/);
      idCol = idm >= 0 ? idm : line.indexOf('CPU ms/s');
      gpuCol = line.indexOf('GPU ms/s'); // -1 when the column is absent
      break;
    }
  }

  const tasks: TaskPower[] = [];

  if (headerIdx >= 0 && idCol >= 0) {
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '' || line.startsWith('***')) break;
      const t = line.trim();
      if (t.startsWith('ALL_TASKS') || t.startsWith('DEAD_TASKS')) continue;
      if (line.length <= idCol) continue;

      const name = line.slice(0, idCol).trim();
      if (!name) continue;

      // After the name: [ID, CPU ms/s, User%, …]. CPU ms/s is the 2nd token.
      const tail = line.slice(idCol).trim().split(/\s+/);
      const cpuMsPerS = parseFloat(tail[1] ?? '');
      if (isNaN(cpuMsPerS)) continue;

      // GPU ms/s only when the column exists (by character position — the
      // Deadlines/Wakeups cells contain commas, so token-index isn't reliable).
      let gpuMsPerS = 0;
      if (gpuCol >= 0 && line.length > gpuCol) {
        const g = parseFloat(line.slice(gpuCol).trim().split(/\s+/)[0] ?? '');
        if (!isNaN(g)) gpuMsPerS = g;
      }

      tasks.push({ name, cpuMsPerS, gpuMsPerS });
    }
  }

  // Sort and cap
  const topCpu = [...tasks].sort((a, b) => b.cpuMsPerS - a.cpuMsPerS).slice(0, 12);
  const topGpu = [...tasks]
    .filter((t) => t.gpuMsPerS > 0)
    .sort((a, b) => b.gpuMsPerS - a.gpuMsPerS)
    .slice(0, 12);

  // ---- Parse gpu_power section ----
  let gpuActiveResidencyPct: number | null = null;
  let gpuPowerMw: number | null = null;

  for (const line of lines) {
    // "GPU HW active residency:  72.34% ..."  or  "GPU active residency:  72.34% ..."
    if (gpuActiveResidencyPct === null) {
      const m = line.match(/GPU (?:HW )?active residency:\s*([\d.]+)%/);
      if (m) gpuActiveResidencyPct = parseFloat(m[1]!);
    }
    // "GPU Power: 1234 mW"
    if (gpuPowerMw === null) {
      const m = line.match(/GPU Power:\s*([\d.]+)\s*mW/);
      if (m) gpuPowerMw = parseFloat(m[1]!);
    }
  }

  const available = tasks.length > 0 || raw.length > 0;

  return {
    available,
    topCpu,
    topGpu,
    gpuActiveResidencyPct,
    gpuPowerMw,
    note: null,
    raw,
  };
}

/**
 * Run powermetrics via the macOS admin auth dialog and parse the result.
 * Returns a PowerSnapshot — never throws.
 */
export async function getPowermetrics(seconds = 1): Promise<PowerSnapshot> {
  const cmd = buildPowermetricsCommand(seconds);
  const timeoutMs = (seconds + 30) * 1000;

  const elev = await runElevated(cmd, timeoutMs);

  if (!elev.ok) {
    return {
      available: false,
      topCpu: [],
      topGpu: [],
      gpuActiveResidencyPct: null,
      gpuPowerMw: null,
      note: elev.note,
      raw: '',
    };
  }

  const snapshot = parsePowermetrics(elev.stdout);
  return snapshot;
}
