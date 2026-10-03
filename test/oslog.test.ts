import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLogShowArgs, parseLogShow } from '../src/collect/oslog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'oslog-compact.txt'), 'utf8');

// ---------------------------------------------------------------------------
// buildLogShowArgs
// ---------------------------------------------------------------------------

describe('buildLogShowArgs', () => {
  it('returns the correct arg array for a valid pid and default minutes', () => {
    const args = buildLogShowArgs(411);
    expect(args).toEqual([
      'show', '--last', '3m',
      '--predicate', 'processID == 411',
      '--style', 'compact',
      '--info',
    ]);
  });

  it('uses a custom minutes value', () => {
    const args = buildLogShowArgs(100, 5);
    expect(args[2]).toBe('5m');
  });

  it('clamps minutes to minimum 1', () => {
    const args = buildLogShowArgs(1, 0);
    expect(args[2]).toBe('1m');
  });

  it('clamps minutes to maximum 10', () => {
    const args = buildLogShowArgs(1, 99);
    expect(args[2]).toBe('10m');
  });

  it('throws RangeError for pid 0', () => {
    expect(() => buildLogShowArgs(0)).toThrow(RangeError);
  });

  it('throws RangeError for negative pid', () => {
    expect(() => buildLogShowArgs(-5)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer pid', () => {
    expect(() => buildLogShowArgs(1.5)).toThrow(RangeError);
  });

  it('never shell-concatenates the pid — pid appears in the predicate arg only', () => {
    const args = buildLogShowArgs(12345, 3);
    // The pid must appear in the --predicate arg, NOT in the command itself
    expect(args).toContain('processID == 12345');
    // And it must NOT be a standalone arg
    expect(args.filter((a) => a === '12345')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseLogShow — fixture
// ---------------------------------------------------------------------------

describe('parseLogShow (fixture)', () => {
  it('parses without throwing', () => {
    expect(() => parseLogShow(FIXTURE, 411, 3)).not.toThrow();
  });

  it('sets available:true', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    expect(snap.available).toBe(true);
  });

  it('returns the correct pid and windowMinutes', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    expect(snap.pid).toBe(411);
    expect(snap.windowMinutes).toBe(3);
  });

  it('counts totalLines (skips header and blank lines)', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    // Fixture has 22 timestamp lines (not counting header or blank)
    expect(snap.totalLines).toBeGreaterThan(0);
    expect(snap.totalLines).toBe(22);
  });

  it('detects error/fault lines (E and F type)', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    // Fixture has 1 E line and 1 F line
    expect(snap.errorCount).toBe(2);
  });

  it('detects <private> redaction tokens', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    // Fixture has 2 <private> occurrences
    expect(snap.privateRedacted).toBe(2);
  });

  it('includes a note about private redaction', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    expect(snap.note).toMatch(/redacted/i);
    expect(snap.note).toMatch(/2/);
  });

  it('topPatterns collapses lines with different numbers into one entry', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    // "[Event] GlobalButtons:N (Last SenderID:0x…)" appears multiple times
    // and should collapse into a single pattern with count >= 2
    const globalBtnsPattern = snap.topPatterns.find(
      (p) => /globalbut/i.test(p.sample) || /globalbuttons/i.test(p.sample),
    );
    expect(globalBtnsPattern).toBeDefined();
    expect(globalBtnsPattern!.count).toBeGreaterThanOrEqual(2);
  });

  it('topPatterns capped at 8', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    expect(snap.topPatterns.length).toBeLessThanOrEqual(8);
  });

  it('topPatterns sorted by count descending', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    for (let i = 1; i < snap.topPatterns.length; i++) {
      expect(snap.topPatterns[i - 1]!.count).toBeGreaterThanOrEqual(snap.topPatterns[i]!.count);
    }
  });

  it('topPatterns include a subsystem string when present', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    const withSys = snap.topPatterns.filter((p) => p.subsystem !== null);
    expect(withSys.length).toBeGreaterThan(0);
  });

  it('bySubsystem is populated and capped at 8', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    expect(snap.bySubsystem.length).toBeGreaterThan(0);
    expect(snap.bySubsystem.length).toBeLessThanOrEqual(8);
  });

  it('bySubsystem sorted by count descending', () => {
    const snap = parseLogShow(FIXTURE, 411, 3);
    for (let i = 1; i < snap.bySubsystem.length; i++) {
      expect(snap.bySubsystem[i - 1]!.count).toBeGreaterThanOrEqual(snap.bySubsystem[i]!.count);
    }
  });
});

// ---------------------------------------------------------------------------
// parseLogShow — edge cases
// ---------------------------------------------------------------------------

describe('parseLogShow (edge cases)', () => {
  it('returns available:false on empty string', () => {
    const snap = parseLogShow('', 411, 3);
    expect(snap.available).toBe(false);
    expect(snap.totalLines).toBe(0);
    expect(snap.topPatterns).toHaveLength(0);
    expect(snap.bySubsystem).toHaveLength(0);
    expect(snap.note).toMatch(/No log entries/);
  });

  it('returns available:false on header-only string (no data lines)', () => {
    const snap = parseLogShow('Timestamp               Ty Process[PID:TID]\n', 411, 3);
    expect(snap.available).toBe(false);
  });

  it('does not throw on garbage input', () => {
    expect(() => parseLogShow('not a log at all\njunk\n', 411, 3)).not.toThrow();
  });

  it('clamps windowMinutes', () => {
    const snap = parseLogShow('', 1, 99);
    expect(snap.windowMinutes).toBe(10);
  });

  it('note includes the minute window when available:false', () => {
    const snap = parseLogShow('', 42, 5);
    expect(snap.note).toMatch(/5m/);
  });
});
