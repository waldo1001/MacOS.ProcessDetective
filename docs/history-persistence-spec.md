# Spec — Option D: Persist history to disk

Implementation-ready spec for a durable, bounded, on-disk metric history for
Process Detective. Target: hours/days of trend that survives app restarts, without
leaking memory or becoming a disk/CPU hog.

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TypeScript (ESM, `"module":"NodeNext"` → **imports use `.js` extensions**),
  strict mode, **no runtime deps beyond `commander`** (use `node:fs/promises`,
  `node:path`, `node:os` only — do NOT add packages).
- The local web server lives in `src/server/server.ts` and is started by the
  `serve` command in `src/cli.ts`. It serves `src/server/page.html` (a single-page
  app, copied to `dist/` by the build) plus JSON endpoints:
  - `GET /api/system` → `collectSystem()` in `src/collect/system.ts` (cpu, memory,
    network, disk, storage, power, host, processes, `server:{rssBytes,uptimeSeconds}`).
  - `GET /api/processes` → process list (+ threads/energy).
  - `GET /api/inspect/:pid`, `POST /api/advice/:pid`.
- The UI keeps **client-side** in-memory ring buffers and renders SVG timelines via
  `timeline(samples, lines, opts)` / `pathFor(...)`. A client history sample is:
  `{ t, cpu, cpuUser, mem, netRx, netTx, energy, diskR, diskW }` (see `pushHistory`
  in `page.html`). Charts break the line on `sample.gap===true` or a time jump > 25s.
- Build: `npm run build` (tsc + copies page.html). Tests: `npm test` (vitest, 27
  currently passing — keep them green). Typecheck: `npx tsc --noEmit`.

## Goal & architecture

Add a **server-side history collector** that samples system metrics on a timer,
keeps a bounded in-memory rolling buffer, and **persists to disk** as rotated JSONL.
The collector runs inside `serve` independent of any browser, so history is durable
and continues even when the UI window is hidden. A new `GET /api/history` endpoint
serves downsampled series; the UI gains a **time-range selector** that reads it.

This is intentionally the durable, server-owned collector — it also gives the
"keeps collecting regardless of window state" benefit for free.

## Data model

Persisted sample (compact; **one `collectSystem()` call per tick — do NOT also call
the per-process collector**, to keep it cheap; energy stays live-only):

```ts
interface HistorySample {
  t: number;        // ms epoch
  cpu: number;      // cpu.usagePct
  cpuUser: number;  // cpu.user
  mem: number;      // memory.usedPct
  netRx: number;    // network.rxBytesPerSec
  netTx: number;    // network.txBytesPerSec
  diskR: number;    // disk.readBytesPerSec
  diskW: number;    // disk.writeBytesPerSec
  load: number;     // cpu.loadAvg[0]
}
```

