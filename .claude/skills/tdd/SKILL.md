---
name: tdd
description: Test-driven change to Process Detective (TypeScript + vitest) — Red → Green → Mutate, with fixtures captured from real macOS command output. Use when the user asks to fix a bug, add a parser/collector/check/endpoint, change behaviour "with tests", "TDD", "test first", or reports a wrong value in the app. Not for Business Central/AL work (that is iFacto.SDD). Args = the behaviour to add or the bug to fix.
---

# TDD for Process Detective

Every change is proven by a test that **failed for the right reason before the fix**
and **fails again when the fix is broken**. CI runs the suite on a clean macOS runner
as a different user, so a test that only passes on this Mac is a broken test.

## Red

1. **Locate the seam.** Find the pure function that owns the behaviour (parsers in
   `src/collect/`, rules in `src/health/`, report text in `src/report/`, HTTP in
   `src/server/`). Test the pure function, not the shell-out: collectors split into
   *run command* + *parse output*; only the parse half is unit-tested.
2. **Capture real input as a fixture** when the behaviour depends on command output:
   run the read-only command once (`ps`, `lsof -p`, `sample`, `tmutil status`, …),
   trim it to the lines that matter, and save it under `test/fixtures/` (health
   checks: `test/fixtures/health/`). **Sanitize before saving**: replace the real
   user name / home path with `/Users/testuser`, hosts with `nas`, serials and
   UUIDs with obvious fakes. The repo is public.
   - Never run a probe with side effects to get a fixture — see the probe-side-effect
     notes (e.g. `sfltool` raises Touch ID, `tmutil latestbackup` mounts the NAS).
3. **Write the test** in the matching `test/*.test.ts` (or a new file with the same
   naming). Load fixtures the way `test/sample.test.ts` does (`readFileSync` via
   `fileURLToPath(import.meta.url)`). Assert the *observable* result: the parsed
   value, the finding's severity and text, the HTTP status — not internals.
4. **Run it and read the failure:**
   ```bash
   npx vitest run test/<file>.test.ts
   ```
   It must fail on the assertion you wrote, for the reason you expect. A failure from
   an import error, a typo or a missing fixture is not Red — fix that and rerun.

## Green

5. **Implement the minimum** in `src/` to pass. Match the surrounding code: ESM
   imports with `.js` extensions, strict TS, no new dependencies without asking.
6. **Run the single file, then everything:**
   ```bash
   npx vitest run test/<file>.test.ts && npm run typecheck && npm test
   ```

## Mutate

7. **Prove the test guards the fix.** Break the implementation on purpose (flip the
   condition, drop the new branch, return the old value), rerun the file, and confirm
   the new test fails. Restore with `git diff` / undo the edit and rerun until green.
   If the test still passes with the fix broken, it tests nothing — strengthen it.

## Machine-independence checklist (CI will catch these anyway — catch them first)

- No real `$HOME` / user name in assertions. Code that abbreviates paths
  (`homePath()` in `src/render/format.ts`) reads `$HOME` → pin it with
  `vi.stubEnv('HOME', '/Users/testuser')` and `vi.unstubAllEnvs()` in `finally`.
  Prefer passing `home` as a parameter where the API already allows it
  (`classifyOpenFile(path, HOME)`).
- No reliance on what is running, mounted or installed on this Mac; no network.
- No wall clock: pass `now` in (most APIs take it) instead of `Date.now()`.
- Quick check that it is not machine-bound: `HOME=/Users/runner npx vitest run test/<file>.test.ts`.

## Finish

8. **Show the evidence** in the reply: the Red failure line, the Green count
   (`Tests N passed`), and the mutation result.
9. **Commit** on `main` with a message that says what behaviour changed. Push only
   when the user wants it shipped — then the `ci` skill (watch the run) and the
   `ship` skill (release) take over; `deploy` installs it.
