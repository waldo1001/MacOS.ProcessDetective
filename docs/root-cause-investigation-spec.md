# Spec — Root-cause investigation ("what is it doing, and why")

Make Process Detective explain *causes*, not just *who/where*. Today the snapshot
answers identity (pid/ppid/name/command/cwd/ports/parent chain) but never **what a
process is actually executing** or **why a symptom process is busy**. This adds:

1. **Stack sample** — "what is it doing right now?" (flagship)
2. **System-process awareness + crash cross-reference** — name the real culprit
   behind symptom daemons like `ReportCrash`
3. **Open handles** in the report (lightweight)
4. **Bake all of it into the diagnostic report + AI investigation prompt** so an
   agent concludes instead of asking for more commands

Motivating case: `ReportCrash` was pegged at ~100% CPU; the parent chain
(`launchd → ReportCrash`) was a dead end. The real signals were the **stack sample**
(stuck symbolicating the Rosetta cache), the **open files** (reading
`dyld_shared_cache_x86_64`), and the **crash reports** in
`~/Library/Logs/DiagnosticReports/` (the victim process). The tool should surface
exactly those.

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TypeScript ESM (`"module":"NodeNext"` → **imports use `.js` extensions**),
  strict, **no new deps** (`node:` builtins + shelling to `sample`, `lsof`, fs).
- Read these to match patterns:
  - `src/collect/lsof.ts` (`getCwd`, `getPorts`, `getFdCount`), `src/util/exec.ts`
    (`run(cmd,args,timeoutMs)` — never throws; returns `{stdout,stderr,failed}`).
  - `src/enrich/classify.ts` (`friendlyLabel`, `isDevProcess`), `src/enrich/interpret.ts`,
    `src/types.ts` (`Enrichment`, `Interpretation`).
  - `src/report/report.ts` (`generateReport(node, enr)`), `src/report/prompt.ts`
    (`buildInvestigationPrompt(node, enr)`).
  - `src/server/payload.ts` (`inspectPayload(node, enr, extra)`), `src/server/server.ts`
    (routes), `src/server/page.html` (detail panel: `rDetail()`, the Profile button,
    `getAdvice`, copy-report/copy-prompt wiring).
- Verify: `npx tsc --noEmit`, `npm run build`, `npm test` (62 tests currently green).

## Feature 1 — Stack sample ("what is it doing?")

**New module `src/collect/sample.ts`:**

```ts
export interface StackFrame { samples: number; symbol: string; binary: string | null; }
export interface StackSample {
  available: boolean;            // false when sample couldn't run (e.g. other-user proc)
  cpuBound: boolean | null;      // false if the hot frame is a wait/idle syscall
  verdict: string | null;        // one-line: "spinning in <symbol> (<binary>)"
  topFrames: StackFrame[];       // heaviest leaf chain, deepest-meaningful first (≤6)
  threadCount: number;
  note: string | null;           // e.g. "requires elevated access (process owned by root)"
  raw?: string;                  // optional: the trimmed sample output for the collapsible view
}

/** Run `sample <pid> <seconds>` (read-only, no sudo for same-user procs) and parse it. */
export async function getStackSample(pid: number, seconds = 2): Promise<StackSample>;
export function parseSample(text: string): StackSample;  // PURE — unit-tested with a fixture
```

- `getStackSample` runs `run('sample', [String(pid), String(seconds)], (seconds+4)*1000)`.
  If `failed` or output contains a permission/`Process ... not found`/`unable` error,
  return `{available:false, note:"requires elevated access or process is gone", ...}`.
  Other-user/root processes (e.g. WindowServer) fail without sudo → `available:false`
  with a clear note. Same-user dev processes work.
- `parseSample(text)` parsing guidance (validate against a real fixture — capture one
  with `sample $$ 1` during dev and trim it; commit a representative fixture to the test):
  - The body has a `Call graph:` section: indented lines of the form
    `<leading spaces><count> <symbol>  (in <binary>) + <offset>  [<addr>]`. Indentation =
    call depth; the `<count>` is samples through that frame.
  - Extract the **heaviest leaf chain**: start at the thread/top-level node with the
    highest count; at each level descend into the child with the max count; stop at the
    deepest frame (no deeper child, or the count drops sharply). Collect the last ≤6
    frames along that chain as `topFrames` (with binary from the `(in X)` clause).
  - `verdict` = the deepest *meaningful* frame: skip pure scaffolding
    (`start`, `_pthread_start`, `thread_start`, `main`, `_dispatch_*` wrappers) when
    choosing the headline, but keep them in `topFrames`.
  - `cpuBound`: if the hottest leaf is a known wait/idle syscall
    (`__psynch_cvwait`, `__psynch_mutexwait`, `mach_msg2_trap`, `kevent`, `kevent_id`,
    `__select`, `__read`, `poll`, `semaphore_wait`, `__workq_kernreturn`) → `cpuBound:false`
    and verdict like "mostly waiting in <symbol> (not CPU-bound)". Otherwise `cpuBound:true`,
    verdict "spinning in <symbol> (<binary>)". (Pair with the known %CPU when presenting:
    high %CPU + compute frame = found the hot path; high %CPU + wait frame = unusual,
    surface both.)
  - `threadCount` = number of `Thread_` headers seen.
  - On unparseable input return `{available:false, note:"could not parse sample", ...}`.

