# Spec: Per-process unified log tail + notable open-file highlighting

Status: ready to build (Sonnet). Spec + verification owned by Opus.

## Origin

An investigation of `BackgroundShortcutRunner` (a macOS Shortcuts XPC service pegging
a core at ~100%) showed the app's snapshot gave the analyst everything *except* the
two signals that actually named the culprit:

1. The AI's top follow-up was `log show --predicate 'subsystem == "com.apple.WorkflowKit"'`
   to see **which shortcut fired**. The app has no unified-log capability at all.
2. The AI had to **manually** pick `~/Library/Shortcuts/ToolKit/Tools-prod.v67…sqlite-shm`
   out of the open-file list as the smoking gun, dismissing `.loctable`,
   `linkd.metadatastore`, `.plist-cache` as noise. The app dumps the top 6 open files
   flat, with no signal/noise ranking.

Both are the recurring theme: *the cause lives outside the process*. Feature 1 is the
generic "what is it doing, in its own words" signal (the analogue of the existing crash
cross-reference that names the crasher for ReportCrash). Feature 2 is a cheap
correctness win that makes the smoking-gun file jump to the top.

Feasibility already verified by Opus:
- `/usr/bin/log show --last 3m --predicate 'processID == <pid>' --style compact` works
  **with no sudo**, ~1.3s for 3 minutes / ~2400 lines of a busy process. `<private>`
  fields are redacted without a logging config profile — **sudo does NOT unlock them**,
  so there is deliberately **no elevated variant**. Note the redaction; don't try to fix it.

Non-negotiables (match the existing codebase):
- Read-only. Never kill/modify anything. `run()` from `src/util/exec.ts` (execFile, no
  shell — pass args as an array; never string-concatenate the pid).
- All parsers **pure and unit-tested** with fixtures (mirror `test/docker.test.ts`).
- The log tail is **on-demand only** (like `POST /api/sample` and `POST /api/docker`) —
  NEVER on the polled `/api/inspect` path.
- Graceful degradation to `available:false` + a `note`, never a throw.
- ESM: relative imports use `.js` extensions. Strict TS.

---

## Feature 1 — Per-process unified log tail (on-demand)

### 1a. New collector: `src/collect/oslog.ts`

```ts
import { run } from '../util/exec.js';
import type { LogTailSnapshot } from '../types.js';
```

**`buildLogShowArgs(pid: number, minutes: number): string[]`** — PURE, exported, unit-tested.
- Guard: if `!Number.isInteger(pid) || pid <= 0` throw `RangeError` (defensive; the
  endpoint already parses `\d+`). Clamp `minutes` to `[1, 10]`, default 3.
- Return:
  ```
  ['show', '--last', `${minutes}m`, '--predicate', `processID == ${pid}`,
   '--style', 'compact', '--info']
  ```
  (No `--debug` — too noisy. `--info` includes Info-level, which is where most app
  messages live.)

**`parseLogShow(stdout: string, pid: number, minutes: number): LogTailSnapshot`** — PURE, exported, unit-tested.
- Compact line format (real samples, capture your own with the command above):
  ```
  2026-07-01 10:04:41.007 A  WindowServer[411:b4b4e] (RunningBoardServices) observedProcessStatesDidChange
  2026-07-01 10:04:41.177 Df WindowServer[411:b61aa] [com.apple.SkyLight:default] [Event] Process button state old:0 new:1 …
  ```
  Layout: `TIMESTAMP  TYPE  PROCESS[PID:TID]  (SENDER)|[subsystem:category]  MESSAGE`.
  - `TYPE` is a short code column: `Df` (default), `In`/`I` (info), `E`/`Er` (error),
    `F` (fault), `A` (activity), `Db` (debug). Treat any type starting with `E` or `F`
    as an **error/fault** line.
  - Skip the header line (`Timestamp ... Process[PID:TID]`) and any lines that don't
    match the leading `YYYY-MM-DD HH:MM:SS.mmm ` timestamp.
  - Extract, per line: `type`, `subsystem` (the `[subsystem:category]` token if present,
    else the `(Sender)` token, else null), and `message` (the remainder).
- Compute:
  - `totalLines` — count of parsed log lines.
  - `topPatterns` — group lines by a **normalized message pattern**: lowercase, then
    replace runs of hex/uuids/numbers/addresses with a placeholder, e.g.
    `msg.replace(/0x[0-9a-f]+/gi,'0x…').replace(/\b[0-9a-f-]{8,}\b/gi,'…').replace(/\d+/g,'#')`.
    For each group keep `{ sample, count, subsystem }` where `sample` is the first raw
    (un-normalized, but truncated to ~160 chars) message. Sort by count desc, cap **8**.
    **This is the smoking gun** — a spinning process repeats the same line.
  - `bySubsystem` — `{ subsystem, count }[]`, sorted desc, cap **8**.
  - `errorCount` — number of error/fault lines.
  - `privateRedacted` — count of `<private>` occurrences in stdout.
  - `note` — set when `available` but `privateRedacted > 0`:
    `"macOS redacted <N> private field(s); install a logging profile to reveal them."`
    When no lines parsed: `available:false`, note `"No log entries in the last <m>m (or logging is restricted)."`

