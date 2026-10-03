import { run } from '../util/exec.js';
import { runElevated } from './elevated.js';

export interface StackFrame {
  samples: number;
  symbol: string;
  binary: string | null;
}

export interface StackSample {
  available: boolean;
  cpuBound: boolean | null;
  verdict: string | null;
  topFrames: StackFrame[];
  threadCount: number;
  note: string | null;
  raw?: string;
}

/**
 * Syscalls that indicate the process is blocked/waiting rather than computing.
 * High CPU + one of these = unusual (surface both); otherwise it's just sleeping.
 */
const WAIT_SYSCALLS = new Set([
  '__psynch_cvwait',
  '__psynch_mutexwait',
  'mach_msg2_trap',
  'mach_msg_trap',
  'kevent',
  'kevent_id',
  '__select',
  '__read',
  'poll',
  'semaphore_wait',
  '__workq_kernreturn',
  '__sigsuspend',
  'sigsuspend',
  '__select_nocancel',
  '__read_nocancel',
  'read',
  'select',
  'nanosleep',
  '__nanosleep',
]);

/**
 * Frames that are pure scaffolding — not meaningful as a "what is it doing"
 * headline, but we keep them in topFrames for completeness.
 */
const SCAFFOLDING = new Set([
  'start',
  '_pthread_start',
  'thread_start',
  'main',
  '_dispatch_worker_thread',
  '_dispatch_root_queue_drain',
  '_dispatch_main_queue_callback_4CF',
  '_dispatch_queue_drain',
  'dispatch_main',
]);

/**
 * Parse a `sample <pid>` output text into a StackSample.
 * Pure function — no side effects, unit-tested with committed fixtures.
 */
export function parseSample(text: string): StackSample {
  if (!text || text.trim().length === 0) {
    return { available: false, cpuBound: null, verdict: null, topFrames: [], threadCount: 0, note: 'could not parse sample' };
  }

  // Find the Call graph section
  const cgIdx = text.indexOf('Call graph:');
  if (cgIdx === -1) {
    return { available: false, cpuBound: null, verdict: null, topFrames: [], threadCount: 0, note: 'could not parse sample' };
  }

  const cgSection = text.slice(cgIdx);

  // Count thread headers (Thread_XXXXXXX lines inside Call graph)
  const threadMatches = cgSection.match(/^\s+\d+\s+Thread_/gm);
  const threadCount = threadMatches ? threadMatches.length : 0;

  // Parse lines in the call graph section into {depth, count, symbol, binary}
  // Format: <leading spaces><count> <symbol>  (in <binary>) + <offset>  [<addr>]
  //      or: <leading spaces><count> ???  (in <binary>)  load address ...
  const lines = cgSection.split('\n');

  interface Frame {
    depth: number;
    count: number;
    symbol: string;
    binary: string | null;
  }

  const frames: Frame[] = [];
  for (const line of lines) {
    // Skip the "Call graph:" header itself and empty lines
    if (!line.trim() || line.trim() === 'Call graph:') continue;
    // Stop at Binary Images
    if (line.startsWith('Binary Images:') || line.trim().startsWith('Binary Images:')) break;
    // Stop at "Total number in stack" or "Sort by"
    if (line.trim().startsWith('Total number') || line.trim().startsWith('Sort by')) break;

    // Match: leading spaces + count + symbol + optional "(in binary)"
    const m = line.match(/^( +)(\d+)\s+(\S+.*?)\s*(?:\(in ([^)]+)\))?(?:\s+\+\s+\d+)?(?:\s+\[0x[0-9a-f]+\])?(?:\s+load address.*)?$/);
    if (!m) continue;

    const depth = m[1]!.length;
    const count = parseInt(m[2]!, 10);
    if (isNaN(count) || count <= 0) continue;

    // Symbol: everything between count and the optional "(in binary)"
    let symbol = m[3]!.trim();
    // Clean up trailing "+ offset [addr]" if the regex didn't fully eat it
    symbol = symbol.replace(/\s+\+\s+\d+\s*\[0x[0-9a-f]+\]\s*$/, '').trim();
    symbol = symbol.replace(/\s+load address.*$/, '').trim();

    const binary: string | null = m[4] ?? null;

    frames.push({ depth, count, symbol, binary });
  }

  if (frames.length === 0) {
    return { available: false, cpuBound: null, verdict: null, topFrames: [], threadCount, note: 'could not parse sample' };
  }

  // Find the root frame (minimum depth, maximum count — usually the Thread_ or start line)
  // Then descend greedily picking the child with the highest count.
  const minDepth = Math.min(...frames.map((f) => f.depth));
  const roots = frames.filter((f) => f.depth === minDepth);
  const rootFrame = roots.reduce((best, f) => (f.count > best.count ? f : best), roots[0]!);

  // Walk the call chain: at each level pick the child with highest count
  const chainFrames: Frame[] = [rootFrame];
  let current = rootFrame;

  // To find children: they have greater depth and appear after current in frames array
  // AND their depth should be exactly current.depth + some increment
  // We iterate linearly to preserve the nesting order
  while (true) {
    const currentIdx = frames.lastIndexOf(current);
    // Candidates: frames after current with depth > current.depth
    const children = frames.slice(currentIdx + 1).filter((f) => f.depth > current.depth);
    if (children.length === 0) break;
    // The immediate children have the smallest depth > current.depth
    const nextDepth = Math.min(...children.map((f) => f.depth));
    const immediateChildren = children.filter((f) => f.depth === nextDepth);
    const best = immediateChildren.reduce((b, f) => (f.count > b.count ? f : b), immediateChildren[0]!);
    chainFrames.push(best);
    current = best;
  }

  // Take the last ≤6 frames of the chain
  const topFrames: StackFrame[] = chainFrames.slice(-6).map((f) => ({
    samples: f.count,
    symbol: f.symbol,
    binary: f.binary,
  }));

  // Find the deepest meaningful frame for the verdict (skip scaffolding)
  const meaningfulFrame = [...chainFrames].reverse().find(
    (f) => !SCAFFOLDING.has(f.symbol) && !f.symbol.startsWith('???'),
  ) ?? chainFrames[chainFrames.length - 1]!;

  const hotSymbol = meaningfulFrame.symbol;
  const hotBinary = meaningfulFrame.binary;

  const cpuBound = !WAIT_SYSCALLS.has(hotSymbol);

  let verdict: string;
  if (!cpuBound) {
    verdict = `mostly waiting in ${hotSymbol}${hotBinary ? ` (${hotBinary})` : ''} (not CPU-bound)`;
  } else {
    verdict = `spinning in ${hotSymbol}${hotBinary ? ` (${hotBinary})` : ''}`;
  }

  return {
    available: true,
    cpuBound,
    verdict,
    topFrames,
    threadCount,
    note: null,
    raw: text,
  };
}

