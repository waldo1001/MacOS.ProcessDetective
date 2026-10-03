# Spec — Mac health check + gated clean-up actions

Status: **DRAFT, Phase 1 ready to build.** Hand this file to `/spec-and-build`.

## Build order (mandatory — read before anything else)

1. **Build Phase 1 only.** Stop at the end of Phase 1's acceptance criteria and report. Do
   **not** start Phase 2 in the same run, even if asked to "do the whole spec" — Phase 2
   changes the app's read-only contract and is reviewed separately.
2. **Waldo reviews Phase 1 in the UI on this Mac** (`npm run deploy`, open the Health section,
   run a full scan, read the findings against the machine he knows). Fixes from that review
   land in Phase 1 before anything else happens.
3. **Only then start Phase 2**, as a new `/spec-and-build` run with the instruction "Phase 2 of
   `docs/health-check-and-cleanup-spec.md`". The Phase 2 agent must confirm Phase 1 is merged
   and its tests are green before touching an action.

If you are the build agent and the request does not say which phase, it is Phase 1.

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
   *healthy*. The verdict comes from memory pressure, swap, thermal, crashes, runaway logs,
   backup state. Clutter is reported as reclaimable space with a safety class, nothing more.
2. **The app stays read-only by default.** Phase 1 adds zero write paths. Phase 2 adds an
   *explicit, separately gated* action layer: dry-run first, confirmation token, Trash instead
   of `rm` wherever possible, allowlisted roots only, audit log, kill-switch. "Read-only" in the
   README becomes "read-only by default; clean-up is an opt-in action layer that never deletes
   without a dry-run and a confirmation, and sends files to the Trash where it can."

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TS ESM (`"module":"NodeNext"` → **relative imports use `.js`**), strict,
  `noUncheckedIndexedAccess`, **no new deps** (`node:` builtins + shell via `run()` in
  `src/util/exec.ts`, which never throws). vitest. Baseline: **337 tests green**
  (`npm test`, 2026-10-03).
- Read first, in this order:
  - `src/util/exec.ts` — `run(cmd, args, timeoutMs)` → `RunResult {stdout, stderr, code, failed}`.
  - `src/collect/elevated.ts` — `runElevated(innerCmd, timeoutMs)` (admin dialog, honors
    `PD_NO_ELEVATED=1`, never throws). The **only** way anything runs as root. Not needed in
    Phase 1; Phase 2 uses it for exactly one fixed command.
  - `src/collect/docker.ts` + `src/collect/fsusage.ts` — the collector pattern to copy: a PURE
    exported parser with a fixture + an async runner that degrades to `available:false, note`.
    `buildFsUsageCommand` shows the "fixed string, regex-asserted, no user input" rule.
  - `src/collect/system.ts` — `collectSystem()` / `SystemStats` (memory, swap, pressure,
    `storage.volumes` via `parseDf`, power). **Reuse it**; do not re-shell `vm_stat`/`df`.
  - `src/collect/crashes.ts` — `getRecentCrashes(windowMs)` / `CrashGroup` (dedup + `looping`).
    Reuse with a 7-day window.
  - `src/history/collector.ts` + `store.ts` — data dir resolution (`PD_DATA_DIR`, `os.homedir()`
    not cwd), JSONL append pattern, lockfile. Phase 2's audit log copies this.
  - `src/report/report.ts`, `src/report/prompt.ts` — text report + AI prompt builders.
  - `src/server/server.ts` — route style (`url.pathname`, `json(res, code, body)`, pid-scoped
    `POST` blocks), `src/server/payload.ts`.
  - `src/server/page.html` (923 lines) — sidebar sections, `rOverview()…rDetail()` renderers,
    keyboard map (`1`–`7`, `g`+letter), the on-demand button + spinner pattern in `rEnergy()`
    (per-app power) and the detail panel's Containers card.
  - `src/cli.ts` — commander commands (`top`, `tree`, `inspect`, `report`, `serve`, `ui`,
    `prompt`, `watch`); add `health` next to `report`.
  - `src/types.ts` — add the new types at the bottom, grouped under a `// ── Health ──` banner.
- Verify: `npx tsc --noEmit`, `npm run build`, `npm test`.
- **The repo is not under git.** Before the build agent starts: `git init && git add -A &&
  git commit -m "baseline before health-check spec"` so every change is diffable and
  revertible. The agent must refuse to start a build in a non-git tree.

---

# Phase 1 — Health check (read-only, no sudo)

## Goal

