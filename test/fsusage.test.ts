import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFsUsageCommand, parseFsUsage } from '../src/collect/fsusage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'fsusage.txt'), 'utf8');

// ---------------------------------------------------------------------------
// buildFsUsageCommand
// ---------------------------------------------------------------------------

describe('buildFsUsageCommand', () => {
  it('returns a valid command for the default value (3)', () => {
    const cmd = buildFsUsageCommand(3);
    expect(cmd).toContain('sleep 3');
    expect(cmd).toContain('/usr/bin/fs_usage -w -f filesys');
    expect(cmd).toContain('mktemp /tmp/pd_fsusage.XXXXXX');
  });

  it('clamps seconds below minimum to 2', () => {
    const cmd = buildFsUsageCommand(0);
    expect(cmd).toContain('sleep 2');
  });

  it('clamps seconds below minimum (negative) to 2', () => {
    const cmd = buildFsUsageCommand(-5);
    expect(cmd).toContain('sleep 2');
  });

  it('clamps seconds above maximum to 5', () => {
    const cmd = buildFsUsageCommand(99);
    expect(cmd).toContain('sleep 5');
  });

  it('floors non-integer seconds', () => {
    const cmd = buildFsUsageCommand(3.9);
    expect(cmd).toContain('sleep 3');
  });

  it('produces integer-only variable in command', () => {
    for (const s of [2, 3, 4, 5]) {
      const cmd = buildFsUsageCommand(s);
      // sleep must be followed by an integer
      expect(cmd).toMatch(/sleep \d+;/);
    }
  });

  it('contains NO double-quotes (safe for AppleScript string embedding)', () => {
    for (const s of [2, 3, 4, 5]) {
      const cmd = buildFsUsageCommand(s);
      expect(cmd).not.toContain('"');
    }
  });

  it('passes the strict shape regex for all valid seconds values', () => {
    const SHAPE =
      /^\/bin\/sh -c 'f=\$\(mktemp \/tmp\/pd_fsusage\.XXXXXX\); \/usr\/bin\/fs_usage -w -f filesys >\$f 2>\/dev\/null & p=\$!; sleep \d+; kill \$p 2>\/dev\/null; sleep 1; kill -9 \$p 2>\/dev\/null; head -c 4000000 \$f; rm -f \$f'$/;
    for (const s of [2, 3, 4, 5]) {
      expect(buildFsUsageCommand(s)).toMatch(SHAPE);
    }
  });

  it('uses /bin/sh -c as the outer wrapper', () => {
    expect(buildFsUsageCommand(3)).toMatch(/^\/bin\/sh -c /);
  });

  it('uses head -c 4000000 to cap output', () => {
    expect(buildFsUsageCommand(3)).toContain('head -c 4000000');
  });

  it('cleans up the temp file (rm -f)', () => {
    expect(buildFsUsageCommand(3)).toContain('rm -f $f');
  });
});

// ---------------------------------------------------------------------------
// parseFsUsage — fixture
// ---------------------------------------------------------------------------

