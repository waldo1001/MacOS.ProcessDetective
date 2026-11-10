# Battery history on the Energy tab — spec

Status: ready to build. Author: spec session (Opus). Builder: background Sonnet agent.

## 1. Why

The user's MacBook ran from 100 % to 1 % in under two hours and Process Detective could not say
why: its persisted history holds only system-wide CPU/mem/net/disk, and only while the app runs.
macOS itself keeps the answer. The powerlog database
`/var/db/powerlog/Library/BatteryLife/CurrentPowerlog.PLSQL` is **world-readable** (no sudo) and
holds, per minute, the battery level and power draw, and, per ~40 s interval, the energy every app
("coalition") used. `pmset -g log` holds the sleep/wake history. This feature reads both, after the
fact, and shows them on the existing **Energy** tab: "my laptop died — which app drained it?"

## 2. Orientation (read these first)

- Stack: TypeScript, ESM (**`.js` extensions in relative imports**), strict TS, Node 24 (`.nvmrc`;
  run `source ~/.nvm/nvm.sh && nvm use` first), vitest. **No new dependencies** — use the macOS
  `/usr/bin/sqlite3` CLI (supports `-json`) and `node:zlib` / `node:fs`.
- `src/util/exec.ts` — `run(cmd, args, timeoutMs)` never throws; all external commands go through it.
- `src/collect/powermetrics.ts`, `src/collect/crashes.ts` — collector style: pure parse functions
  exported and unit-tested, a thin async function that runs the command.
- `src/server/server.ts` — route table; add the new GET routes next to `/api/history`.
- `src/server/guard.ts` — GET routes need nothing extra; do not weaken any rule.
- `src/server/page.html` — single-page app. `rEnergy()` (~line 563) renders the Energy tab; event
  binding for the tab is in the `if(route.section==="energy")` block (~line 1108). Helpers:
  `esc`, `fetchJSON`, `timeline`/`pathFor` (index-based x — **not suitable** here, see §6),
  CSS vars `--calm --warn --crit --acc --mut --bg`, classes `card ctitle note row nm val rsub bar tile btn`.
- `test/*.test.ts`, `test/fixtures/` — test style. Use the project **`tdd` skill**
  (`.claude/skills/tdd/SKILL.md`): Red → Green → Mutate, sanitized fixtures, no dependence on this
  Mac (`$HOME`, running processes, real powerlog, wall clock).
- `CLAUDE.md` rules: probes read-only and side-effect free; tests pass on a clean CI runner.

## 3. Data sources (verified on macOS 26, Mac17,7)

All powerlog `timestamp` columns are **Unix epoch seconds (UTC, fractional)**.

### 3.1 Files
- Current DB: `<dir>/CurrentPowerlog.PLSQL` plus `-wal` and `-shm` siblings (WAL mode; recent rows
  live in the WAL). Covers roughly the last 1–2 days.
- Archives: `<dir>/Archives/powerlog_YYYY-MM-DD_<hex>.PLSQL.gz` — one gzipped SQLite DB per day,
  ~5 days kept, ~3–5 MB gz each. Immutable once written.
- `<dir>` defaults to `/var/db/powerlog/Library/BatteryLife`; override with env `PD_POWERLOG_DIR`
  (tests and smoke tests use this).

**Never open the originals with sqlite3.** Copy the current DB + `-wal` + `-shm` (whichever exist)
into a fresh `mkdtemp(os.tmpdir()/pd-powerlog-)` dir, and gunzip archives into such a dir, then
query the copy. Always `rm -rf` the temp dir in a `finally`. If a query on the current copy fails
with an SQLite error (copy raced a checkpoint), re-copy and retry **once**.

### 3.2 Tables and columns used
Check columns with `pragma table_info(<table>)` and select only those that exist (others → null);
a missing table → that part is empty, not an error.

