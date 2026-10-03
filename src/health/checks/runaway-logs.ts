import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { ClutterItem, HealthFinding } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { ageText, evidence, onDiskBytes, plural, realFs, runPool, slug, type FsLike } from '../util.js';

const MIB = 1024 * 1024;
const TAIL_LINES = 2000;
const MIN_LINES = 50;

export interface DominantLine {
  /** The normalized text of the most repeated line. */
  line: string;
  count: number;
  lines: number;
  ratio: number;
}

/**
 * Strip the parts of a log line that vary between repeats (leading timestamp, UUIDs,
 * hex ids, numbers) so "port 51234" and "port 51235" count as the same message.
 */
export function normalizeLogLine(line: string): string {
  return line
    .replace(/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/, '')
    .replace(/^[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+/, '')
    .replace(/^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s*/, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\b0x[0-9a-f]+\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The most repeated normalized line of a log tail; null below 50 non-empty lines. */
export function dominantLine(text: string): DominantLine | null {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < MIN_LINES) return null;
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = normalizeLogLine(l);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return { line: best, count: bestCount, lines: lines.length, ratio: bestCount / lines.length };
}

/** Share of a log tail taken by its single most repeated message (0 below 50 lines). */
export function repetitionRatio(text: string): number {
  return dominantLine(text)?.ratio ?? 0;
}

/** Friendly owner names for log folders; unknown folders use the folder name. */
const LOG_OWNERS: Record<string, string> = {
  ElgatoStreamDeck: 'Stream Deck',
};

export function logOwner(folder: string): string {
  return LOG_OWNERS[folder] ?? folder;
}

export interface LogFile {
  path: string;
  bytes: number;
  mtimeMs: number;
  ratio: number;
  dominant: DominantLine | null;
}

/**
 * Severity for one folder's big log files: warn when the folder holds more than
 * 500 MiB or any file is dominated by one repeated message; risk when that holds
 * and the newest file was written in the last 10 minutes (still growing).
 */
export function classifyLogGroup(files: LogFile[], now: number): 'warn' | 'risk' | null {
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (!(total > 500 * MIB || files.some((f) => f.ratio >= 0.8))) return null;
  const newest = Math.max(...files.map((f) => f.mtimeMs));
  return now - newest < 10 * 60_000 ? 'risk' : 'warn';
}

/** Run the survey (exported with an injectable fs for tests). */
export async function checkRunawayLogs(ctx: HealthContext, fs: FsLike = realFs): Promise<CheckResult> {
  const root = `${ctx.home}/Library/Logs`;
  const findArgs = [root, '-maxdepth', '3', '-type', 'f', '-size', '+200M'];
  const found = await ctx.run('/usr/bin/find', findArgs, 10_000);
  const paths = found.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${root}/`));
  if (found.failed && paths.length === 0) {
    const err = found.stderr.trim().split('\n')[0] ?? '';
    if (/No such file/i.test(err)) return { findings: [] };
    throw new Error(err || 'find timed out');
  }
  if (paths.length === 0) return { findings: [] };

  const files = (
    await runPool(paths, 4, async (path): Promise<LogFile | null> => {
      try {
        const st = await fs.lstat(path);
        const tail = await ctx.run('/usr/bin/tail', ['-n', String(TAIL_LINES), path], 5000);
        const dominant = dominantLine(tail.stdout);
        return { path, bytes: onDiskBytes(st), mtimeMs: st.mtimeMs, ratio: dominant?.ratio ?? 0, dominant };
      } catch {
        return null; // file vanished between find and lstat
      }
    })
  ).filter((f): f is LogFile => f !== null);

  const groups = new Map<string, LogFile[]>();
  for (const f of files) {
    const rel = f.path.slice(root.length + 1);
    const key = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const findings: HealthFinding[] = [];
  for (const [folder, gf] of groups) {
    const severity = classifyLogGroup(gf, ctx.now);
    if (!severity) continue;
    const total = gf.reduce((s, f) => s + f.bytes, 0);
    const worst = [...gf].sort((a, b) => b.ratio - a.ratio)[0]!;
    const repetitive = worst.ratio >= 0.8 && worst.dominant;
    const newest = Math.max(...gf.map((f) => f.mtimeMs));
    const owner = logOwner(folder);
    const items: ClutterItem[] = gf.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      lastModified: f.mtimeMs,
      safety: 'regenerates',
      note: f.ratio >= 0.8 ? `${Math.round(f.ratio * 100)} % repeated lines` : undefined,
    }));
    const quote = repetitive
      ? `${Math.round(worst.ratio * 100)} % of the last ${TAIL_LINES} lines are the same message: “${worst.dominant!.line.slice(0, 160)}”. `
      : '';
    const growing =
      severity === 'risk'
        ? `Still growing — last write ${ageText(ctx.now - newest)} ago, so the writer is running now.`
        : `Last write ${ageText(ctx.now - newest)} ago.`;
    findings.push({
      id: `runaway-logs:${slug(folder)}`,
      checkId: 'runaway-logs',
      category: 'stability',
      severity,
      title: `${owner} ${repetitive ? 'is writing a runaway log' : 'has oversized logs'} (${fmtBytes(total)}, ${plural(gf.length, 'file')})`,
      detail: `${quote}${growing} A log this size fills the disk and keeps the disk busy; stop or update the writer before deleting the files, or it just refills them.`,
      evidence: [
        evidence(`find ~/Library/Logs -maxdepth 3 -type f -size +200M`, gf.map((f) => `${fmtBytes(f.bytes)}\t${f.path.replace(ctx.home, '~')}`)),
        evidence(
          `tail -n ${TAIL_LINES} "${worst.path}"`,
          worst.dominant
            ? [`${worst.dominant.count} of ${worst.dominant.lines} lines: ${worst.dominant.line}`]
            : ['(too few lines to measure repetition)'],
        ),
      ],
      items,
      reclaimableBytes: total,
      safety: 'regenerates',
      regenNote: 'Logs are recreated by the writer; a runaway writer will refill them until it is fixed.',
    });
  }
  return { findings };
}

export const runawayLogsCheck: HealthCheck = {
  id: 'runaway-logs',
  category: 'stability',
  scope: 'quick',
  timeoutMs: 20_000,
  run: (ctx) => checkRunawayLogs(ctx),
};
