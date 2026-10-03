# Spec: Open-file intel, owner attribution & collection status

## Why this exists (read first — it explains every decision below)

A real investigation failed because of this tool. A VS Code `Code Helper (Plugin)`
process was burning 130% CPU. Process Detective's snapshot was pasted into an AI,
and the AI confidently named the wrong culprit.

Traced to two lines:

- `src/enrich/openfiles.ts` — `isSignalPath()` gives `+2` to anything under
  `~/Library/Application Support/`. Three GitHub Copilot files
  (`session-store.db`, `-wal`, `-shm`) scored `+2` each.
- `src/report/report.ts:134` — the report prints `ranked.slice(0, 6)`.

Meanwhile the *actual* workload was **24 open `.jsonl` file descriptors** under
`~/.claude/projects/…/`, rotating every few seconds. `.jsonl` is not a data
extension and `/.claude/` is not a signal path, so every one of them scored `0`
and fell below the 6-line cut. **The AI never saw the real workload.** It reasoned
correctly from a snapshot that hid the evidence.

Three further gaps showed up in the same transcript:

- The process is named `Code Helper (Plugin)` — anonymous. The AI had to *guess*
  which extension owned it, and picked the wrong one of the two actually loaded.
- The AI had no way to tell "actively reading" from "idle" without `sudo`.
- The AI spent five of its ten answer sections asking for crash / container / log /
  fs-churn data that the report had *silently omitted*. It could not distinguish
  "not collected" from "collected — nothing found".

This spec fixes all four. **A** and **C** ride free on an `lsof` call the tool
already makes. **B** is a new on-demand endpoint. **D** is pure formatting.

---

## Orientation

- **Project root**: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- **Stack**: strict TypeScript, ESM. **All relative imports must use the `.js`
  extension** (e.g. `import { run } from '../util/exec.js'`), even for `.ts` files.
- **No new dependencies.** Node built-ins + existing helpers only.
- **Tests**: `vitest`, files in `test/*.test.ts`, fixtures in `test/fixtures/`.
- **Read these first, in this order:**
  1. `src/types.ts` — the whole data model
  2. `src/collect/lsof.ts` — where open files come from
  3. `src/enrich/openfiles.ts` — the ranking that caused the bug
  4. `src/report/report.ts` — the report builder
  5. `src/report/prompt.ts` — the AI questions
  6. `src/service.ts` — the enrichment pipeline
  7. `src/server/server.ts` (lines 95–205) — the on-demand endpoint pattern
     (`/api/log/:pid` and `/api/fschurn/:pid` are the templates to copy)
  8. `src/server/payload.ts` — what the UI receives
  9. `src/collect/fsusage.ts` — an existing collector with a pure parser + fixture
  10. `test/openfiles.test.ts` — test style to match

### Conventions that are non-negotiable

- **Every collector splits into a pure parser + a thin runner.** The parser takes
  a string of command output and returns typed data; it is unit-tested against a
  fixture. The runner calls `run()` and hands stdout to the parser. Follow
  `src/collect/fsusage.ts` exactly.
- Collectors **never throw**. They degrade to `available: false` with a `note`.
- `run(cmd, args, timeoutMs = 5000)` from `src/util/exec.ts` never throws either.

---

## Goal

Four changes, one build:

| ID | Change |
|----|--------|
| **A** | Aggregate open files into **directory hotspots** and surface them *above* the individual-file list |
| **B** | A no-sudo **read-activity delta** (two `lsof -o` snapshots) that answers "is it actually reading?" |
| **C** | **Owner attribution** — name the VS Code/Cursor extensions hosted inside a generic helper process |
| **D** | A **collection-status** block so the report distinguishes "not collected" from "collected — none found" |

---

## Part 0 — Shared refactor: one `lsof` run, three products

`src/collect/lsof.ts` currently runs `lsof -p <pid>`, drops noisy paths, and
**caps the result at 12 entries**. A and C both need the *full, uncapped* path
list. Do **not** add a second `lsof` call — derive everything from one run.

### 0.1 Extract a pure parser

In `src/collect/lsof.ts`, add and export:

```ts
/** One raw row from `lsof -p <pid>` default-format output. */
export interface LsofRow {
  fd: string;
  type: 'file' | 'dir' | 'socket';
  path: string;
}

/**
 * Parse default-format `lsof -p` stdout into typed rows.
 * Keeps EVERY row (no noise filtering, no cap) — callers filter.
 * De-duplicates on `fd:type:path`.
 */
export function parseLsofRows(stdout: string): LsofRow[]
```

