# Spec — Mac health check + gated clean-up actions

Status: **Phase 1 is built, verified and reviewed by Waldo in the UI (2026-10-03).
Phase 2 below is implementation-ready** — re-verified against the Phase 1 code and this Mac on
2026-10-03. The rows marked ⚠ in "Measured facts" were found only by running things for real.

## Build order (mandatory — read before anything else)

1. Phase 1 is done. Do not rebuild or "tidy" it; Phase 2 adds to it.
2. **This run builds Phase 2 only**, on top of the Phase 1 code in the working tree. Before
   touching anything: `npx tsc --noEmit` clean and `npm test` green with **499 tests in 27
   files** — if not, STOP and report.
3. Phase 2 is the first code in this app that changes anything on disk. Read "Safety contract"
   and "Rules for the build agent" twice. When a rule and convenience disagree, the rule wins.

## Origin

A manual health check on 2026-10-03 (`~/Temp/waldoAI/2026-10-03-mac-health-check-findings.md`)
took ~40 shell commands and an hour of reading to reach a verdict Process Detective should give
in one click: *"the Mac is healthy, not sick — it is cluttered."* The session found a Stream Deck
plugin writing 7 GB of `Trying to connect to port N...`, three Node installs on PATH, four login
items pointing at deleted apps, 113 GB of Xcode DerivedData, two idle CI agents, an unverifiable
Time Machine backup, and — the gotcha — that nothing deleted showed up in `df` until the APFS
local snapshots were thinned. None of that is process-level; all of it is "why does my Mac feel
off", which is this app's mission. Process Detective already answers *why is this process hot*;
this adds *is this machine healthy, and what can I safely clean*.

Two deliberate design decisions, both non-negotiable:

1. **Vitals decide the verdict; clutter never does.** 1.1 TB free with 250 GB of junk is
   *healthy*. The verdict comes from memory pressure, swap, thermal, disk space, crashes, runaway
   logs, backup state. Clutter is reported as reclaimable space with a safety class, nothing more.
2. **The app stays read-only by default.** Phase 1 adds zero write paths. Phase 2 adds an
   *explicit, separately gated* action layer: dry-run first, confirmation token, Trash instead
   of `rm` wherever possible, allowlisted roots only, audit log, kill-switch. "Read-only" in the
   README becomes "read-only by default; clean-up is an opt-in action layer that never deletes
   without a dry-run and a confirmation, and sends files to the Trash where it can."

## Measured facts that shaped this spec (do not "simplify" them away)

Each row was measured on this Mac (macOS 26.6.2, M5 Max) on 2026-10-03. The first draft assumed
otherwise; the design below depends on the measured value.