**`getProcessLog(pid: number, minutes = 3): Promise<LogTailSnapshot>`** — async runner.
- `const res = await run('/usr/bin/log', buildLogShowArgs(pid, minutes), 8000)`.
- Normalize line endings: `const out = res.stdout.replace(/\r\n?/g, '\n')` (defensive).
- If `res.failed && !out.trim()` → return `{ available:false, pid, windowMinutes:minutes,
  totalLines:0, topPatterns:[], bySubsystem:[], errorCount:0, privateRedacted:0,
  note: 'log show failed or returned nothing (process may have exited).' }`.
- Otherwise `return parseLogShow(out, pid, clampedMinutes)`.

### 1b. Types — add to `src/types.ts`

```ts
export interface LogPattern { sample: string; count: number; subsystem: string | null; }
export interface LogSubsystem { subsystem: string; count: number; }
export interface LogTailSnapshot {
  available: boolean;
  pid: number;
  windowMinutes: number;
  totalLines: number;
  topPatterns: LogPattern[];
  bySubsystem: LogSubsystem[];
  errorCount: number;
  privateRedacted: number;
  note: string | null;
}
```
Add to `Enrichment`: `logTail?: LogTailSnapshot;` (optional, only present when fetched
on-demand — exactly like `stackSample?`).

### 1c. Endpoint — `src/server/server.ts`

Add a route mirroring the `/api/sample/:pid` block (place it near `/api/docker`):
```ts
const lm = url.pathname.match(/^\/api\/log\/(\d+)$/);
if (lm && req.method === 'POST') {
  const pid = parseInt(lm[1]!, 10);
  const tree = await snapshot();
  const node = tree.byPid.get(pid);
  if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
  const minutesParam = url.searchParams.get('minutes');
  const minutes = minutesParam ? Math.max(1, Math.min(10, parseInt(minutesParam,10) || 3)) : 3;
  const [enr, logTail] = await Promise.all([enrich(node), getProcessLog(pid, minutes)]);
  const enriched = { ...enr, logTail };
  const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
  const s = stats.get(pid);
  const payload = inspectPayload(node, enriched, {
    threads: s?.threads ?? null, energy: s?.energy ?? null, fdCount,
  });
  return json(res, 200, { logTail, report: payload.report, prompt: payload.prompt, detail: payload });
}
```
Import `getProcessLog` from `../collect/oslog.js`.

### 1d. payload / report / prompt

- `src/server/payload.ts` `inspectPayload`: add `logTail: enr.logTail ?? null,`.
- `src/report/report.ts` `generateReport`: after the Docker section, before Stack
  sample, add (only when `enr.logTail?.available`):
  ```
  Process log (last <m>m):
    <totalLines> entries, <errorCount> error/fault
    Top repeated messages:
      <count>x [<subsystem>] <sample>
      …
    (note line if privateRedacted > 0)
  ```
  The "top repeated messages" list is the payload — a spinning process shows one line
  dominating the count.
- `src/report/prompt.ts` QUESTIONS: add item **9**:
  ```
  '9. If a process log is included, use the top repeated messages to say what the',
  '   process is actively doing (which workflow/task/subsystem is firing) and whether',
  '   it looks like a tight loop or retry storm.',
  ```

### 1e. UI — `src/server/page.html`

Mirror the Docker "⚙ Per-container CPU" button exactly:
- State: `logMeasuring` (bool), `logResult` (LogTailSnapshot|null). Reset both to
  null/false in `loadDetail()`.
- In the detail render (`rDetail`), add a **"📜 Process log"** card with a button that
  POSTs `/api/log/<pid>?minutes=3`, sets `logMeasuring` while awaiting, then renders:
  - header `<totalLines> log entries in <m>m · <errorCount> error/fault`
  - the `topPatterns` list: `<count>×  [subsystem]  sample` (truncate sample, monospace)
  - `bySubsystem` as small chips (optional)
  - the `note` (redaction) in muted text
  - `available:false` → show the note only.
- Bind the button in `bindAfter()` (follow the `dockerStatsBtn` pattern). Guard against
  double-clicks while `logMeasuring`.

---

## Feature 2 — Notable open-file highlighting (cheap, no sudo)

### 2a. New pure module: `src/enrich/openfiles.ts`

```ts
import type { OpenFile } from '../types.js';
export type OpenFileClass = 'signal' | 'noise' | 'neutral';
export interface RankedOpenFile { file: OpenFile; score: number; cls: OpenFileClass; notable: boolean; }
```

**`classifyOpenFile(path: string, home: string): OpenFileClass`** — PURE, unit-tested.
- SIGNAL (the workload a process chews on):
  - data stores by extension: `/\.(sqlite3?|sqlite-wal|sqlite-shm|db|realm|mdb|leveldb|ldb)$/i`
  - user data under the home dir that is clearly *content*, e.g. paths containing
    `/Library/Shortcuts/`, `/Library/Application Support/`, `/Library/Containers/…/Data/`,
    `/Library/Messages/`, `/Library/Mail/`, or under `~/Documents`, `~/Desktop`, `~/Developer`,
    `~/Projects`, `~/src`, `~/code`, `~/SourceCode`.
  - app/user log files: `/\.log$/i` under the home dir (not under `/System` or `/usr`).
