import { run } from '../util/exec.js';
import type { RawProcess } from '../types.js';

/** Base fields for a process, before the full command line is joined in. */
type PsBase = Omit<RawProcess, 'command'>;

/** Last path segment of a path/command token. Null-safe. */
export function basename(p: string | null): string | null {
  if (!p) return null;
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return base || null;
}

/**
 * Parse a `ps` ELAPSED value into seconds.
 * Formats: "ss", "mm:ss", "hh:mm:ss", "dd-hh:mm:ss".
 */
export function parseEtime(raw: string): number {
  if (!raw) return 0;
  let rest = raw.trim();
  let days = 0;
  const dash = rest.indexOf('-');
  if (dash >= 0) {
    days = parseInt(rest.slice(0, dash), 10) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map((p) => parseInt(p, 10) || 0);
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) [h, m, s] = parts as [number, number, number];
  else if (parts.length === 2) [m, s] = parts as [number, number];
  else if (parts.length === 1) [s] = parts as [number];
  return days * 86400 + h * 3600 + m * 60 + s;
}

/**
 * Parse `ps -o pid=,ppid=,pcpu=,pmem=,etime=,user=,comm=` (headers suppressed).
 *
 * The first six fields are single tokens (numbers / a username / an elapsed
 * string with no spaces), so we split on whitespace and treat *everything after
 * the sixth token* as `comm`. On macOS `comm` is the full executable path, which
 * may itself contain spaces — keeping it last is what makes this unambiguous.
 */
export function parsePsComm(stdout: string): Map<number, PsBase> {
  const map = new Map<number, PsBase>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const toks = line.split(/\s+/);
    if (toks.length < 6) continue;
    const pid = parseInt(toks[0]!, 10);
    if (Number.isNaN(pid)) continue;
    const execPath = toks.length > 6 ? toks.slice(6).join(' ') : null;
    map.set(pid, {
      pid,
      ppid: parseInt(toks[1]!, 10) || 0,
      cpu: parseFloat(toks[2]!) || 0,
      mem: parseFloat(toks[3]!) || 0,
      elapsedRaw: toks[4]!,
      elapsedSeconds: parseEtime(toks[4]!),
      user: toks[5]!,
      execPath,
      name: basename(execPath) ?? 'unknown',
    });
  }
  return map;
}

/** Parse `ps -o pid=,args=` (headers suppressed) into pid -> full command. */
export function parsePsArgs(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    map.set(parseInt(m[1]!, 10), m[2]!);
  }
  return map;
}

/** Join the two `ps` views by PID into the unified RawProcess list. */
export function mergeProcesses(
  comm: Map<number, PsBase>,
  args: Map<number, string>,
): RawProcess[] {
  const out: RawProcess[] = [];
  for (const [pid, base] of comm) {
    const command = args.get(pid) ?? null;
    let name = base.name;
    // Some processes (kernel/restricted) expose no comm; fall back to argv[0].
    if ((name === 'unknown' || !name) && command) {
      name = basename(command.split(/\s+/)[0] ?? null) ?? 'unknown';
    }
    out.push({ ...base, name, command });
  }
  return out;
}

/**
 * Take one process snapshot via two cheap `ps` invocations (run in parallel and
 * joined on PID). `-ww` prevents argument truncation; `=` suppresses headers.
 */
export async function collectProcesses(): Promise<RawProcess[]> {
  const [commRes, argsRes] = await Promise.all([
    run('ps', ['-axww', '-o', 'pid=,ppid=,pcpu=,pmem=,etime=,user=,comm=']),
    run('ps', ['-axww', '-o', 'pid=,args=']),
  ]);
  return mergeProcesses(parsePsComm(commRes.stdout), parsePsArgs(argsRes.stdout));
}
