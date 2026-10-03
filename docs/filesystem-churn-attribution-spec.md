# Spec: Filesystem-churn attribution (fs_usage) + fs-symptom hints

Status: **QUEUED** — build only AFTER `process-log-and-openfile-signal-spec.md` lands,
is verified, and is deployed (they edit the same files: types.ts, server.ts, report.ts,
prompt.ts, payload.ts, page.html, sysprocess.ts). Spec + verification owned by Opus.

## Origin

An investigation of `fseventsd` (macOS FSEvents daemon, root) at ~100% CPU. The AI's
verdict: fseventsd is a **symptom, not the disease** — it only works hard when *some
other process* generates a filesystem-change flood. Its single highest-value follow-up:

> `sudo fs_usage -w -f filesys` — "names the process and paths driving the change storm."

The tool can already sample the daemon, read its log (in-flight), list its open files,
and cross-reference crashes — but it has **no way to name the process generating the
file-event flood**. That is the literal "tell me what causes it" mission, for a whole
class of symptom daemons: `fseventsd`, `mds`/`mds_stores`/`mdworker` (Spotlight),
volume-churn spikes. It lives behind sudo → the existing elevated mechanism.

Deduped: `log show --process fseventsd` = the in-flight log-tail feature; `sudo sample`
= elevated sample (built); `lsof` = open files (built); crashes/containers = built.
This feature is the one genuinely new capability.

Non-negotiables (match the codebase):
- Read-only observation only. Reuse **`runElevated(innerCmd, timeoutMs)`** from
  `src/collect/elevated.ts` — it wraps `osascript … with administrator privileges`,
  normalizes `\r`→`\n`, honors `PD_NO_ELEVATED=1`, and never throws.
- The inner command MUST be injection-safe: built from a **clamped integer only**, then
  regex-asserted before use — exactly like `buildElevatedSampleCommand` in
  `src/collect/sample.ts`. No user-supplied strings in the command.
- On-demand only (elevated → shows the auth dialog). NEVER on `/api/inspect`.
- Pure, unit-tested parser. Graceful degrade to `available:false` + note. ESM `.js`
  imports. Strict TS.

---

## Feature A — fs_usage churn attribution (elevated, on-demand)

### A1. New collector: `src/collect/fsusage.ts`

```ts
import { runElevated } from './elevated.js';
import type { FsChurnSnapshot } from '../types.js';
```

**`buildFsUsageCommand(seconds: number): string`** — PURE, exported, unit-tested.
- Clamp `seconds` to `[2, 5]`, floor it (default caller passes 3).
- `fs_usage` streams forever, so bound it: capture to a temp file in the background,
  sleep, kill, print (byte-capped), clean up. **Use NO double-quotes** in the inner
  command (mktemp path has no spaces) so `runElevated`'s AppleScript escaping has nothing
  to touch:
  ```
  /bin/sh -c 'f=$(mktemp /tmp/pd_fsusage.XXXXXX); /usr/bin/fs_usage -w -f filesys >$f 2>/dev/null & p=$!; sleep <N>; kill $p 2>/dev/null; sleep 1; kill -9 $p 2>/dev/null; head -c 4000000 $f; rm -f $f'
  ```
