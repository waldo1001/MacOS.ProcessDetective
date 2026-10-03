---
name: deploy
description: Build, ad-hoc-sign, and install the Process Detective macOS app into the user's Applications folder so it's launchable from Spotlight/Launchpad. Use when the user wants to deploy, install, update, reinstall, or "ship to my Mac" the local app. Local only; for a Developer ID signed + notarized release for other people use `npm run release` (see docs/RELEASING.md).
---

# Deploy Process Detective (local Mac app)

This installs the native app (`ProcessDetective.app`) into an Applications folder
on **this** Mac. It is ad-hoc signed and quarantine-cleared so it launches without
Gatekeeper friction. Nothing is uploaded anywhere.

## Do this

1. **Always deploy to BOTH this Mac and the Mac mini** (`waldomacmini1`) in one run:
   ```bash
   npm run deploy -- --remote=waldomacmini1
   ```
   Default local destination is `~/Applications` (no admin rights). The run will:
   install npm deps if missing → compile TypeScript → bundle (own Node runtime +
   production deps only) + ad-hoc sign with hardened runtime → quit any running
   copy → copy to `~/Applications` → clear quarantine → register with Launch
   Services → then rsync the same build to `waldomacmini1` and finalize it there
   (clear quarantine, re-sign, register). The remote needs no Node install.

   Confirm both lines print success: the local "✓ Installed …" and the remote
   "✓ Deployed to waldomacmini1". If the mini is unreachable, the local install
   still succeeds and the remote step fails fast with a clear hint — report that
   and continue (don't treat a sleeping mini as a total failure).

   Variants (pass through with `--`):
   - Local only (skip the mini): `npm run deploy`.
   - System-wide: `npm run deploy -- --system` (installs to `/Applications`; that
     folder must be writable, otherwise it errors with a hint).
   - Custom folder: `npm run deploy -- --dest=/some/path`.
   - Reinstall the already-built bundle without recompiling: `npm run deploy -- --no-build`.
   - **Also deploy to a remote Mac in the same run** (e.g. the Mac mini on
     Tailscale): `npm run deploy -- --remote=waldomacmini1` (repeatable). This
     installs locally, then rsyncs the same build to the remote.

   **Remote only** (no local install): `npm run deploy:remote -- <host>`, e.g.
   `npm run deploy:remote -- waldomacmini1`. The remote step rsyncs the bundle,
   then on the remote re-resolves Node, re-signs ad-hoc, clears quarantine, and
   registers with Launch Services. Requires passwordless SSH (Remote Login on the
   remote + `ssh-copy-id`) and a matching CPU arch (launcher and bundled Node are
   built for the build machine's arch). The known Mac mini is `waldomacmini1`
   (Tailscale IP `100.69.33.109`), arm64.

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

- **Updating after code changes:** just run the skill again — it rebuilds and
  replaces the installed copy. If a copy is running, the script quits it first.
- **`~/Applications` vs `/Applications`:** the default user folder never needs
  `sudo`. `/Applications` is fine on a personal admin Mac if writable; if the copy
  fails with a permissions error, fall back to the default or fix the folder perms.
- **Local-only signature:** ad-hoc signing trusts the app on this Mac only. Copying
  it to a different Mac triggers a one-time right-click → Open prompt — expected.
- **Prereqs (build machine only):** Node on PATH (it is copied into the bundle as
  `Contents/MacOS/node`) and Xcode Command Line Tools (`xcode-select --install`)
  for `swiftc`. The script surfaces a clear error if either is missing.
- **Release builds** (Developer ID + notarization, for people who are not you) are
  a separate flow: `npm run release` → `scripts/notarize.sh`, documented in
  `docs/RELEASING.md`. Never run that from this skill.
- **Icon:** the app icon is prebuilt at `icon/AppIcon.icns` and copied into the
  bundle by the build script. Regenerate it from `icon/icon.html` with
  `npm run icon` (uses headless Chrome to rasterize, then `sips`/`iconutil`). If
  Finder/Dock still shows the old icon after an update, it's icon-cache lag —
  `touch` the .app or log out/in.
- The scripts live at `scripts/build-app.sh`, `scripts/install-app.sh`,
  `scripts/deploy-remote.sh`, `scripts/notarize.sh`, `scripts/make-icon.sh`;
  install/remote/notarize call the build script internally. Node entitlements
  live in `native/node.entitlements`.
