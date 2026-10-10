import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AuditEntry } from '../types.js';
import { healthCachePath } from './cache.js';

/** `<data dir>/actions.jsonl` — the directory of the health cache; append-only, one line per execution. */
export function auditPath(): string {
  return path.join(path.dirname(healthCachePath()), 'actions.jsonl');
}

/** Read at most this much from the end of the log: a month of clean-ups is a few KB. */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Append one line. `mkdir -p` first; never throws — a read-only data dir must not turn a
 * finished clean-up into an error (the result is still returned to the user).
 */
export async function appendAudit(entry: AuditEntry, file: string = auditPath()): Promise<boolean> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const RESULTS = new Set(['ok', 'partial', 'failed']);

/** One log line → an entry, or null when it is damaged or not an audit entry. */
export function parseAuditLine(line: string): AuditEntry | null {
  try {
    const o = JSON.parse(line) as Partial<AuditEntry> | null;
    if (!o || typeof o !== 'object') return null;
    if (typeof o.at !== 'number' || typeof o.actionId !== 'string' || !Array.isArray(o.paths)) return null;
    if (typeof o.result !== 'string' || !RESULTS.has(o.result)) return null;
    return {
      at: o.at,
      actionId: o.actionId,
      method: o.method === 'command' ? 'command' : 'trash',
      paths: o.paths.filter((p): p is string => typeof p === 'string'),
      bytesPlanned: typeof o.bytesPlanned === 'number' ? o.bytesPlanned : 0,
      bytesFreed: typeof o.bytesFreed === 'number' ? o.bytesFreed : 0,
      result: o.result as AuditEntry['result'],
      note: typeof o.note === 'string' ? o.note : '',
      ...(Array.isArray(o.trashedTo) ? { trashedTo: o.trashedTo.filter((p): p is string => typeof p === 'string') } : {}),
    };
  } catch {
    return null;
  }
}

/** The newest `limit` entries, newest first. A missing file is an empty log; damaged lines are skipped. */
export async function readAudit(limit = 100, file: string = auditPath()): Promise<AuditEntry[]> {
  let text: string;
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line of a tail read is cut
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = parseAuditLine(line);
    if (e) entries.push(e);
  }
  return entries.reverse().slice(0, Math.max(0, limit));
}

/** Σ `bytesPlanned` of the ok/partial entries at or after `ts` (a failed run cleaned nothing). Pure. */
export function sumCleaned(entries: AuditEntry[], ts: number): number {
  return entries
    .filter((e) => e.at >= ts && (e.result === 'ok' || e.result === 'partial'))
    .reduce((s, e) => s + e.bytesPlanned, 0);
}

/** Bytes cleaned since `ts`, read from the log. */
export async function cleanedSince(ts: number, file: string = auditPath()): Promise<number> {
  return sumCleaned(await readAudit(Number.MAX_SAFE_INTEGER, file), ts);
}

/** Midnight on the 1st of the month containing `now` (local time). */
export function startOfMonth(now: number = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
