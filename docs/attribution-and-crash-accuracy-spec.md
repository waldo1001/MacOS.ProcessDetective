# Spec — Per-app attribution (powermetrics) + crash accuracy

From a WindowServer investigation, an outside AI named three gaps: (a) the copied
prompt carried no stack sample, (b) no per-app GPU/compositing breakdown so the
*client driving WindowServer* was unidentified, (c) crash **counts without timestamps**
so it couldn't tell a one-off from a loop. Live data also showed our crash count is
**inflated** — `chrome_crashpad_handler-…​.000/.0002/.0003.ips` are one event counted as
three. This bundle fixes all of that.

Three parts:
- **A. Crash accuracy** (no sudo): dedup multi-dump files, add first/last timestamps
  and a looping flag, surface them in report/prompt/UI.
- **B. Per-app power attribution** (opt-in admin): run `powermetrics --samplers
  tasks,gpu_power` via the existing elevation mechanism → rank the biggest CPU/GPU
  consumers (names the client driving WindowServer / burning the GPU).
- **C. Stack in the prompt**: always show a Stack-sample section (present or "not
  captured — run Sample stack"), and confirm an (admin) sample flows into the copied
  report/prompt.

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TS ESM (`"module":"NodeNext"` → **relative imports use `.js`**), strict, **no
  new deps** (`node:` builtins + shell via `run()` in `src/util/exec.ts`).
- Read first:
  - `src/collect/crashes.ts` — `parseCrashFilename` (PURE), `getRecentCrashes`,
    `CrashGroup` (currently `{process,count,lastAt}` in `src/types.ts`).
  - `src/collect/sample.ts` — `getStackSampleElevated` (the working
    `osascript … with administrator privileges` path + `PD_NO_ELEVATED` kill-switch +
    `-128` cancel handling) and `buildElevatedSampleCommand` (PURE).
  - `src/server/server.ts` — `POST /api/sample/:pid` (+ `?elevated=1`).
  - `src/report/report.ts`, `src/report/prompt.ts` — report/prompt builders + `QUESTIONS`.
  - `src/server/payload.ts` — `inspectPayload`; `src/service.ts` — `enrich()`.
  - `src/server/page.html` — detail panel: Recent-crashes card, "Sample stack" +
    "Sample with admin rights" buttons, `state._deepDetail` copy wiring; and the
    `rEnergy()` / `rCPU()` section renderers (where the per-app power panel goes).
- Verify: `npx tsc --noEmit`, `npm run build`, `npm test` (90 tests currently green).

## A. Crash accuracy (no sudo)

**`src/collect/crashes.ts`:**
- `parseCrashFilename(file)` → already returns `{process, at}`. Add a **dedup key**:
  files of the form `<process>-<YYYY-MM-DD-HHMMSS>[.NNNN].ips` (and the `.crash`
  variants) that share the same `<process>` + base timestamp are the **same event**.
  Return `{ process, at, eventKey }` where `eventKey = process + '|' + baseTimestampString`
  (strip the trailing `.000` / `.0002` / `.0003` dump index before the extension).
  Keep it PURE and unit-tested.
- `getRecentCrashes(windowMs=3600_000)`: when grouping by process, **count distinct
  `eventKey`s, not files** (so the Chrome triple collapses to 1). Extend `CrashGroup`
  (in `src/types.ts`) to:
  ```ts
  interface CrashGroup { process: string; count: number; firstAt: number; lastAt: number; looping: boolean; }
  ```
  `looping = count >= 3 && (lastAt - firstAt) <= 10*60_000` (3+ distinct events within
  10 min). `firstAt`/`lastAt` are min/max event times in the window. Sort by count desc
  then recency. Keep ≤10.
- **`src/report/report.ts` + `src/report/prompt.ts`**: in the Recent-crashes section,
  print per group `process: N crash(es), last <relative> ago` and append `— LOOPING`
  when `looping`. (Add a tiny relative-time helper, e.g. `"3m ago"`, or print the
  ISO/locale time — relative preferred.) The crash-handler "probable culprit" line
  should prefer a `looping` group when present.
- **`src/server/page.html`** Recent-crashes card: show last-seen relative time and a
  red "LOOPING" pill when `looping`.

## B. Per-app power attribution via powermetrics (opt-in admin)

**Refactor the elevation runner into `src/collect/elevated.ts` (reuse, don't duplicate):**
```ts
/** Run a command as root via the macOS admin auth dialog. Honors PD_NO_ELEVATED.
 *  Returns ok+stdout, or ok:false with a note (cancelled / disabled / no GUI / failed). */
export async function runElevated(innerCmd: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; note: string | null }>;
```
- Move the osascript invocation + AppleScript string escaping + `PD_NO_ELEVATED=1`
  short-circuit + `-128`/"User canceled" handling here from `sample.ts`. Refactor
  `getStackSampleElevated` to build its inner `/usr/bin/sample <pid> <secs>` command
  (keep `buildElevatedSampleCommand` in `sample.ts` so its existing tests still pass)
  and call `runElevated`. **Existing elevated-sample behavior + tests must stay green.**

**New `src/collect/powermetrics.ts`:**
```ts
export interface TaskPower { name: string; cpuMsPerS: number; gpuMsPerS: number; }
export interface PowerSnapshot {
  available: boolean;
  topCpu: TaskPower[];        // ranked desc by cpuMsPerS, ≤12
  topGpu: TaskPower[];        // ranked desc by gpuMsPerS, ≤12 (only tasks with gpu>0)
  gpuActiveResidencyPct: number | null;
  gpuPowerMw: number | null;
  note: string | null;        // "requires admin" / "disabled" / "cancelled"
  raw?: string;               // trimmed raw output for a collapsible fallback view
}
export function buildPowermetricsCommand(seconds: number): string;   // PURE, tested
export function parsePowermetrics(text: string): PowerSnapshot;      // PURE, tested
export async function getPowermetrics(seconds?: number): Promise<PowerSnapshot>;
```
- `buildPowermetricsCommand(seconds)`: clamp seconds 1–3 → ms; return EXACTLY
  `/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i <ms>` (numeric only;
  assert it matches `^/usr/bin/powermetrics --samplers tasks,gpu_power -n 1 -i \d+$`).
- `getPowermetrics`: `runElevated(buildPowermetricsCommand(s), (s+30)*1000)`; if `ok`
  → `parsePowermetrics(stdout)` (and set `raw`); else `{available:false, note}`.
- **`parsePowermetrics(text)` — parse defensively** (powermetrics layout varies by
  macOS version; be tolerant and ALWAYS keep `raw` so the UI degrades to showing the
  raw text):
  - **Tasks table**: find the header line that contains both `CPU ms/s` and `GPU ms/s`.
    Record the **character-column start** of each numeric header (the table is
    space-aligned and process names contain spaces, so slice rows by header column
    positions — do NOT naively split on whitespace). For each subsequent non-empty row
    until a blank line / a line starting with `ALL_TASKS` or `***`: `name` = text
    before the first numeric column (trimmed), `cpuMsPerS`/`gpuMsPerS` = parsed floats
    at those columns. Skip `ALL_TASKS`/total rows.
  - **gpu_power section**: parse `GPU HW active residency:` (or `GPU active residency:`)
    → `gpuActiveResidencyPct`; `GPU Power:` (mW) → `gpuPowerMw`. Either may be absent →
    null.
  - If no task rows parse, `available:true` only if `raw` is non-empty (so the UI can
    show raw); set `topCpu/topGpu` empty.
  - **Fixture**: commit `test/fixtures/powermetrics.txt` built from the representative
    layout below; `parsePowermetrics` must extract the top CPU and GPU tasks and the
    GPU residency from it.

  Representative `powermetrics --samplers tasks,gpu_power` layout (use to build the
  fixture; real columns vary — keep the parser tolerant):
  ```
  *** Sampled system activity ...

  *** Running tasks ***

  Name                          ID     CPU ms/s  User%  Deadlines (<2 ms, 2-5 ms)  Wakeups (Intr, Pkg idle)  GPU ms/s
  WindowServer                  415    142.34    45.2   12, 3                      88, 0                     88.21
  Google Chrome Helper (GPU)    1234   95.10     30.1   4, 1                       40, 0                     61.40
  kernel_task                   0      40.10     0.0    0, 0                       120, 0                    0.00
  ALL_TASKS                     -1     410.55    ...

  **** GPU usage ****

  GPU HW active frequency: 600 MHz
  GPU HW active residency:  72.34% (444 MHz: ...)
  GPU idle residency:  27.66%
  GPU Power: 1234 mW
  ```

**Endpoint (`src/server/server.ts`):** `POST /api/powermetrics` (optional
`?seconds=1`) → returns the `PowerSnapshot`. On-demand only (it's ~1–2s + an auth
prompt). Honors `PD_NO_ELEVATED` via `runElevated`.

**UI (`src/server/page.html`):** in **Energy** (and/or **CPU**) section add a panel
**"PER-APP POWER (admin)"** with a button **"⚡ Measure per-app GPU/CPU (admin)"**.
On click → `POST /api/powermetrics` → render two small ranked lists (Top CPU ms/s,
Top GPU ms/s) + a line "GPU active NN% · NN mW", with a note "macOS will ask for your
password." If `topCpu` empty but `raw` present, show the raw output in a collapsible.
Graceful note on cancel/disabled.

## C. Stack sample in report/prompt

- `report.ts`: always emit a **Stack sample** section — if `enr.stackSample?.available`
  show verdict/cpuBound/frames (as today); else a single line
  `Stack sample: not captured (run "Sample stack"; use admin for root processes)`.
  This tells the pasting AI the data is obtainable. Keep `QUESTIONS` item 5 as is.
- Confirm an **elevated** sample updates the copy-report/prompt deep state in
  `page.html` exactly like the normal sample (it returns `{sample,report,prompt,detail}`
  → `state._deepDetail`). Fix if it doesn't.

## Tests

- `test/crashes.test.ts` (extend): `parseCrashFilename` returns a shared `eventKey` for
  `chrome_crashpad_handler-2026-06-25-194230.000.ips` / `.0002.ips` / `.0003.ips`;
  grouping counts distinct events (Chrome triple → 1); `looping` true for 3 events in
  <10 min, false when spread; `firstAt`/`lastAt` correct.
- `test/powermetrics.test.ts` (new): `buildPowermetricsCommand` output + clamping +
  regex guard; `parsePowermetrics(fixture)` extracts top CPU (WindowServer first), top
  GPU (WindowServer/Chrome), and `gpuActiveResidencyPct`/`gpuPowerMw`; returns
  `available:false`-style empty on garbage but keeps `raw`.
- Keep all existing tests green.

## Acceptance criteria (run, capture, report)

1. `npx tsc --noEmit` clean; `npm run build` ok; `npm test` all green incl. new tests.
2. `node dist/index.js serve --no-open --no-history --port 7950`, then:
   - `curl -s http://127.0.0.1:7950/api/inspect/<pid>` → `recentCrashes[*]` now have
     `firstAt`/`lastAt`/`looping`; the `report` shows crash timestamps; a process with a
     `.0002`/`.0003` cluster counts as 1 (verify against
     `ls ~/Library/Logs/DiagnosticReports | grep chrome_crashpad`).
   - `curl -s -X POST 'http://127.0.0.1:7950/api/powermetrics' ` with `PD_NO_ELEVATED=1`
     set → `available:false` + disabled note, **osascript NOT invoked** (the only safe
     non-interactive check — do NOT trigger a real auth dialog).
   - `curl -s http://127.0.0.1:7950/api/sample/<node-pid>` still works (no regression).
   - page contains "PER-APP POWER" and "Measure per-app" and the crash "LOOPING" markup.
3. **Reap every server you start** (`kill`, verify it died; SIGKILL if it survives).
   No orphan / no 1s-cadence servers.

## Constraints & non-goals

- Read-only **except** the opt-in admin powermetrics/sample, each gated by the OS auth
  dialog. Default stays no-sudo. `PD_NO_ELEVATED=1` disables all elevation.
- **Injection-safe**: only sanitized numerics reach the elevated commands; assert via
  the regex guards. Reuse `runElevated`'s escaping — don't hand-roll a second one.
- powermetrics output varies by macOS version: the parser must be tolerant and ALWAYS
  retain `raw` so the UI still shows something. (Real per-app numbers are validated by
  the user post-deploy with an actual admin run — the agent can't sudo in tests; do NOT
  attempt to.)
- ESM `.js` imports, strict TS, no new deps, match existing layout.
- **Do NOT deploy** and do not ssh anywhere. Implement, verify locally, update
  `README.md` (note per-app power + crash-accuracy), then STOP and report.
- Out of scope (future): per-core CPU from powermetrics `cpu_power`, fan RPM (SMC),
  `fs_usage`/`nettop` per-process IO — same elevation path, later.

## Deliverables to report

Files created/modified; outputs of typecheck/build/tests and the smoke commands
(incl. the `PD_NO_ELEVATED=1` powermetrics check and the Chrome-cluster dedup proof);
deviations with rationale; confirmation of no orphan processes; and the follow-up
(`npm run deploy -- --remote=waldomacmini1`).