`GET /api/health?scope=quick` answers in ≤ 5 s with a verdict and the vitals; a **full scan**
(`POST /api/health/scan` → job) adds the disk-clutter survey (bounded `du`, ≤ 90 s). A new
sidebar section **Health** (key `8`, `g h`) shows verdict → findings grouped by category →
reclaimable table → "Copy report" / "Copy AI prompt" / "Save findings (.md)". CLI:
`pdetective health [--full] [--json] [--md <file>]`.

## Data model (`src/types.ts`)

```ts
export type HealthVerdict = 'healthy' | 'cluttered' | 'degraded' | 'sick';
export type HealthSeverity = 'info' | 'advice' | 'warn' | 'risk';
export type HealthCategory =
  | 'vitals' | 'stability' | 'startup' | 'processes' | 'tooling' | 'updates' | 'backup' | 'clutter';
export type SafetyClass =
  | 'regenerates'   // caches/build output: delete freely, app rebuilds it
  | 'orphan'        // owner app no longer installed / target missing
  | 'ask'           // valuable to some users (VM disks, models, downloads)
  | 'keep'          // in use / recently touched; listed for transparency only
  | 'manual';       // needs sudo, GUI or a restart — print steps, never act

export interface HealthEvidence {
  command: string;          // exactly what was run, copy-pasteable
  excerpt: string;          // trimmed stdout/stderr lines that justify the finding (≤ 12 lines)
}

export interface HealthFinding {
  id: string;               // stable, kebab-case, e.g. 'runaway-log', 'node-multiple-installs'
  category: HealthCategory;
  severity: HealthSeverity;
  title: string;            // one line, human
  detail: string;           // 1–3 sentences; say what it means, not just what it is
  evidence: HealthEvidence[];
  reclaimableBytes?: number;     // only for clutter + runaway logs
  safety?: SafetyClass;          // only for clutter
  paths?: string[];              // resolved absolute paths this finding is about
  lastModified?: number;         // ms epoch of the newest path, when cheap to know
  actionId?: string;             // Phase 2: id of the clean-up action that fixes it
  manualSteps?: string[];        // for safety 'manual': exact commands / Settings path
}

export interface HealthReport {
  at: number;
  scope: 'quick' | 'full';
  durationMs: number;
  verdict: HealthVerdict;
  verdictReason: string;    // "no pressure, no swap, no crashes; 236 GB reclaimable clutter"
  vitals: {                 // numbers the UI shows as tiles; all nullable
    memFreePct: number | null; swapUsedBytes: number | null; pressure: string | null;
    loadAvg1: number | null; uptimeSec: number | null; processCount: number | null;
    thermalWarning: boolean | null; batteryCycles: number | null; batteryHealthPct: number | null;
    diskFreeBytes: number | null; diskTotalBytes: number | null; localSnapshots: number | null;
    crashes7d: number | null;
  };
  findings: HealthFinding[];
  reclaimable: { total: number; byClass: Record<SafetyClass, number> };
  skipped: { id: string; reason: string }[];   // checks that timed out / unavailable
}
```

`HealthVerdict` rule (PURE `computeVerdict(vitals, findings)`, unit-tested):
- `sick` — any `risk` finding in `vitals|stability` (pressure critical, swap > 4 GB **and**
  memFree < 10 %, thermal warning present, a crash group `looping`, a runaway log still growing).
- `degraded` — any `warn` in `vitals|stability|processes|backup`.
- `cluttered` — otherwise, when `reclaimable.byClass.regenerates + orphan` ≥ 20 GB **or** any
  `warn` in `startup|tooling|updates`.
- `healthy` — otherwise. Clutter alone can never produce `degraded` or `sick`.

## Checks (`src/health/checks/*.ts`)

Every check is one file exporting `const check: HealthCheck`:

```ts
export interface HealthCheck {
  id: string;
  category: HealthCategory;
  scope: 'quick' | 'full';        // full-only checks run in the scan job
  timeoutMs: number;
  run(ctx: HealthContext): Promise<HealthFinding[]>;  // never throws; [] when nothing to say
}
export interface HealthContext {
  home: string;                   // os.homedir()
  system: SystemStats;            // one collectSystem() call shared by all checks
  now: number;
  run: typeof run;                // injectable for tests
}
```

Registry `src/health/registry.ts` exports `ALL_CHECKS` and `runChecks(scope, ctx, onProgress?)`
— runs quick checks with concurrency 6, full checks with concurrency 3, each wrapped in a
timeout; a timed-out or throwing check becomes a `skipped` entry, never a crash. Parsers are
PURE and exported from the same file for tests. Each `run()` must collect its own evidence
(the command string + a trimmed excerpt).

### quick scope

