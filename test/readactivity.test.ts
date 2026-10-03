import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLsofOffsets, diffOffsets, getReadActivity } from '../src/collect/readactivity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const T0 = readFileSync(join(__dirname, 'fixtures', 'lsof-offsets-t0.txt'), 'utf8');
const T1 = readFileSync(join(__dirname, 'fixtures', 'lsof-offsets-t1.txt'), 'utf8');

describe('parseLsofOffsets', () => {
  it('extracts the right key count from the t0 fixture', () => {
    const map = parseLsofOffsets(T0);
    expect(map.size).toBe(6); // 6 REG rows; the IPv4 row and header are excluded
  });

  it('ignores non-REG rows and the header', () => {
    const map = parseLsofOffsets(T0);
    for (const { path } of map.values()) {
      expect(path.startsWith('/Users/testuser/.claude/projects')).toBe(true);
    }
  });
});

describe('diffOffsets', () => {
  it('diffs t0 → t1 into 3 added, 2 removed, 2 offsets advanced', () => {
    const before = parseLsofOffsets(T0);
    const after = parseLsofOffsets(T1);
    const result = diffOffsets(before, after, 1500);
    expect(result.fdsAdded).toBe(3);
    expect(result.fdsRemoved).toBe(2);
    expect(result.offsetsAdvanced).toBe(2);
    expect(result.available).toBe(true);
  });

  it('verdict is the churn message when fdsAdded + fdsRemoved >= 3', () => {
    const before = parseLsofOffsets(T0);
    const after = parseLsofOffsets(T1);
    const result = diffOffsets(before, after, 1500);
    expect(result.verdict).toBe('churning file handles — actively streaming through many files');
  });

  it('verdict is the idle message when both snapshots are identical', () => {
    const before = parseLsofOffsets(T0);
    const result = diffOffsets(before, before, 1500);
    expect(result.verdict).toBe('file descriptors idle over this window');
    expect(result.fdsAdded).toBe(0);
    expect(result.fdsRemoved).toBe(0);
    expect(result.offsetsAdvanced).toBe(0);
  });

  it('commonDir resolves to the shared transcript directory', () => {
    const before = parseLsofOffsets(T0);
    const after = parseLsofOffsets(T1);
    const result = diffOffsets(before, after, 1500);
    expect(result.commonDir).toBe(
      '/Users/testuser/.claude/projects/-Users-testuser-SourceCode-Demo',
    );
  });

  it('records the passed-in gapMs verbatim', () => {
    const before = parseLsofOffsets(T0);
    const after = parseLsofOffsets(T1);
    const result = diffOffsets(before, after, 1234);
    expect(result.gapMs).toBe(1234);
  });
});

describe('getReadActivity', () => {
  it('returns available:false with a note when the pid has no open files (empty lsof output)', async () => {
    // A very unlikely-to-exist pid — lsof returns empty stdout, never throws.
    const result = await getReadActivity(999999, 500);
    expect(result.available).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.note).toMatch(/lsof returned no output/);
    expect(result.commonDir).toBeNull();
    expect(result.sampleAdded).toEqual([]);
  }, 10000);

  it('clamps gapMs into [500, 3000]', async () => {
    const result = await getReadActivity(999999, 50);
    expect(result.available).toBe(false);
  }, 10000);
});
