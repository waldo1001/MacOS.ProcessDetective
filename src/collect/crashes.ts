import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import type { CrashGroup } from '../types.js';

export { CrashGroup };

/**
 * Parse a crash report filename to extract process name, approximate timestamp,
 * and a dedup event key.
 * Returns null for unrecognised filenames.
 *
 * Patterns handled:
 *   Google Chrome Helper-2026-06-26-131241.ips          → "Google Chrome Helper"
 *   chrome_crashpad_handler-2026-06-26-131241.0003.ips  → "chrome_crashpad_handler"
 *   MyApp_2026-06-26-131241.crash                       → "MyApp"
 *   app-name_2026-06-26_131241.ips                      → "app-name"
 *
 * Event key: files of the form <process>-<YYYY-MM-DD-HHMMSS>[.NNNN].ips that share
 * the same process + base timestamp are one crash event. The eventKey is
 * `process|baseTimestamp` where the trailing dump index (.000, .0002, .0003) is
 * stripped before the extension.
 */
export function parseCrashFilename(
  file: string,
): { process: string; at: number; eventKey: string } | null {
  // Strip the final extension (.ips, .crash, .diag, etc.)
  const base = file.replace(/\.[^.]+$/, '');

  // Try to find a date segment: -YYYY-MM-DD or _YYYY-MM-DD
  const dateMatch = base.match(/[-_](\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;

  const dateIdx = base.indexOf(dateMatch[0]!);
  if (dateIdx <= 0) return null;

  const processName = base.slice(0, dateIdx).trim();
  if (!processName) return null;

  // Parse the date (time portion is best-effort)
  const dateStr = dateMatch[1]!;
  const at = new Date(dateStr).getTime();
  if (isNaN(at)) return null;

  // Build the event key: everything after the process name, with the trailing
  // numeric dump-index suffix (.000, .0002, .0003, etc.) stripped.
  // e.g. "-2026-06-25-194230.000" → "-2026-06-25-194230"
  const afterProcess = base.slice(dateIdx); // includes the separator + date + optional time + optional dump-index
  const baseTimestamp = afterProcess.replace(/\.\d+$/, '');
  const eventKey = processName + '|' + baseTimestamp;

  return { process: processName, at, eventKey };
}

/**
 * Scan DiagnosticReports directories, group recent crash reports by process name
 * (counting distinct events, not dump files), and return the groups sorted by
 * count desc then recency.
 */
export async function getRecentCrashes(windowMs = 3_600_000): Promise<CrashGroup[]> {
  const dirs: string[] = [
    join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    '/Library/Logs/DiagnosticReports',
  ];

  const now = Date.now();
  const sinceMs = now - windowMs;

  // Map from process name → set of eventKeys seen + timestamps
  const groups = new Map<string, { eventKeys: Set<string>; times: number[] }>();

  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      // Unreadable (no permission, doesn't exist) — skip silently
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.ips') && !file.endsWith('.crash')) continue;

      const parsed = parseCrashFilename(file);
      if (!parsed) continue;

      // Use file mtime as the authoritative timestamp (more robust than filename parsing)
      let mtime: number;
      try {
        const s = await stat(join(dir, file));
        mtime = s.mtimeMs;
      } catch {
        // Use filename-derived date as fallback
        mtime = parsed.at;
      }

      if (mtime < sinceMs) continue;

      const existing = groups.get(parsed.process);
      if (existing) {
        existing.eventKeys.add(parsed.eventKey);
        existing.times.push(mtime);
      } else {
        groups.set(parsed.process, {
          eventKeys: new Set([parsed.eventKey]),
          times: [mtime],
        });
      }
    }
  }

  const result: CrashGroup[] = Array.from(groups.entries()).map(([process, { eventKeys, times }]) => {
    const count = eventKeys.size;
    const firstAt = Math.min(...times);
    const lastAt = Math.max(...times);
    // looping: 3+ distinct events within 10 minutes
    const looping = count >= 3 && (lastAt - firstAt) <= 10 * 60_000;
    return { process, count, firstAt, lastAt, looping };
  });

  // Sort by count desc, then recency desc
  result.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  return result.slice(0, 10);
}
