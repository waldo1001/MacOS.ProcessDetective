# Spec — Elevated stack sampling ("Sample with admin rights")

Let the user *opt in* to sampling root/hardened processes (ReportCrash, WindowServer,
mds, kernel daemons…) that the read-only/no-sudo path can't attach to. When a normal
`POST /api/sample/:pid` comes back `available:false` because of privileges, the UI
offers a **"Sample with admin rights"** button; clicking it runs the sample through
**macOS's native admin authorization** (no signed helper, no stored password), and
shows the same verdict/frames the unprivileged path produces for your own processes.

Motivating case: `ReportCrash` (root) pegged a core for 40 min; `sample` was refused
("you do not have appropriate privileges to examine it"). This closes that gap.

## Context (read first)

- Project root: `/Users/waldo/SourceCode/Community/MacOS.ProcessDetective`
- Stack: TypeScript ESM (`"module":"NodeNext"` → **relative imports use `.js`**),
  strict, **no new deps** (`node:` builtins + shelling via the existing
  `run(cmd, args, timeoutMs)` in `src/util/exec.ts`, which never throws).
- Read first:
  - `src/collect/sample.ts` — `parseSample(text)` (PURE) + `getStackSample(pid, seconds)`
    + the `StackSample` shape. **Reuse `parseSample` unchanged** — the output format of
    `sample` is identical whether run as user or root.
  - `src/server/server.ts` — the existing `POST /api/sample/:pid` route (returns
    `{ sample, report, prompt, detail }`).
  - `src/server/page.html` — the detail panel "What is it doing?" section: the
    "Sample stack (2s)" button, its spinner, and how it renders verdict/frames/raw
    and updates the copy-report/prompt state.
  - `src/types.ts` — `StackSample`.
- Verify: `npx tsc --noEmit`, `npm run build`, `npm test` (80 tests currently green).

## How elevation works (the mechanism)

macOS lets a GUI app run a one-off privileged command via AppleScript, which pops the
**standard system authentication dialog** (Touch ID / password) and runs the command
as root — no SMJobBless helper, no stored secret:

```
osascript -e 'do shell script "<command>" with administrator privileges'
```

The Node server is spawned by the bundled `.app` inside the user's GUI session, so the
auth dialog appears normally. macOS caches the authorization for ~5 minutes, so repeated
elevated samples won't re-prompt. If the user cancels, `osascript` exits non-zero with
`User canceled` / error `-128`.

## Architecture

**`src/collect/sample.ts` — add two things:**

```ts
/** Build the privileged sample shell command. PURE — unit-tested. */
export function buildElevatedSampleCommand(pid: number, seconds: number): string;

/** Run `sample <pid>` as root via the macOS admin auth dialog, then parse it. */
export async function getStackSampleElevated(pid: number, seconds?: number): Promise<StackSample>;
```

- `buildElevatedSampleCommand(pid, seconds)`:
  - **Sanitize hard**: `pid` must be a positive integer (`Number.isInteger(pid) && pid > 0`,
    else throw); `seconds` clamped to **1–5** integer. These are the only interpolated
    values and they are numeric — there is no string injection surface, but assert it.
  - Return the inner shell command, e.g. `/usr/bin/sample 12345 3` (use the absolute
    `/usr/bin/sample` path so it works under the reduced PATH of `do shell script`).
- `getStackSampleElevated(pid, seconds=2)`:
  - Build the inner command, then run:
    `run('osascript', ['-e', \`do shell script "<cmd>" with administrator privileges\`], (seconds+30)*1000)`.
    The long timeout covers the user taking time at the auth dialog. `<cmd>` must be
    embedded with proper AppleScript string escaping (escape `"` and `\\`); since the
    command is built from sanitized numerics it's simple, but escape correctly.
  - Interpret the result:
    - If stdout looks like a sample report (contains `Call graph` / `Analysis of sampling`)
      → `parseSample(stdout)` and return it (this is the win — a real root stack).
    - If stderr/stdout contains `User canceled` or exit code 1 with `-128` →
      `{ available:false, ..., note: 'admin authentication cancelled' }`.
    - If it failed for another reason (no GUI session, osascript missing) →
      `{ available:false, ..., note: 'elevated sampling failed: <short reason>' }`.
  - Never throw; always return a `StackSample`.

**`src/server/server.ts` — extend the existing route, don't add a new one:**
- `POST /api/sample/:pid` reads an `elevated` flag from the query string
  (`?elevated=1`) **or** a JSON body `{ "elevated": true }` (support query at least).