/**
 * Build the privileged sample shell command. PURE — unit-tested.
 *
 * Uses the absolute path to `sample` so it works under the reduced PATH of
 * `do shell script`. Only sanitized integers are interpolated.
 *
 * @throws if `pid` is not a positive integer.
 */
export function buildElevatedSampleCommand(pid: number, seconds: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pid must be a positive integer, got: ${pid}`);
  }
  // Clamp and floor seconds to the range [1, 5].
  const safeSecs = Math.max(1, Math.min(5, Math.floor(seconds)));
  const cmd = `/usr/bin/sample ${pid} ${safeSecs}`;
  // Sanity-assert the result before returning (belt-and-suspenders).
  if (!/^\/usr\/bin\/sample \d+ \d+$/.test(cmd)) {
    throw new Error(`Unexpected command shape: ${cmd}`);
  }
  return cmd;
}

/**
 * Run `sample <pid>` as root via the macOS admin auth dialog, then parse it.
 * Never throws — returns available:false with a descriptive note on any failure.
 *
 * Respects the PD_NO_ELEVATED=1 environment kill-switch (enforced inside runElevated).
 */
export async function getStackSampleElevated(pid: number, seconds = 2): Promise<StackSample> {
  let innerCmd: string;
  try {
    innerCmd = buildElevatedSampleCommand(pid, seconds);
  } catch (err) {
    return {
      available: false,
      cpuBound: null,
      verdict: null,
      topFrames: [],
      threadCount: 0,
      note: `elevated sampling failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const timeoutMs = (seconds + 30) * 1000;
  const elev = await runElevated(innerCmd, timeoutMs);

  if (!elev.ok) {
    return {
      available: false,
      cpuBound: null,
      verdict: null,
      topFrames: [],
      threadCount: 0,
      note: elev.note ?? 'elevated sampling failed',
    };
  }

  if (elev.stdout.includes('Call graph') || elev.stdout.includes('Analysis of sampling')) {
    const result = parseSample(elev.stdout);
    if (result.available) {
      result.raw = elev.stdout.slice(0, 4096);
    }
    return result;
  }

  return {
    available: false,
    cpuBound: null,
    verdict: null,
    topFrames: [],
    threadCount: 0,
    note: 'elevated sampling failed: unexpected output',
  };
}

/**
 * Run `sample <pid> <seconds>` and parse the output into a StackSample.
 * Degrades gracefully when the process is owned by another user or gone.
 */
export async function getStackSample(pid: number, seconds = 2): Promise<StackSample> {
  const timeoutMs = (seconds + 4) * 1000;
  const res = await run('sample', [String(pid), String(seconds)], timeoutMs);

  if (res.failed || !res.stdout) {
    const combined = (res.stderr + res.stdout).toLowerCase();
    const isPermission =
      combined.includes('permission denied') ||
      combined.includes('unable to') ||
      combined.includes('not permitted') ||
      combined.includes('process') && combined.includes('not found') ||
      combined.includes('no process');
    return {
      available: false,
      cpuBound: null,
      verdict: null,
      topFrames: [],
      threadCount: 0,
      note: isPermission
        ? 'requires elevated access or process is gone'
        : `sample failed: ${(res.stderr || res.stdout).slice(0, 120).trim()}`,
    };
  }

  // Check for permission/not-found messages in stdout (sample sometimes exits 0 but reports errors)
  const lower = res.stdout.toLowerCase();
  if (
    lower.includes('unable to') ||
    lower.includes('permission denied') ||
    (lower.includes('process') && lower.includes('not found'))
  ) {
    return {
      available: false,
      cpuBound: null,
      verdict: null,
      topFrames: [],
      threadCount: 0,
      note: 'requires elevated access or process is gone',
    };
  }

  const result = parseSample(res.stdout);
  if (result.available) {
    // Trim the raw output to keep it reasonable (first 4KB)
    result.raw = res.stdout.slice(0, 4096);
  }
  return result;
}
