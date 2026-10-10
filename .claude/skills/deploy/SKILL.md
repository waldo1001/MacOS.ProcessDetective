---
name: deploy
description: Install the Process Detective macOS app on this Mac and the Mac mini from the latest GitHub release (signed + notarized by CI), so it's launchable from Spotlight/Launchpad. Use when the user wants to deploy, install, update, reinstall, or "ship to my Mac". To publish a new release first, use `npm run ship` (see docs/RELEASING.md).
---

# Deploy Process Detective (from the GitHub release)

The app that gets installed is the one CI built, signed with Developer ID and
notarized for the latest GitHub release — not a local build. `scripts/fetch-release.sh`
downloads it and refuses it unless the checksum, the Developer ID signature of team
92A2K3Q7NH, the stapled notarization ticket and Gatekeeper all check out.

## Do this

0. **Unreleased changes on `main`?** Deploying installs the latest *release*, so
   code that has not been released is not in it. If the user wants their latest
   changes installed, cut a release first (needs a clean, pushed `main`):
   ```bash
   npm run ship              # patch bump → tag → CI signs + notarizes → GitHub release
   ```
   It follows the release run and prints the release URL when done (~5-15 min,
   mostly Apple's notary service).

1. **Always deploy to BOTH this Mac and the Mac mini** (`waldomacmini1`) in one run:
   ```bash
   npm run deploy -- --remote=waldomacmini1
   ```
   Default local destination is `~/Applications` (no admin rights). The run will:
   download + verify the latest release → quit any running copy → copy to
   `~/Applications` → register with Launch Services → rsync the same bundle to
   `waldomacmini1` and register it there (the Developer ID signature is kept).

   Confirm both lines print success: the local "✓ Installed Process Detective
   <version> (notarized release) …" and the remote "✓ Deployed to waldomacmini1".
   If the mini is unreachable, the local install still succeeds and the remote
   step fails fast with a clear hint — report that and continue (don't treat a
   sleeping mini as a total failure).

   Variants (pass through with `--`):
   - Local only (skip the mini): `npm run deploy`.
   - A specific release: `npm run deploy -- --tag=v0.1.1`.
   - **Unreleased code, for testing only:** `npm run deploy -- --local-build`
     builds this checkout ad-hoc signed (needs Node + Xcode CLT). Say clearly that
     this is not the release build.
   - System-wide: `npm run deploy -- --system` (installs to `/Applications`).
   - Reinstall the bundle already at `./ProcessDetective.app`: `npm run deploy -- --no-build`.

   **Remote only** (no local install): `npm run deploy:remote -- waldomacmini1`
   (accepts `--tag=`, `--local-build`, `--no-build`). Requires passwordless SSH
   (Remote Login + `ssh-copy-id`); the release is arm64, like the mini.

2. Verify it worked:
   ```bash
   codesign --verify --strict ~/Applications/ProcessDetective.app && echo signed-ok
   open ~/Applications/ProcessDetective.app   # launch by path always works
   ```
   Confirm the window opens and shows live data; then it's done.

3. Report back the exact install path the script printed, and the launch options:
   - **Now:** double-click it in Finder, or `open ~/Applications/ProcessDetective.app`.
   - **Spotlight / `open -a "Process Detective"`:** works once macOS indexes the
     app (a short delay for `~/Applications`, or immediately after the first launch).
     Don't treat the initial "Unable to find application named…" as a failure —
     it's just indexing lag; launching by path proves the install is good.

## Notes & gotchas

- **Updating after code changes:** `npm run ship`, then deploy again. If a copy
  is running, the script quits it first.
- **`~/Applications` vs `/Applications`:** the default user folder never needs
  `sudo`. `/Applications` is fine on a personal admin Mac if writable; if the copy
  fails with a permissions error, fall back to the default or fix the folder perms.
- **Prereqs:** `gh` (GitHub CLI) for the download. Only `--local-build` needs
  Node on PATH and Xcode Command Line Tools.
- **No release yet / fetch fails:** the error names the cause (no release, checksum,
  signature, ticket, Gatekeeper). Never fall back to `--local-build` silently.
- **Local notarized build** (`npm run release` → `scripts/notarize.sh`) still works
  as a fallback when GitHub Actions is unavailable; see `docs/RELEASING.md`.
- **Icon:** the app icon is prebuilt at `icon/AppIcon.icns` and copied into the
  bundle by the build script. Regenerate it from `icon/icon.html` with
  `npm run icon` (uses headless Chrome to rasterize, then `sips`/`iconutil`). If
  Finder/Dock still shows the old icon after an update, it's icon-cache lag —
  `touch` the .app or log out/in.
- The scripts live at `scripts/build-app.sh`, `scripts/install-app.sh`,
  `scripts/deploy-remote.sh`, `scripts/fetch-release.sh`, `scripts/ship.sh`,
  `scripts/notarize.sh`, `scripts/make-icon.sh`. Node entitlements
  live in `native/node.entitlements`.