**Endpoint (server.ts):** `POST /api/sample/:pid` → returns
`{ sample: StackSample, report: string, prompt: string }` where `report`/`prompt` are
the FULL enriched diagnostic (see Feature 4) including the stack. This is the
**on-demand deep investigate** — it takes ~2–3s, so it MUST NOT run on the normal
`/api/inspect` path (which the UI polls every 2s). Only on the button click.

## Feature 2 — Open handles (lightweight)

**Extend `src/collect/lsof.ts`** with `getOpenFiles(pid): Promise<{type:string; path:string}[]>`:
- Run `lsof -p <pid>` (you already call this for fd count — consider one call feeding
  both). Parse columns `COMMAND PID USER FD TYPE … NAME`. Keep entries whose TYPE is
  `REG`/`DIR`/`IPv4`/`IPv6`/`unix` and whose NAME does **not** look like a library/cache
  (`.dylib`, `.framework`, `/usr/lib`, `dyld_shared_cache`, `.bundle`) — those are noise,
  EXCEPT keep `dyld_shared_cache*`/`*.atlas` when nothing else interesting exists (it was
  the ReportCrash clue). Return ≤12, de-duplicated, most-interesting first (cwd, regular
  files the process opened, sockets). Mark each `type` (`file`/`dir`/`socket`).
- Surfaced in the report/prompt and (optionally) the detail panel. Cheap → can be part
  of `/api/inspect`.

## Feature 3 — System-process awareness + crash cross-reference

**New module `src/enrich/sysprocess.ts`:**

```ts
export interface SysProcessHint { label: string; what: string; lookWhere: string | null; isCrashHandler?: boolean; }
/** Returns a hint for a known macOS daemon/system process, else null. */
export function sysProcessHint(name: string): SysProcessHint | null;
```

Cover at least: `ReportCrash` (crash reporter — `isCrashHandler:true`, lookWhere =
"~/Library/Logs/DiagnosticReports — see Recent crashes for the actual culprit"),
`spindump`, `mds`/`mds_stores`/`mdworker`/`mdworker_shared` (Spotlight indexing),
`WindowServer` (display compositing), `kernel_task` (kernel/thermal — high CPU often =
thermal throttling), `coreaudiod`, `bluetoothd`, `cloudd`/`bird` (iCloud sync),
`photoanalysisd`/`mediaanalysisd` (Photos analysis), `backupd` (Time Machine),
`syspolicyd`, `trustd`. Wire it into `interpret()` / `friendlyLabel` so the detail
panel shows the friendly label + a "what this is / where the real signal lives" line
for system processes (today they get no interpretation).

**New module `src/collect/crashes.ts`:**

```ts
export interface CrashGroup { process: string; count: number; lastAt: number; }
export function parseCrashFilename(file: string): { process: string; at: number } | null; // PURE, tested
/** Scan DiagnosticReports dirs, group recent crashes by process. */
export async function getRecentCrashes(windowMs = 3600_000): Promise<CrashGroup[]>;
```

- Scan `~/Library/Logs/DiagnosticReports/` (via `os.homedir()`) and, best-effort,
  `/Library/Logs/DiagnosticReports/` (may be unreadable → ignore). Match `*.ips` and
  `*.crash`. `parseCrashFilename`: process = filename up to the first `-YYYY-MM-DD` or
  `_` date segment (e.g. `Google Chrome Helper-2026-06-26-131241.ips` → `Google Chrome Helper`;
  `chrome_crashpad_handler-2026-...0003.ips` → `chrome_crashpad_handler`). `at` from the
  file mtime (simpler/robust than parsing the filename date). Group within `windowMs`,
  sort by count desc then recency. Return ≤10.