`PLBatteryAgent_EventBackward_Battery` (~1 row/min while awake):
`timestamp`, `Level` (0–100 %), `ExternalConnected` (1 = on AC), `IsCharging`,
`SystemPower` (watts, float; may be null/0), `InstantAmperage` (mA, negative when discharging),
`Voltage` (mV), `AppleRawCurrentCapacity` (mAh).

`PLCoalitionAgent_EventInterval_CoalitionInterval` (one row per app per ~40 s interval):
`timestamp`, `BundleId` (may be null/empty), `LaunchdName`, `energy` (**nanojoules**, inferred:
cross-checked — the morning drain attributed 22.8 Wh to apps against ~60 Wh drained from the
battery; the remainder is display/SoC idle/radios, which macOS does not attribute),
`cpu_time` (seconds), `gpu_energy_nj` (nJ), `interrupt_wakeups` (count).
Aggregate in SQL, never pull raw rows:
```sql
select cast(timestamp/900 as int)*900 as b, coalesce(BundleId,'') as bid, coalesce(LaunchdName,'') as ln,
       sum(energy) as e, sum(cpu_time) as cpu, sum(gpu_energy_nj) as gpu, sum(interrupt_wakeups) as wk
from PLCoalitionAgent_EventInterval_CoalitionInterval group by 1,2,3;
```
(~7 k rows per 1.5 days — small.)

`PLBatteryAgent_EventPoint_BatteryShutdown` (optional): `BatteryShutdownTimestamp` → a
"battery ran empty" event.

### 3.3 `pmset -g log`
`/usr/bin/pmset -g log` (~3 s, ~55 k lines, ~7 days). Only these lines matter (column 4 is the
event type, padded with spaces, then a TAB, then the message):
```
2026-11-10 07:33:25 +0100 Sleep               	Entering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:100%) 494 secs
2026-11-10 07:41:39 +0100 DarkWake            	DarkWake from Deep Idle [CDNP] : due to smc.sysState.Wake(0x70070000) wifibt SMC.OutboxNotEmpty centauri-alpha E_CONNECTION_LOSS ARPT/ Using BATT (Charge:100%) 45 secs
2026-11-10 08:51:22 +0100 Wake                	DarkWake to FullWake from Deep Idle [CDNVA] : due to UserActivity Assertion Using BATT (Charge:100%)
2026-11-10 10:42:50 +0100 Sleep               	Entering Sleep state due to 'Low Power Sleep':TCPKeepAlive=inactive Using Batt (Charge:1%) 47 secs
```
Ignore every other type (`Assertions`, `Wake Requests`, `Kernel Client Acks`, …). Parse the time
as an explicit offset (`2026-11-10T07:33:25+01:00`) — never `new Date("2026-11-10 07:33:25")`.

## 4. Module: `src/collect/powerlog.ts`

Exported **pure** functions (all unit-tested, no I/O, no clock):

```ts
export interface BatterySample { t: number /*ms*/; level: number; onBattery: boolean;
  charging: boolean; watts: number | null; rawCapMah: number | null; voltageMv: number | null; }

export type PowerEventKind = 'sleep' | 'wake' | 'darkwake' | 'low-power-sleep' | 'battery-empty';
export interface PowerEvent { t: number; kind: PowerEventKind; reason: string;
  onBattery: boolean | null; chargePct: number | null; }

export interface AppBucketRow { b: number /*bucket start, s*/; bid: string; ln: string;
  e: number /*nJ*/; cpu: number; gpu: number; wk: number; }

export interface DischargeSession { id: string /*String(start)*/; start: number; end: number;
  startLevel: number; endLevel: number; durationMin: number; drainPctPerHour: number;
  avgWatts: number | null; peakWatts: number | null; drainedWh: number | null;
  endedBy: 'ac' | 'empty' | 'ongoing' | 'data-end';
  asleepMin: number | null; darkWakes: number; topDarkWakeReasons: { reason: string; count: number }[]; }

export interface AppEnergy { key: string; name: string; energyWh: number; sharePct: number;
  cpuSec: number; gpuWh: number; wakeups: number; }
```