- When `elevated` is truthy → call `getStackSampleElevated(pid)`, else the existing
  `getStackSample(pid)`. Everything else (building `report`/`prompt`/`detail` with the
  resulting `stackSample`) stays the same — the elevated result flows through the exact
  same enrichment/report path.
- An optional kill-switch: if `process.env.PD_NO_ELEVATED === '1'`, the elevated branch
  returns `{ available:false, note:'elevated sampling disabled (PD_NO_ELEVATED=1)' }`
  without invoking osascript. (Lets the cautious disable it.)

**`src/server/page.html` — UI:**
- In the "What is it doing?" result rendering: when a sample comes back
  `available:false` **and** its `note` indicates a privilege problem (matches
  `/privilege|elevated|administrator|not permitted|appropriate privileges/i`), show a
  secondary button **"🔓 Sample with admin rights"** plus a one-line muted note:
  *"macOS will ask for your password; runs `sample` as root just for this."*
- Clicking it → `POST /api/sample/<pid>?elevated=1`, same spinner, render the same way.
  Result updates the copy-report/prompt deep state just like the normal sample.
- If the elevated result is `available:false` with the cancellation note, show that
  inline (not an error) so a cancel is graceful.
- Do not auto-trigger elevation — it is always a deliberate second click.

## Tests (`test/sample.test.ts`, extend)

- `buildElevatedSampleCommand`:
  - returns a command containing `/usr/bin/sample 12345 3` for `(12345, 3)`.
  - clamps `seconds`: `0 → 1`, `99 → 5`, non-integer floored/clamped.
  - throws on non-integer / non-positive pid (`0`, `-1`, `1.5`, `NaN`).
  - the produced string contains no shell metacharacters beyond the numeric args
    (assert it matches `^/usr/bin/sample \d+ \d+$`).
- Reuse existing `parseSample` fixtures (the parser is unchanged) — optionally add a
  test that a root-style sample header still parses.
- Do **not** attempt to invoke `osascript`/`sample` from tests (would pop an auth
  dialog / hang). Keep all existing tests green.

## Acceptance criteria (run these; capture output; report)

1. `npx tsc --noEmit` clean; `npm run build` ok; `npm test` all green incl. new builder tests.
2. `node dist/index.js serve --no-open --no-history --port 7940`, then:
   - `curl -s -X POST 'http://127.0.0.1:7940/api/sample/<a-node-pid>'` → still works
     unchanged (`available:true`, verdict) — **no regression** on the normal path.
   - `curl -s -X POST 'http://127.0.0.1:7940/api/sample/<that-pid>?elevated=1'` with
     `PD_NO_ELEVATED=1` set → returns `available:false` with the "disabled" note and
     **does not** invoke osascript. (This is the only safe way to exercise the elevated
     branch non-interactively — do NOT trigger a real auth dialog in the smoke test.)
   - `curl -s 'http://127.0.0.1:7940/' | grep -c 'admin rights'` → ≥1 (button present).
3. Confirm the normal unprivileged `/api/sample` path and `/api/inspect` are unchanged.
4. **Reap every server you start** (`kill`, verify it died; SIGKILL if it survives).
   No orphan / no 1s-cadence servers.

## Constraints & non-goals

- Elevation is **strictly opt-in, per-action**, gated by the OS auth dialog. The default
  experience stays read-only/no-sudo. No stored credentials, no background privilege, no
  signed helper.
- **Injection-safe**: only sanitized integers (pid, seconds) are interpolated; assert it.
- Never throw from the collector; cancellation and missing-GUI degrade gracefully.
- Do NOT actually authenticate or pop a dialog in automated tests/smoke — use
  `PD_NO_ELEVATED=1` to exercise the branch.
- ESM `.js` imports, strict TS, no new deps, match existing layout.
- **Do NOT deploy** (`scripts/*deploy*`, `npm run deploy*`) and do not ssh anywhere.
  Implement, verify locally, update `README.md` (a short "Elevated sampling" note under
  Root-cause investigation), then STOP and report.
- Out of scope (note as future): elevated `powermetrics` for per-core CPU, fan RPM (SMC),
  `fs_usage`/`nettop` per-process IO — same opt-in elevation mechanism could power them
  later, but not in this change.

## Deliverables to report

Files created/modified; outputs of typecheck/build/tests and the smoke commands
(including the `PD_NO_ELEVATED=1` elevated-branch check); deviations from the spec with
rationale; confirmation of no orphan processes; and the follow-up
(`npm run deploy -- --remote=waldomacmini1`).
