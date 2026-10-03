import { run } from '../util/exec.js';
import type { LogTailSnapshot, LogPattern, LogSubsystem } from '../types.js';

// ---------------------------------------------------------------------------
// buildLogShowArgs — PURE, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Build the arg array for `/usr/bin/log show`.
 * - pid must be a positive integer (throws RangeError otherwise).
 * - minutes is clamped to [1, 10], defaults to 3.
 * Returns args suitable for execFile (no shell expansion).
 */
export function buildLogShowArgs(pid: number, minutes = 3): string[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(`Invalid pid: ${pid}`);
  }
  const m = Math.max(1, Math.min(10, Number.isFinite(minutes) ? Math.floor(minutes) : 3));
  return [
    'show',
    '--last', `${m}m`,
    '--predicate', `processID == ${pid}`,
    '--style', 'compact',
    '--info',
  ];
}

// ---------------------------------------------------------------------------
// parseLogShow — PURE, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Normalize a raw log message into a pattern string for grouping.
 * Replaces hex addresses, UUIDs, and bare numbers with placeholders.
 */
function normalizeMessage(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '0x…')
    .replace(/\b[0-9a-f-]{8,}\b/gi, '…')
    .replace(/\d+/g, '#');
}

/**
 * Parse compact `log show` output into a LogTailSnapshot.
 *
 * Compact line format:
 *   YYYY-MM-DD HH:MM:SS.mmm TYPE  PROCESS[PID:TID]  (SENDER)|[subsystem:category]  MESSAGE
 *
 * TYPE codes: Df (default), In/I (info), E/Er (error), F (fault), A (activity), Db (debug).
 * Lines starting with E or F are counted as error/fault.
 */
export function parseLogShow(stdout: string, pid: number, minutes: number): LogTailSnapshot {
  const clampedMinutes = Math.max(1, Math.min(10, Number.isFinite(minutes) ? Math.floor(minutes) : 3));
  const lines = stdout.split('\n');

  // Count <private> occurrences in the full output
  let privateRedacted = 0;
  for (const match of stdout.matchAll(/<private>/g)) {
    void match;
    privateRedacted++;
  }

  interface ParsedLine {
    type: string;
    subsystem: string | null;
    message: string;
  }

  const parsed: ParsedLine[] = [];

  for (const line of lines) {
    // Must start with a timestamp pattern YYYY-MM-DD HH:MM:SS.mmm
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+/.test(line)) continue;

    // Layout after timestamp (23 chars + space):
    //   YYYY-MM-DD HH:MM:SS.mmm TY PROCESS[PID:TID] …
    // The timestamp is the first 23 chars, then whitespace, then type, then space(s), then rest
    const rest = line.slice(23).trimStart();

    // Extract type token (letters, no spaces)
    const typeMatch = rest.match(/^(\S+)\s+/);
    if (!typeMatch) continue;
    const type = typeMatch[1]!;
    const afterType = rest.slice(typeMatch[0].length);

    // afterType: PROCESS[PID:TID] (SENDER)|[subsystem:category] message
    // Skip the process[pid:tid] token
    const procMatch = afterType.match(/^\S+\s*/);
    if (!procMatch) continue;
    const afterProc = afterType.slice(procMatch[0].length);

    // Try to extract subsystem: [subsystem:category] or (Sender)
    let subsystem: string | null = null;
    let message = afterProc;

    const subsysMatch = afterProc.match(/^(\[[\w.:]+\]|\([\w.]+\))\s*/);
    if (subsysMatch) {
      subsystem = subsysMatch[1]!;
      message = afterProc.slice(subsysMatch[0].length);
    }

    parsed.push({ type, subsystem, message: message.slice(0, 200) });
  }

  const totalLines = parsed.length;

  if (totalLines === 0) {
    return {
      available: false,
      pid,
      windowMinutes: clampedMinutes,
      totalLines: 0,
      topPatterns: [],
      bySubsystem: [],
      errorCount: 0,
      privateRedacted,
      note: `No log entries in the last ${clampedMinutes}m (or logging is restricted).`,
    };
  }

  // Count error/fault lines (type starts with E or F)
  let errorCount = 0;
  for (const l of parsed) {
    if (/^[EF]/i.test(l.type)) errorCount++;
  }

  // topPatterns: group by normalized message, keep first raw sample per group
  const patternMap = new Map<string, { sample: string; count: number; subsystem: string | null }>();
  for (const l of parsed) {
    const key = normalizeMessage(l.message);
    const existing = patternMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      patternMap.set(key, {
        sample: l.message.slice(0, 160),
        count: 1,
        subsystem: l.subsystem,
      });
    }
  }
  const topPatterns: LogPattern[] = [...patternMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // bySubsystem: group by subsystem string
  const sysMap = new Map<string, number>();
  for (const l of parsed) {
    if (l.subsystem) {
      sysMap.set(l.subsystem, (sysMap.get(l.subsystem) ?? 0) + 1);
    }
  }
  const bySubsystem: LogSubsystem[] = [...sysMap.entries()]
    .map(([subsystem, count]) => ({ subsystem, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const note =
    privateRedacted > 0
      ? `macOS redacted ${privateRedacted} private field(s); install a logging profile to reveal them.`
      : null;

  return {
    available: true,
    pid,
    windowMinutes: clampedMinutes,
    totalLines,
    topPatterns,
    bySubsystem,
    errorCount,
    privateRedacted,
    note,
  };
}

// ---------------------------------------------------------------------------
// getProcessLog — async runner
// ---------------------------------------------------------------------------

/**
 * Run `log show` for a given pid and return a LogTailSnapshot.
 * Never throws — degrades to available:false on failure.
 */
export async function getProcessLog(pid: number, minutes = 3): Promise<LogTailSnapshot> {
  const clampedMinutes = Math.max(1, Math.min(10, Number.isFinite(minutes) ? Math.floor(minutes) : 3));
  let args: string[];
  try {
    args = buildLogShowArgs(pid, clampedMinutes);
  } catch {
    return {
      available: false,
      pid,
      windowMinutes: clampedMinutes,
      totalLines: 0,
      topPatterns: [],
      bySubsystem: [],
      errorCount: 0,
      privateRedacted: 0,
      note: 'log show failed or returned nothing (process may have exited).',
    };
  }

  const res = await run('/usr/bin/log', args, 8000);
  // Normalize line endings (defensive)
  const out = res.stdout.replace(/\r\n?/g, '\n');

  if (res.failed && !out.trim()) {
    return {
      available: false,
      pid,
      windowMinutes: clampedMinutes,
      totalLines: 0,
      topPatterns: [],
      bySubsystem: [],
      errorCount: 0,
      privateRedacted: 0,
      note: 'log show failed or returned nothing (process may have exited).',
    };
  }

  return parseLogShow(out, pid, clampedMinutes);
}