- `toBatterySamples(rows)` — rows from the battery query → `BatterySample[]` sorted by `t`.
  `watts` = `SystemPower` if > 0, else `abs(InstantAmperage) * Voltage / 1e6` when both present and
  on battery, else null. Drop rows with null `Level`.
- `parsePmsetLog(text)` → `PowerEvent[]` per §3.3. `Sleep` with reason `Low Power Sleep` →
  `low-power-sleep`; other `Sleep` → `sleep`; `Wake` → `wake`; `DarkWake` → `darkwake`.
  `reason`: sleep → text inside `due to '…'`; (dark)wake → text after `due to ` up to ` Using`,
  trimmed, max 120 chars. `onBattery` from `Using Batt`/`Using BATT` vs `Using AC`; `chargePct`
  from `Charge:N%`.
- `detectSessions(samples, events, now)` → `DischargeSession[]` **newest first**.
  A session is a maximal run of consecutive samples with `onBattery === true`. Keep it only if
  `durationMin >= 10` **or** `startLevel - endLevel >= 3`.
  `end` = last on-battery sample. `drainPctPerHour` = level drop / hours (0 if duration 0).
  `avgWatts`/`peakWatts` over non-null `watts`. `drainedWh` = `(firstRawCap - lastRawCap) *
  meanVoltageMv / 1e6`, null if either is missing.
  `endedBy`: `'ac'` if a later sample exists and is on AC; else `'empty'` if a `battery-empty` or
  `low-power-sleep` event lies within [end − 10 min, end + 10 min] or `endLevel <= 2`; else
  `'ongoing'` if `now - end < 5 min`; else `'data-end'`. (Check `'empty'` before `'ac'` when the
  low-power-sleep event precedes the AC sample — the user's case: Low Power Sleep at 10:42:50,
  plugged in at 10:43:38. Result must be `'empty'`.)
  `asleepMin`: sum of the time between each `sleep`/`low-power-sleep` event in the session and the
  next `wake` (dark wakes do not end sleep), clipped to the session; null when there are no events
  for the period. `darkWakes`: count of `darkwake` events in [start, end];
  `topDarkWakeReasons`: top 3 by count, reason normalised by dropping hex `(0x…)`.
- `appKey(bid, ln)` → `key`. Key = `bid` if non-empty, else `ln` normalised: strip a
  leading `application.`, strip a trailing `.<digits>.<digits>` instance suffix, strip a trailing
  `.<UUID-like>` (`[0-9A-F-]{20,}`) suffix.
- **Recognisable names are a core requirement** (user feedback): the ranking must read like
  "Claunes Agents · 76 %", "Gatekeeper malware scanning · 16 %", "WindowServer (draws the screen)
  · 1.4 %" — never a bare bundle id when a name is knowable. `appLabel(key, names)` →
  `{ name: string; description: string | null }`, resolved in this order:
  1. **Curated map** `SYSTEM_LABELS` (~30 entries, name + plain-English description of what it is
     and why it uses energy) for system/daemon keys that have no app name, e.g.
     `com.apple.security.syspolicy` → `Gatekeeper malware scanning` / "checks programs the first
     time they run — spikes when many new binaries are built or downloaded";
     `com.apple.WindowServer` → `WindowServer` / "draws the screen";
     `com.apple.kernel_task` → `macOS kernel`; `com.apple.Spotlight` → `Spotlight indexing`;
     `com.apple.mds`/`mds_stores` → Spotlight; `com.apple.backupd` → `Time Machine`;
     `com.apple.photoanalysisd` → `Photos analysis`; `com.apple.cloudd`/`bird` → `iCloud sync`;
     `com.apple.fseventsd` → `File change tracking`; `com.apple.XprotectFramework.AnalysisService`
     → `XProtect malware scanning`; `com.microsoft.VSCode` → `Visual Studio Code`; plus other
     common Apple daemons you find in the real data's top 40. Descriptions ≤ 80 chars.
  2. **Powerlog app info** (`names` map built in `loadPowerlog`, from every DB read):
     `PLApplicationAgent_EventNone_AppInfo` columns `BundleID`, `LSDisplayName`, `CFDisplayName`,
     `Name` → first non-empty of LSDisplayName, CFDisplayName, Name (latest row per BundleID).
     Verified: `be.waldo.claunes.agents` → "Claunes Agents", `dev.kdrag0n.MacVirt` → "OrbStack",
     `com.microsoft.teams2` → "Microsoft Teams" (119 bundle ids in one DB).
  3. **Powerlog process names**: `PLProcessMonitorAgent_EventInterval_ProcessMonitorInterval_Dynamic`
     `BundleID` → most frequent `ProcessName` (fallback only; e.g. Teams appears as "MSTeams").
  4. Last resort: a prettified key — last dotted segment of the id, with `-`/`_` → space
     (`com.example.foo-bar` → `foo bar`). Never return an empty name.
  The key is still sent (`AppEnergy.key`) and shown small/grey under the name; `AppEnergy` gains
  `description: string | null`, shown in the UI as the row's `rsub` / title tooltip.
  `loadPowerlog` returns `names: Record<string,string>` (merged, current DB wins) and the
  `/api/battery/apps` handler resolves labels server-side.
