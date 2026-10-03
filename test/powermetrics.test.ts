import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPowermetricsCommand, parsePowermetrics } from '../src/collect/powermetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'powermetrics.txt'), 'utf8');

// ---- buildPowermetricsCommand ----

describe('buildPowermetricsCommand', () => {
  it('returns a string matching the required regex', () => {
    const cmd = buildPowermetricsCommand(1);
    expect(/^\/usr\/bin\/powermetrics --samplers tasks,gpu_power -n 1 -i \d+$/.test(cmd)).toBe(true);
  });

  it('clamps seconds to minimum 1', () => {
    const cmd = buildPowermetricsCommand(0);
    expect(cmd).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 1000');
  });

  it('clamps seconds to minimum 1 for negative input', () => {
    const cmd = buildPowermetricsCommand(-5);
    expect(cmd).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 1000');
  });

  it('clamps seconds to maximum 3', () => {
    const cmd = buildPowermetricsCommand(5);
    expect(cmd).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 3000');
  });

  it('floors fractional seconds', () => {
    const cmd = buildPowermetricsCommand(2.9);
    expect(cmd).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 2000');
  });

  it('produces 1000ms for seconds=1', () => {
    expect(buildPowermetricsCommand(1)).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 1000');
  });

  it('produces 2000ms for seconds=2', () => {
    expect(buildPowermetricsCommand(2)).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 2000');
  });

  it('produces 3000ms for seconds=3', () => {
    expect(buildPowermetricsCommand(3)).toBe('/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i 3000');
  });

  it('does not include shell metacharacters', () => {
    const cmd = buildPowermetricsCommand(1);
    // Only alphanumeric, spaces, hyphens, slashes, commas, and dots
    expect(/^[a-zA-Z0-9 /_.,-]+$/.test(cmd)).toBe(true);
  });
});

// ---- parsePowermetrics with fixture ----

describe('parsePowermetrics (fixture)', () => {
  it('parses without throwing', () => {
    expect(() => parsePowermetrics(FIXTURE)).not.toThrow();
  });

  it('sets available:true', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.available).toBe(true);
  });

  it('keeps raw output', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.raw).toBeDefined();
    expect(snap.raw!.length).toBeGreaterThan(0);
  });

  it('extracts top CPU tasks with WindowServer first', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.topCpu.length).toBeGreaterThan(0);
    expect(snap.topCpu[0]!.name).toBe('WindowServer');
    expect(snap.topCpu[0]!.cpuMsPerS).toBeCloseTo(142.34, 1);
  });

  it('extracts Chrome Helper as second CPU task', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.topCpu.length).toBeGreaterThanOrEqual(2);
    expect(snap.topCpu[1]!.name).toContain('Google Chrome Helper');
  });

  it('skips ALL_TASKS row', () => {
    const snap = parsePowermetrics(FIXTURE);
    const names = snap.topCpu.map((t) => t.name);
    expect(names.some((n) => n.includes('ALL_TASKS'))).toBe(false);
  });

  it('extracts top GPU tasks (WindowServer and Chrome have GPU > 0)', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.topGpu.length).toBeGreaterThan(0);
    // Both WindowServer and Chrome Helper have GPU ms/s > 0
    const gpuNames = snap.topGpu.map((t) => t.name);
    expect(gpuNames.some((n) => n.includes('WindowServer') || n.includes('Google Chrome Helper'))).toBe(true);
  });

  it('excludes tasks with gpuMsPerS == 0 from topGpu', () => {
    const snap = parsePowermetrics(FIXTURE);
    for (const t of snap.topGpu) {
      expect(t.gpuMsPerS).toBeGreaterThan(0);
    }
  });

  it('parses gpuActiveResidencyPct', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.gpuActiveResidencyPct).not.toBeNull();
    expect(snap.gpuActiveResidencyPct).toBeCloseTo(72.34, 1);
  });

  it('parses gpuPowerMw', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.gpuPowerMw).not.toBeNull();
    expect(snap.gpuPowerMw).toBeCloseTo(1234, 0);
  });

  it('topCpu is sorted descending by cpuMsPerS', () => {
    const snap = parsePowermetrics(FIXTURE);
    for (let i = 1; i < snap.topCpu.length; i++) {
      expect(snap.topCpu[i - 1]!.cpuMsPerS).toBeGreaterThanOrEqual(snap.topCpu[i]!.cpuMsPerS);
    }
  });

  it('topGpu is sorted descending by gpuMsPerS', () => {
    const snap = parsePowermetrics(FIXTURE);
    for (let i = 1; i < snap.topGpu.length; i++) {
      expect(snap.topGpu[i - 1]!.gpuMsPerS).toBeGreaterThanOrEqual(snap.topGpu[i]!.gpuMsPerS);
    }
  });

  it('note is null on success', () => {
    const snap = parsePowermetrics(FIXTURE);
    expect(snap.note).toBeNull();
  });
});

