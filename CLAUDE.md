# Process Detective

macOS CPU/process detective: a TypeScript CLI + local web dashboard, wrapped in a
native Swift launcher (`native/AppMain.swift`) that bundles its own Node runtime.
Public repo: github.com/waldo1001/MacOS.ProcessDetective. Not related to Business
Central / AL — the iFacto AL agents and skills do not apply here.

## The loop (each step is a project skill)

| Step | Skill | Command underneath |
|---|---|---|
| Change behaviour, test first | `tdd` | `npx vitest run test/<file>.test.ts`, `npm run typecheck`, `npm test` |
| Bigger feature | `spec-and-build` | spec in `docs/<slug>-spec.md`, Sonnet builds, verify here |
| Push, keep CI green | `ci` | `gh run list --workflow ci.yml`, `gh run view <id> --log-failed` |
| Release (CI signs + notarizes) | `ship` | `npm run ship -- patch` |
| Install on this Mac + the mini | `deploy` | `npm run deploy -- --remote=waldomacmini1` |
| Mine an AI investigation for gaps | `investigation-review` | → `spec-and-build` |

"Get it onto my Macs" = commit → push → CI green → `ship` → `deploy`. Deploy installs
the latest **GitHub release**, never the working tree (`--local-build` exists for
testing unreleased code and must be called out as such).

## Rules

- Node 24 (`.nvmrc`): it is the runtime bundled into the app, and dependencies need
  >= 22.12. The shell's nvm default may be older — run `source ~/.nvm/nvm.sh && nvm use`
  in the project so tests run on the CI version. `build-app.sh` picks the `.nvmrc` Node from nvm itself.
- Work on `main`; small commits. Push and release only when the user wants it shipped.
- Tests must pass on a clean CI runner (`HOME=/Users/runner`, nothing running):
  no real home paths, no live machine state, no wall clock. Fixtures are sanitized
  (`/Users/testuser`) — the repo is public.
- Probes must be read-only and side-effect free; some "read-only" commands are not
  (`sfltool` raises Touch ID, `tmutil latestbackup` mounts the NAS).
- Never handle signing certificates, the notary API key or app-specific passwords;
  the user sets those (`docs/RELEASING.md`). Team ID 92A2K3Q7NH is public.
- Release details: `docs/RELEASING.md`. Workflows: `.github/workflows/`.
