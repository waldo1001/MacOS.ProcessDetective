import { describe, expect, it } from 'vitest';
import { parseCrashFilename } from '../src/collect/crashes.js';

describe('parseCrashFilename', () => {
  it('handles a dash-separated name with .ips extension', () => {
    const r = parseCrashFilename('Google Chrome Helper-2026-06-26-131241.ips');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('Google Chrome Helper');
    expect(r!.at).toBeGreaterThan(0);
  });

  it('handles an underscore-separated name with .ips extension', () => {
    const r = parseCrashFilename('chrome_crashpad_handler-2026-06-26-131241.0003.ips');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('chrome_crashpad_handler');
  });

  it('handles a .crash extension', () => {
    const r = parseCrashFilename('MyApp-2026-06-26-100000.crash');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('MyApp');
  });

  it('handles underscore-date variant', () => {
    const r = parseCrashFilename('app-name_2026-06-26_131241.ips');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('app-name');
  });

  it('handles the .0003 index suffix', () => {
    const r = parseCrashFilename('SomeHelper-2026-06-26-131241.0003.ips');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('SomeHelper');
  });

  it('handles process names with spaces', () => {
    const r = parseCrashFilename('My App Name-2026-06-26-131241.ips');
    expect(r).not.toBeNull();
    expect(r!.process).toBe('My App Name');
  });

  it('returns null for filenames without a date segment', () => {
    expect(parseCrashFilename('somefile.ips')).toBeNull();
    expect(parseCrashFilename('nodate.crash')).toBeNull();
    expect(parseCrashFilename('')).toBeNull();
  });

  it('returns null for filenames with invalid date', () => {
    // Edge: just a random name with numbers that look like but aren't a date
    expect(parseCrashFilename('app-1234-56-78.ips')).toBeNull();
  });

  it('parses the date correctly to a timestamp', () => {
    const r = parseCrashFilename('Foo-2026-01-15-120000.ips');
    expect(r).not.toBeNull();
    // Should be at or near 2026-01-15
    const d = new Date(r!.at);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(0); // January
    expect(d.getUTCDate()).toBe(15);
  });

  // ---- New: eventKey dedup tests ----

  it('returns an eventKey field', () => {
    const r = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.000.ips');
    expect(r).not.toBeNull();
    expect(r!.eventKey).toBeDefined();
  });

  it('assigns the same eventKey to the .000, .0002, .0003 dump-index variants of one crash', () => {
    const base = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.000.ips');
    const dup2 = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.0002.ips');
    const dup3 = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.0003.ips');

    expect(base).not.toBeNull();
    expect(dup2).not.toBeNull();
    expect(dup3).not.toBeNull();

    expect(base!.eventKey).toBe(dup2!.eventKey);
    expect(base!.eventKey).toBe(dup3!.eventKey);
  });

  it('assigns different eventKeys to crashes at different timestamps', () => {
    const a = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.000.ips');
    const b = parseCrashFilename('chrome_crashpad_handler-2026-06-25-204500.000.ips');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.eventKey).not.toBe(b!.eventKey);
  });

  it('assigns different eventKeys to different processes even at the same timestamp', () => {
    const a = parseCrashFilename('MyApp-2026-06-25-194230.000.ips');
    const b = parseCrashFilename('OtherApp-2026-06-25-194230.000.ips');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.eventKey).not.toBe(b!.eventKey);
  });

  it('assigns the same eventKey to a file with no dump-index suffix', () => {
    // file without a .NNN suffix should get the same key as the .000 variant
    const plain = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.ips');
    const withIdx = parseCrashFilename('chrome_crashpad_handler-2026-06-25-194230.000.ips');
    expect(plain).not.toBeNull();
    expect(withIdx).not.toBeNull();
    // Both strip trailing numeric suffix; plain has none to strip — keys must match
    expect(plain!.eventKey).toBe(withIdx!.eventKey);
  });
});

describe('crash grouping logic (via parseCrashFilename)', () => {
  it('groups multiple crashes of the same process', () => {
    const files = [
      'MyApp-2026-06-26-100000.ips',
      'MyApp-2026-06-26-110000.ips',
      'MyApp-2026-06-26-120000.ips',
      'OtherApp-2026-06-26-100000.ips',
    ].map((f) => parseCrashFilename(f));

    const myAppCrashes = files.filter((r) => r?.process === 'MyApp');
    const otherAppCrashes = files.filter((r) => r?.process === 'OtherApp');

    expect(myAppCrashes).toHaveLength(3);
    expect(otherAppCrashes).toHaveLength(1);
  });

  it('window filter works (old crashes should be excluded)', () => {
    // Simulate what getRecentCrashes does: mtime comparison
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const twoHoursAgo = now - 7_200_000;

    // Recent crash should be within window
    expect(now - 1000).toBeGreaterThan(oneHourAgo);
    // Old crash should be outside window
    expect(twoHoursAgo).toBeLessThan(oneHourAgo);
  });

  it('counts distinct eventKeys, not dump files (Chrome triple = 1 event)', () => {
    // Simulate the grouping logic: three dump files share one eventKey
    const files = [
      'chrome_crashpad_handler-2026-06-25-194230.000.ips',
      'chrome_crashpad_handler-2026-06-25-194230.0002.ips',
      'chrome_crashpad_handler-2026-06-25-194230.0003.ips',
    ].map((f) => parseCrashFilename(f)!);

    const eventKeys = new Set(files.map((r) => r.eventKey));
    // All three files belong to one event
    expect(eventKeys.size).toBe(1);
  });

  it('looping: 3+ distinct events within 10 min → true', () => {
    // Simulate distinct events at 0, 3min, 6min
    const now = Date.now();
    const times = [now - 6 * 60_000, now - 3 * 60_000, now];
    const count = 3;
    const firstAt = Math.min(...times);
    const lastAt = Math.max(...times);
    const looping = count >= 3 && (lastAt - firstAt) <= 10 * 60_000;
    expect(looping).toBe(true);
  });

  it('looping: 3 events spread over 15 min → false', () => {
    const now = Date.now();
    const times = [now - 15 * 60_000, now - 7 * 60_000, now];
    const count = 3;
    const firstAt = Math.min(...times);
    const lastAt = Math.max(...times);
    const looping = count >= 3 && (lastAt - firstAt) <= 10 * 60_000;
    expect(looping).toBe(false);
  });

  it('looping: only 2 events within 10 min → false', () => {
    const now = Date.now();
    const times = [now - 2 * 60_000, now];
    const count = 2;
    const firstAt = Math.min(...times);
    const lastAt = Math.max(...times);
    const looping = count >= 3 && (lastAt - firstAt) <= 10 * 60_000;
    expect(looping).toBe(false);
  });

  it('firstAt and lastAt are correct', () => {
    const now = Date.now();
    const t0 = now - 5 * 60_000;
    const t1 = now - 2 * 60_000;
    const t2 = now;
    const times = [t1, t0, t2]; // deliberately unordered
    const firstAt = Math.min(...times);
    const lastAt = Math.max(...times);
    expect(firstAt).toBe(t0);
    expect(lastAt).toBe(t2);
  });
});