Column layout (already documented in the existing code):
`COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME` — `fd` is `cols[3]`, type is
`cols[4]` uppercased, name is `cols.slice(8).join(' ').trim()`.

Type mapping (identical to today): `REG`→`file`, `DIR`→`dir`,
`IPV4`/`IPV6`/`UNIX`→`socket`, anything else → **skip the row**.
Skip blank lines and the `COMMAND` header. Skip rows with `cols.length < 9` or an
empty name.

### 0.2 Rewrite `getOpenFiles` on top of it

`getOpenFiles(pid)` must keep its **exact current behaviour and signature**
(`Promise<OpenFile[]>`, noise-filtered, cap 12, cache-entry fallback). Reimplement
its body to call `parseLsofRows()` and then apply the existing filtering rules.
Existing behaviour is load-bearing — do not change what it returns.

### 0.3 Add the combined collector

```ts
export interface OpenFileIntel {
  files: OpenFile[];              // identical to getOpenFiles() output
  hotspots: DirHotspot[];         // Part A
  owners: OwnerAttribution | null;// Part C
}

/** One `lsof -p` run → open files, directory hotspots and owner attribution. */
export async function getOpenFileIntel(pid: number, home: string): Promise<OpenFileIntel>
```

It runs `lsof -p <pid>` **once**, parses with `parseLsofRows`, then:
- `files` — existing filter+cap logic
- `hotspots` — `await computeDirHotspots(rows, home)` (Part A)
- `owners` — `attributeOwners(rows.map(r => r.path))` (Part C)

On empty stdout return `{ files: [], hotspots: [], owners: null }`.

### 0.4 Wire into `src/service.ts`

Replace the `getOpenFiles(node.proc.pid)` call in the `Promise.all` with
`getOpenFileIntel(node.proc.pid, homedir())` (import `homedir` from `node:os`),
and populate `enr.openFiles`, `enr.dirHotspots`, `enr.owners` from the result.
`dirHotspots` and `owners` are **always-on** — they cost nothing extra.

---

## Part A — Directory hotspots

### Types (add to `src/types.ts`)

```ts
/** A directory that many of a process's open file descriptors point into. */
export interface DirHotspot {
  /** Absolute directory path. */
  dir: string;
  /** Number of distinct open REG files under this directory (recursively). */
  fdCount: number;
  /** Total size on disk in KB from `du -sk`; null when unavailable or timed out. */
  sizeKb: number | null;
  /** Up to 3 example file basenames under this directory. */
  sampleFiles: string[];
  /** Dominant file extension among the open files (e.g. "jsonl"), or null. */
  dominantExt: string | null;
}
```

Add to the `Enrichment` interface:
```ts
  /** Directories that concentrate this process's open file descriptors. */
  dirHotspots?: DirHotspot[];
```

### New file: `src/enrich/dirs.ts`

```ts
/** PURE. Group file paths by ancestor directory and return the hot ones. */
export function dirHotspots(
  paths: string[],
  home: string,
  opts?: { minFiles?: number; maxHotspots?: number },
): Omit<DirHotspot, 'sizeKb'>[]
```

Defaults: `minFiles = 3`, `maxHotspots = 3`.

Algorithm — implement exactly:

1. **Filter inputs.** Drop any path where
   `classifyOpenFile(path, home) === 'noise'` (import from `./openfiles.js` —
   this reuses the existing, tested noise rules). De-duplicate paths.
2. **Count ancestors.** For each surviving path, walk from its parent directory
   upward, adding the path to a `Map<string, Set<string>>` keyed by directory.
   **Stop the walk** when the directory:
   - has fewer than **3 segments** (so `/`, `/Users`, `/private` never qualify), or
   - is exactly `home`, or
   - is one of the shallow roots `/Applications`, `/System`, `/Library`, `/usr`,
     `/opt`, `/private/var`, `/private/tmp`, `/tmp`.

   These stop conditions exclude the directory itself *and* everything above it.
3. **Candidates** = entries whose `Set.size >= minFiles`.
4. **Sort** by `Set.size` descending, then by path **depth** (segment count)
   descending, then by path ascending. Depth-descending is what makes the
   *deepest* directory win when a chain of ancestors all hold the same count —
   `~/.claude/projects/<project>` must beat `~/.claude/projects` and `~/.claude`.