| id | category | source (no sudo) | finding logic |
|---|---|---|---|
| `memory-pressure` | vitals | `ctx.system.memory` (pressure, swap, free) | `warn` when swap > 1 GB or pressure `warning`; `risk` when critical. `info` tile otherwise |
| `thermal` | vitals | `pmset -g therm` | `risk` if any line is **not** `No … has been recorded` (fixture below) |
| `battery` | vitals | `system_profiler SPPowerDataType` (≈1.5 s; cache 10 min) → `Cycle Count`, `Condition`, `Maximum Capacity` | `warn` when Condition ≠ Normal or capacity < 80 %; else `info` with the numbers |
| `uptime-load` | vitals | `sysctl kern.boottime`, `vm.loadavg`, `ps -A | wc -l` (or `ctx.system`) | `advice` when uptime > 30 d ("a restart is overdue; macOS updates pending") |
| `crashes-7d` | stability | `getRecentCrashes(7 * 86400_000)` | `warn` per group with count ≥ 3, `risk` when `looping`; `info` "0 crash reports in 7 days" otherwise |
| `runaway-logs` | stability | `find ~/Library/Logs -type f -size +200M` (`-maxdepth 3`), then for each: `stat -f %m %z`, and `tail -n 2000 <file>` → normalize digits → top-line ratio | `warn` when size > 500 MB **or** repetition ratio ≥ 0.8; `risk` when also modified in the last 10 min (still growing). `reclaimableBytes` = size, `safety:'regenerates'`. Title names the owning app from the path (`ElgatoStreamDeck/com.elgato.camerahub3.log` → "Stream Deck"). Detail quotes the repeated line |
| `login-items` | startup | `osascript` (fixture below) → name → path | `warn` per item whose path is `missing value` (`safety:'orphan'`, `manualSteps`: System Settings → General → Login Items). `advice` for a path under `node_modules/`, `/Temp/`, `/tmp/` ("dev build registered as a login item") |
| `launch-agents` | startup | `ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons`, parse each plist's `Program`/`ProgramArguments[0]` via `plutil -extract … raw` | `warn` when the program path does not exist (`orphan`); `info` for `*.bak*`/`*.disabled` stray files (`regenerates`, tiny) |
| `btm-items` | startup | `sfltool dumpbtm` (works without sudo on macOS 26) → blocks of `Name / Type / Disposition` | `info` count of enabled legacy agents/daemons; `advice` when a `developer`/`app` entry's name matches no bundle in `/Applications` or `~/Applications` (best-effort by name, say so) |
| `duplicate-helpers` | processes | existing `snapshot()` tree | group processes by normalized command (strip pids/ports); `advice` when the same long-lived helper runs ≥ 3× under different parents (e.g. 5× `bc-telemetry-buddy-mcp`), naming the parents. `warn` when the parent is dead/`launchd` and the child is an IDE/agent helper (orphan). No `pgrep -f`: it matches itself — use the tree |
| `node-installs` | tooling | `which -a node` → unique paths; `<path> --version` each (`run`, 3 s) | `warn` when > 1 distinct install; detail says which one wins (`PATH` order) and that a `/usr/local/bin/node` from a `.pkg` needs `sudo` to remove (`manualSteps` with the exact `sudo rm -rf …` list; `safety:'manual'`) |
| `brew` | tooling | `brew --version`; `brew outdated --json=v2` (≤ 20 s); `brew cleanup -n` last line; `brew doctor` only when `PD_HEALTH_BREW_DOCTOR=1` (slow) | `advice` with outdated count + cleanup bytes (`reclaimableBytes`, `regenerates`, `actionId:'brew-cleanup'`); skip silently when brew is absent |
| `software-update` | updates | `softwareupdate -l` (10–40 s; **quick scope but cached 6 h** in `PD_DATA_DIR/health-cache.json`; first call may be `skipped` with reason "warming") | one `advice` finding listing labels; `warn` when a same-major macOS update has `Action: restart` (security content). Never installs |
| `time-machine` | backup | `tmutil destinationinfo`; `tmutil latestbackup` | `info` when the latest backup < 48 h; `warn` when > 7 d; **`advice` "last backup unverifiable — destination not mounted"** when `latestbackup` fails with `Failed to mount destination` (do NOT call that a risk; it is the normal away-from-NAS state). `info` with count of `tmutil listlocalsnapshots /` → `vitals.localSnapshots` |

### full scope (the clutter survey)

`disk-clutter` walks a **curated catalog** — not the whole disk. `src/health/catalog.ts`
exports `CLUTTER_CATALOG: ClutterEntry[]`:

```ts
export interface ClutterEntry {
  id: string; title: string; path: string;             // path may contain ~ and one '*' glob at the end
  safety: SafetyClass; owner?: string;                 // owner = app bundle name to test for 'orphan'
  regenNote: string;                                   // what happens after deletion, one sentence
  actionId?: string;                                   // Phase 2 action able to clean it
  minBytes?: number;                                   // report only above this (default 500 MB)
}
```

Initial catalog (sizes/dates from `du -sk` + `stat -f %m`; `*` entries report per child, top 15):

| id | path | safety | regenNote |
|---|---|---|---|
| `xcode-deriveddata` | `~/Library/Developer/Xcode/DerivedData/*` | regenerates | Xcode rebuilds on next build (minutes) |
| `xcode-devicesupport` | `~/Library/Developer/Xcode/iOS DeviceSupport/*` | regenerates | re-fetched when the device is plugged in |
| `coresimulator` | `~/Library/Developer/CoreSimulator/Devices/*` (name via `plutil -extract name raw device.plist`) | ask | `xcrun simctl delete unavailable` is always safe; named devices lose their state |
| `android-avd` | `~/.android/avd/*.avd` | ask | emulator recreated in Android Studio (~2 min); snapshots lost |
| `brew-cache` | `~/Library/Caches/Homebrew` | regenerates | `brew cleanup` |
| `user-caches` | `~/Library/Caches/*` (excluding Homebrew) | regenerates | apps rebuild caches; browsers re-download |
| `user-logs` | `~/Library/Logs/*` | regenerates | logs; see `runaway-logs` for the pathological ones |
| `npm-cache` | `~/.npm/_cacache` | regenerates | `npm cache clean --force` |
| `nuget-cache` | `~/.nuget/packages` | regenerates | restored on next `dotnet restore` |
| `hf-models` | `~/.cache/huggingface/hub/models--*` | ask | model re-downloaded on next use (GBs) |
| `orbstack-disk` | `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw` | ask | **all** Docker images/containers/Linux VMs; detail must say whether OrbStack is running |
| `docker-desktop` | `~/Library/Containers/com.docker.docker/Data/vms` | ask | idem for Docker Desktop |
| `claude-vm` | `~/Library/Application Support/Claude/vm_bundles` | ask | Claude Desktop local-agent VM; regenerates, VM-local session data lost |
| `parallels-vms` | `~/Parallels/*.pvm` | keep | listed for transparency only |
| `downloads-installers` | `~/Downloads/*.{dmg,pkg,iso,xip,tar,tar.gz,zip}` older than 30 d | ask | installers are re-downloadable; zips may be data — list them, never auto-select |
| `wallpaper-cache` | `~/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches` | regenerates | aerials re-download |
| `app-support-orphans` | `~/Library/Application Support/*` | orphan **only** when `owner` resolution finds no bundle | the owner check: an entry's folder name or a known map (`Autodesk→Fusion*`, `Google→Google Chrome`, …); unknown → `keep` |
| `claude-worktrees` | `~/SourceCode/**/.claude/worktrees/*` (depth ≤ 6, `find -prune`) | ask | per worktree: `git -C <wt> status --porcelain` empty → `regenerates` ("clean worktree; branch is kept"); non-empty → `keep` ("N uncommitted changes") |
| `devops-agents` | `~/**/_work` whose parent has `.agent` (Azure Pipelines agent) | ask | build output; detail shows pool/agent name from `.agent` |

Rules for the survey:
- **Measure with `du -sk`** (kilobytes) and convert — never `du -sg`, which rounds every entry
  up to 1 GB (the 2026-10-03 session mis-sized two dozen folders that way).
- Concurrency 3, per-entry timeout 30 s, whole survey ≤ 90 s; a timed-out entry is `skipped`
  with its reason. Expand `*` with `fs.readdir`, not the shell.
- Never follow symlinks (`du -skP` is default; also skip `lstat().isSymbolicLink()` entries).
- `lastModified` = newest `mtime` among the entry's direct children (cheap) — enough to say
  "idle since Sep 7".
- Results cached in `PD_DATA_DIR/health-cache.json` with the scan timestamp; `GET /api/health`
  returns the last full scan's clutter alongside fresh quick results, marked `stale: true` when
  older than 24 h.

### Also in full scope