// ---- parsePowermetrics edge cases ----

const FIXTURE_AS = readFileSync(join(__dirname, 'fixtures', 'powermetrics-apple-silicon.txt'), 'utf8');
describe('parsePowermetrics (Apple Silicon — real format, no per-app GPU column)', () => {
  it('parses top CPU tasks (names with dots/spaces) even without a GPU column', () => {
    const snap = parsePowermetrics(FIXTURE_AS);
    expect(snap.available).toBe(true);
    expect(snap.topCpu.length).toBeGreaterThan(3);
    expect(snap.topCpu.some((t) => t.name === 'com.apple.WebKit.GPU')).toBe(true);
    expect(snap.topCpu.some((t) => t.name === 'WindowServer')).toBe(true);
    expect(snap.topCpu[0]!.cpuMsPerS).toBeGreaterThanOrEqual(snap.topCpu[1]!.cpuMsPerS);
  });
  it('has no per-app GPU and skips ALL_TASKS / DEAD_TASKS rows', () => {
    const snap = parsePowermetrics(FIXTURE_AS);
    expect(snap.topGpu).toHaveLength(0);
    expect(snap.topCpu.some((t) => /ALL_TASKS|DEAD_TASKS/.test(t.name))).toBe(false);
  });
  it('parses system GPU residency and power', () => {
    const snap = parsePowermetrics(FIXTURE_AS);
    expect(snap.gpuActiveResidencyPct).toBeCloseTo(52.98, 1);
    expect(snap.gpuPowerMw).toBeCloseTo(322, 0);
  });
});

describe('parsePowermetrics (edge cases)', () => {
  it('returns available:false on empty string but keeps raw', () => {
    const snap = parsePowermetrics('');
    expect(snap.available).toBe(false);
    expect(snap.raw).toBeDefined();
    expect(snap.topCpu).toHaveLength(0);
    expect(snap.topGpu).toHaveLength(0);
  });

  it('returns gracefully on garbage input, keeps raw', () => {
    const garbage = 'zzz garbage not a real powermetrics output zzz';
    const snap = parsePowermetrics(garbage);
    // available is true because raw is non-empty even with no task rows
    expect(snap.raw).toBeDefined();
    expect(snap.raw!.length).toBeGreaterThan(0);
    expect(snap.topCpu).toHaveLength(0);
    expect(snap.topGpu).toHaveLength(0);
    expect(snap.gpuActiveResidencyPct).toBeNull();
    expect(snap.gpuPowerMw).toBeNull();
  });

  it('parses gpuPowerMw from "GPU Power:" line', () => {
    const text = 'GPU Power: 800 mW\n';
    const snap = parsePowermetrics(text);
    expect(snap.gpuPowerMw).toBeCloseTo(800, 0);
  });

  it('parses gpuActiveResidencyPct from "GPU active residency:" variant', () => {
    const text = 'GPU active residency:  55.00% (something)\n';
    const snap = parsePowermetrics(text);
    expect(snap.gpuActiveResidencyPct).toBeCloseTo(55.0, 1);
  });
});