5. **Collapse related branches.** Walk the sorted list, greedily accepting a
   candidate only if it is neither an ancestor nor a descendant of an
   already-accepted directory. (Prefix comparison on `dir + '/'`.) This yields at
   most one hotspot per branch of the tree.
6. **Truncate** to `maxHotspots`.
7. For each accepted directory compute:
   - `fdCount` = the set size
   - `sampleFiles` = up to 3 basenames, sorted, from that set
   - `dominantExt` = the most common extension (lowercased, no dot) among that
     set; `null` when no file in the set has an extension. Ties broken
     alphabetically for determinism.

Also in `src/enrich/dirs.ts`:

```ts
/** Runs `du -sk` for the top hotspots; returns fully-populated DirHotspots. */
export async function computeDirHotspots(
  rows: LsofRow[],
  home: string,
): Promise<DirHotspot[]>
```

- Feed it only `rows.filter(r => r.type === 'file').map(r => r.path)`.
- Call `dirHotspots(...)`.
- For **at most the first 2** hotspots, run `run('du', ['-sk', dir], 1500)`.
  Parse the leading integer from stdout → `sizeKb`. On `failed`, timeout, or an
  unparseable first token → `sizeKb: null`. Remaining hotspots get `sizeKb: null`
  without a `du` call. **This bound is deliberate** — `du` on a large tree is the
  only expensive thing in this spec.
- These two `du` calls may run concurrently (`Promise.all`).

### Ranking integration — `src/enrich/openfiles.ts`

Add an **optional third parameter** to `rankOpenFiles` (existing call sites and
tests must keep working unchanged):

```ts
export function rankOpenFiles(
  files: OpenFile[],
  home: string,
  hotspotDirs: string[] = [],
): RankedOpenFile[]
```

New scoring rule: **`+3` if `file.path` starts with `<hotspotDir>/` for any entry
in `hotspotDirs`.** Applied on top of the existing signal/noise/dir/socket scores.
`+3` is chosen so a hotspot file (`0 + 3 = 3`) outranks an unrelated signal file
(`+2`) — which is precisely the inversion that caused the misdiagnosis.

Everything else about `rankOpenFiles` (stable sort, single `notable` mark on the
highest-scoring `signal` file) is unchanged.

Update the two call sites to pass hotspot dirs:
- `src/report/report.ts` → `rankOpenFiles(enr.openFiles, homedir(), (enr.dirHotspots ?? []).map(h => h.dir))`
- `src/server/payload.ts` → same

### Report section (`src/report/report.ts`)

Emit **immediately before** the existing `Open files (notable):` block, so it is
never lost to a line cut:

```
Directory hotspots:
  24 open files under ~/.claude/projects/-Users-waldo-...-iFactoCockpit  (327.0 MB, mostly .jsonl)
    e.g. agent-a1403ebc.jsonl, agent-ae152fe9.jsonl, e4e3bc52.jsonl
  → Many descriptors concentrated in one directory tree usually IS the workload.
```

Formatting rules:
- Only emit the section when `enr.dirHotspots?.length`.
- Apply `homePath()` (already imported in `report.ts`) to the directory so it
  renders as `~/…`.
- Size clause: omit entirely when `sizeKb === null`. Otherwise render MB with one
  decimal (`(sizeKb / 1024).toFixed(1) + ' MB'`); if `sizeKb >= 1024 * 1024`, use
  GB with one decimal instead.
- `mostly .<ext>` clause only when `dominantExt !== null`.
- The `→` advisory line is emitted **once**, after the last hotspot.

---

## Part B — Read-activity delta

Answers "is this process actually reading, or are those descriptors just open?"
without `sudo`. This is the check that turned a hypothesis into proof during the
real investigation.

### Types (add to `src/types.ts`)

```ts
/** Result of two `lsof -o` snapshots taken a short interval apart. */
export interface ReadActivitySnapshot {
  available: boolean;
  /** Actual measured gap in ms between the two snapshots. */
  gapMs: number;
  fdsBefore: number;
  fdsAfter: number;
  /** Descriptors present in the second snapshot but not the first. */
  fdsAdded: number;
  /** Descriptors present in the first snapshot but not the second. */
  fdsRemoved: number;
  /** Descriptors present in both whose file offset changed. */
  offsetsAdvanced: number;
  /** Up to 3 paths of newly-appeared descriptors. */
  sampleAdded: string[];
  /** Deepest shared directory across added + advanced paths, or null. */
  commonDir: string | null;
  /** One-line plain-English conclusion. */
  verdict: string;
  note: string | null;
}
```