`apfs-snapshots` (stability/backup): `tmutil listlocalsnapshots /` count. `advice` when ≥ 1:
"deleted files stay allocated until local snapshots thin; `tmutil thinlocalsnapshots /
999999999999 4` releases them (no sudo)". `actionId:'thin-snapshots'`.

## Report + prompt (`src/report/health.ts`)

- `buildHealthReport(r: HealthReport): string` — plain text, same voice as `generateReport`:
  verdict line first, then vitals in a 2-column block, then findings grouped by category,
  severity tag in brackets, evidence indented, then a reclaimable table sorted by bytes with
  safety class, then "Skipped" and "Manual steps".
- `buildHealthPrompt(r): string` — the AI prompt: the report + QUESTIONS: "Is anything here a
  real health problem or is it all clutter? Which three items would you act on first and why?
  Which findings need more evidence before acting? Say explicitly which items need sudo or a
  restart." Mirror `report/prompt.ts` conventions.
- `buildHealthMarkdown(r): string` — the findings file format Waldo writes by hand today:
  `# Mac health check — <date>`, verdict table, "What is worth fixing", clutter table (GB /
  where / what / safe?), commands used, "Clean-ups executed" (Phase 2 fills it). This is the
  `--md` output and the "Save findings" button.

## Endpoints (`src/server/server.ts`)

- `GET /api/health?scope=quick` → runs quick checks (≤ 5 s target; `software-update` and
  `battery` come from cache) → `HealthReport` + `{ lastFullScanAt: number|null }`.
- `POST /api/health/scan` → starts the full survey as a **single in-process job** (second call
  while running returns the same job id, 202). Returns `{ jobId }`.
- `GET /api/health/scan/:jobId` → `{ state:'running'|'done'|'failed', progress:{done,total,
  current}, report?: HealthReport }`.
- `GET /api/health/report?format=text|prompt|md` → built from the latest report (quick merged
  with the last full scan).
- No pid in these routes; nothing here reads a process argument. No new `POST` performs a write
  in Phase 1 (the scan writes only its own cache file under `PD_DATA_DIR`).

## UI (`src/server/page.html`)

New sidebar section **Health** (icon: stethoscope/heart-pulse; key `8`, `g h`):

1. **Verdict banner** — one of the four words, colored by the existing severity ramp
   (healthy = calm, cluttered = neutral accent, degraded = warning, sick = critical), with
   `verdictReason` beneath. Right side: "Quick check: 3.8 s · Full scan: 2 h ago (stale)" and a
   **"Run full scan"** button → `POST /api/health/scan`, progress bar polling every 1 s, result
   replaces the clutter table.
2. **Vitals tiles** — mem free %, swap, pressure, load, uptime, thermal, battery (cycles ·
   health %), disk free, crashes 7d, local snapshots. Tabular numerics, muted when null.
3. **Findings** — grouped by category in the order vitals → stability → startup → processes →
   tooling → updates → backup; each row: severity pill, title, detail; expandable **Evidence**
   (`command` in monospace + excerpt); `manualSteps` rendered as a copyable code block.
4. **Reclaimable** — table: size · path (shortened with `~`) · what · safety pill · last
   modified; sortable by size; footer totals per safety class; `keep` rows dimmed. In Phase 1
   the action column is absent.
5. Header actions: **Copy report**, **Copy AI prompt**, **Save findings (.md)** (download via
   `data:` URL; filename `<YYYY-MM-DD>-mac-health-check-findings.md`).

Keep existing sections untouched. Health never polls on the 2 s cadence — quick check runs on
section open and on an explicit **Re-check** button; nothing in Health runs while the section is
not visible (a monitor must not become the spike).

## CLI (`src/cli.ts`)

```
pdetective health [--full] [--json] [--md <file>] [--no-cache]
```
Quick by default; `--full` runs the survey inline with a progress line on stderr; `--json`
prints the `HealthReport`; `--md <file>` writes `buildHealthMarkdown`. Exit code 0 always
(a health report is not a test).

## Tests (`test/health/*.test.ts` + `test/fixtures/health/`)

Fixtures are real captures from the 2026-10-03 machine; create them verbatim:

`pmset-therm-ok.txt`
```
Note: No thermal warning level has been recorded
Note: No performance warning level has been recorded
Note: No CPU power status has been recorded
```
`login-items.txt` (output of the osascript in `login-items`, one `name -> path` per line)
```
Dropbox -> /Applications/Dropbox.app
amelia-gateway -> /Users/waldo/.local/bin/amelia-gateway
Mouse Glide -> missing value
DockDoor -> missing value
Warp -> missing value
Electron -> /Users/waldo/Temp/TeamsChatNotificationApp/node_modules/electron/dist/Electron.app
DisplayLink Manager -> /Applications/DisplayLink Manager.app
```
`sfltool-dumpbtm.txt` — ≥ 6 blocks, including:
```
                 Name: DisplayLink Manager
                 Type: legacy agent (0x10008)
          Disposition: [enabled, allowed, not notified] (0x3)
                 Name: com.muse.authservice
                 Type: legacy daemon (0x10010)
          Disposition: [enabled, allowed, notified] (0xb)
                 Name: (null)
                 Type: developer (0x20)
          Disposition: [disabled, allowed, not notified] (0x2)
```
`which-node.txt`
```
/Users/waldo/.nvm/versions/node/v20.20.2/bin/node
/opt/homebrew/bin/node
/usr/local/bin/node
/opt/homebrew/bin/node
```
`softwareupdate-l.txt`
```
* Label: Command Line Tools for Xcode 27.0-27.0
	Title: Command Line Tools for Xcode 27.0, Version: 27.0, Size: 519460KiB, Recommended: YES, 
* Label: macOS Tahoe 26.7.1-25G241
	Title: macOS Tahoe 26.7.1, Version: 26.7.1, Size: 2960823KiB, Recommended: YES, Action: restart, 
* Label: macOS 27.0.1-26A434
	Title: macOS 27.0.1, Version: 27.0.1, Size: 11713682KiB, Recommended: YES, Action: restart, 
```
`tmutil-latestbackup-unmounted.txt`
```
Failed to mount backup destination, error: Error Domain=com.apple.backupd.ErrorDomain Code=18 "Failed to mount destination." UserInfo={NSLocalizedDescription=Failed to mount destination.}
```
`runaway-log-tail.txt` — 200 lines of `2026-10-02T15:29:01.123 Info AppClient: Trying to connect
to port 51234...` with varying digits, plus 5 unrelated lines (ratio ≈ 0.97).
`brew-cleanup-n.txt` — last line `==> This operation would free approximately 248.6MB of disk space.`
`brew-outdated.json` — a two-formula `--json=v2` document.
`du-sk.txt` — `118554624\t/Users/waldo/Library/Developer/Xcode/DerivedData/Findly-gnto…` style lines.

Required unit tests (pure parsers + rules):
- `parseTherm` → ok fixture gives no finding; a line `CPU_Speed_Limit = 60` gives `risk`.
- `parseLoginItems` → 3 orphans + 1 dev-build advice; the Dropbox line gives nothing.
- `parseBtm` → block count, enabled legacy agents, `(null)` names tolerated.
- `parseWhichNode` → de-duplicates to 3 installs, winner is the first.
- `parseSoftwareUpdate` → 3 labels; the 26.7.1 entry flagged same-major + restart given
  `ProductVersion 26.6.2`; 27.0.1 is not same-major.
- `parseLatestBackup` → unmounted fixture → `advice` not `warn`.
- `repetitionRatio(tail)` → ≥ 0.8 for the runaway fixture, < 0.3 for a varied log.
- `parseDuSk` → bytes (× 1024) and path; tolerates `du:` permission lines on stderr.
- `computeVerdict` — table test: clutter-only → `cluttered`; swap 5 GB + free 8 % → `sick`;
  looping crash → `sick`; TM unmounted alone → `healthy`; dangling login item alone → `cluttered`.
- `classifyClutter` — Autodesk with no bundle → `orphan`; a `.claude/worktrees` path with
  porcelain output → `keep`.
- Registry: a check that throws and a check that exceeds its timeout both land in `skipped`
  and do not fail the report.
Do **not** run `softwareupdate`, `system_profiler`, `du` over real paths or `osascript` in tests;
inject `ctx.run`.

## Acceptance criteria (Phase 1)

1. `npx tsc --noEmit` clean; `npm run build`; `npm test` green with ≥ 337 + new tests.
2. `node dist/index.js health --json | jq .verdict` prints one of the four words in ≤ 10 s on
   a warm cache (first run may report `software-update` as skipped/warming — acceptable).
3. `node dist/index.js health --full --md /tmp/pd-health.md` finishes ≤ 120 s, the file has
   the verdict table and a reclaimable table whose sizes are **not** all whole gigabytes.
4. `node dist/index.js serve --no-open --no-history --port 7941`, then
   `curl -s 'http://127.0.0.1:7941/api/health?scope=quick' | jq '.findings|length'` ≥ 1;
   `curl -s -X POST http://127.0.0.1:7941/api/health/scan` → `jobId`; polling the job reaches
   `done`; `curl -s 'http://127.0.0.1:7941/' | grep -c 'Run full scan'` ≥ 1.