Per-core and per-process series are **not** persisted (too large) — they remain
live/in-memory in the UI. Document this in the UI ("per-core/per-process history is
live-only").

## Storage

- **Location:** `~/Library/Application Support/ProcessDetective/history/`, resolved
  from `os.homedir()` (NOT cwd — the bundled app runs with cwd inside the .app).
  Override with env `PD_DATA_DIR`. Create dirs recursively on start.
- **Format:** append-only **JSONL**, one `HistorySample` per line. Rotated per UTC
  day: `history-YYYY-MM-DD.jsonl`. Append with a tolerant writer (a kept-open
  `fs.WriteStream` or sequential `fs.appendFile`); a partial/corrupt last line on
  load must be skipped, not fatal.
- **Disk cadence:** default **15 000 ms** (`PD_HISTORY_INTERVAL_MS`). At 15s a day
  is ~5 760 lines × ~110 bytes ≈ ~0.6 MB/day.
- **Retention:** default **14 days** (`PD_HISTORY_RETENTION_DAYS`). On startup and
  at each day rollover, delete `history-*.jsonl` older than retention. → bounded
  total ≈ ~9 MB. State the bound in a log line on start.
- **Single-writer safety:** a second server instance (two app windows) sharing the
  dir must not double-write. Use a simple lockfile `history/.writer.lock` containing
  the pid; if a live lock is held by another running pid, this instance runs
  **read-only** (still serves `/api/history` from disk) and does not append. Remove
  the lock on graceful shutdown (`process.on('exit'|'SIGINT'|'SIGTERM')`).

## Modules to create

1. `src/history/store.ts` — **pure, unit-testable** functions (no timers, no I/O
   side effects beyond explicit fs helpers):
   - `encodeSample(s): string` / `parseLine(line): HistorySample | null` (JSONL).
   - `parseJsonl(text): HistorySample[]` (skips blank/corrupt lines).
   - `downsample(samples, maxPoints): HistorySample[]` — bucket by time into
     ≤ maxPoints buckets, averaging numeric fields, preserving order; if already
     ≤ maxPoints, return as-is. Must never exceed maxPoints.
   - `filterSince(samples, sinceMs): HistorySample[]`.
   - `dayFileName(date): string` and `isExpired(fileName, now, retentionDays): bool`
     and `prunable(fileNames, now, retentionDays): string[]` (which files to delete).
   - `RANGES: Record<string, number|null>` mapping `"15m"|"1h"|"6h"|"24h"|"7d"|"all"`
     to durations in ms (`all` → null).
2. `src/history/collector.ts` — the runtime piece:
   - `class HistoryStore` (or factory) with: `start()`, `stop()`, `getSamples(sinceMs?, maxPoints?)`.
   - On `start()`: resolve data dir, acquire writer lock (else read-only), load the
     last `retentionDays` of files into a bounded in-memory array, prune expired
     files, then `setInterval(tick, intervalMs)`.
   - `tick()`: `await collectSystem()`, build a `HistorySample`, push to the
     in-memory buffer (cap at `retentionDays`-worth, e.g. `ceil(retentionMs/intervalMs)+slack`,
     shift overflow), and append the JSONL line (writer only). Day rollover: when the
     date changes, switch the target file and run prune. Wrap all fs work in
     try/catch — on disk error, log once and continue **in-memory only** (never crash).
   - Bounded by construction: the in-memory array is capped; file handles closed on stop.

## Endpoint

`GET /api/history` (in `server.ts`):
- Query params: `range` (one of RANGES keys; default `"1h"`) and/or `since` (ms),
  `maxPoints` (default 600, clamp 50–2000).
- Returns `{ samples: HistorySample[], cadenceMs: number, retentionDays: number }`,
  downsampled to ≤ maxPoints, oldest→newest. Reads from the in-memory buffer.
- Cheap; no subprocess spawns.

## CLI / config

- Env (read in `serve`): `PD_HISTORY` (`0` disables persistence entirely → behaves
  exactly as today, synthetic seed, no disk), `PD_DATA_DIR`, `PD_HISTORY_INTERVAL_MS`,
  `PD_HISTORY_RETENTION_DAYS`. **Default: persistence ON.**
- Add matching `serve` flags in `src/cli.ts`: `--no-history`, `--data-dir <path>`,
  `--history-interval <sec>`, `--history-retention <days>`. Env overrides if both set,
  or pick one precedence and document it.
- `serve` startup log: print whether history is on, the data dir, cadence, retention,
  and the approximate disk bound.

## UI integration (`src/server/page.html`)

Keep the live polling exactly as now for current values + the live fine-grained
window. Add longer-range viewing backed by the server:

1. **Seed from real history:** on load, `GET /api/history?range=1h` and use it to
   seed the timeline buffer instead of (or in addition to) the synthetic
   `seedHistory(...)`. The returned samples share the client sample shape (map
   1:1; `energy` will be absent in server samples — default it to 0 for those).
2. **Range selector:** a small control in the header (next to the interval pill) or
   on each timeline card: `15m · 1h · 6h · 24h · 7d`. Store `state.range`.
   - For `15m`/live: charts read the live in-memory buffer `H` as today.
   - For longer ranges: fetch `/api/history?range=<r>` into `state.serverHist`, and
     the main timelines (`Overview` CPU/Network, `CPU` usage, `Memory` used, `Disk`
     I/O, `Network` throughput) render from `state.serverHist`. Refetch every ~30s
     while visible. Introduce a `histSamples()` accessor the section renderers use
     so the swap is centralized.
   - Per-core grid and per-process sparklines stay live-only regardless of range;
     when a long range is active, show a muted note ("per-core history is live-only").
   - Same gap rules apply (`gap` / >25s time jump) — server history can have real
     gaps (server was down); render them honestly.
3. Don't regress existing behavior: keyboard nav, pause, adaptive cadence, the
   `monitor … rss` readout, etc. all stay.

## Tests (`test/history.test.ts`, vitest)

- JSONL round-trip: `parseLine(encodeSample(s))` deep-equals `s`; `parseJsonl`
  skips a corrupt/partial line.
- `downsample`: returns ≤ maxPoints; on `n ≤ maxPoints` returns input; bucket
  averages are correct on a small fixture; order preserved.
- `filterSince` boundaries.
- Retention: `prunable([...fileNames], now, retentionDays)` returns exactly the
  expired ones; `isExpired` boundary at the retention edge.
- `RANGES` durations sane (`15m` = 900000, `all` = null, etc.).
- Keep all existing 27 tests green.

## Acceptance criteria

- `npx tsc --noEmit` clean, `npm run build` ok, `npm test` all green (existing + new).
- Manual smoke (do this and report output):
  1. `node dist/index.js serve --no-open --port 7900` → confirm a startup log line
     about history; confirm `~/Library/Application Support/ProcessDetective/history/history-<today>.jsonl`
     gets lines appended over ~40s.
  2. `curl 'http://127.0.0.1:7900/api/history?range=1h&maxPoints=100'` → returns
     `{samples,cadenceMs,retentionDays}` with samples in the documented shape and
     `samples.length ≤ 100`.
  3. Stop the server, restart it, `curl /api/history` again → previously written
     samples are present (proves persistence across restart).
  4. `curl http://127.0.0.1:7900/` → page still serves; grep it for the new range
     selector markup.
  5. `PD_HISTORY=0 node dist/index.js serve …` → no files written, behaves as before.
- Disk stays bounded: confirm only files within retention exist; note the size math.
- No new leaks: in-memory buffer is capped; lockfile released on exit.

## Constraints & non-goals

- **Read-only on other processes** (the tool never kills/modifies anything); writing
  our OWN history files is the only new disk write — keep it inside the app-support dir.
- Keep the "don't be the spike" ethos: 15s default disk cadence (do not sample to
  disk at the 1–2s UI rate); one `collectSystem()` call per disk tick (no per-process
  collector in the durable path).
- ESM + `.js` import extensions; strict TS; match existing code style and module
  layout (`src/collect/*`, `src/server/*`, etc.). No new dependencies.
- **Do NOT deploy.** Implement, verify locally per the acceptance criteria, update
  `README.md` (a short "History persistence" subsection) and this spec if anything
  changed, then STOP and report. Deployment to the two Macs is a separate follow-up.
- Out of scope (note as future): persisting per-core/per-process history, gzip of old
  day files, a `launchd` background agent (Option C), persisting energy.

## Deliverables to report back

A summary listing: files created/modified, the verification command outputs
(typecheck/build/tests + the 5 smoke steps), the on-disk size math, anything that
deviated from this spec and why, and any follow-ups (notably: deploy to both Macs
with `npm run deploy -- --remote=waldomacmini1`).
