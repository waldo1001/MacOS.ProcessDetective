import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSample, buildElevatedSampleCommand } from '../src/collect/sample.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

describe('buildElevatedSampleCommand', () => {
  it('returns the correct command for a normal pid and seconds', () => {
    const cmd = buildElevatedSampleCommand(12345, 3);
    expect(cmd).toBe('/usr/bin/sample 12345 3');
  });

  it('clamps seconds: 0 → 1', () => {
    const cmd = buildElevatedSampleCommand(100, 0);
    expect(cmd).toBe('/usr/bin/sample 100 1');
  });

  it('clamps seconds: 99 → 5', () => {
    const cmd = buildElevatedSampleCommand(100, 99);
    expect(cmd).toBe('/usr/bin/sample 100 5');
  });

  it('floors a non-integer seconds value then clamps', () => {
    // Math.floor(2.9) = 2, which is within [1,5]
    const cmd = buildElevatedSampleCommand(100, 2.9);
    expect(cmd).toBe('/usr/bin/sample 100 2');
  });

  it('clamps a floored non-integer seconds below 1 to 1', () => {
    // Math.floor(0.9) = 0 → clamped to 1
    const cmd = buildElevatedSampleCommand(100, 0.9);
    expect(cmd).toBe('/usr/bin/sample 100 1');
  });

  it('throws on pid = 0', () => {
    expect(() => buildElevatedSampleCommand(0, 2)).toThrow();
  });

  it('throws on negative pid', () => {
    expect(() => buildElevatedSampleCommand(-1, 2)).toThrow();
  });

  it('throws on non-integer pid (1.5)', () => {
    expect(() => buildElevatedSampleCommand(1.5, 2)).toThrow();
  });

  it('throws on NaN pid', () => {
    expect(() => buildElevatedSampleCommand(NaN, 2)).toThrow();
  });

  it('produced command matches ^/usr/bin/sample \\d+ \\d+$ (no shell metacharacters)', () => {
    const cmd = buildElevatedSampleCommand(99999, 5);
    expect(cmd).toMatch(/^\/usr\/bin\/sample \d+ \d+$/);
  });
});

describe('parseSample', () => {
  it('parses a wait-syscall fixture as NOT cpu-bound', () => {
    const result = parseSample(fixture('sample-wait.txt'));
    expect(result.available).toBe(true);
    expect(result.cpuBound).toBe(false);
    expect(result.verdict).toContain('__sigsuspend');
    expect(result.verdict).toContain('not CPU-bound');
    expect(result.threadCount).toBe(1);
    expect(result.topFrames.length).toBeGreaterThan(0);
    expect(result.note).toBeNull();
  });

  it('parses a compute fixture as cpu-bound', () => {
    const result = parseSample(fixture('sample-compute.txt'));
    expect(result.available).toBe(true);
    expect(result.cpuBound).toBe(true);
    expect(result.verdict).toContain('spinning in');
    // Should pick the deepest meaningful frame — not scaffolding like start/main
    expect(result.verdict).not.toContain('spinning in start');
    expect(result.verdict).not.toContain('spinning in main');
    expect(result.threadCount).toBe(1);
    expect(result.topFrames.length).toBeGreaterThan(0);
  });

  it('returns available:false on empty input', () => {
    const result = parseSample('');
    expect(result.available).toBe(false);
    expect(result.cpuBound).toBeNull();
    expect(result.verdict).toBeNull();
    expect(result.topFrames).toHaveLength(0);
  });

  it('returns available:false on garbage input', () => {
    const result = parseSample('not a sample output at all\njust random text\n');
    expect(result.available).toBe(false);
    expect(result.topFrames).toHaveLength(0);
  });

  it('topFrames has ≤6 entries', () => {
    const result = parseSample(fixture('sample-wait.txt'));
    expect(result.topFrames.length).toBeLessThanOrEqual(6);
  });

  it('identifies the binary in topFrames', () => {
    const result = parseSample(fixture('sample-wait.txt'));
    // The deepest frame should be __sigsuspend in libsystem_kernel.dylib
    const deepest = result.topFrames[result.topFrames.length - 1]!;
    expect(deepest.symbol).toBe('__sigsuspend');
    expect(deepest.binary).toBe('libsystem_kernel.dylib');
  });

  it('compute fixture deepest meaningful frame is the v8 function', () => {
    const result = parseSample(fixture('sample-compute.txt'));
    // Verdict should point to the deepest non-scaffolding frame
    expect(result.verdict).toContain('v8::internal::BytecodeGenerator::GenerateBytecode');
  });
});