5. `grep -rn "sudo\|rm -rf\|unlink\|rmSync\|rm(" src/health src/report/health.ts` returns
   **nothing** (Phase 1 has no write path except the cache file written via `fs.writeFile` in
   `src/health/cache.ts`).
6. Reap every server you start; verify it died.
7. **Do NOT deploy** (`scripts/*deploy*`, `npm run deploy*`), do not ssh, do not `git init` on
   the user's behalf if the tree is not git — stop and report instead.

---

# Phase 2 — Clean-up actions (gated, opt-in, audited)

**Do not build in the same run as Phase 1.** Build only after Waldo has reviewed Phase 1 in
the UI on this Mac and its fixes are in (see "Build order" at the top). Same conventions.

## Safety contract (this is the feature)

1. **Allowlisted targets only.** An action may touch only paths that a Phase 1 finding
   produced *in this server's current report* (matched by `finding.id` + exact path) and that
   lie under a root in `ALLOWED_ROOTS` (`~/Library/Developer`, `~/Library/Caches`,
   `~/Library/Logs`, `~/Library/Application Support/<orphan owner>`, `~/.npm`, `~/.nuget`,
   `~/.cache`, `~/.android/avd`, `~/Downloads`, `*/.claude/worktrees/*`, `*/_work`). Paths are
   `realpath`-resolved; a symlink or a path escaping its root → refuse (`403`).
2. **Dry-run is mandatory.** `POST /api/health/action/:actionId` with body `{ paths? }` and
   **no** `confirm` returns the plan: resolved paths, `du -sk` bytes per path, method, what
   regenerates, and a `confirm` token = `sha256(actionId + sorted paths + totalBytes + reportAt)`
   truncated to 16 hex. Executing requires `{ confirm }` matching; a mismatch (stale report,
   different paths) → `409`.
3. **Trash, not `rm`**, for every file/folder action: `osascript -e 'tell application "Finder"
   to delete POSIX file "<path>"'` with proper AppleScript escaping (reuse the escaping helper
   from `elevated.ts`; refactor it into `src/util/applescript.ts` if it is private). Finder
   delete is undoable (⌘Z / Put Back). Document that a 100 GB Trash is still allocated until
   emptied; the UI says so and offers **Empty Trash** as its own action
   (`tell application "Finder" to empty trash`) — never automatic.
4. **Commands are fixed strings**, regex-asserted before use, exactly like
   `buildFsUsageCommand`: `brew cleanup`, `brew cleanup --prune=all` (separate action),
   `xcrun simctl delete unavailable`, `tmutil thinlocalsnapshots / 999999999999 4`,
   `npm cache clean --force`, `git -C <wt-from-finding> worktree remove <wt>` (no `--force`;
   if git refuses, report — never force), `osascript … delete login item "<name>"` only for
   items whose path is `missing value`. **No command ever takes a user-typed string.**
5. **No sudo in Phase 2 except one action**: `thin-snapshots` works without sudo; everything
   that needs root (`/usr/local` Node removal, macOS install, DisplayLink install) stays
   `manual` with exact steps. `runElevated` is **not** used in Phase 2 v1. (Future: a
   `node-pkg-remove` action through `runElevated` with the fixed path list — spec it then.)
6. **Kill-switch** `PD_NO_ACTIONS=1` → every action endpoint returns `403 {note:'actions
   disabled (PD_NO_ACTIONS=1)'}`; the UI hides action buttons when `GET /api/health/actions`
   says `enabled:false`. The bundled app sets nothing; the CLI defaults to dry-run.
7. **Audit log** `PD_DATA_DIR/actions.jsonl` (append-only, like history): `{at, actionId,
   method, paths, bytesPlanned, bytesFreed, result:'ok'|'partial'|'failed', note}`. `GET
   /api/health/actions/log` returns the last 100. The Health section shows **"Cleaned this
   month: 190 GB"** from it, and `buildHealthMarkdown` fills "Clean-ups executed" from it.
8. **Re-measure after acting**: run `df -k` before/after and the target's `du -sk` after;
   when `df` moved less than 50 % of `bytesPlanned` and local snapshots ≥ 1, append the note
   "space is held by local Time Machine snapshots — run Thin snapshots" and surface the
   `thin-snapshots` action inline. This is the 2026-10-03 gotcha, made impossible to miss.
9. **Open-file guard** for `ask`-class disk images (`*.img`, `*.raw`, `*.qcow2`, `*.pvm`,
   `vm_bundles`): `lsof -- <path>` (bounded 10 s); any holder → refuse with the holder's name.
