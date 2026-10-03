# Spec — Docker/OrbStack container awareness

When the inspected process is the OrbStack/Docker runtime helper, the tool sees
"vmgr at 500% CPU + hundreds of loopback ports" but can't see *into* the runtime —
so an AI has to guess and tell the user to run `docker stats`. Fix that: surface the
container picture directly (count, per-image breakdown, churn, Testcontainers
detection, and on-demand per-container CPU), baked into the report/prompt and a
detail-panel card. Real case it must explain: *"38 containers, 20 created in 2 min,
postgres:17-alpine ×17 — a Testcontainers storm from a `dotnet stryker` run."*

All **read-only** (`docker ps` / `docker stats` only — never stop/rm), **no sudo**
(the docker CLI is user-accessible via OrbStack/Docker Desktop).

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TS ESM (`"module":"NodeNext"` → **relative imports use `.js`**), strict,
  **no new deps** (`node:` builtins + shell via `run()` in `src/util/exec.ts`).
- Read first:
  - `src/enrich/sysprocess.ts` — `sysProcessHint(name)` + `SysProcessHint`
    (`src/types.ts`); you'll add container-runtime entries with a new
    `isContainerRuntime?: true` flag.
  - `src/service.ts` — `enrich()` (where to conditionally attach the docker snapshot).
  - `src/collect/sample.ts` / `src/collect/powermetrics.ts` — pattern for a collector
    with a PURE parser + an async runner.
  - `src/report/report.ts`, `src/report/prompt.ts` — add a "Containers" section.
  - `src/server/payload.ts` (`inspectPayload`), `src/server/server.ts` (routes),
    `src/server/page.html` (detail panel; the per-app-power card in `rEnergy` is a good
    pattern for the on-demand button + result rendering).
- **Docker is available without sudo** — you (the agent) can and SHOULD run
  `docker ps`/`docker stats` to build fixtures and validate live.
- Verify: `npx tsc --noEmit`, `npm run build`, `npm test` (129 tests currently green).

## Data model (`src/types.ts`)

```ts
export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  status: string;                 // raw "Up Less than a second" / "Up 4 seconds"
  runningForSec: number | null;   // parsed age in seconds (null if unknown)
  testcontainers: boolean;        // has an org.testcontainers* label
}
export interface DockerSnapshot {
  available: boolean;
  dockerPath: string | null;
  totalRunning: number;
  byImage: { image: string; count: number }[];   // desc by count, ≤10
  recentlyStarted: number;        // containers with runningForSec <= 30 (churn signal)
  testcontainers: number;         // count with an org.testcontainers label
  note: string | null;
}
export interface ContainerCpu { name: string; cpuPct: number; memUsage: string; pids: number; }
export interface DockerStatsSnapshot { available: boolean; topByCpu: ContainerCpu[]; note: string | null; }
```
Add `docker?: DockerSnapshot` to `Enrichment`.

## Collector (`src/collect/docker.ts`)

```ts
export function findDocker(): string | null;          // PURE-ish (fs check)
export function parseDockerPs(stdout: string): DockerSnapshot;      // PURE, tested
export function parseDockerStats(stdout: string): DockerStatsSnapshot; // PURE, tested
export function parseRunningFor(s: string): number | null;         // PURE, tested
export async function dockerPs(): Promise<DockerSnapshot>;         // fast (~100-300ms)
export async function dockerStats(): Promise<DockerStatsSnapshot>; // ~1-2s, on-demand only
```

- `findDocker()`: first `command -v docker` (via `run('command',['-v','docker'])` or
  check `process.env.PATH`), then fall back to these absolute paths, returning the
  first executable one: `~/.orbstack/bin/docker`, `/usr/local/bin/docker`,
  `/opt/homebrew/bin/docker`, `/Applications/Docker.app/Contents/Resources/bin/docker`.
  Return null if none found.