- Assert the built string matches a strict shape before returning, e.g.
  `/^\/bin\/sh -c 'f=\$\(mktemp \/tmp\/pd_fsusage\.XXXXXX\); \/usr\/bin\/fs_usage -w -f filesys >\$f 2>\/dev\/null & p=\$!; sleep \d+; kill \$p 2>\/dev\/null; sleep 1; kill -9 \$p 2>\/dev\/null; head -c 4000000 \$f; rm -f \$f'$/`
  (throw if it doesn't). The only variable is `<N>` (an integer).

**`parseFsUsage(stdout: string, seconds: number): FsChurnSnapshot`** — PURE, exported, unit-tested.
- `fs_usage -w` line shape (capture real samples to build the fixture):
  ```
  12:34:56.789  open              F=12  /Users/waldo/p/node_modules/.x  0.000123 W node.12345
  12:34:56.790  WrData[async]     ...   /Users/waldo/p/build/out.o               mds_stores.234
  ```
  The **last whitespace-delimited token** is `<procname>.<threadid>` (fs_usage truncates
  the process column and shows no spaces). Strip a trailing `.\d+` to get the process
  name. The **path** is the longest token starting with `/`.
- Aggregate by process name into `{ count, paths: string[] }`. **Exclude the observers
  themselves**: `fseventsd`, `fs_usage`, `sh`, `mktemp`, `osascript` (and blank names).
- Produce `topProcesses`: for each process, `{ process, count, samplePaths (top 3
  distinct, most-frequent first), commonDir }`, sorted by `count` desc, cap **8**.
  - `commonDir` = the most common 4-level-deep parent directory across that process's
    paths (or the longest common path prefix). Used to say "churning under X".
- `totalEvents` = sum of parsed events. `truncated` = stdout byte length ≥ ~3.9 MB
  (the head cap was hit) → set note accordingly.
- **Concentration annotation** (`note`): if the top process's `commonDir` matches a
  known churn source, name it — regex any of: `/node_modules/`, `/\.git/`, `\.orbstack`,
  `/Library/Developer/`, `/DiagnosticReports/`, `/Caches/`, a `bin|obj|target|dist|build`
  dir. e.g. `"Top driver: node — 8,400 events under ~/proj/node_modules (dependency
  install or file watcher)."`
- Empty/failed input → `{ available:false, windowSeconds:seconds, totalEvents:0,
  topProcesses:[], truncated:false, note:'no filesystem activity captured' }`.

**`getFsChurn(seconds = 3): Promise<FsChurnSnapshot>`** — async runner.
- `const inner = buildFsUsageCommand(seconds)` (wrap in try/catch → available:false).
- `const r = await runElevated(inner, (seconds + 8) * 1000)`.
- If `!r.ok` → `{ available:false, windowSeconds:seconds, totalEvents:0, topProcesses:[],
  truncated:false, note: r.note }` (surfaces "auth cancelled" / kill-switch / timeout).
- Else `return parseFsUsage(r.stdout, seconds)`.

### A2. Types — `src/types.ts`

```ts
export interface FsChurnProcess {
  process: string;
  count: number;
  samplePaths: string[];
  commonDir: string | null;
}
export interface FsChurnSnapshot {
  available: boolean;
  windowSeconds: number;
  totalEvents: number;
  topProcesses: FsChurnProcess[];
  truncated: boolean;
  note: string | null;
}
```
Add to `Enrichment`: `fsChurn?: FsChurnSnapshot;` (on-demand, like `stackSample?`).

### A3. Endpoint — `src/server/server.ts`

Pid-scoped endpoint (system-wide data, attached to that pid's report for context) —
mirror the `/api/sample/:pid` block; import `getFsChurn` from `../collect/fsusage.js`:
```ts
const fm = url.pathname.match(/^\/api\/fschurn\/(\d+)$/);
if (fm && req.method === 'POST') {
  const pid = parseInt(fm[1]!, 10);
  const tree = await snapshot();
  const node = tree.byPid.get(pid);
  if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
  const secondsParam = url.searchParams.get('seconds');
  const seconds = secondsParam ? Math.max(2, Math.min(5, parseInt(secondsParam,10) || 3)) : 3;
  const [enr, fsChurn] = await Promise.all([enrich(node), getFsChurn(seconds)]);
  const enriched = { ...enr, fsChurn };
  const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
  const s = stats.get(pid);
  const payload = inspectPayload(node, enriched, {
    threads: s?.threads ?? null, energy: s?.energy ?? null, fdCount,
  });
  return json(res, 200, { fsChurn, report: payload.report, prompt: payload.prompt, detail: payload });
}
```

### A4. payload / report / prompt

- `src/server/payload.ts`: add `fsChurn: enr.fsChurn ?? null,`.
- `src/report/report.ts`: add a section when `enr.fsChurn?.available` (place near the
  Docker section):
  ```
  Filesystem churn (system-wide, <N>s):
    <totalEvents> fs events
    <process> ×<count>  under <commonDir>
      e.g. <samplePath>
    …
    (concentration note; "(truncated)" if truncated)
  ```
  When the inspected process `enr.sysHint?.isFsSymptom` is true, append:
  `→ This daemon is a symptom; the process above is generating the file-event flood.`
- `src/report/prompt.ts` QUESTIONS — add item **10** (renumber if the log-tail build
  already added 9):
  ```
  'N. If filesystem-churn attribution is included, name the process generating the',
  '   file-event flood and the directory it is hammering; tie it back to the symptom',
  '   daemon (fseventsd / Spotlight) if relevant.',
  ```

### A5. UI — `src/server/page.html`

Add a **"🌊 Filesystem churn (admin)"** button in the detail panel — this triggers the
macOS auth dialog (like the elevated "admin rights" sample). Mirror the elevated-sample /
docker button wiring:
- State `fsChurnMeasuring` / `fsChurnResult` (FsChurnSnapshot|null); reset in `loadDetail()`.
- POST `/api/fschurn/<pid>?seconds=3`; while awaiting show "requesting admin… sampling
  filesystem…". Render `topProcesses` as rows: `<process>  ×<count>  under <commonDir>`
  with the top sample path in muted mono; show the `note` and a "(truncated)" flag.
- `available:false` → show the `note` (e.g. auth cancelled).
- Make the button visually prominent (or auto-hint) when the inspected process is an
  fs-symptom daemon (see Feature B). Bind in `bindAfter()`; guard double-clicks.

---

## Feature B — fs-symptom system-process hints (cheap)

### B1. `src/enrich/sysprocess.ts` (and mirror the flag in `src/types.ts`'s `SysProcessHint`)

- Add to the `SysProcessHint` interface (both the local copy in `sysprocess.ts` and the
  canonical one in `types.ts`): `/** Symptom daemon whose cause is external filesystem churn. */ isFsSymptom?: true;`
- Add a `fseventsd` entry and set `isFsSymptom: true` on the filesystem-symptom daemons.
  Match by the existing case-insensitive lookup:
  ```ts
  fseventsd: {
    label: 'FSEvents daemon',
    what: 'Fans out filesystem-change notifications to Spotlight, Time Machine, sync clients and file watchers. High CPU means another process is generating a flood of file changes — it is the symptom, not the cause.',
    lookWhere: 'Run "Filesystem churn" to name the process driving the change storm',
    isFsSymptom: true,
  },
  ```
  Set `isFsSymptom: true` also on `mds`, `mds_stores`, `mdworker`, `mdworker_shared`
  (Spotlight indexing is driven by file churn too), and add `mdbulkimport` if not present.
  Keep their existing `label`/`what`; add the `lookWhere` churn hint where null.

### B2. Report already handled in A4 (the `isFsSymptom` branch). No extra work.

---

## Tests (add; keep existing green)

- `test/fsusage.test.ts` — `buildFsUsageCommand` (clamp 2..5, exact regex shape, NO
  double quotes, integer-only); `parseFsUsage` against `test/fixtures/fsusage.txt`
  containing real-shape lines from ≥3 processes (one dominant, e.g. `node` under
  `node_modules`; `mds_stores`; a couple others), plus `fseventsd`/`fs_usage` lines that
  MUST be excluded, and enough volume to exercise `topProcesses` ordering + `commonDir`
  + the concentration note. Assert exclusion, ordering, counts, commonDir, note, and the
  empty-input → `available:false` path.
- `test/sysprocess.test.ts` (extend if it exists, else add) — `fseventsd` returns a hint
  with `isFsSymptom:true`; `mds_stores` has `isFsSymptom:true`; a normal process returns
  null / no `isFsSymptom`.

## Definition of done (build agent self-checks; Opus re-verifies independently)

1. `npx tsc --noEmit` clean; `npm run build` ok (page.html copied to dist).
2. `npm test` green — all prior tests still pass + new ones.
3. `node --check` on the extracted page.html `<script>` passes.
4. **Do NOT trigger the real admin dialog in an automated smoke** (it needs an
   interactive password). Instead verify the pieces without elevation:
   - Unit test `parseFsUsage` against the fixture (covers the parse path fully).
   - With `PD_NO_ELEVATED=1` set, `POST /api/fschurn/<pid>` returns HTTP 200 with
     `fsChurn.available:false` and the kill-switch note — proving the endpoint wiring,
     graceful degrade, and that `/api/inspect` never calls it. Capture that JSON.
   - `GET /api/inspect/<fseventsd-pid>` → `sysHint.isFsSymptom === true` and the report
     contains the "symptom" language + the "Run Filesystem churn" hint.
   - page.html contains "Filesystem churn" and the button markup.
   - **Reap any server you spawn — 0 orphans, no 1s loops.**
5. Report real output + any deviations. Opus re-runs these checks and, separately, does
   ONE real elevated run (approving the dialog) to confirm live fs_usage parsing before
   deploying to both Macs.

## Out of scope

- Per-process fs_usage filtering (fs_usage can't reliably filter by pid for *children*;
  system-wide + attribution is the point).
- Continuous streaming / persisting churn to history.
- `nettop`/network attribution (separate future spec).