10. The UI never pre-selects anything. `regenerates`/`orphan` rows have a checkbox; `ask`
    rows need a second explicit toggle ("I understand what this removes"); `keep` and
    `manual` rows have no checkbox. Every execution shows the dry-run plan first, in a modal
    with the total and the method ("to Trash" / "command"), then **one** confirm click.

## Action registry (`src/health/actions.ts`)

```ts
export type ActionMethod = 'trash' | 'command' | 'login-item' | 'manual';
export interface CleanupAction {
  id: string; title: string; method: ActionMethod;
  acceptsFindings: string[];           // finding ids whose paths it may act on
  command?: () => string;              // fixed, regex-asserted
  roots: string[];                     // ALLOWED_ROOTS subset
  explain: string;                     // one sentence shown in the dry-run modal
}
export function planAction(a, finding paths, report): Promise<ActionPlan>;   // dry run, PURE except du
export function executeAction(plan, confirm): Promise<ActionResult>;         // checks token, acts, audits, re-measures
```
Initial actions: `trash-paths` (generic, for every `regenerates`/`orphan`/`ask` finding),
`brew-cleanup`, `simctl-delete-unavailable`, `thin-snapshots`, `npm-cache-clean`,
`git-worktree-remove`, `remove-dangling-login-item`, `empty-trash`.

## Endpoints / UI / CLI

- `GET /api/health/actions` → `{ enabled, actions:[{id,title,method,explain}] }`.
- `POST /api/health/action/:id` (dry run / execute as above). `GET /api/health/actions/log`.
- UI: action column + checkboxes in the Reclaimable table, a sticky footer "Clean selected
  (N items · X GB)" → dry-run modal → execute → per-row result + re-measure note; a "Manual
  steps" card lists `manual` findings with copy buttons.
- CLI: `pdetective clean --list`, `pdetective clean <actionId> [--path …] [--apply]`;
  without `--apply` prints the plan and the confirm token; `--apply` requires `--confirm <tok>`.

## Tests (Phase 2)

- Token: same inputs → same token; any path or byte change → different; execute with wrong
  token → `409` (route test with an injected store).
- `resolveTargets`: a path outside roots → refused; a symlink inside a root pointing outside →
  refused; `..` segments → refused.
- Every `command()` matches its regex; a mutation test: changing one character fails the assert.
- AppleScript escaping: a path with `"` and `\` round-trips.
- Audit log: a failed Finder delete writes `result:'failed'` and never throws.
- Smoke (safe): with `PD_DATA_DIR=/tmp/pd-smoke` and `PD_HEALTH_EXTRA_ROOT=/tmp/pd-smoke/root`,
  create `root/junk/` with a 10 MB file, make the `user-caches`-style finding point at it,
  dry-run → execute → assert the folder is gone from `root/` and present in `~/.Trash`
  (then remove it from the Trash by the test's own path). `PD_NO_ACTIONS=1` → `403`.

## Acceptance criteria (Phase 2)

1. Typecheck/build/tests green; Phase 1 tests unchanged.
2. `grep -rn "rm -rf\|rmSync\|fs.rm(" src/health` → nothing. `grep -rn "runElevated" src/health`
   → nothing (v1).
3. The safe smoke above passes against a live server; the audit log has one `ok` line.
4. In the UI, no action button is visible with `PD_NO_ACTIONS=1`.
5. Reap servers; **do NOT deploy**; stop and report.

---

## Constraints & non-goals (both phases)

- No new dependencies. ESM `.js` imports. Strict TS. Match the collector/parser/fixture
  pattern. Never throw from a check or an action; degrade to `skipped`/`failed` + note.
- Never `pgrep -f`, never `du -sg`, never unbounded `find /`. Every subprocess has a timeout.
- Health work never runs on the 2 s poll and never while the section is hidden.
- Nothing installs updates, removes `/usr/local` binaries, edits launchd plists, unregisters
  CI agents, or touches Parallels VMs, OrbStack/Docker disks or Claude VM bundles **without**
  the `ask` toggle + dry-run + confirm — and the first three stay `manual` outright.
- Out of scope: a privileged helper, scheduling/periodic scans, notifications, remote Macs,
  `brew upgrade` (changes toolchains; manual).
- Update `README.md`: a **Health** section (what it checks, the verdict rule, the snapshot
  gotcha) and the reworded read-only principle. Add `docs/health-checks.md` listing every check
  id with its command and what triggers it — the durable reference.

## Deliverables to report

Files created/modified; outputs of typecheck/build/tests (counts before/after); the smoke
command outputs; the generated `.md` from `--full`; every deviation from this spec with the
reason; follow-ups (checks that proved too slow, catalog entries that need an owner map, etc.).