Add to `Enrichment`:
```ts
  /** Read-activity delta; only present when fetched on-demand via POST /api/readdelta/:pid. */
  readActivity?: ReadActivitySnapshot;
```

### New file: `src/collect/readactivity.ts`

```ts
/** PURE. Parse `lsof -o -p <pid>` stdout into fd-key → offset string. */
export function parseLsofOffsets(stdout: string): Map<string, { offset: string; path: string }>
```

With `-o`, the `SIZE/OFF` column (`cols[6]`) holds an offset like `0t12345`.
Key the map on `` `${fd}:${path}` `` (fd = `cols[3]`). Include only rows whose
type is `REG`. Skip the header, blank lines, and rows with `cols.length < 9`.

```ts
/** Take two `lsof -o` snapshots gapMs apart and diff them. */
export async function getReadActivity(pid: number, gapMs = 1500): Promise<ReadActivitySnapshot>
```

- Clamp `gapMs` into `[500, 3000]`.
- `run('lsof', ['-o', '-p', String(pid)], 5000)` → wait `gapMs` → run again.
  Record the real elapsed ms as `gapMs` in the result.
- If **either** run produces empty stdout: return `available: false` with
  `note: 'lsof returned no output (process gone or access restricted)'` and all
  counters `0`, `verdict: 'unknown'`, `commonDir: null`, `sampleAdded: []`.
- Compute `fdsAdded` / `fdsRemoved` from the key sets, and `offsetsAdvanced` as
  the count of keys in both maps whose `offset` string differs.
- `sampleAdded` = up to 3 paths from the added keys (sorted, for determinism).
- `commonDir` — longest common directory prefix across the union of added paths
  and advanced paths; `null` when that union is empty or the prefix has fewer
  than 3 segments.
- **Verdict** (first match wins):
  - `fdsAdded + fdsRemoved >= 3` →
    `'churning file handles — actively streaming through many files'`
  - `offsetsAdvanced >= 1` → `'actively reading — file offsets are advancing'`
  - `fdsAdded + fdsRemoved >= 1` → `'some file activity — a few descriptors changed'`
  - else → `'file descriptors idle over this window'`

**Read-only, no sudo, nothing spawned that outlives the call.**

### Endpoint (`src/server/server.ts`)

Add `POST /api/readdelta/:pid`, modelled **exactly** on the `/api/fschurn/:pid`
handler (lines 151–167):

```ts
const rm = url.pathname.match(/^\/api\/readdelta\/(\d+)$/);
if (rm && req.method === 'POST') { … }
```

- Query param `gap` (ms), clamped `[500, 3000]`, default `1500`.
- 404 `{ error: 'No process with PID <pid>' }` when the pid is not in the tree.
- `Promise.all([enrich(node), getReadActivity(pid, gap)])`, then
  `const enriched = { ...enr, readActivity }`, then build the payload with
  `getFdCount` + `collectProcStats` like the sibling handlers.
- Respond `{ readActivity, report: payload.report, prompt: payload.prompt, detail: payload }`.

### Report section (`src/report/report.ts`)

Emit after the fs-churn block, only when `enr.readActivity?.available`:

```
Read activity (2 lsof snapshots, 1500ms apart):
  Verdict: churning file handles — actively streaming through many files
  fds: 193 → 191   (+18 new, -20 closed, 4 offsets advanced)
  Active under: ~/.claude/projects/-Users-waldo-...-iFactoCockpit
    e.g. agent-a1403ebc.jsonl
```

Omit the `Active under:` line when `commonDir` is null; omit the `e.g.` line when
`sampleAdded` is empty. Apply `homePath()` to `commonDir`.

### UI (`src/server/page.html`)

Mirror the existing fs-churn button wiring exactly (state keys at ~line 184–187,
reset at ~line 358, button markup at ~line 743, handler at ~line 827):

- State: `readMeasuring: false`, `readResult: null`; reset both in the same place
  `fsChurnResult` is reset.
- Button `id="readDeltaBtn"`, label `📖 Read activity (3s)`, placed next to the
  filesystem-churn button, disabled while `readMeasuring`.
- Handler: `POST /api/readdelta/<pid>?gap=1500`, set `state.readResult = r.readActivity || null`,
  refresh report/prompt text from `r.report` / `r.prompt` the same way the
  fs-churn handler does, and clear `readMeasuring` in a `finally`-equivalent path.