describe('parseFsUsage (fixture)', () => {
  it('parses without throwing', () => {
    expect(() => parseFsUsage(FIXTURE, 3)).not.toThrow();
  });

  it('sets available:true', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.available).toBe(true);
  });

  it('returns the correct windowSeconds', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.windowSeconds).toBe(3);
  });

  it('counts totalEvents correctly (excludes fseventsd, fs_usage, sh, mktemp, osascript)', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    // node: 20 events, mds_stores: 5, Xcode: 3 = 28 total
    // fseventsd (2), fs_usage (2), sh (1), osascript (1), mktemp (1) = excluded
    expect(snap.totalEvents).toBe(28);
  });

  it('node is the top process', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses[0]!.process).toBe('node');
  });

  it('node has the highest count (20)', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses[0]!.count).toBe(20);
  });

  it('topProcesses are sorted by count descending', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    for (let i = 1; i < snap.topProcesses.length; i++) {
      expect(snap.topProcesses[i - 1]!.count).toBeGreaterThanOrEqual(snap.topProcesses[i]!.count);
    }
  });

  it('topProcesses capped at 8', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.length).toBeLessThanOrEqual(8);
  });

  it('excludes fseventsd from topProcesses', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'fseventsd')).toBeUndefined();
  });

  it('excludes fs_usage from topProcesses', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'fs_usage')).toBeUndefined();
  });

  it('excludes sh from topProcesses', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'sh')).toBeUndefined();
  });

  it('excludes mktemp from topProcesses', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'mktemp')).toBeUndefined();
  });

  it('excludes osascript from topProcesses', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'osascript')).toBeUndefined();
  });

  it('node samplePaths includes node_modules paths', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    const nodeEntry = snap.topProcesses[0]!;
    expect(nodeEntry.samplePaths.length).toBeGreaterThan(0);
    const hasNodeModulesPath = nodeEntry.samplePaths.some((p) => p.includes('node_modules'));
    expect(hasNodeModulesPath).toBe(true);
  });

  it('samplePaths capped at 3', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    for (const proc of snap.topProcesses) {
      expect(proc.samplePaths.length).toBeLessThanOrEqual(3);
    }
  });

  it('node commonDir points under node_modules area', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    const nodeEntry = snap.topProcesses[0]!;
    expect(nodeEntry.commonDir).not.toBeNull();
    // Should be within 4 levels of the proj root
    expect(nodeEntry.commonDir).toMatch(/\/Users\/waldo/);
  });

  it('produces a concentration note naming node and node_modules', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.note).not.toBeNull();
    expect(snap.note!.toLowerCase()).toContain('node');
    expect(snap.note!.toLowerCase()).toContain('node_modules');
  });

  it('truncated is false for the small fixture', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.truncated).toBe(false);
  });

  it('includes mds_stores as a recognized process', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'mds_stores')).toBeDefined();
  });

  it('includes Xcode as a recognized process', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.topProcesses.find((p) => p.process === 'Xcode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// parseFsUsage — edge cases
// ---------------------------------------------------------------------------

describe('parseFsUsage (edge cases)', () => {
  it('returns available:false on empty string', () => {
    const snap = parseFsUsage('', 3);
    expect(snap.available).toBe(false);
    expect(snap.totalEvents).toBe(0);
    expect(snap.topProcesses).toHaveLength(0);
    expect(snap.note).toMatch(/no filesystem activity captured/);
  });

  it('returns available:false on whitespace-only string', () => {
    const snap = parseFsUsage('   \n  \n', 3);
    expect(snap.available).toBe(false);
  });

  it('does not throw on garbage input', () => {
    expect(() => parseFsUsage('not fs_usage output at all', 3)).not.toThrow();
  });

  it('clamps windowSeconds in the result', () => {
    const snap = parseFsUsage('', 99);
    expect(snap.windowSeconds).toBe(5);
  });

  it('clamps windowSeconds minimum to 2', () => {
    const snap = parseFsUsage('', 0);
    expect(snap.windowSeconds).toBe(2);
  });

  it('excludes all observer processes when they are the only lines', () => {
    const observersOnly = [
      '12:34:57.300  getattrlist   /dev/null  0.000003   fseventsd.222',
      '12:34:57.400  stat64        /tmp/x  0.000004   fs_usage.333',
      '12:34:57.500  stat64        /bin/sh  0.000002   sh.444',
      '12:34:57.600  stat64        /bin/sh  0.000003   osascript.555',
      '12:34:57.700  stat64        /private/tmp  0.000004   mktemp.666',
    ].join('\n');
    const snap = parseFsUsage(observersOnly, 3);
    expect(snap.available).toBe(false);
    expect(snap.totalEvents).toBe(0);
  });

  it('detects truncated flag when byte length >= 3.9 MB', () => {
    // Build a string slightly over 3.9 MB with real-ish lines
    const line =
      '12:34:56.789  open  F=3  /Users/waldo/proj/node_modules/.cache/x.json  0.000123 W node.12345\n';
    const reps = Math.ceil(3_900_001 / line.length);
    const big = line.repeat(reps);
    const snap = parseFsUsage(big, 3);
    expect(snap.truncated).toBe(true);
  });

  it('handles lines with no leading path (no / token) without crashing', () => {
    const noPath = '12:34:56.789  open  F=3  0.000123 W node.12345\n';
    expect(() => parseFsUsage(noPath, 3)).not.toThrow();
    const snap = parseFsUsage(noPath, 3);
    // node still appears, just with no path
    if (snap.available) {
      const nodeEntry = snap.topProcesses.find((p) => p.process === 'node');
      if (nodeEntry) expect(nodeEntry.samplePaths).toHaveLength(0);
    }
  });

  it('concentration note mentions node_modules for a node-dominated fixture', () => {
    const snap = parseFsUsage(FIXTURE, 3);
    expect(snap.note).toMatch(/node_modules/);
  });
});