| Fact | Measurement | Consequence |
|---|---|---|
| ⚠ `sfltool dumpbtm` needs no sudo **but raises an authorization dialog on every run** | `authd`: `system.privilege.admin` requested by `/usr/bin/sfltool`, Touch ID UI shown, credential not shared between runs. The "7.3–7.8 s" first measured was Waldo's Touch ID, not compute | **`login-items` is an on-demand check**: it runs only on an explicit click / `--login-items`, never automatically, never in the background, never in a full scan |
| The BTM dump contains every login item | uid-501 `app`+`user item` records with `[enabled` = 15 = exactly what System Events lists | login items come from the BTM dump — no `osascript`. Bonus: it shows *where* a dangling item points (`~/.Trash/DockDoor.app`) |
| ⚠ `tmutil latestbackup` **mounts the backup destination** | log: `backupd` → `NetAuthSysAgent` "Mount URL smb://…/Time Machine", the backup image attached at `/Volumes/Backups of …`, a backup started 90 s later, and `df -k` stalled meanwhile. Once mounted it answers "requires Full Disk Access" (8.9 s) | **never asked unless the backup volume is already mounted** (`tmutil status` reports a `DestinationMountPoint`, or a local destination's `Mount Point` exists) and no backup is running. Otherwise `advice` "not verified" |
| `df -k` (all mounts) stalls while a network mount is busy | the `/` row was missing from one snapshot → disk free `null` | `disk-space` falls back to `df -k /` (root only) |
| `softwareupdate -l` | 6 s warm, up to 40 s cold | cached 6 h, background refresh |
| `system_profiler SPPowerDataType` | 0.2 s | no cache needed |
| `tmutil listlocalsnapshots /` | 0.03 s | quick check (feeds a vitals tile) |
| `df -k /` reports the sealed system volume | Used 12 GB, **Available 1433 GB**, total 1948 GB | free space = the `Available` column. `total − used` over-reports free by ~490 GB |
| `100 − memory.usedPct` is not "free memory" | inactive pages count as used | free % = `sysctl -n kern.memorystatus_level` (91 — identical to `memory_pressure`) |
| `which -a node` in the app's environment misses nvm | app PATH = launchd PATH + `/usr/local/bin:/opt/homebrew/bin` | ask the user's login shell; it returns 7 lines, 5 unique paths, 3 *origins* |
| `brew outdated` auto-updates (network) unless told not to | 0.4 s with `HOMEBREW_NO_AUTO_UPDATE=1` | always set it; `brew cleanup -n` takes 2.7 s and prints **no** "would free" line when there is nothing to free |
| Azure Pipelines `.agent` files start with a UTF-8 BOM | `ef bb bf` | strip it before `JSON.parse` |
| VM disk images are sparse | apparent size ≫ on-disk | sizes are always on-disk (`du -k`, or `lstat().blocks * 512`), never `size` |
| The bundled app is a bare `WKWebView` (no download delegate) | `native/AppMain.swift` | no `<a download>`; the UI **copies** the markdown, the CLI writes the file |
| `render()` runs on every 2 s tick and replaces `#view` | `src/server/page.html` `tick()` | Health must be exempt or every open Evidence block collapses every 2 s |

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TS ESM (`"module":"NodeNext"` → **relative imports use `.js`**), strict,
  `noUncheckedIndexedAccess`, **no new deps** (`node:` builtins + shell via `run()` in
  `src/util/exec.ts`, which never throws). vitest, no config file (default include picks up
  `test/**/*.test.ts`). Baseline before Phase 1: 337 tests in 17 files. **Baseline before
  Phase 2: 499 tests in 27 files, green; `npx tsc --noEmit` clean** (verified 2026-10-03).
- The repo is under git (`main`). **Do not commit, stash, reset or switch branches** — leave
  your work as uncommitted changes in the working tree for review. `docs/…-spec.md` and
  `test/fixtures/health/*` are already there, uncommitted, and are inputs: do not rewrite the
  fixtures.
- Read first, in this order:
  - `src/util/exec.ts` — `run(cmd, args, timeoutMs)` → `RunResult {stdout, stderr, code, failed}`.
    On timeout it still returns whatever stdout was collected (`failed: true`).
  - `src/collect/docker.ts` + `src/collect/fsusage.ts` — the collector pattern to copy: a PURE
    exported parser with a fixture + an async runner that degrades to `available:false, note`.
    `findDocker()` shows "probe known absolute paths, don't trust PATH".
  - `src/collect/system.ts` — `collectSystem()` / `SystemStats`. **Reuse it**; do not re-shell
    `vm_stat`/`df`/`top`. You will add one field to it (see "Changes to existing code").
  - `src/collect/crashes.ts` — `getRecentCrashes(windowMs)` / `CrashGroup` (dedup + `looping`).
  - `src/collect/ps.ts` — `collectProcesses()` → `RawProcess[]` (`name`, `ppid`, `command`,
    `elapsedSeconds`, `mem`, `user`).
  - `src/history/collector.ts` — data-dir convention (`PD_DATA_DIR`, `os.homedir()` not cwd).
  - `src/report/report.ts`, `src/report/prompt.ts` — text report + AI prompt voice.
  - `src/server/server.ts` — route style (`url.pathname`, `json(res, code, body)`).
  - `src/server/page.html` (923 lines) — `SECTIONS`, `render()`/`bindView()` and the
    per-section binding block after it, `tick()`, the keyboard handler, the on-demand button
    pattern in `rEnergy()` (`powerBtn`), the clipboard pattern (`copySys`).
  - `src/cli.ts` — commander commands; add `health` after `report`.
  - `src/types.ts` — add the new types at the bottom under a `// ── Health ──` banner.
  - `test/fsusage.test.ts` — fixture loading convention (`readFileSync(join(__dirname, 'fixtures', …))`).
- Verify with: `npx tsc --noEmit`, `npm run build`, `npm test`.

---

# Phase 1 — Health check (read-only, no sudo, no AppleScript)

## Goal

`GET /api/health` answers in ≤ 5 s with a verdict, vitals and findings; slow checks are served
from a per-check cache and refreshed in the background. A **full scan** (`POST /api/health/scan`
→ job) adds the disk-clutter survey (bounded `du`, ≤ 90 s). A new sidebar section **Health**
(key `8`, `g h`) shows verdict → vitals tiles → findings grouped by category → reclaimable table
→ "Copy report" / "Copy AI prompt" / "Copy findings (.md)". CLI:
`pdetective health [--full] [--json] [--md <file>] [--no-cache]`.

## Files

Create:

```
src/health/context.ts          HealthCheck, HealthContext, CheckResult, makeContext()
src/health/registry.ts         ALL_CHECKS, runCheck() (timeout + never-throw), runPool()
src/health/cache.ts            per-check cache: fileCache(path), memoryCache(), healthCachePath()
src/health/engine.ts           collectHealth(), startFullScan(), getScanJob(), getLastReport(), whenIdle()
src/health/verdict.ts          computeVerdict(), computeReclaimable(), sortFindings()
src/health/catalog.ts          CLUTTER_CATALOG, APP_SUPPORT_OWNERS, classifyAppSupport()
src/health/manual.ts           manual-step text templates (the ONLY health file that may contain "sudo")
src/health/checks/<id>.ts      one file per check id in the tables below
src/report/health.ts           buildHealthReport(), buildHealthPrompt(), buildHealthMarkdown()
src/server/health-routes.ts    handleHealthRoute(req, res, url) → Promise<boolean>
test/health/*.test.ts          see Tests
docs/health-checks.md          durable reference: every check id, its command, what triggers it
```

Modify: `src/types.ts`, `src/collect/system.ts`, `src/server/server.ts`, `src/server/page.html`,
`src/cli.ts`, `README.md`.

### Changes to existing code (keep them this small)

- `src/collect/system.ts`: add `availBytes: number` to `storage.volumes[]` — the `Available`
  column of `df -k` (index 3) × 1024 — and `export` `parseDf` so it can be tested. Do not change
  `usedBytes`/`usedPct` (the Disk section's numbers are a separate follow-up).
- `src/server/server.ts`: one line before the final 404 —
  `if (await handleHealthRoute(req, res, url)) return;` — plus the import. `send`/`json` are
  module-private there; give `health-routes.ts` its own two-line `json` helper.

## Data model (`src/types.ts`)

```ts
// ── Health ──
export type HealthVerdict = 'healthy' | 'cluttered' | 'degraded' | 'sick';
export type HealthSeverity = 'info' | 'advice' | 'warn' | 'risk';
export type HealthCategory =
  | 'vitals' | 'stability' | 'startup' | 'processes' | 'tooling' | 'updates' | 'backup' | 'clutter';
export type SafetyClass =
  | 'regenerates'   // caches/build output: delete freely, app rebuilds it
  | 'orphan'        // owner app no longer installed / target missing
  | 'ask'           // valuable to some users (VM disks, models, downloads)
  | 'keep'          // in use / owner unknown; listed for transparency only
  | 'manual';       // needs sudo, GUI or a restart — print steps, never act

export interface HealthEvidence {
  command: string;          // exactly what was run, copy-pasteable
  excerpt: string;          // trimmed output lines that justify the finding (≤ 12 lines)
}

/** One path a finding is about. These are the rows of the Reclaimable table. */
export interface ClutterItem {
  path: string;                  // absolute
  bytes: number;                 // ON-DISK bytes (du -k × 1024, or lstat blocks × 512)
  lastModified: number | null;   // ms epoch
  safety: SafetyClass;
  note?: string;                 // "iPhone 17 Pro", "3 uncommitted changes", "OrbStack is not running"
}

export interface HealthFinding {
  id: string;               // unique within a report, kebab-case; `<checkId>` or `<checkId>:<slug>`
  checkId: string;
  category: HealthCategory;
  severity: HealthSeverity;
  title: string;            // one line, human
  detail: string;           // 1–3 sentences; say what it means, not just what it is
  evidence: HealthEvidence[];
  items?: ClutterItem[];
  reclaimableBytes?: number;     // sum of items with safety regenerates | orphan | ask
  safety?: SafetyClass;          // default class of the finding
  regenNote?: string;            // what happens after deletion, one sentence
  actionId?: string;             // Phase 2: id of the clean-up action that fixes it
  manualSteps?: string[];        // exact commands / Settings path
  asOf?: number;                 // set by the engine when the finding was served from cache
}

export interface HealthVitals {           // tiles; every field nullable
  memFreePct: number | null; swapUsedBytes: number | null; pressure: string | null;
  loadAvg1: number | null; uptimeSec: number | null; processCount: number | null;
  thermalWarning: boolean | null; batteryCycles: number | null; batteryHealthPct: number | null;
  diskFreeBytes: number | null; diskTotalBytes: number | null; localSnapshots: number | null;
  crashes7d: number | null;
}

export interface HealthReport {
  at: number;
  scope: 'quick' | 'full';
  durationMs: number;
  verdict: HealthVerdict;
  verdictReason: string;
  vitals: HealthVitals;
  findings: HealthFinding[];                                    // sorted, see sortFindings
  reclaimable: { total: number; byClass: Record<SafetyClass, number> };
  skipped: { id: string; reason: string }[];                    // timed out / failed / warming
  fullScan: { at: number | null; stale: boolean };              // stale = older than 24 h
  refreshing: string[];                                         // check ids refreshing in background
  /** Checks that only run when the user asks (they raise a macOS authorization dialog). */
  onDemand: { id: string; category: HealthCategory; label: string; note: string; at: number | null }[];
}
```

### Pure rules (`src/health/verdict.ts`, all unit-tested)

`computeVerdict(findings, reclaimable, vitals) → { verdict, reason }`:
- `sick` — any `risk` finding in `vitals | stability`.
- `degraded` — any `warn` in `vitals | stability | processes | backup`.
- `cluttered` — otherwise, when `byClass.regenerates + byClass.orphan ≥ 20 GiB` **or** any
  `warn` in `startup | tooling | updates`.
- `healthy` — otherwise. Clutter alone can never produce `degraded` or `sick`.
- `reason`: for `sick`/`degraded` the titles of the triggering findings (max 3, joined `; `);
  for `cluttered` `"no vitals or stability problem; 236 GB reclaimable clutter"` and/or
  `"N startup/tooling/update warnings"`; for `healthy`
  `"no memory pressure, no crash loop, 1.43 TB free"` built from the vitals that are non-null.

`computeReclaimable(findings)`: flatten all `items`; **count leaves only** — an item is left out
of the totals when another item's path is inside it (`other.path.startsWith(item.path + '/')`),
so `~/Library/Logs/ElgatoStreamDeck` (from `user-logs`) and the log files inside it (from
`runaway-logs`) are not counted twice, and the more specific item's safety class wins.
`byClass` has all five keys; `total = regenerates + orphan + ask`.

`sortFindings`: category order `vitals, stability, startup, processes, tooling, updates, backup,
clutter`; within a category `risk > warn > advice > info`, then `reclaimableBytes` desc.

## Check plumbing (`src/health/context.ts`, `registry.ts`)

```ts
export interface HealthContext {
  home: string;                   // os.homedir()
  uid: number;                    // process.getuid()
  now: number;
  system: SystemStats;            // ONE collectSystem() call shared by all checks
  processes: RawProcess[];        // ONE collectProcesses() call
  run: typeof run;                // every subprocess goes through this — injectable for tests
  exists(p: string): boolean;     // fs.existsSync — injectable
  crashes(windowMs: number): Promise<CrashGroup[]>;   // getRecentCrashes — injectable
}
export interface CheckResult { findings: HealthFinding[]; vitals?: Partial<HealthVitals>; }
export interface HealthCheck {
  id: string;
  category: HealthCategory;
  scope: 'quick' | 'full';        // 'full' checks run only inside a full scan
  ttlMs?: number;                 // quick + ttlMs = "cached check": served from cache, refreshed in background
  optIn?: { label: string; note: string };   // on-demand: NEVER runs on its own (it raises a macOS dialog)
  timeoutMs: number;
  run(ctx: HealthContext, onProgress?: (current: string) => void): Promise<CheckResult>;
}
```

- `makeContext()` — `Promise.all([collectSystem(), collectProcesses()])`.
- `runCheck(check, ctx)` → `{ result: CheckResult | null, skipped: string | null, durationMs }`.
  `Promise.race` against `timeoutMs`; a rejection or a timeout becomes
  `skipped: "timed out after 20 s"` / `"failed: <message>"` — never a throw. Every subprocess a
  check starts has its own `run()` timeout **shorter** than the check's, so nothing lingers.
- `runPool(items, limit, fn)` — tiny promise pool (quick checks: 6; clutter entries: 3).
- Each check exports its **pure parser(s)** from the same file and builds its own evidence
  (`command` = the copy-pasteable command line, `excerpt` = ≤ 12 trimmed lines).
- Direct `node:fs/promises` reads (`readdir`, `lstat`, `readFile`, `realpath`) are fine inside
  checks. No `child_process` import anywhere under `src/health` — only `ctx.run`.

## Checks (`src/health/checks/*.ts`)

Severity that feeds the verdict is exactly what the table says — do not invent extra `warn`s.

### Fresh on every request (`scope:'quick'`, no `ttlMs`; each ≤ 3 s)

| id | category | source | finding logic |
|---|---|---|---|
| `memory-pressure` | vitals | `ctx.system.memory` (pressure, swap) + `sysctl -n kern.memorystatus_level` (free %) | `risk`: pressure `critical`, **or** swap > 4 GiB **and** free < 10 %. `warn`: pressure `warning`, **or** swap > 1 GiB **and** free < 25 %. `advice`: swap > 1 GiB alone ("swap in use but no pressure — normal after long uptime; a restart clears it"). Else `info` "Memory: 91 % free, swap 0 B, pressure normal". Vitals: `memFreePct`, `swapUsedBytes`, `pressure` |
| `disk-space` | vitals | volume with `mount === '/'` in `ctx.system.storage.volumes` (`availBytes`, `totalBytes`); when the snapshot has no `/` row, `df -k /` (2.5 s) | `risk`: free < 5 % or < 10 GiB. `warn`: free < 10 % or < 25 GiB. Else `info` "1.3 TB free of 1.8 TB". Vitals: `diskFreeBytes`, `diskTotalBytes` |
| `thermal` | vitals | `pmset -g therm` | `parseTherm`: `risk` when `CPU_Speed_Limit` or `CPU_Scheduler_Limit` `= N` with N < 100, or when a line contains `warning level` and does **not** start with `Note: No `. `= 100` is normal (Intel Macs always print it) → no finding. Else `info`. Vitals: `thermalWarning` |
| `battery` | vitals | `system_profiler SPPowerDataType` (8 s) | `parseBattery` → `{cycles, condition, capacityPct}` or `null` when there is no `Cycle Count` line (desktop Mac → no finding, vitals stay null). `warn` when condition ≠ `Normal` or capacity < 80; else `info` "Battery: 79 cycles, 95 % capacity, Normal". Vitals: `batteryCycles`, `batteryHealthPct` |
| `uptime-load` | vitals | `ctx.system.host.uptimeSeconds`, `cpu.loadAvg`, `processes.total` | `advice` when uptime > 30 d ("a restart is overdue"); otherwise no finding. Vitals: `uptimeSec`, `loadAvg1`, `processCount` |
| `crashes-7d` | stability | `ctx.crashes(7 * 86_400_000)` | per group: `risk` when `looping` **and** `lastAt` within 24 h; `warn` when `count ≥ 3` (including an older loop). One `info` line otherwise ("0 crash reports in 7 days" / "4 crash reports in 7 days, no repeat offender"). Vitals: `crashes7d` = sum of group counts |
| `runaway-logs` | stability | `find <home>/Library/Logs -maxdepth 3 -type f -size +200M` (10 s); per file `lstat` + `tail -n 2000 <file>` (5 s) → `repetitionRatio` | group files by first folder under `Logs`. Per group: `warn` when total > 500 MiB **or** any ratio ≥ 0.8; `risk` when that holds **and** the newest file was modified < 10 min ago (still growing). `items` = the files (`regenerates`). Title "Stream Deck is writing a runaway log (7.2 GB, 5 files)" — owner name from a small map (`ElgatoStreamDeck → Stream Deck`), unknown → the folder name. Detail quotes the dominant normalized line |
| `apfs-snapshots` | backup | `tmutil listlocalsnapshots /` (5 s) | count lines starting `com.apple.TimeMachine.`. `advice` when ≥ 1: "N local snapshots — deleted files stay allocated until they thin" + newest snapshot time (parsed from `…YYYY-MM-DD-HHMMSS.local`); `manualSteps` `tmutil thinlocalsnapshots / 999999999999 4` (no sudo); `actionId:'thin-snapshots'`. Vitals: `localSnapshots` |
| `launch-agents` | startup | `readdir` of `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`; per `*.plist`: `plutil -extract Program raw -o - <f>`, on exit ≠ 0 `plutil -extract ProgramArguments.0 raw -o - <f>` (2 s each, pool 6) | `warn` per plist whose program is an **absolute** path that `!ctx.exists` (`safety:'orphan'`, `manualSteps` from `manual.ts`). Neither key present, or a relative program → skip silently. One `info` finding listing stray non-`.plist` files in `~/Library/LaunchAgents` (`*.bak*`, `*.disabled`, …) as `items` (`orphan`) |
| `duplicate-helpers` | processes | `ctx.processes` | see "Duplicate helpers" below |
| `node-installs` | tooling | `<$SHELL or /bin/zsh> -lic '/usr/bin/which -a node'` (6 s); per unique path `realpath` + `<path> --version` (3 s) | see "Node installs" below |

### Cached (`scope:'quick'` + `ttlMs`; never awaited by `GET /api/health`)

| id | category | ttl | source | finding logic |
|---|---|---|---|---|
| `software-update` | updates | 6 h | `softwareupdate -l` (60 s) + `sw_vers -productVersion` | `parseSoftwareUpdate(stdout + stderr, currentVersion)`: each `* Label:` line + its `Title: …, Version: …, …` line. `warn` per macOS entry whose `Version` has the **same major** as the running OS and has `Action: restart` ("macOS 26.7.1 is available — same major, security content, needs a restart"). One `advice` listing every other label. `No new software available` → `info`. `manualSteps`: System Settings → General → Software Update. Never installs |
| `time-machine` | backup | 15 min | `tmutil destinationinfo` (5 s); `tmutil status` (5 s); `tmutil latestbackup` (12 s) **only when already mounted and not running** | `No destinations configured` → `advice` "Time Machine is not configured". `Running = 1` → `info` "backup in progress (<phase>)". Not mounted → `advice` "Last backup not verified — the backup destination is not mounted" (the question is never asked: it would mount the destination). Mounted: path containing `YYYY-MM-DD-HHMMSS` → age: `info` < 48 h, `advice` 48 h–7 d, `warn` > 7 d; `requires Full Disk Access`, a failure or a timeout → `advice`, never `warn`/`risk` |
| `brew` | tooling | 1 h | brew at `/opt/homebrew/bin/brew` or `/usr/local/bin/brew` (probe with `ctx.exists`; absent → `{findings: []}`); `env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 <brew> outdated --json=v2` (20 s); `<brew> cleanup -n` (20 s); `<brew> doctor` (60 s) only when `PD_HEALTH_BREW_DOCTOR=1` | `parseBrewOutdated(json)` → names (formulae + casks); `parseBrewCleanup(text)` → bytes from `would free approximately 248.6MB` (KB/MB/GB), `0` when the line is absent. One `advice` when anything is outdated or cleanup > 0 ("31 outdated; `brew cleanup` would free 249 MB"), `actionId:'brew-cleanup'`, **no `items`** (it overlaps the `brew-cache` clutter entry); else `info` |

### On demand (`optIn`; never automatic)

| id | category | source | finding logic |
|---|---|---|---|
| `login-items` | startup | `sfltool dumpbtm` (60 s — the user has to answer a Touch ID / password dialog). Refuses when `PD_NO_ELEVATED=1` | see "Login items" below |

An on-demand check runs only when its id is in `CollectOptions.include`, which only an explicit
user action sets: the **Check login items** button (`POST /api/health/check/login-items`) or
`pdetective health --login-items`. It is never started by a quick request, a background refresh,
a full scan, `--no-cache` or `awaitCached`. Its last result is served from the cache with `asOf`;
with no result yet it appears in `skipped` ("on demand — not run yet (…)"). The report lists every
on-demand check in `onDemand` with the time of its last run.

### Full scan only (`scope:'full'`)

| id | category | source |
|---|---|---|
| `disk-clutter` | clutter | the catalog survey below (≤ 90 s) |

A full scan also force-refreshes every cached check (not the on-demand ones).

`PD_HEALTH_SKIP=id,id` (check ids and/or clutter-catalog ids) leaves those out entirely; they are
listed in `skipped` as "disabled by PD_HEALTH_SKIP".

### Login items (`checks/login-items.ts`)

`sfltool dumpbtm` prints sections and item blocks (real capture in
`test/fixtures/health/sfltool-dumpbtm.txt` — read it before writing the parser):

```
========================
 Records for UID 501 : 8B30737A-…
========================
 …
 #2:
                 UUID: 16BB3FC3-…
                 Name: DockDoor
       Developer Name: Ethan Bills
                 Type: app (0x2)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 2.com.ethanbills.DockDoor
                  URL: file:///Users/waldo/.Trash/DockDoor.app/
  Embedded Item Identifiers:
    #1: 16.com.microsoft.autoupdate.helper      ← NOT an item header
```

```ts
export interface BtmItem {
  uid: number; name: string; developer: string | null;
  type: string;            // 'app', 'user item', 'login item', 'agent', 'legacy agent', … (no "(0x…)")
  enabled: boolean;        // Disposition starts with "[enabled"
  url: string | null;      // raw
  path: string | null;     // decoded absolute path when url is file:// (trailing "/" stripped)
  identifier: string | null;
}
export function parseBtm(text: string): BtmItem[];
export function classifyLoginItems(items: BtmItem[], uid: number, exists: (p: string) => boolean): HealthFinding[];
```

- Section = ` Records for UID <n> :`. Item header = a line that is exactly `#<n>:` after
  trimming **and** has nothing after the colon. Key/value = `^\s+([A-Za-z][A-Za-z. ]*?):\s(.*)$`.
  `(null)` → `null`. A relative URL (`Contents/Library/LoginItems/…`) → `path: null`.
- **Login item** = `uid === ctx.uid` && `enabled` && `type ∈ {'app', 'user item'}`.
- Per login item: path contains `/.Trash/` → `warn` "Login item “DockDoor” points into the
  Trash"; else `!exists(path)` → `warn` "Login item “Warp” points at an app that no longer
  exists"; else path matches `/\/node_modules\/|\/Temp\/|\/tmp\//` → `advice` "dev build
  registered as a login item". Warns carry `safety:'orphan'` and `manualSteps` (System Settings →
  General → Login Items & Extensions → Open at Login → remove). Ids `login-items:<slug-of-name>`.
- One `info` summary (id `login-items`): "15 login items · 12 background agents/daemons enabled
  (9 legacy)" — agents = enabled `agent | daemon | legacy agent | legacy daemon` in uid sections
  `ctx.uid`, `0`, `-2`, de-duplicated by `identifier`.

### Node installs (`checks/node-installs.ts`)

- The app's PATH has no nvm, so ask the login shell:
  `ctx.run(process.env.SHELL ?? '/bin/zsh', ['-lic', '/usr/bin/which -a node'], 6000)`; keep only
  lines matching `^/.*\/node$` (rc files print noise). Empty/failed → fall back to probing
  `/opt/homebrew/bin/node`, `/usr/local/bin/node` with `ctx.exists` and say "PATH order unknown".
- `parseWhichNode(text)` → unique paths in order (first = the winner).
- `classifyNodeOrigin(realPath)` (pure): `/.nvm/` → `nvm`; `/.fnm/` or `/fnm_multishells/` →
  `fnm`; `/.volta/` → `volta`; `/.asdf/` → `asdf`; `/mise/` → `mise`; `/opt/homebrew/` or
  `/Cellar/` → `homebrew`; `/usr/local/bin/node` → `pkg` (the nodejs.org installer); else `other`.
  The runner resolves `fs.realpath` first so an Intel-Homebrew symlink lands on `/Cellar/`.
- Several versions under one manager are **one** origin. `warn` when > 1 distinct origin:
  "3 Node.js installs on PATH (nvm wins: v20.20.2)", detail lists origin → paths → version,
  `safety:'manual'`; when a `pkg` origin is present add `manualSteps` from `manual.ts` (the
  `/usr/local` removal list). One origin → `info`.

### Duplicate helpers (`checks/duplicate-helpers.ts`)

Pure `findDuplicateHelpers(procs: RawProcess[]) → { groups, orphans }`:
- Candidates: `command != null`, `elapsedSeconds ≥ 600`, and `name` (lower-cased) matches
  `^(node|python[\d.]*|dotnet|deno|bun|java|ruby)$` — interpreter-hosted helpers only (shells and
  browser renderers legitimately run many copies).
- Group key = `normalizeCommand(command)`: `/_npx/<hash>/` → `/_npx/#/`, UUIDs → `#`,
  `--port[= ]\d+` → `--port #`, any run of ≥ 4 digits → `#`. Label = basename of the first
  argument that is a path, else the first argument.
- A group = ≥ 3 members with ≥ 2 distinct `ppid`s.
- Orphan = a group member with `ppid === 1` while at least one other member has `ppid !== 1`.
- **One** `advice` finding (`duplicate-helpers`): "8 helpers run 3+ copies (34 processes,
  ~2.1 GB)" — RSS estimate = Σ `mem` % × `ctx.system.memory.totalBytes`; evidence lists
  `count × label (parents: a, b, c)` for the top 10. Closing finished IDE/agent sessions releases them.