- On a thrown request error, set a fallback object
  `{available:false, note:"Request failed", gapMs:1500, fdsBefore:0, fdsAfter:0, fdsAdded:0, fdsRemoved:0, offsetsAdvanced:0, sampleAdded:[], commonDir:null, verdict:"unknown"}`
  — matching the fs-churn error path.
- Render the result compactly under the button: verdict line + the fd counts line.

---

## Part C — Owner attribution

`Code Helper (Plugin)` tells you nothing. The files it has open tell you it hosts
`anthropic.claude-code` and the built-in `copilot` extension.

### Types (add to `src/types.ts`)

```ts
/** One extension identified as running inside a host process. */
export interface OwnerExtension {
  /** e.g. "anthropic.claude-code" or "copilot". */
  id: string;
  /** e.g. "2.1.218"; null for built-ins and when unparseable. */
  version: string | null;
  /** True when it ships inside the app bundle rather than ~/.vscode/extensions. */
  builtin: boolean;
  /** Number of distinct open paths attributed to this extension. */
  fileCount: number;
  /** True when a native .node module of this extension is loaded — strong evidence. */
  hasNativeModule: boolean;
  /** Basenames of THIS extension's own loaded native modules, sorted. */
  nativeModuleNames: string[];
}

/** What is actually running inside a generic host/helper process. */
export interface OwnerAttribution {
  /** "VS Code" | "Cursor" | null. */
  host: string | null;
  /** Sorted strongest-evidence-first. */
  extensions: OwnerExtension[];
  /** Basenames of loaded native modules, e.g. ["audio-capture.node"]. */
  nativeModules: string[];
}
```

Add to `Enrichment`:
```ts
  /** Extensions/plugins hosted inside this process; null when nothing identified. */
  owners?: OwnerAttribution | null;
```

### New file: `src/enrich/owner.ts`

```ts
/** PURE. Identify hosted extensions from a process's open file paths. */
export function attributeOwners(paths: string[]): OwnerAttribution | null
```

Recognise these path shapes (case-sensitive, matched anywhere in the path):

| Pattern | Yields |
|---|---|
| `/.vscode/extensions/<pub>.<name>-<version>/` | `id: "<pub>.<name>"`, `version`, `builtin: false`, host `VS Code` |
| `/.vscode-insiders/extensions/<pub>.<name>-<version>/` | same, host `VS Code` |
| `/.cursor/extensions/<pub>.<name>-<version>/` | same, host `Cursor` |
| `/Contents/Resources/app/extensions/<name>/` | `id: "<name>"`, `version: null`, `builtin: true` |

Version-parsing detail: extension directory names look like
`anthropic.claude-code-2.1.218-darwin-arm64` — the id is everything before the
**first** `-<digit>` sequence, and the version is the dotted numeric run that
follows (`2.1.218`; drop any platform suffix such as `-darwin-arm64`). When no
`-<digit>` run is present, the whole directory name is the id and `version` is
`null`.

Host detection: derive from which pattern matched. If both a VS Code and a Cursor
pattern match, prefer whichever has more attributed paths; break ties with
`VS Code`. `host` is `null` only when no extension was identified.

`nativeModules`: basenames of every path ending in `.node`, de-duplicated, sorted.
Set `hasNativeModule: true` on an extension when a `.node` path falls **under
that extension's directory**.

Sort `extensions`: **`builtin: false` first** (see below), then `hasNativeModule`
(true before false), then `fileCount` descending, then `id` ascending.

> **Revised during verification (2026-07-23).** The first build sorted on
> `hasNativeModule` before `builtin`, and rendered the *process-wide*
> `nativeModules` list next to every extension. Live-tested against the real
> `Code Helper (Plugin)` this produced two failures: bundled
> `microsoft-authentication` outranked the user-installed
> `anthropic.claude-code` (the actual culprit in the original incident), and all
> four extensions claimed to have loaded `audio-capture.node`. Both are exactly
> the kind of misleading evidence this section exists to remove. Fixed by adding
> per-extension `nativeModuleNames` and sorting user-installed extensions first —
> a bundled extension is present in *every* VS Code helper and is almost never
> the anomaly. Locked in by regression tests in `test/owner.test.ts`.

**Return `null`** when no extension matched — the report then omits the section
entirely. Do not invent a host from the process name.

### Report section (`src/report/report.ts`)

Emit right after the `System process:` block, when `enr.owners?.extensions.length`:

```
Hosted extensions (VS Code):
  anthropic.claude-code 2.1.218   ← native module loaded (audio-capture.node)
  copilot (built-in)
  → This is a generic helper process; the extensions above are what run inside it.
    Attribute the CPU to one of them, not to the helper's own name.
```

- `← native module loaded (…)` only on extensions with `hasNativeModule`, naming
  up to 2 module basenames.
- ` (built-in)` suffix on extensions with `builtin: true`.
- Version rendered after the id when non-null.
- The `→` advisory emitted once, after the list.

---

## Part D — Collection status

The report currently *silently omits* every optional section. An AI reading it
cannot tell "we checked and found nothing" from "we never looked", so it wastes
its answer asking for data.

### Report section (`src/report/report.ts`)

Emit **immediately before** the final `Recommendation:` block:

```
Collection status:
  open files: collected — 12 entries
  open ports: collected — none detected
  crashes: collected — none in the last hour
  hosted extensions: collected — 2 identified
  directory hotspots: collected — 1 found
  stack sample: not collected (click "Sample stack")
  read activity: not collected (click "Read activity")
  process log: not collected (click "Process log")
  filesystem churn: not collected (click "Filesystem churn (admin)")
  containers: not collected (only gathered for container-runtime processes)
  → "collected — none …" means it was checked and was genuinely empty. Do not ask for it again.
```

Status rules, per source:

| Source | Condition | Line |
|---|---|---|
| open files | `enr.openFiles.length` | `collected — N entries` / `collected — none detected` |
| open ports | `enr.ports.length` | `collected — N open` / `collected — none detected` |
| crashes | `enr.recentCrashes.length` | `collected — N group(s)` / `collected — none in the last hour` |
| hosted extensions | `enr.owners` | `collected — N identified` / `collected — none identified` |
| directory hotspots | `enr.dirHotspots` | `collected — N found` / `collected — none found` |
| stack sample | see below | button `"Sample stack"` |
| read activity | see below | button `"Read activity"` |
| process log | see below | button `"Process log"` |
| filesystem churn | see below | button `"Filesystem churn (admin)"` |
| containers | see below | `not collected (only gathered for container-runtime processes)` |

For the five **on-demand** sources (`stackSample`, `readActivity`, `logTail`,
`fsChurn`, `docker`) use this three-way rule:

- field **absent** (`undefined`/`null`) → `not collected (click "<Button>")`
  — except `containers`, which uses its own note above
- field present and `available === true` → `collected`
- field present and `available === false` → `attempted — unavailable (<note>)`,
  falling back to `attempted — unavailable` when `note` is null

The `→` advisory line is emitted once, at the end of the block.

**Implement this as a small exported pure helper** in `src/report/report.ts` so it
can be unit-tested directly:

```ts
export function collectionStatus(enr: Enrichment): string[]
```
returning the body lines (without the `Collection status:` heading and without
the trailing `→` advisory).

### Prompt updates (`src/report/prompt.ts`)

Append to `QUESTIONS`, after item 10 and before the closing
`'Never suggest force-killing…'` lines:

```
11. If "Directory hotspots" are listed, treat a directory holding many open file
   descriptors as the prime suspect for the workload — name the directory and say
   what kind of files it holds.
12. If "Hosted extensions" are listed, the process name is a generic host. Attribute
   the CPU to a specific extension and justify which one from the evidence
   (native modules loaded, files being read) — do not guess.
13. If "Read activity" is included, use it to say whether the process is actively
   streaming files or merely holding descriptors open.
14. A "Collection status" block lists what was gathered. Anything marked
   "collected — none …" was checked and was genuinely empty: do NOT ask for it
   again. Only request data marked "not collected".
```

---

## Files to create

- `src/enrich/dirs.ts`
- `src/enrich/owner.ts`
- `src/collect/readactivity.ts`
- `test/dirs.test.ts`
- `test/owner.test.ts`
- `test/readactivity.test.ts`
- `test/fixtures/lsof-codehelper.txt`
- `test/fixtures/lsof-offsets-t0.txt`
- `test/fixtures/lsof-offsets-t1.txt`

## Files to modify

- `src/types.ts` — `DirHotspot`, `ReadActivitySnapshot`, `OwnerExtension`,
  `OwnerAttribution`, plus three new optional `Enrichment` fields
- `src/collect/lsof.ts` — `LsofRow`, `parseLsofRows`, `getOpenFileIntel`,
  `getOpenFiles` reimplemented on the parser