- `rankApps(rows, fromS, toS, topN = 25)` → `{ attributedWh, apps: AppEnergy[] }`: rows with
  `fromS <= b < toS`, grouped by `appKey`, sorted by energy desc, the rest summed into one
  `{ key: 'other', name: 'Other (n apps)' }` entry. `energyWh = e / 3.6e12`;
  `gpuWh = gpu / 3.6e12`. `sharePct` relative to `attributedWh`.
- `bucketApps(rows, fromS, toS, topKeys)` → `{ t /*ms*/, totalWh, byApp: Record<key, Wh> }[]` per
  15-min bucket, every bucket in range present (zero-filled), apps outside `topKeys` under `other`.
- `downsample(samples, max = 720)` — keep the first and last sample and every sample where
  `onBattery` flips; fill the rest by uniform stride.

I/O functions (thin, not unit-tested beyond the integration test in §7):
- `loadPowerlog(opts: { dir?: string; now?: number; pmsetText?: string })` →
  `{ samples, events, appRows, coverage }`. Reads the current DB (via the temp copy) and every
  archive; merges samples (dedupe by `t`) and app rows (sum duplicates of the same `b,bid,ln`);
  adds `battery-empty` events from the shutdown table; runs `pmset -g log` unless `pmsetText` is
  given. sqlite3 calls: `run('/usr/bin/sqlite3', ['-json', copyPath, sql], 20_000)`; empty stdout
  → `[]`.
- Caching (module level): archive results cached forever keyed by archive file name (immutable);
  current-DB + pmset results cached for 60 s. Concurrent callers share one in-flight promise.

## 5. Endpoints (`src/server/server.ts`)

`GET /api/battery` →
```ts
{ available: boolean; note?: string; hasBattery: boolean;
  coverage: { from: number; to: number } | null;       // ms
  samples: BatterySample[];                            // downsampled ≤ 720
  sessions: DischargeSession[];                        // newest first
  events: PowerEvent[]; }                              // excluding 'darkwake' (counted per session)
```
- powerlog dir missing/unreadable → `{ available:false, note:'macOS power log not readable at <dir>', … }`.
- No battery samples (desktop Mac) → `available:true, hasBattery:false`, sessions `[]`; the app
  ranking still works for the "last 24 h" window (§6).

`GET /api/battery/apps?from=<ms>&to=<ms>` →
`{ from, to, bucketSec: 900, attributedWh, apps: AppEnergy[], buckets: … }` (top 5 keys in buckets).
400 on missing/non-numeric/inverted params or a range > 8 days.

Both: read-only, never throw out of the handler (500 with `{error}` on a bug).

## 6. UI (`src/server/page.html`, inside `rEnergy()`)

Insert a new card **after the three tiles**, before "TOTAL ENERGY IMPACT":