- `dockerPs()`: if no docker → `{available:false, …, note:'docker CLI not found'}`.
  Else `run(docker, ['ps','--format','{{json .}}'], 5000)`. If it fails (daemon not
  running) → `available:false` with the trimmed error as note. Else `parseDockerPs`.
- `parseDockerPs(stdout)`: each non-empty line is a JSON object (NDJSON). Fields used:
  `ID`, `Names`, `Image`, `Status`, `RunningFor`, `Labels`. For each:
  - `runningForSec` = `parseRunningFor(RunningFor || Status)`.
  - `testcontainers` = `Labels` includes `org.testcontainers`.
  - Build `byImage` (group by `Image`, count, sort desc, ≤10), `recentlyStarted`
    (count of `runningForSec != null && runningForSec <= 30`), `testcontainers` total,
    `totalRunning` = parsed line count. Tolerate malformed lines (skip).
  Real `docker ps --format '{{json .}}'` line (for the fixture):
  ```json
  {"ID":"ce9f7a003f0c","Image":"postgres:17-alpine","Names":"hardcore_galois","Status":"Up Less than a second","RunningFor":"1 second ago","State":"running","Labels":"org.testcontainers=true,org.testcontainers.session-id=e60fa6…"}
  ```
- `parseRunningFor(s)`: best-effort → seconds. Handle: `"Less than a second"`→0,
  `"N second(s) ago"`/`"Up N seconds"`→N, `"About a minute"`/`"Up About a minute"`→60,
  `"N minute(s)"`→N*60, `"About an hour"`→3600, `"N hour(s)"`→N*3600, `"N day(s)"`→N*86400.
  Strip a leading `"Up "`. Return null if nothing matches.
- `dockerStats()`: `run(docker, ['stats','--no-stream','--format','{{json .}}'], 8000)`.
  `parseDockerStats`: NDJSON lines with `Name`, `CPUPerc` (`"13.12%"`→13.12),
  `MemUsage` (`"21.05MiB / 15.66GiB"`), `PIDs` (`"7"`→7). Sort by cpuPct desc, ≤12.
  Real line:
  ```json
  {"CPUPerc":"13.12%","ID":"ce9f7a003f0c","MemPerc":"0.13%","MemUsage":"21.05MiB / 15.66GiB","Name":"hardcore_galois","PIDs":"7"}
  ```

## System-process hint (`src/enrich/sysprocess.ts`)

Add a tolerant container-runtime match (the inspected `name` is the comm basename,
e.g. `"OrbStack Helper"`). For names matching (case-insensitive) `orbstack`, `vmgr`,
`com.docker`, `dockerd`, `docker` (the desktop helper), or `colima`, return a hint
with `isContainerRuntime: true`, e.g. label `"Container runtime (OrbStack/Docker)"`,
`what: "Runs Linux VMs/containers and brokers their networking. High CPU here is
almost always a busy or rapidly-churning container, not the helper itself."`,
`lookWhere: "see Containers below — docker ps / docker stats name the culprit"`.

## Enrichment (`src/service.ts`)