- Surface in `/api/inspect` as `recentCrashes`. In the detail panel, show a **Recent
  crashes** card; when the inspected process is a crash handler (`isCrashHandler`),
  surface it prominently with a line like "ReportCrash is a symptom — the likely cause
  is **<top crasher>** (<n> crashes in the last hour)."

## Feature 4 — Bake signals into report + prompt

- `Enrichment` (or an extras object threaded through) gains: `openFiles`,
  `recentCrashes`, `sysHint`, and an optional `stackSample`.
- `generateReport(node, enr)` and `buildInvestigationPrompt(node, enr)`:
  - Always include (from fast inspect): a **System process** line when `sysHint` exists,
    **Open files** (top few), and **Recent crashes** (top few) — and for crash handlers,
    explicitly name the probable culprit.
  - Include a **Stack sample** section (verdict + top frames + cpuBound) when a
    `stackSample` is present (i.e. on the deep `/api/sample` path).
  - The prompt's question set should now say: "If a stack sample is included, use it to
    state what the process is executing; if recent crashes are listed, identify the
    repeat offender." Keep the existing read-only / no-force-kill framing.

## UI (page.html, `rDetail()`)

- New **"What is it doing?"** card with a **"Sample stack (2s)"** button. On click,
  `POST /api/sample/:pid`, show a spinner, then render: the **verdict** (color by
  `cpuBound`: amber "spinning in …" / muted "mostly waiting …"), the **top frames**
  list, and a collapsible raw view. Keep the existing "Profile this process for 10s"
  button (CPU% over time) — they're complementary (how-much vs what). The sample
  response also carries the enriched `report`/`prompt`; update `state` so the existing
  **Copy report / Copy AI prompt** buttons now copy the deep versions after a sample.
- **Open files** mini-list and a **Recent crashes** card (from `/api/inspect`). For a
  crash-handler process, render the "the real culprit is X" callout prominently.
- Don't regress existing detail behavior. Per-core/per-process/live-history all stay.

## Tests

- `test/sample.test.ts`: `parseSample(fixture)` extracts the right verdict, marks a
  wait-syscall fixture as `cpuBound:false` and a compute fixture as `true`, returns
  `available:false` on garbage. Commit a small real-ish `sample` fixture.
- `test/crashes.test.ts`: `parseCrashFilename` handles `.ips`/`.crash`, names with spaces,
  `_`-dated and `-`-dated variants, and the `.0003` index suffix; grouping counts/sorts
  correctly; window filter works.
- Keep all existing tests green.

## Acceptance criteria (run these, capture output, report)

1. `npx tsc --noEmit` clean; `npm run build` ok; `npm test` all green incl. new tests.
2. `node dist/index.js serve --no-open --port 7930` then:
   - `curl -s -X POST http://127.0.0.1:7930/api/sample/<a-node-pid>` returns a
     `StackSample` with a non-null `verdict` and `topFrames` for a same-user process.
   - `curl -s -X POST http://127.0.0.1:7930/api/sample/1` (launchd, root) returns
     `available:false` with an elevated-access note (no crash).
   - `curl -s http://127.0.0.1:7930/api/inspect/<pid>` includes `openFiles`,
     `recentCrashes`, and (for a system proc) a `sysHint`.
   - `curl -s http://127.0.0.1:7930/` serves the page; grep shows the "Sample stack" button.
3. Confirm `/api/inspect` latency is unchanged (no `sample` on that path).
4. **Reap every server you start** (`kill`, then verify it died — the history collector
   traps SIGTERM, so confirm; use SIGKILL if needed). Do NOT leave 1s-cadence or orphan
   servers running.

## Constraints & non-goals

- **Read-only, no sudo.** `sample`/`lsof` on other-user/root processes will fail →
  degrade to `available:false` / "requires elevated access", never crash, never break layout.
- Never run `sample` on the polled `/api/inspect` path (it's ~2s) — on-demand only.
- ESM `.js` imports, strict TS, no new deps, match existing module layout.
- **Do NOT deploy** (`scripts/*deploy*`, `npm run deploy*`) and do not ssh anywhere.
  Implement, verify locally per the acceptance criteria, update `README.md` (a
  "Root-cause investigation" subsection), then STOP and report.
- Out of scope (note as future): symbolicating offsets beyond what `sample` already
  prints; full call-tree visualization; persisting samples.

## Deliverables to report

Files created/modified; the actual outputs of typecheck/build/tests and the smoke
commands; any deviations from this spec with rationale; and the follow-up
(`npm run deploy -- --remote=waldomacmini1` to ship to both Macs).