**`BATTERY HISTORY`** `<span class="note">macOS power log · read-only · no admin</span>`

- Loaded on entering the Energy tab (once; a `↻` button reloads). Not polled. State in
  `state.battery` (`{loading, data, error, sel, apps}`). Show "Reading the macOS power log…" while
  loading; the note text when `available:false`.
- **Charge chart** (new helper `timeChart(samples, opts)` — x by **time**, not index): level % line
  (0–100), watts as a thin second line scaled to its own max (label the max, e.g. "peak 96 W"),
  on-battery spans shaded lightly, a gap where samples are > 30 min apart. Event ticks along the
  bottom: `sleep` grey, `low-power-sleep`/`battery-empty` `--crit`. Hour/day labels on the x-axis.
  Clicking inside a shaded span selects that session.
- **Session list** (newest first): one `row` each:
  `Tue 08:52 → 10:42 · 100 % → 1 % · 1 h 50 m · 54 %/h · avg 32 W · ran empty`.
  `drainPctPerHour > 25` → `--crit`, `> 12` → `--warn`, else `--calm`. `endedBy` labels:
  ac → "plugged in", empty → "ran empty", ongoing → "on battery now", data-end → "end of log".
  When asleep data exists add "asleep 12 m · 47 dark wakes". Plus a final entry **"Last 24 hours"**
  (always present; the only one on a desktop Mac). Default selection: the newest session, else
  "Last 24 hours".
- **Selected window panel** (fetched from `/api/battery/apps`):
  - Line: `Apps used <attributedWh> Wh of <drainedWh> Wh drained — the rest is display, chip idle
    and radios, which macOS does not attribute per app.` (omit the "of …" part when `drainedWh` is null).
  - Ranking: top 12 apps as bar rows: name (+ key in `rsub` when different), share %, Wh,
    CPU time (`cpuSec`, formatted m/h), wakeups (k/M). Bar width = share.
  - **Over time**: stacked bars per 15-min bucket for the top 5 apps + other (colors: `--warn`,
    `--acc`, `--calm`, `--crit`, a 5th distinct var or `#a78bfa`, other `--mut`), with a legend.
    Hover title on a bar: bucket time + per-app Wh.
  - If a session's `topDarkWakeReasons` is non-empty: a small "Dark wakes while asleep" list.
- All text through `esc()`. No external resources. Must render in both light and dark themes
  (use the CSS vars only).

## 7. Tests (vitest, follow the `tdd` skill)

New `test/powerlog.test.ts` + fixtures under `test/fixtures/powerlog/` (**sanitized**: bundle ids
like `com.example.agents`, `com.example.browser`; no real user/host names):

1. `parsePmsetLog` on `test/fixtures/powerlog/pmset-log.txt` (a ~40-line sanitized excerpt with
   Sleep, DarkWake, Wake, Low Power Sleep, plus `Assertions`/`Wake Requests` noise lines): kinds,
   reasons, `chargePct`, `onBattery`, and the epoch for a `+0100` and a `-0700` line.
2. `toBatterySamples`: watts from `SystemPower`, fallback from amperage×voltage, null otherwise.
3. `detectSessions`: AC→battery→AC (`endedBy:'ac'`); the user's case — drain to 1 % with a Low
   Power Sleep event then an AC sample → `'empty'`; a 3-minute 1 % blip is dropped; trailing
   on-battery with `now` 2 min later → `'ongoing'`, 2 h later → `'data-end'`; `drainedWh` math;
   `asleepMin` and `darkWakes` from events.
4. `appKey`: bundle id wins; `application.com.apple.Terminal.1152921500311914148.1152921500311914153`
   → `com.apple.Terminal`; mdworker UUID suffix stripped.
   `appLabel`: curated map beats powerlog names; AppInfo name beats ProcessName; prettified
   fallback is never empty and never the raw dotted id. The integration fixture includes AppInfo
   and ProcessMonitor rows so `/api/battery/apps`-level output carries real names.