- `src/enrich/openfiles.ts` — optional `hotspotDirs` param, `+3` scoring
- `src/service.ts` — use `getOpenFileIntel`, populate the new fields
- `src/report/report.ts` — three new sections + `collectionStatus()`, and pass
  hotspot dirs into `rankOpenFiles`
- `src/report/prompt.ts` — questions 11–14
- `src/server/payload.ts` — expose `dirHotspots`, `owners`, `readActivity`; pass
  hotspot dirs into `rankOpenFiles`
- `src/server/server.ts` — `POST /api/readdelta/:pid`
- `src/server/page.html` — Read-activity button, state, handler, render
- `test/openfiles.test.ts` — add cases for the `hotspotDirs` scoring

---

## Fixtures

### `test/fixtures/lsof-codehelper.txt`

Default-format `lsof -p` output reproducing the real failure. It must contain:

- 3 rows under `/Users/testuser/Library/Application Support/Code/User/globalStorage/github.copilot-chat/`:
  `session-store.db`, `session-store.db-wal`, `session-store.db-shm` (all `REG`)
- **at least 8** `REG` rows for distinct `.jsonl` files under
  `/Users/testuser/.claude/projects/-Users-testuser-SourceCode-Demo/` (some nested
  under `subagents/` and `subagents/workflows/wf_abc/`)
- 1 `REG` row for
  `/Users/testuser/.vscode/extensions/anthropic.claude-code-2.1.218-darwin-arm64/resources/audio-capture/arm64-darwin/audio-capture.node`
- 1 `REG` row for
  `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/node_modules/@github/copilot/sdk/prebuilds/darwin-arm64/runtime.node`
- several noise rows (`.dylib`, `/System/Library/...`, `/usr/share/...`)
- 2 `IPv4` socket rows and 1 `DIR` row
- the `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME` header

Use the real column shape, e.g.:
```
Code\x20H 75941 testuser   35u     REG               1,17    23229802 12345678 /Users/testuser/.claude/projects/-Users-testuser-SourceCode-Demo/aaa.jsonl
```

### `test/fixtures/lsof-offsets-t0.txt` / `-t1.txt`

Two `lsof -o -p` snapshots of the same process where, between t0 and t1:
- **3 descriptors are new** in t1
- **2 descriptors are gone** from t1
- **2 descriptors persist with a changed `0t…` offset**
- **at least 2 descriptors persist with an identical offset**

All added/advanced paths must sit under a shared
`/Users/testuser/.claude/projects/-Users-testuser-SourceCode-Demo/` prefix so
`commonDir` is exercised.

---

## Tests

Existing tests **must all still pass unchanged**. Add:

### `test/dirs.test.ts`
1. `dirHotspots` picks `~/.claude/projects/-Users-testuser-SourceCode-Demo` from the
   fixture paths, with the correct `fdCount`.
2. It returns the **deepest** directory when a chain of ancestors share one count
   (not `~/.claude`, not `~/.claude/projects`).
3. It never returns `/`, `/Users`, `/Users/testuser`, or `/System`.
4. It excludes noise paths (a directory of only `.dylib` files is not a hotspot).
5. It respects `minFiles` — 2 files under a directory yields no hotspot at the
   default threshold.
6. It does not return both an ancestor and its descendant (branch collapsing).
7. `dominantExt` is `"jsonl"` for the transcript directory.
8. `sampleFiles` contains at most 3 basenames.
9. Empty input → `[]`.

### `test/owner.test.ts`
1. Parses `anthropic.claude-code-2.1.218-darwin-arm64` →
   `id: "anthropic.claude-code"`, `version: "2.1.218"`, `builtin: false`.
2. Parses the bundled `app/extensions/copilot/…` path →
   `id: "copilot"`, `builtin: true`, `version: null`.
3. `host === 'VS Code'` for the fixture.
4. `hasNativeModule` is true for `anthropic.claude-code` (its `.node` sits under
   its directory).
5. `nativeModules` contains both `audio-capture.node` and `runtime.node`, sorted
   and de-duplicated.
6. Sort order puts a native-module extension ahead of one without.
7. A Cursor path yields `host: 'Cursor'`.
8. Paths with no extension dirs → returns `null`.

### `test/readactivity.test.ts`
1. `parseLsofOffsets` extracts the right key count from the t0 fixture.
2. It ignores non-`REG` rows and the header.
3. Diffing t0→t1 yields `fdsAdded: 3`, `fdsRemoved: 2`, `offsetsAdvanced: 2`
   (test the pure diff — factor the diff out of `getReadActivity` into an
   exported pure `diffOffsets(before, after, gapMs)` so no process is needed).
