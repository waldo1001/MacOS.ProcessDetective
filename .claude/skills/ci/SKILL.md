---
name: ci
description: Check and repair Process Detective's GitHub Actions CI (typecheck, vitest, ad-hoc app build on macOS). Use when the user asks "is CI green", "did the build pass", "fix CI", "why did the pipeline fail", after pushing to main, or before cutting a release. Reads the failed logs, reproduces locally, fixes with a test, pushes and watches the rerun.
---

# CI for Process Detective

Workflow: `.github/workflows/ci.yml` on every push to `main` and every PR —
`npm ci` → `npm run typecheck` → `npm test` → `scripts/build-app.sh` (ad-hoc) →
smoke run of real CLI commands on the bundled Node → ad-hoc zip as an artifact (7 days).
Runner: `macos-latest` (Apple Silicon), Node from `.nvmrc` (24), user `runner` (`HOME=/Users/runner`).

## Status

```bash
gh run list --workflow ci.yml --limit 5
gh run list --workflow ci.yml --commit "$(git rev-parse HEAD)" --limit 1   # this commit
```

Following a run in progress: `gh run watch <id> --exit-status --interval 20`
(run it in the background for long waits; you are notified when it ends — do not
poll with sleep loops).

## When it is red

1. **Read the failure, not the summary:**
   ```bash
   gh run view <id> --log-failed | grep -E 'FAIL|Error|error|×|expected|Tests ' | head -40
   ```
2. **Classify it:**
   - *Test passes locally, fails in CI* → machine dependence. Reproduce with the
     runner's environment: `HOME=/Users/runner npx vitest run test/<file>.test.ts`,
     `TZ=UTC`, `LANG=C`. Fix the **test** (pin env, pass `home`/`now` in), not by
     special-casing CI in product code. See the `tdd` skill checklist.
   - *Typecheck/test fails locally too* → a real regression; fix it the `tdd` way.
   - *App build step* → `bash scripts/build-app.sh` locally; the usual causes are a
     stray Mach-O in the bundle (a new dependency with a native binary) or a
     `swiftc` error in `native/AppMain.swift`.
   - *`npm ci` / setup* → lockfile out of sync (`npm install` and commit the lock),
     or a GitHub outage (`gh run rerun <id>` once; don't loop).
3. **Fix, verify locally** (`npm run typecheck && npm test`, plus the reproduction
   command), commit, push, and watch the new run to green. Report the run URL.

Never mark a failing test `skip`/`todo`, loosen an assertion until it passes, or
add `continue-on-error` to get green — say what is wrong instead.

## Dependabot PRs

`gh pr list --author app/dependabot`. For each: `gh pr checks <n>`; green and a
patch/minor bump → offer to merge (`gh pr merge <n> --squash`) — merging is the
user's call, ask first. Red → treat like any CI failure on that branch.