5. `rankApps`: nJ→Wh conversion, shares sum to 100 (±0.1), range filtering, `other` roll-up.
6. `bucketApps`: zero-filled buckets, `other` bucket.
7. `downsample`: ≤ max, first/last kept, every onBattery flip kept.
8. **Integration** (`it.skipIf(!existsSync('/usr/bin/sqlite3'))`): build a tiny powerlog in a
   `mkdtemp` dir from `test/fixtures/powerlog/fixture.sql` (CREATE TABLE subsets of the three
   tables + ~30 rows) via `/usr/bin/sqlite3 <db> < fixture.sql` (use `run` with `.read`), plus a
   gzipped copy of a second fixture DB under `Archives/powerlog_2026-01-01_ABCD.PLSQL.gz`; call
   `loadPowerlog({ dir, now, pmsetText })` and assert merged coverage, one session, the app ranking.
   Must not touch `/var/db/powerlog` or run the real `pmset`.

Existing tests stay green. Mutate step: break the `'empty'` precedence and the nJ→Wh factor and
confirm a test fails for each, then restore.

## 8. Acceptance criteria

```bash
source ~/.nvm/nvm.sh && nvm use
npm run typecheck          # clean
npm test                   # all green; count includes the new powerlog tests
npm run build              # clean; dist/server/page.html present
```
Smoke (this Mac has a readable powerlog; keep it short, kill the server afterwards):
```bash
PORT=7391; node dist/index.js serve --port $PORT & PID=$!   # check `node dist/index.js --help` for the real serve syntax
sleep 3
curl -s localhost:$PORT/api/battery | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.available,d.hasBattery,d.samples.length,d.sessions.length,d.sessions[0])'
# expect: true true ≤720 ≥1, and among the sessions one starting ~2026-11-10 08:5x local,
# 100 → 1 %, endedBy "empty"
F=$(curl -s localhost:$PORT/api/battery | node -e 'const d=JSON.parse(require("fs").readFileSync(0));const s=d.sessions.find(s=>s.endedBy==="empty")||d.sessions[0];console.log(s.start+"&to="+s.end)')
curl -s "localhost:$PORT/api/battery/apps?from=$F" | node -e 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.attributedWh.toFixed(1),d.apps.slice(0,3).map(a=>a.name+" "+a.sharePct.toFixed(0)+"%"))'
# expect for the 2026-11-10 morning session: "Claunes Agents" (the name, not the bundle id) on top
# at ~75 %, "Gatekeeper malware scanning" second at ~15 %, attributedWh ≈ 20–25; none of the top 15
# names may be a raw dotted bundle id
curl -s -o /dev/null -w '%{http_code}\n' "localhost:$PORT/api/battery/apps?from=abc&to=1"   # 400
ls /tmp | grep pd-powerlog- || echo "temp dirs cleaned"
kill $PID; sleep 1; kill -0 $PID 2>/dev/null && echo STILL RUNNING || echo stopped
```
Then open the Energy tab in a browser at that port (or render `rEnergy` output) and confirm the
card renders with the chart, the session list, and the app panel.

## 9. Constraints & non-goals

- Read-only. No sudo, no `powermetrics`, nothing written outside the temp dirs, which are removed.
- Never modify or lock the original powerlog files.
- Graceful degradation everywhere: missing dir, missing table, missing column, sqlite3 error,
  pmset failure → partial data plus a `note`, never a 500.
- No new dependencies; no change to the existing Energy tab content other than inserting the card.
- Non-goals (follow-ups): a CLI `battery` command; feeding sessions into the investigation
  prompt; Fan RPM; per-process (not per-app) energy; display brightness attribution;
  persisting anything to Process Detective's own history.

## 10. Process

**Do NOT commit, push, release or deploy. Do not ssh anywhere.** Implement, verify locally per §8,
then STOP and report: files changed, the verification outputs (typecheck, test count, build,
smoke output), deviations from this spec and why, and recommended follow-ups.