- **One** `warn` finding (`duplicate-helpers:orphans`) only when orphans exist: "2 leaked helper
  processes (parent gone)", listing pid + label.
- Never `pgrep -f` (it matches itself — the 2026-10-03 session's false positive).

### The clutter survey (`checks/disk-clutter.ts`, `src/health/catalog.ts`)

Walks a **curated catalog** — not the whole disk.

```ts
export interface ClutterEntry {
  id: string; title: string;
  kind: 'path' | 'children' | 'files' | 'worktrees' | 'devops-agents';
  base: string;                  // '~/…', expanded with ctx.home ('' for the two discovery kinds)
  match?: RegExp;                // children/files: basename must match
  exclude?: RegExp;              // children: basename must not match
  olderThanDays?: number;        // files: mtime filter
  safety: SafetyClass;
  regenNote: string;
  actionId?: string;             // Phase 2
  minBytes?: number;             // per item; default 500 MiB
  ownerCheck?: boolean;          // classify each child with classifyAppSupport
  runningHint?: { name: RegExp; label: string };   // note "OrbStack is not running" from ctx.processes
  nameFromPlist?: string;        // children: `plutil -extract name raw -o - <child>/<file>` → item.note
}
```

| id | kind | base | match / options | safety | regenNote |
|---|---|---|---|---|---|
| `xcode-deriveddata` | children | `~/Library/Developer/Xcode/DerivedData` | | regenerates | Xcode rebuilds on the next build (minutes) |
| `xcode-devicesupport` | children | `~/Library/Developer/Xcode/iOS DeviceSupport` | | regenerates | re-fetched when the device is plugged in |
| `coresimulator` | children | `~/Library/Developer/CoreSimulator/Devices` | `nameFromPlist:'device.plist'` | ask | `xcrun simctl delete unavailable` is always safe; named devices lose their state |
| `android-avd` | children | `~/.android/avd` | `/\.avd$/` | ask | emulator recreated in Android Studio (~2 min); snapshots lost |
| `brew-cache` | path | `~/Library/Caches/Homebrew` | | regenerates | `brew cleanup` |
| `user-caches` | children | `~/Library/Caches` | exclude `/^Homebrew$/` | regenerates | apps rebuild caches; browsers re-download |
| `user-logs` | children | `~/Library/Logs` | | regenerates | logs; see `runaway-logs` for the pathological ones |
| `npm-cache` | path | `~/.npm/_cacache` | | regenerates | `npm cache clean --force` |
| `nuget-cache` | path | `~/.nuget/packages` | | regenerates | restored on the next `dotnet restore` |
| `hf-models` | children | `~/.cache/huggingface/hub` | `/^models--/` | ask | model re-downloaded on next use (GBs) |
| `orbstack-disk` | path | `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw` | `runningHint` OrbStack | ask | **all** Docker images/containers/Linux VMs |
| `docker-desktop` | path | `~/Library/Containers/com.docker.docker/Data/vms` | `runningHint` Docker | ask | all Docker Desktop images/containers |
| `claude-vm` | path | `~/Library/Application Support/Claude/vm_bundles` | | ask | Claude Desktop local-agent VM; regenerates, VM-local session data lost |
| `parallels-vms` | children | `~/Parallels` | `/\.pvm$/`, `minBytes: 0` | keep | listed for transparency only |
| `downloads-installers` | files | `~/Downloads` | `/\.(dmg|pkg|iso|xip|tar|tar\.gz|tgz|zip)$/i`, `olderThanDays: 30`, `minBytes: 50 MiB` | ask | installers are re-downloadable; zips may be data — never auto-select |
| `wallpaper-cache` | path | `~/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches` | | regenerates | aerials re-download |
| `app-support-orphans` | children | `~/Library/Application Support` | `ownerCheck`, `minBytes: 1 GiB` | keep (per item: orphan/keep) | leftover data of an app that is no longer installed |
| `claude-worktrees` | worktrees | | `minBytes: 50 MiB` | ask (per item: regenerates/keep) | clean worktree — the branch is kept |
| `devops-agents` | devops-agents | | `minBytes: 100 MiB` | ask | build output of a self-hosted Azure Pipelines agent |

Measuring (always on-disk size, never follow symlinks):
- `path`: `du -sk -P -x -- <path>` (30 s) → one item.
- `children`: **one** `du -k -d 1 -P -x -- <base>` (30 s) — one line per child directory, the
  base total last (drop it). Filter by `match`/`exclude`, keep items ≥ `minBytes`, top 15 by
  size; the rest is summed into the detail ("+ 12 smaller, 1.2 GB"). `du -d 1` does not list
  loose files in `base`; that is accepted.
- `files`: `readdir(base, {withFileTypes:true})` → regular files only → `lstat` →
  `bytes = blocks * 512`, `mtime` older than `olderThanDays`.
- `worktrees`: roots = `PD_HEALTH_DEV_ROOTS` (colon-separated) or the existing ones among
  `~/SourceCode ~/Source ~/Developer ~/Projects ~/Code ~/src ~/git ~/repos ~/dev`. Per root
  `find <root> -maxdepth 6 ( -name node_modules -o -name .git ) -prune -o -type d -path '*/.claude/worktrees' -print -prune`
  (15 s; 0.08 s measured). Per worktrees dir: `du -k -d 1 -P -x`, then per child
  `git -C <child> status --porcelain` (5 s): ok + empty → `regenerates`, note "clean worktree";
  ok + output → `keep`, note "N uncommitted changes"; failed → `keep`, note "not a git worktree".
- `devops-agents`: every non-hidden directory directly under `~` that has a `.agent` file and a
  `_work` directory → `du -sk` of `_work`; note "agent <agentName> (pool <poolName>)" from
  `.agent` — **strip the UTF-8 BOM** before `JSON.parse` (`parseAgentFile`, fixture
  `devops-agent.json`).
- `parseDuK(stdout)` → `{kb, path}[]` from lines `^(\d+)\t(.+)$`; everything else is ignored.
- `lastModified` = max mtime of the item and of its direct children (`readdir` + `lstat`, first
  200 entries).
- `base` missing → no finding (not `skipped`). `lstat(base)` is a symlink → `skipped`
  ("symlink — not followed").
- **Permission-denied must never look like "0 B".** When `du` prints no size line for the
  operand and stderr has `Operation not permitted` / `Permission denied` → `skipped`
  ("no permission — grant Full Disk Access to include"). A size line plus permission noise for
  sub-folders → keep the size, append the note "partial: some sub-folders unreadable".
- A `du` that hits its timeout still returns the child lines printed so far: use them and add a
  `skipped` entry "partial: timed out after 30 s".
- Pool of 3 entries, whole survey ≤ 90 s: entries not started by the deadline are `skipped`
  ("survey budget exhausted"). `onProgress(entry.title)` per entry.
- One finding per catalog entry that has ≥ 1 item: `id` = entry id, `checkId:'disk-clutter'`,
  `severity` `advice` when `reclaimableBytes ≥ 1 GiB` else `info`, title
  "Xcode DerivedData: 113 GB in 14 items", `detail` = `regenNote` (+ remainder), evidence = the
  `du` command + its top lines.
- Never `du -sg` (rounds every entry up to 1 GB — the 2026-10-03 session mis-sized two dozen
  folders that way).

`classifyAppSupport(folder, installedApps) → { safety, note }` (pure): `installedApps` = bundle
names without `.app` from `/Applications`, `/Applications/Utilities`, `~/Applications`,
`/System/Applications`. `APP_SUPPORT_OWNERS: Record<string, RegExp>` maps an **exact** folder
name to a pattern an installed app name must match: `Autodesk → /^(Autodesk|Fusion)/i`,
`dev.warp.Warp-Stable → /^Warp/i`, `Spotify`, `Slack`, `discord → /^Discord/i`,
`zoom.us → /^zoom/i`, `Docker Desktop → /^Docker/i`, `Cursor`, `UniFi OS Server → /^UniFi/i`,
`com.elgato.StreamDeck → /Stream Deck/i`, `Steam`, `obs-studio → /^OBS/i`. Folder in the map and
no installed app matches → `orphan`. Folder in the map and an app matches → `keep`. **Folder
not in the map → `keep`, note "owner unknown — not classified"** (a wrong `orphan` is the one
expensive mistake here: `Code` is VS Code's settings).

## Cache + engine (`src/health/cache.ts`, `engine.ts`)

```ts
export interface CacheEntry { at: number; durationMs: number; findings: HealthFinding[]; vitals?: Partial<HealthVitals>; }
export interface HealthCacheStore {
  get(id: string): CacheEntry | undefined;
  set(id: string, e: CacheEntry): void;       // schedules a flush
  lastFullScanAt: number | null;
  flush(): Promise<void>;
}
export function healthCachePath(): string;    // <PD_DATA_DIR ?? ~/Library/Application Support/ProcessDetective>/health-cache.json
export function fileCache(path: string): HealthCacheStore;   // loads once, tolerates a missing/corrupt file
export function memoryCache(): HealthCacheStore;             // tests
```

Writes are atomic (`writeFile` to `<path>.tmp` + `rename`), serialized through one promise chain,
`mkdir -p` first, and never throw (a read-only data dir just means no cache). This file is the
**only** thing Phase 1 writes.

```ts
export interface CollectOptions {
  mode: 'quick' | 'full';
  awaitCached?: boolean;          // CLI: true. Server quick path: false.
  noCache?: boolean;              // ignore cached entries of cached checks (run + await them)
  include?: string[];             // on-demand check ids to run now — set only by an explicit user action
  onProgress?: (p: { done: number; total: number; current: string }) => void;
  checks?: HealthCheck[];         // default ALL_CHECKS — injectable for tests
  ctx?: HealthContext;            // default makeContext()
  cache?: HealthCacheStore;       // default fileCache(healthCachePath())
}
export function collectHealth(opts: CollectOptions): Promise<HealthReport>;
export function whenIdle(): Promise<void>;     // resolves when no background refresh is running
```

Per check:

| check | mode quick | mode full |
|---|---|---|
| quick, no ttl | run now | run now |
| quick + ttl, cache fresh | cached findings (`asOf = entry.at`) | run now, store |
| quick + ttl, cache stale | `awaitCached`/`noCache`: run now, store. Else: stale findings (`asOf`) **and** start a background refresh; id goes into `report.refreshing` | run now, store |
| quick + ttl, no cache | `awaitCached`/`noCache`: run now, store. Else: `skipped` "warming — first result in under a minute" + background refresh | run now, store |
| full | cached findings (`asOf`), if any | run now, store; set `lastFullScanAt` |
| on demand (`optIn`) | in `include`: run now, store. Else: cached findings (`asOf`) or `skipped` "on demand — not run yet" | same — a full scan never starts it |

- A cached check that fails or times out on refresh **keeps its previous cache entry** and adds a
  `skipped` line; it never overwrites good data with nothing.
- Background refresh is single-flight per check id (module-level `Map<string, Promise>`), uses a
  fresh context, never throws, and stores the result.
- Assemble: merge vitals (base from `ctx.system` + every result's patch), `sortFindings`,
  `computeReclaimable`, `computeVerdict`, `fullScan = { at: lastFullScanAt, stale: at == null ? false : now − at > 24 h }`.
- `startFullScan()` → **one in-process job**; a second call while it runs returns the same job.
  `{ id, state: 'running'|'done'|'failed', progress: {done,total,current}, report?, error? }`.
  The last finished job stays in memory. `getLastReport()` = the most recent `HealthReport`
  produced by either path.

## Report + prompt (`src/report/health.ts`)

- `buildHealthReport(r): string` — plain text, same voice as `generateReport`: verdict line
  first, then vitals in a 2-column block, findings grouped by category with the severity tag in
  brackets (`[WARN]`), evidence indented, cached findings marked "(as of 2 h ago)", then a
  reclaimable table sorted by bytes with safety class, then "Skipped" and "Manual steps".
- `buildHealthPrompt(r): string` — mirrors `report/prompt.ts`: intro + QUESTIONS + the report
  between `--- health snapshot ---` markers. Questions: "Is anything here a real health problem
  or is it all clutter? Which three items would you act on first and why? Which findings need
  more evidence before acting? Say explicitly which items need sudo or a restart. Anything
  under 'Skipped' was NOT checked — do not treat it as clean."
- `buildHealthMarkdown(r): string` — the findings file Waldo writes by hand today:
  `# Mac health check — <YYYY-MM-DD>`, verdict table (area / state / evidence), "What is worth
  fixing" (warn + risk + advice findings with their manual steps), clutter table
  (GB / where / what / safe?), "Commands used" (every evidence `command`, de-duplicated),
  "Clean-ups executed" (empty in Phase 1: "none — Phase 1 is read-only").
- Sizes everywhere: add `fmtBytes(bytes)` to `src/render/format.ts` — 1024-based, labelled
  `B/KB/MB/GB/TB`, one decimal below 10, like the page's `fmtBytes` — and use it in all three
  builders. Never round up to whole gigabytes.

## Endpoints (`src/server/health-routes.ts`)

- `GET /api/health` (any `?scope=` is accepted and ignored) →
  `collectHealth({mode:'quick', awaitCached:false})` → `HealthReport`. Target ≤ 5 s.
- `POST /api/health/scan` → `{ jobId, state }`, status `202`.
- `GET /api/health/scan/:jobId` → the job (`404` for an unknown id).
- `GET /api/health/report?format=text|prompt|md` → `text/plain; charset=utf-8`, built from
  `getLastReport()` (computes a quick one when there is none). Unknown format → `400`.
- `POST /api/health/check/:id` → runs that **on-demand** check now and returns the quick report
  (`404` for an id that is not an on-demand check). Single-flight per id: a double click must not
  raise two dialogs.
- No pid in these routes; nothing here reads a request body. No `POST` performs a write in
  Phase 1 (the scan writes only the cache file).

## UI (`src/server/page.html`)

Eighth sidebar section **Health**: `{ id:"health", label:"Health", key:"h", icon:<heart-pulse path> }`
appended to `SECTIONS`; the digit shortcut regex becomes `/^[1-8]$/`; `g h` then works through
the existing `key` lookup. Add `health: rHealth` to the renderer map.

1. **Verdict banner** — the verdict word, colored with the existing ramp (`healthy` → `calm`,
   `cluttered` → `acc`, `degraded` → `warn`, `sick` → `crit`), `verdictReason` beneath. Right
   side: "Checked 3.8 s ago · Full scan: 2 h ago (stale)" (or "never"), a **Re-check** button and
   a **Run full scan** button → `POST /api/health/scan`, then poll the job every 1 s and show
   `done/total · current`; when `done`, show its report.
2. **Vitals tiles** — mem free %, swap, pressure, load, uptime, thermal, battery (cycles ·
   health %), disk free, crashes 7d, local snapshots. `.tile` grid, muted "—" when null.
3. **Findings** — grouped by category in `sortFindings` order (clutter findings are shown in the
   Reclaimable table instead). Each row: severity pill, title, detail, "as of 2 h ago" when
   `asOf` is set; expandable **Evidence** (`<details>`: `command` in monospace + excerpt);
   `manualSteps` as a `<pre>` with a copy button. Each `report.onDemand` entry is a card in its
   category ("ON DEMAND · Check login items · not checked yet / last checked 2 h ago", the note
   that macOS will ask for Touch ID or the password, and a button that `POST`s
   `/api/health/check/<id>` and shows "Waiting for your approval…"). "Skipped" list at the bottom, and a
   "refreshing: login-items, software-update…" line while `refreshing` is non-empty.
4. **Reclaimable** — every finding's `items` flattened: size · path (`~`-shortened) · what
   (finding title / item note) · safety pill · last modified. Sorted by size (click the header to
   flip); footer totals per safety class from `reclaimable`; `keep` rows dimmed. No action
   column in Phase 1. Before the first full scan: an empty state "Run a full scan to survey disk
   clutter (~1 min, read-only)".
5. Header actions: **Copy report**, **Copy AI prompt**, **Copy findings (.md)** — each fetches
   `/api/health/report?format=…` and uses `navigator.clipboard.writeText` + `toast(...)`, like
   `copySys`. (No download link: the bundled app is a bare `WKWebView`.)

Behavior rules — these are correctness, not polish:

- **Health is exempt from the 2 s tick.** In `tick()`, render only when
  `route.section !== "health"`; and `render()` must not show "Collecting…" for Health when
  `state.sys` is still null. Health re-renders only when its own state changes.
- Keep the open/closed state of Evidence blocks in `state` (a `Set` of finding ids, updated from
  a `toggle` listener) so a legitimate re-render (scan progress, re-check) does not collapse them.
- Health fetches **only** when the section is open: on entering it (when there is no report yet
  or it is older than 60 s), on **Re-check**, and while a scan job is running. While
  `refreshing` is non-empty, re-fetch once after 10 s (at most 6 times). Leaving the section
  stops every Health timer; coming back resumes polling a still-running job. Nothing in Health
  runs on the 2 s cadence — a monitor must not become the spike.
- Escape every string with the existing `esc()`. All state lives under `state.health`.
- Do not change any existing section's markup or behavior.

## CLI (`src/cli.ts`)

```
pdetective health [--full] [--json] [--md <file>] [--no-cache] [--login-items]
```

`--login-items` includes the on-demand check (macOS asks for Touch ID or the password).
Always `awaitCached: true` (a one-shot process cannot refresh in the background), so a cold
first run takes as long as its slowest cached check (≤ ~60 s); later runs are fast. `--full`
runs the survey inline with a `\r` progress line on **stderr**. Default output:
`buildHealthReport`; `--json` prints the `HealthReport`; `--md <file>` writes
`buildHealthMarkdown` to the file and prints the path. Exit code 0 always (a health report is
not a test).

## Tests (`test/health/*.test.ts`, fixtures in `test/fixtures/health/`)

The fixtures are **real captures from this Mac (2026-10-03)** and already exist — use them as
they are. You create two generated ones: `runaway-log-tail.txt` (200 lines
`2026-10-02T15:29:01.123 Info AppClient: Trying to connect to port 51234...` with varying
digits + 5 unrelated lines) and `du-k-d1.txt` (five `<kb>\t<path>` child lines, a `du: …:
Operation not permitted` line, and the base total last).

| fixture | what it is |
|---|---|
| `sfltool-dumpbtm.txt` | 3 uid sections, 18 items (5 in uid −2, 0 in uid 0, 13 in uid 501) |
| `pmset-therm-ok.txt` | three `Note: No …` lines |
| `which-node.txt` | 7 lines, 5 unique paths, 3 origins |
| `system-profiler-power.txt` | Cycle Count 79, Condition Normal, Maximum Capacity 95% |
| `softwareupdate-l.txt` | Safari 27.0, macOS Tahoe 26.7.1 (restart), macOS 27.0.1 (restart) |
| `tmutil-latestbackup-unmounted.txt` | `Failed to mount backup destination…` |
| `tmutil-latestbackup-no-fda.txt` | `latestbackup requires Full Disk Access privileges.` |
| `tmutil-status-running.txt` / `tmutil-status-idle.txt` | `Running = 1` with `BackupPhase` + `DestinationMountPoint` / `Running = 0` |
| `tmutil-destinationinfo.txt` | Kind Network |
| `tmutil-listlocalsnapshots.txt` | 1 snapshot |
| `df-k.txt` | `/` with Used 12337068, Available 1433398200 |
| `brew-outdated.json` | 0 formulae, 3 casks |
| `brew-cleanup-n.txt` / `brew-cleanup-n-nothing.txt` | 248.6MB / no "would free" line |
| `devops-agent.json` | `.agent` file **with BOM**, agentId 18, pool `IFX-UBUNTU-BUILD` |

Required unit tests (pure parsers + rules; put a small `fakeContext(overrides)` in
`test/health/helpers.ts`):

- `parseDf` → `/` has `availBytes === 1433398200 * 1024`; `disk-space` sets
  `vitals.diskFreeBytes` to that value — not `totalBytes − usedBytes`.
- `parseTherm` → ok fixture: no risk, `thermalWarning:false`; `CPU_Speed_Limit = 60` → `risk`;
  `CPU_Speed_Limit = 100` → **no** risk.
- `parseBattery` → 79 / Normal / 95; text without `Cycle Count` → `null`.
- `parseBtm` → 18 items; uid −2/0/501 = 5/0/13; the `Embedded Item Identifiers` sub-lines
  create no items; `Mouse Glide` path is `/Users/waldo/.Trash/Mouse Glide.app` (decoded, no
  trailing slash); `OneDrive Launcher` has `path: null`; `Alarm` is `enabled:false`.
- `classifyLoginItems` (uid 501, `exists = p => p !== '/Applications/Warp.app'`) → exactly 3
  `warn` (DockDoor + Mouse Glide: Trash; Warp: missing), 1 `advice` (Electron), 1 `info`
  summary counting 9 login items; Dropbox and the disabled `Alarm` produce nothing.
- `parseWhichNode` + `classifyNodeOrigin` → 5 unique paths, 3 origins, winner is the nvm
  v20.20.2 path; three nvm versions alone are **one** origin (no warn).
- `parseSoftwareUpdate` with current `26.6.2` → 3 entries; 26.7.1 is same-major + restart →
  `warn`; 27.0.1 and Safari are not; `No new software available.` → `info`.
- `time-machine` → destination not mounted → `advice` **and `latestbackup` is never run**; a
  running backup → `info`, `latestbackup` not run; mounted local disk: a date 3 h old → `info`,
  9 days old → `warn`; "requires Full Disk Access", `Failed to mount` or a timeout → `advice`.
- `parseBrewOutdated` → 3 names; `parseBrewCleanup` → 248.6 MB in bytes; the "nothing" fixture → 0.
- `repetitionRatio` → ≥ 0.8 for the runaway fixture, < 0.3 for a varied log, 0 below 50 lines.
- `parseDuK` → bytes = kb × 1024 and path; the `du:` permission line is ignored.
- `parseAgentFile` → BOM fixture parses; `agentName`/`poolName` extracted.
- `findDuplicateHelpers` → 4 `node` processes with the same normalized command under 3 parents →
  one group; one of them with `ppid 1` → one orphan; 5 identical `zsh` → nothing; members
  younger than 10 min are ignored; `/_npx/<hash>/` variants fall into one group.
- `classifyAppSupport` → `Autodesk` with no matching app → `orphan`; `Autodesk` with
  `Autodesk Fusion` installed → `keep`; `Code` (not in the map) → `keep` + "owner unknown".
- `computeReclaimable` → a parent item and a file item inside it are counted once (the leaf),
  with the leaf's class; `total` excludes `keep` and `manual`.
- `computeVerdict` table test: clutter-only 30 GiB `regenerates` → `cluttered`; `ask`-only
  200 GiB → `healthy`; swap 5 GiB + free 8 % → `sick`; looping crash today → `sick`; a 4-day-old
  loop → `degraded`; TM unverifiable alone → `healthy`; dangling login item alone → `cluttered`;
  leaked helpers → `degraded`; disk 3 % free → `sick`.
- Registry: a check that throws and a check that exceeds its timeout both land in `skipped`
  and do not fail the report.
- On-demand: an `optIn` check does not run in quick, `awaitCached`, `noCache` or full mode and is
  never refreshed in the background; it runs when its id is in `include`, is stored, and is
  served with `asOf` afterwards; a failed run keeps the previous result. `PD_HEALTH_SKIP` leaves a
  check or a catalog entry out. `login-items` refuses to run with `PD_NO_ELEVATED=1`.
- Engine (injected `checks` + `memoryCache()` + fake ctx): a cached check with no entry and
  `awaitCached:false` → `skipped` "warming", id in `refreshing`, and after `whenIdle()` a second
  `collectHealth` returns its findings with `asOf`; `awaitCached:true` runs it inline; a failing
  refresh keeps the old entry; `mode:'quick'` never runs a `full` check; `mode:'full'` sets
  `fullScan.at`.
- Report builders: `buildHealthMarkdown` contains the verdict table and prints `9.9 GB` (not
  `10 GB`) for 10_630_000_000 bytes; `buildHealthPrompt` contains the report and the "Skipped"
  warning; a cached finding shows "as of".

Do **not** run `softwareupdate`, `system_profiler`, `sfltool`, `tmutil`, `brew`, `du` over real
paths or a login shell in tests — inject `ctx.run`. Existing tests stay green and untouched.

## Acceptance criteria (Phase 1)

Run all of it; paste the outputs in your report.

1. `npx tsc --noEmit` clean; `npm run build` succeeds; `npm test` green with **337 + new**
   tests (state both numbers).
2. `export PD_DATA_DIR="$TMPDIR/pd-health-smoke"` for every command below (do not write the
   real cache). `node dist/index.js health --json | jq -r .verdict` prints one of the four
   words — the cold first run may take up to ~60 s; **run it a second time: ≤ 10 s**.
   `… | jq '.vitals.diskFreeBytes / 1024 / 1e6 | floor'` is within 5 of
   `df -k / | awk 'NR==2 {print int($4/1e6)}'` (the `Available` column) — not ~490 higher.
3. `node dist/index.js health --json | jq -c '[.skipped[].id], [.onDemand[].id]'` lists
   `login-items` in both (it did not run), and neither a quick run nor a full scan raises a macOS
   dialog or mounts a volume: after the runs,
   `/usr/bin/log show --last 5m --predicate '(process == "authd" AND eventMessage CONTAINS "sfltool") OR (process == "NetAuthSysAgent" AND eventMessage CONTAINS "Mount URL")'`
   prints no events. Do **not** run `--login-items` or `POST /api/health/check/login-items`
   unattended — it raises a Touch ID dialog on the user's screen.
4. `node dist/index.js health --full --md "$TMPDIR/pd-health.md"` finishes ≤ 120 s; the file has
   the verdict table and a clutter table whose sizes are **not** all whole gigabytes.
5. `node dist/index.js serve --no-open --no-history --port 7941 &`, then:
   `curl -s http://127.0.0.1:7941/api/health | jq '.findings|length'` ≥ 5 and the request took
   ≤ 6 s (`curl -w '%{time_total}'`); `curl -s -X POST http://127.0.0.1:7941/api/health/scan | jq -r .jobId`
   → an id; polling `/api/health/scan/<id>` reaches `done` with a `report`;
   `curl -s 'http://127.0.0.1:7941/api/health/report?format=md' | head -3` starts with
   `# Mac health check`; `curl -s http://127.0.0.1:7941/ | grep -c 'Run full scan'` ≥ 1.
6. `grep -rnE "\b(unlink|unlinkSync|rmSync|rmdir|rmdirSync)\b|\bfs\.rm\b|\brm\(|runElevated|child_process|osascript" src/health src/report/health.ts src/server/health-routes.ts`
   → **nothing**. `grep -rn "sudo\|rm -rf" src/health | grep -v "src/health/manual.ts"`
   → **nothing**. Comments count: do not write those words in these files, not even to say
   what the code avoids.
7. Kill the server you started and verify it is gone (`lsof -nP -iTCP:7941 -sTCP:LISTEN` empty).
   Remove `$TMPDIR/pd-health-smoke` and `$TMPDIR/pd-health.md` — those two are the only things
   you may delete.
8. If a macOS permission prompt appears while you run a command you cannot answer it: the check
   must time out into `skipped`, and that counts as a pass. Report which one.
9. **Do NOT deploy** (`scripts/*deploy*`, `npm run deploy*`, `npm run app`, `npm run release`),
   do not ssh, do not commit. Stop and report.

---

# Phase 2 — Clean-up actions (gated, opt-in, audited)

## Goal

From the Health section the user can tick reclaimable rows and move them **to the Trash**, and
run three fixed clean-up commands — always as *dry run → plan shown → one confirm click →
result + audit line*. Nothing is ever pre-selected, nothing is ever hard-deleted, and a single
environment variable turns the whole layer off. CLI: `pdetective clean`.

## Read first (Phase 2)

Phase 1 is the codebase you extend. Read, in this order: `src/health/context.ts`,
`src/health/util.ts` (`FsLike`, `realFs` — the read-only fs seam the tests use),
`src/health/catalog.ts`, `src/health/checks/disk-clutter.ts` (how items are produced: one finding
per catalog entry, `finding.id === entry.id`, `checkId:'disk-clutter'`),
`src/health/checks/runaway-logs.ts` and `launch-agents.ts` (the two other item producers),
`src/health/verdict.ts` (`flattenItems`), `src/health/cache.ts`, `src/health/engine.ts`,
`src/server/health-routes.ts`, `src/server/server.ts`, the `// ---------- health ----------`
block of `src/server/page.html`, `test/health/helpers.ts` (`fakeContext`, `scriptedRun`,
`fakeFs`) and `test/health/engine.test.ts`. Conventions are unchanged: ESM `.js` imports, strict
TS, no new dependencies, every subprocess through `ctx.run`, pure exported functions with tests.

## What changed from the draft, and why (measured 2026-10-03)

| Draft | Measured / reasoned | Phase 2 v1 |
|---|---|---|
| Trash through Finder (`osascript … tell application "Finder" to delete`) | Apple events need the Automation permission **and** the `com.apple.security.automation.apple-events` entitlement, which the bundle does not have (`tccd`: "requires entitlement … but it is missing") | Trash through **`NSFileManager.trashItemAtURL`**, called in-process by `osascript -l JavaScript` — no Apple event, no permission prompt. Probed: 0.1 s, returns the resulting Trash path, a missing file comes back as an error string, `authd`/`tccd` logged nothing |
| `empty-trash` action | needs Finder Apple events (same entitlement), and it is the one truly irreversible step | **not built.** The result says "X is now in the Trash — the space is freed when you empty it in Finder" |
| `remove-dangling-login-item` action | needs System Events Apple events (same entitlement) | stays `manual` (the Phase 1 steps) |
| `npm-cache-clean`, `brew cleanup --prune=all`, `git-worktree-remove` commands | each hard-deletes; `git worktree remove` also deletes ignored files (`.env.local`) that `status --porcelain` never showed | **no command** — the generic Trash action covers `~/.npm/_cacache`, the Homebrew cache and clean worktrees, recoverably. A trashed worktree is merely "prunable" to git; Put Back restores it |
| Deleting simulator device folders | bypasses CoreSimulator's own bookkeeping | `coresimulator` items are **not** trashable; only the fixed `xcrun simctl delete unavailable` |
| Token = hash of paths + bytes + report time | sizes drift between dry run and click → spurious `409` | token = hash of action + paths only, **and** the server keeps the plan: execute takes a token, never paths |
| (not in the draft) | the server is unauthenticated HTTP on localhost. Read-only, that was tolerable; with a write path, any web page the user visits could `POST` to it (CSRF), and DNS rebinding makes it same-origin | **request guard** (Host allowlist, same-origin `Origin`, JSON content type) — see Safety contract 6 |
| `tmutil thinlocalsnapshots` "works without sudo" | `authd` logged no request from `tmutil` during this morning's run (unlike `sfltool`) | kept as a fixed command. It deletes local restore points → treated like an `ask` item (explicit acknowledgement) |

## Safety contract (this is the feature)

1. **Only what the report found.** A target is `{findingId, path}`. It must be an item of that
   finding in the server's **current** report (`getLastReport()`), with the exact same path —
   otherwise `409` ("not in the current report — re-check"). No endpoint accepts a free path.
2. **Only where the catalog looks.** `isActionable(finding, item, home)` (pure, `src/health/actionable.ts`):
   - `item.safety` is `regenerates`, `orphan` or `ask` — never `keep`, never `manual`;
   - the path is absolute, has no `..` segment, and lies under `home` at least **two** segments
     deep — and at least **three** when it is under `~/Library` (`~/.npm/_cacache`,
     `~/Downloads/x.dmg`, `~/Library/Caches/x` yes; `~/Downloads`, `~/Library/Caches`, `~/x` no).
     The only exemption is the `sandbox` entry of rule 8, whose shape rule is
     `dirname(path) === <sandbox dir>`;
   - and it has the shape its producer can produce:
     - `disk-clutter` + catalog entry of kind `path`: `path === expand(entry.base)`;
     - kind `children` / `files`: `dirname(path) === expand(entry.base)`;
     - kind `worktrees`: matches `/\/\.claude\/worktrees\/[^/]+$/`;
     - kind `devops-agents`: matches `^<home>/[^/]+/_work$`;
     - `runaway-logs`: a path under `<home>/Library/Logs/`, at most 3 levels deep;
     - `launch-agents` stray files: `dirname(path) === <home>/Library/LaunchAgents` and the name
       does **not** end in `.plist`;
     - any other finding → not actionable;
   - the catalog entry is not marked `noTrash` (new optional `ClutterEntry` field; set it on
     `coresimulator` and `parallels-vms`).
   The engine stamps `actionable: true` on every item that passes (new optional
   `ClutterItem.actionable`), so the page and the CLI use the same answer.
3. **Re-check on disk, twice** (`resolveTargets`, at plan time **and again** immediately before
   acting): `lstat(path)` exists and is not a symlink; `realpath(path)` lies inside
   `realpath(root)` where `root` is the directory the shape rule names (the entry base,
   `~/Library/Logs`, …) — a symlink that leads outside is refused; an entry with a `runningHint`
   whose process is running is refused ("OrbStack is running — quit it first"); a single file
   ending in `.raw|.img|.qcow2|.dmg|.iso` is refused when `lsof -- <path>` (10 s) prints a data
   row on **stdout** (it writes harmless warnings to stderr). A target that changed between plan
   and execution is skipped ("changed since the dry run"), never forced.
4. **Dry run is mandatory, and the server keeps the plan.** `POST /api/health/action/plan`
   resolves and measures the targets (`du -sk -P -x`, or `lstat` blocks for files) and returns an
   `ActionPlan` with `token = planToken(actionId, paths)` = first 16 hex of
   `sha256(actionId + "\n" + sorted paths joined by "\n")`. The server stores the plan (5 min,
   single use, at most 20). `POST /api/health/action/execute` takes `{ token }` — **no paths** —
   and runs exactly the stored plan. Unknown/expired/used token → `409`.
5. **Trash, never delete.** `src/health/trash.ts` is the only file that may mention `osascript`.
   It runs one fixed JXA script (a module constant) with the paths as **arguments** — nothing is
   interpolated into the script:
   ```js
   function run(argv){ ObjC.import("Foundation"); var out=[];
     for (var i=0;i<argv.length;i++){ var err=$(), res=$();
       var ok=$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[i]), res, err);
       out.push(JSON.stringify({path:argv[i], ok:!!ok, trashedTo: ok?ObjC.unwrap(res.path):null, error: ok?null:ObjC.unwrap(err.localizedDescription)})); }
     return out.join("\n"); }
   ```
   `ctx.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TRASH_JXA, ...paths], 120_000)`, at
   most 50 paths per call; `parseTrashOutput` reads one JSON object per line. A path the system
   refuses is reported `failed` with its message — there is **no fallback** to any other way of
   removing it. Never `fs.rm`, `rmSync`, `unlink`, `rmdir`, `rename` into `~/.Trash`, or `rm`.
6. **Request guard** (`src/server/guard.ts`, pure `checkRequest(...)`, called first thing in the
   server's request handler):
   - **G1 — Host.** When the server is bound to a loopback address, every request's `Host`
     header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (the real listening
     port) → else `403`. This is what defeats DNS rebinding.
   - **G2 — Origin.** Every non-`GET`/`HEAD` request: an `Origin` header, when present, must
     equal `http://` + the `Host` header → else `403`. (No `Origin` = a non-browser client.)
   - **G3 — actions.** `POST /api/health/action/*`: refused with `403` unless the server is
     bound to loopback; `Content-Type` must start with `application/json` → else `415`; body
     ≤ 64 KiB and valid JSON → else `400`.
   G1 and G2 apply to **all** routes, old and new (the on-demand login-items check raises a Touch
   ID dialog; the elevated sample raises an admin dialog — a web page must not be able to
   trigger either). The page's own requests already satisfy both.
7. **Kill-switch** `PD_NO_ACTIONS=1` → `GET /api/health/actions` says `enabled:false`, plan and
   execute return `403 {error:'actions disabled (PD_NO_ACTIONS=1)'}`, the page shows no
   checkbox and no action button, and items are not stamped `actionable`.
8. **Sandbox** `PD_ACTIONS_SANDBOX=<absolute existing dir>`: (a) the survey gains one extra
   catalog entry `{ id:'sandbox', kind:'children', base:<dir>, safety:'regenerates',
   minBytes: 1 MiB }`; (b) planning **and** execution refuse every target whose `realpath` is
   not inside `realpath(<dir>)` ("outside the sandbox"); (c) a command action can still be
   planned (so the dialog can be exercised) but its execution is refused with `403`. Set but not
   an absolute existing directory → actions are disabled entirely (fail closed). This is how the
   feature is developed and smoke-tested without touching real data.
9. **Fixed commands only**, as argv arrays (never a shell string), asserted against a regex
   before use — the `buildFsUsageCommand` rule. No command takes a path, a name or any other
   value from a request:

   | action id | shown on finding | argv | timeout | note |
   |---|---|---|---|---|
   | `brew-cleanup` | `brew` | `/usr/bin/env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 <brew> cleanup` (`<brew>` = the probed absolute path) | 120 s | |
   | `thin-snapshots` | `apfs-snapshots` | `/usr/bin/tmutil thinlocalsnapshots / 999999999999 4` | 120 s | deletes local restore points → `needsAck` |
   | `simctl-delete-unavailable` | `coresimulator` | `/usr/bin/xcrun simctl delete unavailable` | 180 s | can take minutes when CoreSimulator is cold |

   A command action is offered only when its finding is in the current report.
10. **No sudo, no elevation, no Apple events.** `runElevated` is not imported anywhere in
    `src/health`. Whatever needs root or the GUI stays `manual`.
11. **Audit log** `<data dir>/actions.jsonl` (the directory of `healthCachePath()`; append-only,
    `mkdir -p`, never throws): `{at, actionId, method, paths, bytesPlanned, bytesFreed,
    result:'ok'|'partial'|'failed', note, trashedTo?: string[]}`. One line per execution, also
    for failures.
12. **Tell the truth about the space.** `df -k /` (`Available`) before and after.
    - Trash: `bytesFreed` is what `df` moved (normally ~0). The note always says "N items
      (X) are now in the Trash — the space is freed when you empty the Trash in Finder; local
      Time Machine snapshots can hold it after that (Thin snapshots)".
    - Commands: when `df` moved less than 50 % of what was planned and `vitals.localSnapshots ≥ 1`,
      append "the space is held by local Time Machine snapshots — run Thin snapshots".
13. **The UI never pre-selects.** `regenerates`/`orphan` rows have a checkbox; `ask` rows have
    one that stays disabled until the table's toggle "Include ‘ask’ items — I understand what
    they remove" is on; `keep`, `manual` and non-actionable rows have none. Every execution
    shows the plan first (targets with re-measured sizes, refused targets with the reason, the
    method, the total, and for `needsAck` plans a second checkbox), then **one** confirm click.

## Files

Create:

```
src/health/actionable.ts       isActionable(), effectiveCatalog(), actionRootFor()        (pure)
src/health/trash.ts            TRASH_JXA, trashPaths(ctx, paths), parseTrashOutput()
src/health/actions.ts          ACTIONS, actionsEnabled(), planAction(), executePlan(), planToken(), plan store
src/health/audit.ts            appendAudit(), readAudit(limit), cleanedSince(ts), auditPath()
src/server/guard.ts            checkRequest()                                              (pure)
test/health/actionable.test.ts, trash.test.ts, actions.test.ts, audit.test.ts, test/guard.test.ts
```

Modify: `src/types.ts` (`ClutterItem.actionable?`, `ActionPlan`, `ActionResult`, `AuditEntry`),
`src/health/catalog.ts` (`noTrash`, the sandbox entry via `effectiveCatalog()`),
`src/health/checks/disk-clutter.ts` (survey `effectiveCatalog()`), `src/health/engine.ts`
(stamp `actionable`; `pruneTargets()` after an execution), `src/health/cache.ts` (`remove(id)`),
`src/server/health-routes.ts`, `src/server/server.ts` (guard), `src/server/page.html`,
`src/report/health.ts` ("Clean-ups executed"), `src/cli.ts` (`clean`), `README.md`,
`docs/health-checks.md` (an "Actions" chapter).

## Types (`src/types.ts`)

```ts
export type ActionMethod = 'trash' | 'command';
export interface ActionTarget { findingId: string; path: string }
export interface ActionPlan {
  token: string;
  actionId: string;
  method: ActionMethod;
  createdAt: number;
  reportAt: number;                 // `at` of the report the targets were matched against
  targets: { findingId: string; path: string; bytes: number; safety: SafetyClass; note?: string }[];
  refused: { findingId: string; path: string; reason: string }[];
  totalBytes: number;
  command?: string;                 // display string of the fixed command
  explain: string;                  // one sentence: what happens and how to undo it
  needsAck: boolean;                // any `ask` target, or the action itself is flagged
}
export interface ActionResult {
  token: string; actionId: string; method: ActionMethod; at: number;
  result: 'ok' | 'partial' | 'failed';
  targets: { path: string; ok: boolean; trashedTo?: string; error?: string }[];
  bytesPlanned: number; bytesFreed: number;
  output?: string;                  // command actions: last 12 lines
  note: string;
}
export interface AuditEntry {
  at: number; actionId: string; method: ActionMethod; paths: string[];
  bytesPlanned: number; bytesFreed: number; result: 'ok' | 'partial' | 'failed'; note: string;
  trashedTo?: string[];
}
```

## Engine (`src/health/actions.ts`)

```ts
export interface CleanupAction {
  id: string; title: string; method: ActionMethod;
  explain: string;
  needsAck?: true;
  findingId?: string;                                   // command actions: the finding that offers it
  argv?: (ctx: HealthContext) => string[] | null;       // command actions; null = unavailable (no brew)
  pattern?: RegExp;                                     // the argv joined by ' ' must match
}
export const ACTIONS: CleanupAction[];                  // trash-paths + the three commands
export function actionsEnabled(boundHost?: string): { enabled: boolean; reason?: string; sandbox: string | null };
export function planToken(actionId: string, paths: string[]): string;
export interface ActionDeps { ctx: HealthContext; report: HealthReport; fs?: FsLike; now?: number }
export async function planAction(actionId: string, targets: ActionTarget[], deps: ActionDeps): Promise<ActionPlan>;
export async function executePlan(plan: ActionPlan, deps: ActionDeps & { ack?: boolean }): Promise<ActionResult>;
export function storePlan(plan: ActionPlan): void;
export function takePlan(token: string, now?: number): ActionPlan | undefined;   // single use, 5 min
```

- `planAction` for `trash-paths`: at least one target required; each goes through rules 1–3;
  the ones that fail land in `refused` with the reason; a plan with zero `targets` is returned
  (so the UI can show why) but is **not stored**. For a command action: `targets` must be empty,
  its finding must be in the report, `argv(ctx)` must be non-null and match `pattern`;
  `totalBytes` = the finding's `reclaimableBytes ?? 0`.
- `executePlan`: `needsAck && !ack` → throws `ActionError(400, …)`. Sandbox and kill-switch are
  checked **here too**, not only in the route. Re-run rule 3 per target. Then act, measure,
  build the note (rule 12), `appendAudit`, return. It never throws for a failed target or a
  failed command — that is `result:'failed'|'partial'`.
- After an execution the route calls `pruneTargets(paths)` in the engine: the trashed paths are
  removed from the cached `disk-clutter` entry (a finding left without items is dropped, its
  `reclaimableBytes` recomputed), a `brew-cleanup` run removes the cached `brew` entry
  (`cache.remove('brew')`), and a fresh quick `collectHealth` becomes the current report — so a
  second plan for the same path answers `409`.

## Endpoints (`src/server/health-routes.ts`)

- `GET /api/health/actions` → `{ enabled, reason?, sandbox, actions: [{id, title, method, explain, needsAck, findingId?}] }`.
- `POST /api/health/action/plan` — body `{ actionId, targets?: ActionTarget[] }` → `200 ActionPlan`;
  `400` bad body / unknown action, `403` disabled, `409` no current report.
- `POST /api/health/action/execute` — body `{ token, ack?: boolean }` →
  `200 { result: ActionResult, report: HealthReport }`; `409` unknown/expired/used token;
  `400` missing acknowledgement; `403` disabled.
- `GET /api/health/actions/log` → `{ entries: AuditEntry[] (newest first, ≤ 100), cleanedThisMonthBytes }`
  — the sum of `bytesPlanned` of `ok`/`partial` entries since the 1st of the month.
- The body reader lives in `health-routes.ts` (64 KiB cap, JSON only); nothing else reads bodies.

## UI (`src/server/page.html`)

- On entering Health, also `GET /api/health/actions` (once; again after an execution).
  `enabled:false` → the table and findings render exactly as in Phase 1 plus one muted line
  ("Clean-up actions are off: <reason>"). A sandbox → a visible `SANDBOX` badge next to
  "RECLAIMABLE".
- Reclaimable table: a leading checkbox column per rule 13 (state in `state.health.sel`, a `Set`
  of `findingId|path`; it survives re-renders and is cleared after an execution or a new
  report). Above the table, the `ask` toggle. A footer bar that appears when something is
  selected: "Move 3 items to the Trash · 12.4 GB" + **Review…**.
- **Review…** → `POST plan` → a modal (a fixed overlay; Escape or Cancel closes; the page has
  none yet — keep it ~40 lines): targets (path, re-measured size, class), refused targets with
  reasons (muted), "Method: to the Trash — recoverable until you empty it", the total, the
  acknowledgement checkbox when `needsAck`, and one **Move to Trash** button (disabled until
  acknowledged). → `POST execute` → the modal shows the result: ✓/✗ per target, the note, and
  when local snapshots exist a "Thin snapshots…" button that opens that action's own plan.
- Command actions: on the finding that offers one, a button ("Run `brew cleanup`…") → the same
  modal with the exact command line, `explain`, the acknowledgement checkbox when `needsAck`,
  one **Run** button → result with the output excerpt in a `<pre>`.
- Under the verdict banner: "Cleaned this month: 190 GB" (hidden when 0).
- All new requests send `content-type: application/json`. All strings through `esc()`.
  Phase 1's behavior rules still hold (no 2 s tick, timers stop when leaving the section).

## CLI (`src/cli.ts`)

```
pdetective clean --list [--json]
pdetective clean <actionId> [--finding <id>]… [--path <p>]… [--include-ask] [--apply --confirm <token>]
```

Uses a quick report (which carries the last full scan's clutter); with no full scan on record
it says "run `pdetective health --full` first" and exits 1. `--list` prints the actionable items
grouped by finding and the available command actions. Without `--apply` it prints the plan and
its token (a dry run). `--apply` needs `--confirm <token>` equal to the plan's token — the plan
is recomputed, so changed paths give a different token — and `--include-ask` when the plan
`needsAck`. `--finding` selects that finding's actionable `regenerates`/`orphan` items (plus
`ask` with `--include-ask`). Exit 1 on a refused or failed run.

## Report (`src/report/health.ts`)

`buildHealthMarkdown(r, audit?: AuditEntry[])` fills "Clean-ups executed" from the entries of the
last 30 days (date · what · result · size); the route and the CLI pass `readAudit(100)`. Empty →
"none yet".

## Tests

All with injected `ctx.run`, `FsLike` and stores — **no test touches the real Trash, real
`du`, or any real path**.

- `isActionable`: a `children` item directly in its base → ok; one level deeper → refused; a
  `keep` item, a `manual` item → refused; `~/Library/Caches`, `~/Downloads` and a path with `..`
  → refused while `~/.npm/_cacache` and `~/Downloads/x.dmg` (from their own entries) → ok; a
  sandbox item directly in the sandbox dir → ok, the same path without the sandbox set → refused;
  `coresimulator` (`noTrash`) → refused; a worktree path → ok; `<home>/x/_work` → ok,
  `<home>/x/y/_work` → refused; a stray `x.plist.bak` in `~/Library/LaunchAgents` → ok, a
  `.plist` there → refused; a finding from an unknown check → refused.
- `resolveTargets`: a path not in the report → refused ("not in the current report"); a symlink
  target → refused; a path whose `realpath` leaves the root → refused; a running `runningHint`
  process → refused; an open disk image (`lsof` stdout has a row) → refused, and `lsof` noise on
  stderr alone is **not** a holder; the same checks run again in `executePlan` and a target that
  vanished is skipped.
- `planToken`: same action + same paths in any order → same token; one path more, or another
  action → different.
- Plan store: `takePlan` returns a plan once; after 5 min → undefined; the 21st plan evicts the oldest.
- `TRASH_JXA` contains none of the request's paths (they are argv); `parseTrashOutput` handles
  an ok line, a failed line, garbage lines and empty output (→ every path `failed`); more than
  50 paths are split over several calls.
- Every command's argv joined matches its `pattern`; a one-character mutation does not; no argv
  element comes from the plan or the request.
- `executePlan`: all ok → `'ok'`; one failed → `'partial'`; all failed → `'failed'`; **never
  throws** for a failing run; `needsAck` without `ack` → `ActionError 400` and `ctx.run` was not
  called; with `PD_NO_ACTIONS=1` → `ActionError 403`, nothing run; in a sandbox, a target outside
  it → refused and a command action → refused; the Trash note is always present for
  `trash`; the snapshot note appears for a command when `df` did not move and snapshots ≥ 1.
- Audit: `appendAudit` writes one JSON line and never throws on an unwritable directory;
  `readAudit` skips damaged lines; `cleanedSince` sums `bytesPlanned` of ok/partial entries only.
- `checkRequest`: `Host: 127.0.0.1:7878` / `localhost:7878` / `[::1]:7878` ok on port 7878;
  `evil.example:7878` and `127.0.0.1:1` → 403; `POST` with `Origin: http://evil.example` → 403;
  `POST` with the matching `Origin` or with none → ok; an action route with `text/plain` → 415;
  an action route while bound to `0.0.0.0` → 403; a `GET` with a foreign `Origin` → ok (G2 is
  for non-GET).
- `pruneTargets`: a trashed item disappears from the cached finding, the finding is dropped when
  empty, `reclaimableBytes` is recomputed.
- Phase 1's 499 tests stay green and untouched (adjust only where a signature legitimately grew).

## Rules for the build agent (non-negotiable)

- **You never execute a clean-up against real data.** Every server or CLI you start for a smoke
  test has `PD_ACTIONS_SANDBOX` set to a directory you created under `$TMPDIR`, plus
  `PD_DATA_DIR` under `$TMPDIR` and `PD_HEALTH_SKIP=wallpaper-cache`. With the sandbox set, the
  code itself refuses anything outside it — build and unit-test that refusal **before** your
  first smoke run.
- You never run `brew cleanup`, `tmutil thinlocalsnapshots`, `xcrun simctl delete`, `rm` on
  anything outside `$TMPDIR`, or anything touching `~/.Trash` by hand. The command actions are
  verified by unit tests with an injected `run` only.
- The junk your smoke test trashes stays in the Trash — do not go into `~/.Trash` to remove it.
  Name it `pd-sandbox-junk-…` so it is recognizable, keep it ≤ 2 MB, and report the names.
- Never `--login-items`, never `POST /api/health/check/login-items` (Touch ID dialog), never
  `tmutil latestbackup`.
- Do not deploy, do not commit, do not touch git state. A preview server may be running on port
  **7941** for the user — leave it alone and use port **7942**.

## Acceptance criteria (Phase 2)

Run all of it; paste the outputs in your report.

1. `npx tsc --noEmit` clean; `npm run build`; `npm test` green with **499 + new** tests.
2. Set up: `SB="$TMPDIR/pd-actions-sandbox"; mkdir -p "$SB/pd-sandbox-junk-a" "$SB/pd-sandbox-junk-b"`,
   a 2 MB file in each; `export PD_DATA_DIR="$TMPDIR/pd-actions-data" PD_ACTIONS_SANDBOX="$SB" PD_HEALTH_SKIP=wallpaper-cache`;
   `node dist/index.js serve --no-open --no-history --port 7942 &`; run a full scan through the API.
3. `GET /api/health/actions` → `enabled:true`, `sandbox` = the directory, four actions.
4. Plan for one **real** item of the report (e.g. the `npm-cache` item) → `200` with that item
   under `refused` ("outside the sandbox") and no token usable for execution.
5. Plan for `pd-sandbox-junk-a` → a token; `execute` with it → `result:'ok'`, `trashedTo` under
   `~/.Trash`; the folder is gone from `$SB`; `pd-sandbox-junk-b` is untouched; the same token
   again → `409`; a new plan for junk-a → refused ("not in the current report");
   `actions.jsonl` has exactly one line, `result:'ok'`.
6. Guard, each with `curl -s -o /dev/null -w '%{http_code}'`: plan with
   `-H 'Origin: http://evil.example'` → `403`; with `-H 'Host: evil.example:7942'` → `403`;
   with `-H 'Content-Type: text/plain'` → `415`; `GET /api/health -H 'Host: evil.example:7942'` → `403`;
   a plain `GET /api/health` and `POST /api/health/scan` still → `200`/`202`.
7. A command action in the sandbox: plan `thin-snapshots` → the plan shows the command;
   `execute` → refused (`403`), and `tmutil thinlocalsnapshots` was **not** run
   (`/usr/bin/log show --last 5m --predicate 'process == "tmutil"'` shows no `thinlocalsnapshots`).
8. Restart the server with `PD_NO_ACTIONS=1`: `GET /api/health/actions` → `enabled:false`; plan → `403`;
   `curl -s http://127.0.0.1:7942/ ` still serves the page.
9. CLI: `node dist/index.js clean --list` shows the sandbox item; `clean trash-paths --path "$SB/pd-sandbox-junk-b"`
   prints a plan and a token; with `--apply --confirm <token>` it is trashed; with a wrong token → exit 1, nothing trashed.
10. In the Browser pane on `http://127.0.0.1:7942/#/health` (sandbox still set): nothing is
    pre-selected; an `ask` row's checkbox is disabled until the toggle is on; selecting a sandbox
    row → Review… → the modal lists it → confirm → the result shows and the row is gone. (Create
    a third junk folder for this.)
11. `grep -rnE "\b(unlinkSync|unlink|rmSync|rmdirSync|rmdir)\b|\bfs\.rm\b|\brm\(|runElevated|child_process" src/health src/report/health.ts src/server/health-routes.ts src/server/guard.ts`
    → nothing. `grep -rln "osascript" src/health src/server src/report` → only `src/health/trash.ts`.
    `grep -rn "sudo\|rm -rf" src/health | grep -v "src/health/manual.ts"` → nothing.
12. Stop every server you started (port 7942 free; **7941 untouched**), remove
    `$TMPDIR/pd-actions-sandbox` and `$TMPDIR/pd-actions-data`. Report the names of the junk
    folders now in the Trash.
13. **Do NOT deploy, do NOT commit.** Stop and report.

---

## Constraints & non-goals (both phases)

- No new dependencies. ESM `.js` imports. Strict TS. Match the collector/parser/fixture
  pattern. Never throw from a check; degrade to `skipped` + reason.
- Never `pgrep -f`, never `du -sg`, never unbounded `find /`, never AppleScript in Phase 1.
  Every subprocess has a timeout.
- **No side effects, no surprise dialogs.** A check must not change system state — that includes
  mounting a volume (`tmutil latestbackup`) — and must not raise an authorization dialog unless
  the user explicitly asked for that check (`optIn`). When in doubt whether a command does either,
  watch `authd` / `NetAuthSysAgent` in the unified log while running it once by hand.
- Health work never runs on the 2 s poll and never while the section is hidden.
- Nothing installs updates, removes `/usr/local` binaries, edits launchd plists, unregisters
  CI agents or touches Parallels VMs. OrbStack/Docker disks and Claude VM bundles move only to
  the Trash, only as `ask` items, only when their app is not running.
- Out of scope: a privileged helper, scheduling/periodic scans, notifications, remote Macs,
  `brew upgrade`, a native download delegate for the WKWebView, fixing the Disk section's
  "used" figure for `/`, emptying the Trash, removing login items, anything that needs the
  Apple-events entitlement.
- Update `README.md`: a **Health** section (what it checks, the verdict rule, the snapshot
  gotcha, the cache file and `PD_DATA_DIR`, the permission prompts a full scan can trigger for
  `~/Downloads` and other apps' containers). **Phase 2 rewords the read-only principle**
  everywhere the README states it: "read-only by default; clean-up is an opt-in action layer
  that never deletes — it moves things to the Trash after a dry run and a confirmation — and
  `PD_NO_ACTIONS=1` turns it off", plus a **Clean-up** section (the safety contract in plain
  words, the four actions, the audit log, the request guard). Add `docs/health-checks.md` listing every check id with its
  command, scope/ttl and what triggers each severity.

## Deliverables to report

Files created/modified; outputs of typecheck/build/tests (counts before/after); the output of
every acceptance command; for Phase 2 also the names of the sandbox junk folders left in the
Trash and a plain statement of which actions were executed for real (it must be: only
`trash-paths`, only inside the sandbox); every deviation from this spec with the reason;
follow-ups. Then **STOP** — no deploy, no commit.
