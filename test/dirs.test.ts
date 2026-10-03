import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirHotspots, computeDirHotspots } from '../src/enrich/dirs.js';
import { parseLsofRows } from '../src/collect/lsof.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOME = '/Users/testuser';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'lsof-codehelper.txt'), 'utf8');

function fixtureFilePaths(): string[] {
  return parseLsofRows(FIXTURE)
    .filter((r) => r.type === 'file')
    .map((r) => r.path);
}

describe('dirHotspots (fixture)', () => {
  it('picks the transcript directory with the correct fdCount', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    const demo = hotspots.find((h) => h.dir.endsWith('-Users-testuser-SourceCode-Demo'));
    expect(demo).toBeDefined();
    expect(demo!.fdCount).toBe(8);
  });

  it('returns the deepest directory in a same-count ancestor chain (not .claude or .claude/projects)', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    const dirs = hotspots.map((h) => h.dir);
    expect(dirs).not.toContain('/Users/testuser/.claude');
    expect(dirs).not.toContain('/Users/testuser/.claude/projects');
    expect(dirs.some((d) => d.endsWith('-Users-testuser-SourceCode-Demo'))).toBe(true);
  });

  it('never returns /, /Users, /Users/testuser, or /System', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    const dirs = hotspots.map((h) => h.dir);
    expect(dirs).not.toContain('/');
    expect(dirs).not.toContain('/Users');
    expect(dirs).not.toContain('/Users/testuser');
    expect(dirs).not.toContain('/System');
  });

  it('excludes noise paths — a directory of only .dylib files is not a hotspot', () => {
    const paths = [
      '/Users/testuser/Developer/libs/a.dylib',
      '/Users/testuser/Developer/libs/b.dylib',
      '/Users/testuser/Developer/libs/c.dylib',
    ];
    const hotspots = dirHotspots(paths, HOME);
    expect(hotspots.find((h) => h.dir === '/Users/testuser/Developer/libs')).toBeUndefined();
  });

  it('respects minFiles — 2 files under a directory yields no hotspot at the default threshold', () => {
    const paths = [
      '/Users/testuser/Developer/proj/a.txt',
      '/Users/testuser/Developer/proj/b.txt',
    ];
    const hotspots = dirHotspots(paths, HOME);
    expect(hotspots).toHaveLength(0);
  });

  it('does not return both an ancestor and its descendant (branch collapsing)', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    for (const a of hotspots) {
      for (const b of hotspots) {
        if (a === b) continue;
        expect(`${b.dir}/`.startsWith(`${a.dir}/`)).toBe(false);
      }
    }
  });

  it('dominantExt is "jsonl" for the transcript directory', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    const demo = hotspots.find((h) => h.dir.endsWith('-Users-testuser-SourceCode-Demo'))!;
    expect(demo.dominantExt).toBe('jsonl');
  });

  it('sampleFiles contains at most 3 basenames', () => {
    const hotspots = dirHotspots(fixtureFilePaths(), HOME);
    for (const h of hotspots) {
      expect(h.sampleFiles.length).toBeLessThanOrEqual(3);
    }
  });

  it('returns [] for empty input', () => {
    expect(dirHotspots([], HOME)).toEqual([]);
  });
});

describe('computeDirHotspots', () => {
  it('populates sizeKb (null or number) for at most the first 2 hotspots, without throwing', async () => {
    const rows = parseLsofRows(FIXTURE);
    const result = await computeDirHotspots(rows, HOME);
    expect(result.length).toBeGreaterThan(0);
    for (const h of result) {
      expect(h.sizeKb === null || typeof h.sizeKb === 'number').toBe(true);
    }
  });

  it('returns [] when there are no REG rows', async () => {
    const result = await computeDirHotspots([], HOME);
    expect(result).toEqual([]);
  });
});