- NOISE (system incidentals — the AI dismissed exactly these):
  - `/\.(loctable|strings|nib|car|ttf|otf|woff2?|icns|dylib|so|plist-cache)$/i`
  - path contains `linkd`, `metadatastore`, `/Caches/`, `.cache`, `TemporaryItems`,
    `/var/folders/`, `/System/`, `/usr/lib`, `/usr/share`, `/Library/Fonts`,
    `/private/var/db/`, `.framework/`, `.dSYM/`.
- Otherwise `'neutral'`.
- Order of checks: SIGNAL by data-extension first, then NOISE, then SIGNAL by path,
  then neutral. (A `.sqlite` under Caches is still noise — apply NOISE-by-path before
  SIGNAL-by-path but AFTER SIGNAL-by-data-extension is a judgment call; prefer:
  data-extension SIGNAL wins even under Caches, since a live SQLite handle is the
  workload. Encode this order and test it.)

**`rankOpenFiles(files: OpenFile[], home: string): RankedOpenFile[]`** — PURE, unit-tested.
- score: signal `+2`, neutral `0`, noise `-1`. Directories (`type==='dir'`) and sockets
  get a small penalty so real data files rank above them (`-` a little), but keep sockets
  visible (a process's unexpected socket can be a signal — don't hide them).
- Stable-sort by score desc (preserve original order within equal scores).
- `notable` = true for the **single highest-scoring file when its class is 'signal'**
  (the smoking gun). If nothing is a signal, no file is marked notable.

### 2b. Wire into report + payload (no new syscalls)

- `src/report/report.ts` Open-files section: replace the flat `enr.openFiles.slice(0,6)`
  with `rankOpenFiles(enr.openFiles, homedir())` (import `homedir` from `node:os`).
  Show the top 6 ranked. Tag the `notable` one:
  ```
  [file] ~/Library/Shortcuts/ToolKit/Tools-prod.v67…sqlite-shm   ← likely the workload
  ```
  Keep using `homePath()` for display.
- `src/server/payload.ts`: keep `openFiles` as-is for compat, and ADD
  `openFilesRanked: rankOpenFiles(enr.openFiles, homedir()).map(r => ({ path: r.file.path,
  type: r.file.type, notable: r.notable, cls: r.cls }))`.
- `src/server/page.html`: in the open-files list, render ranked order and show a small
  **"notable"** badge (or `←likely workload`) on the `notable` entry. Use
  `openFilesRanked` if present, else fall back to `openFiles`.

---

## Tests (add, don't weaken existing 166)

- `test/oslog.test.ts` — `buildLogShowArgs` (pid guard, minutes clamp, exact arg array);
  `parseLogShow` against a fixture `test/fixtures/oslog-compact.txt` containing: a header
  line, ~20 mixed lines, a dominant repeated message (same text, different numbers → must
  collapse into one `topPatterns` entry with the right count), at least one `E`/`F` line,
  and one `<private>` token. Assert totalLines, top pattern count/sample, errorCount,
  privateRedacted, bySubsystem, and the empty-input → `available:false` path.
- `test/openfiles.test.ts` — `classifyOpenFile` for each SIGNAL/NOISE/neutral case
  (the real Shortcuts SQLite path = signal; `.loctable`, `linkd.metadatastore`,
  `.plist-cache` = noise; a `.sqlite` under `/Caches/` = signal by data-extension per the
  rule above — test whichever order you encode and document it); `rankOpenFiles` ordering
  + exactly-one `notable` when a signal exists, none when it doesn't.

## Definition of done (the build agent must self-check, Opus re-verifies independently)

1. `npx tsc --noEmit` clean; `npm run build` ok (page.html copied to dist).
2. `npm test` green — existing 166 still pass + new tests.
3. `node --check` on the extracted page.html `<script>` passes.
4. Live smoke (server on a spare port, **reap it after — no orphans, no 1s loops**):
   - Pick a real chatty pid (e.g. WindowServer). `POST /api/log/<pid>?minutes=3` →
     `available:true`, `totalLines>0`, `topPatterns` non-empty, `errorCount` a number,
     `privateRedacted` reported. Confirm `report` contains "Process log (last 3m)".
   - `POST /api/log/<pid>` is **never** triggered by `GET /api/inspect/<pid>` (grep the
     inspect path — no `getProcessLog` call there).
   - `GET /api/inspect/<pid>` for a process with a real user-data file open shows
     `openFilesRanked` with the data file marked `notable:true` and a `.loctable`/cache
     file ranked below it.
   - page.html contains "Process log" and the notable/"likely workload" markup.
5. Report anything surprising; do not paper over anomalies. **Do not trust your own
   summary — Opus will run the smoke commands again.**

## Out of scope (do NOT build)

- Elevated/sudo log variant (private data needs a config profile, not sudo).
- `log stream` (continuous) — one-shot `log show` only.
- Persisting log output to history.