4. Verdict is the churn message when `fdsAdded + fdsRemoved >= 3`.
5. Verdict is the idle message when both snapshots are identical.
6. `commonDir` resolves to the shared transcript directory.
7. Empty stdout → `available: false` with a note.

### `test/openfiles.test.ts` (additions)
1. A `neutral` file under a hotspot dir (score 3) outranks a `signal` file that is
   not (score 2) — **this is the regression test for the original bug**.
2. Omitting `hotspotDirs` reproduces today's ordering exactly.
3. A hotspot dir prefix must match on a `/` boundary — `/a/bc` is not under `/a/b`.

### Report tests
Add to `test/enrich.test.ts` (or a new `test/report.test.ts`, your choice):
1. `collectionStatus()` reports `not collected (click "Sample stack")` when
   `stackSample` is absent.
2. It reports `attempted — unavailable (<note>)` when `stackSample.available === false`.
3. It reports `collected — none in the last hour` for zero crashes.

---

## Acceptance criteria

All must pass, run from the project root:

```bash
npx tsc --noEmit
npm run build
npm test
```

- `npm test` must report **more** tests than the current baseline (run `npm test`
  **before** making changes and record the number; state both numbers in your report).
- Zero TypeScript errors. No `any`. No new dependencies in `package.json`.

### Manual smoke test

Start the server on a non-default port, exercise the new endpoint against a
**real, long-lived** PID, and **always reap the server**:

```bash
PORT=7777 node dist/index.js --server >/tmp/pd-smoke.log 2>&1 &
echo $! > /tmp/pd-smoke.pid
sleep 2
PID=$(pgrep -n -f "Code Helper" || echo $$)
curl -s "http://127.0.0.1:7777/api/inspect/$PID" | head -c 1500
curl -s -X POST "http://127.0.0.1:7777/api/readdelta/$PID?gap=1000" | head -c 1200
kill "$(cat /tmp/pd-smoke.pid)" 2>/dev/null; sleep 1
pkill -f "dist/index.js --server" 2>/dev/null
pgrep -f "dist/index.js --server" && echo "STILL RUNNING - kill it" || echo "reaped"
```

Verify in the output and **paste the evidence** in your report:
1. `/api/inspect` includes `dirHotspots` and `owners` keys.
2. `/api/readdelta` returns a `readActivity` object with a non-empty `verdict`.
3. The `report` string contains a `Collection status:` block.
4. The smoke server is confirmed dead (`reaped`).

If the server refuses to start with those flags, read `src/index.ts` for the real
CLI invocation and adjust — then say what you changed.

---

## Constraints & non-goals

- **Read-only.** No process is killed, no file is written outside `docs/`, `src/`,
  and `test/`.
- **No sudo, no `osascript`, no elevated prompts anywhere in this feature.** All
  four parts work as the current user. (`fs_usage`/`powermetrics` already cover
  the elevated cases — do not touch them.)
- **Bounded cost.** At most **one** extra `lsof` run per inspect (Part 0 reuses
  the existing one) and at most **two** `du -sk` calls, each capped at 1500 ms.
  Part B's two `lsof` runs happen only on the on-demand endpoint.
- Never spawn anything that outlives a request. No polling loops, no timers with
  a cadence under 1 second.
- **Do not change** `src/collect/fsusage.ts`, `src/collect/powermetrics.ts`,
  `src/collect/elevated.ts`, or `src/collect/oslog.ts`.
- `getOpenFiles()` keeps its exact current output — it is load-bearing.
- Non-goal: Chrome renderer / tab attribution, `nettop`, per-extension CPU
  measurement. Path-evidence attribution only.

---

## ⛔ Do NOT deploy

Implement, verify locally against the acceptance criteria, then **STOP and report**.
Do not run `npm run deploy`, do not run `scripts/install-app.sh`, do not `ssh`
anywhere, do not touch `waldomacmini1`. Deployment is handled separately after an
independent verification pass.

## Deliverables to report

1. Every file created and modified.
2. Verbatim output of `npx tsc --noEmit`, `npm run build`, `npm test` (with the
   before/after test counts).
3. The smoke-test output proving the four checks above, including `reaped`.
4. Any deviation from this spec and why it was necessary.
5. Anything you noticed but deliberately left out of scope.
