import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, auditPath, cleanedSince, parseAuditLine, readAudit, startOfMonth, sumCleaned } from '../../src/health/audit.js';
import type { AuditEntry } from '../../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pd-audit-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  at: 1_000, actionId: 'trash-paths', method: 'trash', paths: ['/Users/test/a'], bytesPlanned: 100, bytesFreed: 0, result: 'ok', note: 'n', ...over,
});

describe('appendAudit', () => {
  it('writes exactly one JSON line per call, creating the directory', async () => {
    const file = join(dir, 'nested', 'actions.jsonl');
    expect(await appendAudit(entry({ trashedTo: ['/Users/test/.Trash/a'] }), file)).toBe(true);
    expect(await appendAudit(entry({ at: 2_000, result: 'failed' }), file)).toBe(true);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ at: 1_000, actionId: 'trash-paths', result: 'ok', trashedTo: ['/Users/test/.Trash/a'] });
    expect(JSON.parse(lines[1]!)).toMatchObject({ at: 2_000, result: 'failed' });
  });

  it('never throws on an unwritable location', async () => {
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    await expect(appendAudit(entry(), join(ro, 'deeper', 'actions.jsonl'))).resolves.toBe(false);
    // a path under a regular file cannot be created either
    writeFileSync(join(dir, 'file'), 'x');
    await expect(appendAudit(entry(), join(dir, 'file', 'actions.jsonl'))).resolves.toBe(false);
    chmodSync(ro, 0o700);
  });

  it('lives next to the health cache, in the data dir', () => {
    const prev = process.env['PD_DATA_DIR'];
    process.env['PD_DATA_DIR'] = '/tmp/pd-x';
    try {
      expect(auditPath()).toBe('/tmp/pd-x/actions.jsonl');
    } finally {
      if (prev === undefined) delete process.env['PD_DATA_DIR'];
      else process.env['PD_DATA_DIR'] = prev;
    }
  });
});

describe('readAudit', () => {
  it('returns newest first, skips damaged lines and respects the limit', async () => {
    const file = join(dir, 'actions.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify(entry({ at: 1 })),
        '{this is damaged',
        '',
        JSON.stringify({ at: 'nope' }),
        JSON.stringify({ ...entry({ at: 2 }), result: 'weird' }),
        JSON.stringify(entry({ at: 3 })),
        JSON.stringify(entry({ at: 4 })),
      ].join('\n') + '\n',
    );
    expect((await readAudit(100, file)).map((e) => e.at)).toEqual([4, 3, 1]);
    expect((await readAudit(2, file)).map((e) => e.at)).toEqual([4, 3]);
  });

  it('a missing file is an empty log', async () => {
    expect(await readAudit(100, join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('parseAuditLine fills defaults for optional fields', () => {
    expect(parseAuditLine(JSON.stringify({ at: 5, actionId: 'x', paths: ['/a'], result: 'ok' }))).toMatchObject({ method: 'trash', bytesPlanned: 0, note: '' });
    expect(parseAuditLine('null')).toBeNull();
  });
});

describe('cleanedSince', () => {
  it('sums bytesPlanned of ok and partial entries at or after the timestamp, never failed ones', () => {
    const entries = [
      entry({ at: 10, bytesPlanned: 100, result: 'ok' }),
      entry({ at: 20, bytesPlanned: 50, result: 'partial' }),
      entry({ at: 30, bytesPlanned: 999, result: 'failed' }),
      entry({ at: 5, bytesPlanned: 7, result: 'ok' }),
    ];
    expect(sumCleaned(entries, 10)).toBe(150);
    expect(sumCleaned(entries, 0)).toBe(157);
    expect(sumCleaned(entries, 100)).toBe(0);
  });

  it('reads the log from disk', async () => {
    const file = join(dir, 'actions.jsonl');
    await appendAudit(entry({ at: 10, bytesPlanned: 100 }), file);
    await appendAudit(entry({ at: 20, bytesPlanned: 40, result: 'failed' }), file);
    expect(await cleanedSince(0, file)).toBe(100);
  });

  it('startOfMonth is midnight on the 1st, local time', () => {
    const d = new Date(startOfMonth(new Date(2026, 9, 17, 14, 30).getTime()));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 1, 0, 0]);
  });
});
