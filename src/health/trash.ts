import path from 'node:path';
import type { HealthContext } from './context.js';

/**
 * Move files to the Trash — the only way the clean-up layer ever removes anything.
 *
 * It calls NSFileManager.trashItemAtURL in-process through JavaScript for Automation, so
 * there is no Apple event, no Automation permission prompt and no Finder involved. The
 * script is a constant: the paths arrive as ARGUMENTS and are never part of its text. A
 * path the system refuses is reported as failed with the system's message; there is no
 * fallback to any other way of removing it.
 */
export const TRASH_JXA = [
  'function run(argv){ ObjC.import("Foundation"); var out=[];',
  '  for (var i=0;i<argv.length;i++){ var err=$(), res=$();',
  '    var ok=$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[i]), res, err);',
  '    out.push(JSON.stringify({path:argv[i], ok:!!ok, trashedTo: ok?ObjC.unwrap(res.path):null, error: ok?null:ObjC.unwrap(err.localizedDescription)})); }',
  '  return out.join("\\n"); }',
].join('\n');

/** At most this many paths per call, so one slow volume cannot hold a whole selection. */
export const TRASH_BATCH = 50;
const TRASH_TIMEOUT_MS = 120_000;

export interface TrashOutcome {
  path: string;
  ok: boolean;
  trashedTo?: string;
  error?: string;
}

/**
 * Read the script's output — one JSON object per line — into one outcome per requested path,
 * in request order. Garbage lines are ignored, lines about paths that were not requested are
 * ignored, and a requested path with no line at all is a failure (never a silent success).
 */
export function parseTrashOutput(text: string, paths: string[]): TrashOutcome[] {
  const seen = new Map<string, TrashOutcome>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { path?: unknown; ok?: unknown; trashedTo?: unknown; error?: unknown };
      if (typeof o.path !== 'string' || !paths.includes(o.path) || seen.has(o.path)) continue;
      if (o.ok === true && typeof o.trashedTo === 'string' && o.trashedTo !== '') {
        seen.set(o.path, { path: o.path, ok: true, trashedTo: o.trashedTo });
      } else {
        seen.set(o.path, { path: o.path, ok: false, error: typeof o.error === 'string' && o.error ? o.error : 'the system refused to move it to the Trash' });
      }
    } catch {
      /* not a result line */
    }
  }
  return paths.map((p) => seen.get(p) ?? { path: p, ok: false, error: 'no answer from the system — nothing was confirmed moved' });
}

/** A path the script may be given: absolute, no NUL (an argument starting with "-" could be read as an option). */
const safeArg = (p: string): boolean => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0');

/**
 * Move `paths` to the Trash through `ctx.run`, in batches of {@link TRASH_BATCH}. Never throws;
 * every path gets exactly one outcome, in request order.
 */
export async function trashPaths(ctx: Pick<HealthContext, 'run'>, paths: string[]): Promise<TrashOutcome[]> {
  const out: TrashOutcome[] = [];
  for (let i = 0; i < paths.length; i += TRASH_BATCH) {
    const batch = paths.slice(i, i + TRASH_BATCH);
    const runnable = batch.filter(safeArg);
    let parsed: TrashOutcome[] = [];
    if (runnable.length > 0) {
      try {
        const r = await ctx.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, ...runnable], TRASH_TIMEOUT_MS);
        // osascript prints a JavaScript result on stderr on some systems; the result lines are self-identifying.
        parsed = parseTrashOutput(`${r.stdout}\n${r.stderr}`, runnable);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        parsed = runnable.map((p) => ({ path: p, ok: false, error: `could not run the Trash helper: ${why}` }));
      }
    }
    for (const p of batch) {
      out.push(parsed.find((o) => o.path === p) ?? { path: p, ok: false, error: 'not an absolute path — refused' });
    }
  }
  return out;
}
