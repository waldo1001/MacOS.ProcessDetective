#!/usr/bin/env bash
# Install Process Detective.app into an Applications folder so it's launchable
# from Spotlight / Launchpad. By default the app is the signed + notarized build
# from the latest GitHub release (built by CI); nothing is compiled locally.
#
#   bash scripts/install-app.sh                # latest release → ~/Applications
#   bash scripts/install-app.sh --tag=v0.1.1   # a specific release
#   bash scripts/install-app.sh --local-build  # build ad-hoc from this checkout (unreleased code)
#   bash scripts/install-app.sh --no-build     # install the existing ./ProcessDetective.app as-is
#   bash scripts/install-app.sh --system       # → /Applications  (folder must be writable)
#   bash scripts/install-app.sh --dest=/path   # → a custom folder
#   bash scripts/install-app.sh --remote=host  # also push the same bundle to another Mac
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Serialize against any other build/deploy — build-app.sh wipes the source
# bundle, which would otherwise vanish underneath a concurrent copy.
. "$ROOT/scripts/_lock.sh"
acquire_lock "$ROOT"
export PD_LOCK_HELD=1

DEST="$HOME/Applications"
SOURCE=release
TAG=""
REMOTES=()
for a in "$@"; do
  case "$a" in
    --system)    DEST="/Applications" ;;
    --dest=*)    DEST="${a#--dest=}" ;;
    --remote=*)  REMOTES+=("${a#--remote=}") ;;
    --tag=*)     TAG="${a#--tag=}" ;;
    --local-build) SOURCE=local ;;
    --no-build)  SOURCE=existing ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

case "$SOURCE" in
  release)
    bash scripts/fetch-release.sh ${TAG:+"$TAG"} ;;
  local)
    if [ ! -d node_modules ]; then echo "› Installing npm dependencies…"; npm install >/dev/null; fi
    bash scripts/build-app.sh ;;
esac

APP="$ROOT/ProcessDetective.app"
[ -d "$APP" ] || { echo "error: $APP not found — drop --no-build to fetch the latest release." >&2; exit 1; }

mkdir -p "$DEST"
if [ ! -w "$DEST" ]; then
  echo "error: $DEST is not writable. Use the default (~/Applications), or 'sudo' / fix permissions for $DEST." >&2
  exit 1
fi

TARGET="$DEST/ProcessDetective.app"
echo "› Installing to $TARGET"
osascript -e 'tell application "Process Detective" to quit' 2>/dev/null || true
sleep 0.5
rm -rf "$TARGET"

# Copy the bundle. rsync handles extended attributes cleanly; cp -R can exit
# non-zero on cosmetic xattr complaints even when every byte arrived. Neither
# exit code is trusted — the integrity check below is what decides.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$APP/" "$TARGET/" 2>/dev/null || COPY_WARNED=1
else
  cp -R "$APP" "$TARGET" 2>/dev/null || COPY_WARNED=1
fi

# Verify the copy for real, rather than believing the exit status.
SRC_N="$(find "$APP" -type f | wc -l | tr -d ' ')"
DST_N="$(find "$TARGET" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$SRC_N" != "$DST_N" ]; then
  echo "error: incomplete copy — $DST_N of $SRC_N files reached $TARGET." >&2
  echo "  The installed app may be broken. Re-run the install." >&2
  exit 1
fi
for required in "Contents/MacOS/ProcessDetective" "Contents/Resources/app/dist/index.js"; do
  [ -e "$TARGET/$required" ] || { echo "error: copy is missing $required" >&2; exit 1; }
done
[ -n "${COPY_WARNED:-}" ] && echo "  (copy reported extended-attribute warnings; all $SRC_N files verified present)"

xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

# Register with Launch Services so Spotlight / Launchpad find it immediately.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$TARGET" >/dev/null 2>&1 || true

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$TARGET/Contents/Info.plist" 2>/dev/null || echo '?')"
if codesign -dvv "$TARGET" 2>&1 | grep -q "^Authority=Developer ID Application"; then KIND="notarized release"; else KIND="ad-hoc local build"; fi
echo "✓ Installed Process Detective $VERSION ($KIND) → $TARGET"
echo "  Launch now:  open \"$TARGET\"   (or double-click it in Finder)"
echo "  Spotlight:   ⌘Space → 'Process Detective'  (after macOS indexes it / first launch)"

# Also push to any remote Macs (e.g. a Mac mini on Tailscale), reusing this build.
# Every remote is attempted even if an earlier one fails, and a failure is loud:
# a half-finished fleet must never look like a clean deploy.
if [ "${#REMOTES[@]}" -gt 0 ]; then
  FAILED=""
  for R in "${REMOTES[@]}"; do
    echo; echo "── Remote deploy → $R ──"
    if bash "$ROOT/scripts/deploy-remote.sh" "$R" --no-build; then :; else FAILED="$FAILED $R"; fi
  done
  echo
  if [ -n "$FAILED" ]; then
    echo "✗ Remote deploy FAILED for:$FAILED" >&2
    echo "  The local install above is fine; those Macs are still on the OLD build." >&2
    echo "  Retry with:  npm run deploy:remote --$FAILED --no-build" >&2
    exit 1
  fi
  echo "✓ All remotes up to date."
fi
