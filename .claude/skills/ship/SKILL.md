---
name: ship
description: Release Process Detective through GitHub Actions — version bump, tag, CI signs with Developer ID, notarizes with Apple, publishes the GitHub release — then install it on both Macs. Use when the user says "ship it", "release", "cut a release", "publish a new version", "get this onto my Macs", or after finished work on main should reach the installed app. Args = optional bump (patch | minor | major | x.y.z), default patch.
---

# Ship a release

The installed app always comes from a GitHub release (see the `deploy` skill), so
"get my change onto my Macs" means **ship, then deploy**. Publishing a release is
public — confirm with the user before running it unless they asked for the release
in this conversation.

## Preflight (stop and report on any failure — never work around it)

```bash
git status --porcelain                       # must be empty
git rev-parse --abbrev-ref HEAD              # must be main
git fetch -q && git status -sb | head -1     # must not be ahead/behind origin/main
gh run list --workflow ci.yml --commit "$(git rev-parse HEAD)" --limit 1   # must be success
gh release list --limit 3                    # what the last version was
```

- Unpushed commits → push, then wait for CI on that commit (`ci` skill).
- CI red or still running → `ci` skill first; never release a red commit.
- Uncommitted work the user wants included → commit it first (ask if unclear).

Pick the bump: `patch` for fixes, `minor` for features, as the user said otherwise.

## Release

```bash
npm run ship -- <patch|minor|major|x.y.z>
```

`scripts/ship.sh` re-checks the tree, runs typecheck + tests, `npm version`
(commit + tag `vX.Y.Z`), pushes with tags, then follows the release run and prints
the release URL. Run it in the background (`run_in_background`) — notarization
takes ~3-15 min, longer on Apple's bad days — and tell the user it is running.

## When the release run fails

```bash
gh run list --workflow release.yml --limit 1
gh run view <id> --log-failed | tail -60
```

| Step that failed | Usual cause → fix |
|---|---|
| Tag must match package.json | tag pushed by hand → delete it (`git push --delete origin vX; git tag -d vX`) and use `npm run ship` |
| Import Developer ID certificate | secrets missing/expired → the user re-sets the secrets per `docs/RELEASING.md` (you never handle certificate or key material yourself) |
| notarize: credentials not working | API key revoked / wrong issuer → same: user re-sets `NOTARY_API_KEY_P8` / `NOTARY_ISSUER_ID` |
| notarize: status Invalid | read the notary log the step printed (`xcrun notarytool log <id>` needs the key — ask the user, or check `release/notarize-*.log` in the run artifact) — usually an unsigned binary from a new dependency |
| Publish GitHub release | transient → rerun from the Actions tab: *Release → Run workflow → tag* (re-uploads assets) |

After a fix on `main`, **don't reuse the failed tag**: ship the next patch version.
A version that never published is fine to skip.

## Then deploy

When the release URL is printed, install it everywhere with the `deploy` skill:
`npm run deploy -- --remote=waldomacmini1`. Report: version, release URL, and both
"✓ Installed … (notarized release)" / "✓ Deployed to waldomacmini1" lines.

Fallback when GitHub Actions is down: `npm run release` builds and notarizes locally
with the `PD-notary` keychain profile, then `npm run deploy -- --no-build --remote=waldomacmini1`.