In `enrich(node)`: after computing `sysHint`, if `sysHint?.isContainerRuntime`, run
`dockerPs()` and attach as `enr.docker`. (Only for the runtime process — do NOT run
docker for every inspected process.) `dockerPs` is fast enough for the inspect path;
**`dockerStats` must NOT run here** (it's the ~2s one — on-demand endpoint only).

## Report + prompt

- `report.ts`: when `enr.docker?.available`, add a section:
  ```
  Containers (OrbStack/Docker):
    total running: 38
    by image: postgres:17-alpine ×17, testcontainers/ryuk:0.9.0 ×20, …
    recently started (<30s): 20   ← churn
    Testcontainers-managed: 37
  ```
  When `recentlyStarted` is high (e.g. ≥ 5) and many are Testcontainers, append a line:
  `→ High container churn — likely a test/CI run spinning up a container per test.`
- `prompt.ts` `QUESTIONS`: add an item — "If container info is included, say whether a
  container storm / churn is the cause, which image dominates, and (for Testcontainers)
  that a test or mutation run is the likely driver."

## Endpoint (`src/server/server.ts`)

`POST /api/docker` → `dockerStats()` (system-wide; on-demand because of the ~2s cost).
Returns `DockerStatsSnapshot`. (The fast `dockerPs` snapshot already rides on
`/api/inspect` for the runtime process via `enr.docker`.)

## UI (`src/server/page.html`)

In the **process detail** view, when the inspected process has `detail.docker`
(i.e. it's the runtime), render a **"Containers"** card: total running, the
per-image breakdown (top images with counts), a **churn** line (recently-started),
a Testcontainers count, and a **"⚙ Per-container CPU (docker stats)"** button →
`POST /api/docker` → render the `topByCpu` list (name · CPU% · mem). Graceful note
when `available:false`. Don't run docker stats automatically (cost). Keep all
existing detail behavior.

## Tests (`test/docker.test.ts` + fixtures)

- Build `test/fixtures/docker-ps.jsonl` and `test/fixtures/docker-stats.jsonl` from
  REAL output (run `docker ps --format '{{json .}}'` / `docker stats --no-stream
  --format '{{json .}}'`). Include a mix: several `postgres:17-alpine` + several
  `testcontainers/ryuk` + one non-testcontainers container.
- `parseDockerPs(fixture)`: totalRunning correct; byImage grouped+sorted; recentlyStarted
  counts "Up Less than a second"/"Up N seconds" rows; testcontainers counts the labelled rows.
- `parseDockerStats(fixture)`: topByCpu sorted desc; CPUPerc/PIDs parsed.
- `parseRunningFor`: the unit cases above (seconds/minutes/hours/days/less-than-a-second/null).
- Empty/garbage input → `available:false`-style result, no throw.
- Keep all existing tests green.

## Acceptance criteria (run, capture, report)

1. `npx tsc --noEmit` clean; `npm run build` ok; `npm test` all green incl new tests.
2. `node dist/index.js serve --no-open --no-history --port 7960`, then (docker is up):
   - Find the OrbStack helper PID (`pgrep -f "OrbStack Helper" | head -1`).
   - `curl -s http://127.0.0.1:7960/api/inspect/<that-pid>` → has `docker` with
     `available:true`, `totalRunning>0`, `byImage`, `recentlyStarted`; the `report`
     contains a "Containers" section.
   - `curl -s -X POST http://127.0.0.1:7960/api/docker` → `topByCpu` populated.
   - `curl -s http://127.0.0.1:7960/api/inspect/1` (launchd) → **no** `docker` field
     (only attached for container-runtime processes).
   - page contains "Containers" and "Per-container CPU".
   - If docker happens to be down at test time, note it and rely on the fixture tests
     (parsers must still pass).
3. **Reap every server you start** (`kill`, verify; SIGKILL if it survives). No orphans.

## Constraints & non-goals

- **Read-only**: only `docker ps` / `docker stats`. Do NOT add stop/kill/rm or any
  container mutation. Degrade gracefully when docker is missing or the daemon is down.
- `dockerStats` (~2s) is on-demand only — never on `/api/inspect` or any polled path.
- Only run `dockerPs` for container-runtime processes (gated by `isContainerRuntime`).
- ESM `.js` imports, strict TS, no new deps, match existing layout.
- **Do NOT deploy** and do not ssh anywhere. Implement, verify locally, update
  `README.md` briefly, then STOP and report.
- Out of scope (future): docker logs, per-container drill-down, non-docker runtimes
  beyond what the `docker` CLI covers, stopping containers from the UI.

## Deliverables to report

Files created/modified; outputs of typecheck/build/tests and the smoke commands;
whether docker was live during the smoke; deviations with rationale; confirmation of
no orphan processes; and the follow-up (`npm run deploy -- --remote=waldomacmini1`).
