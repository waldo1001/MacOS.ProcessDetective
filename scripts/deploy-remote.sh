#!/usr/bin/env bash
# Deploy Process Detective.app to another Mac over SSH (e.g. a Mac mini on Tailscale).
# Rsyncs the bundle (which carries its own Node runtime), then on the remote:
# clears quarantine, re-signs ad-hoc (only if the build is not Developer ID
# signed), and registers with Launch Services.
#
#   bash scripts/deploy-remote.sh waldomacmini1
#   bash scripts/deploy-remote.sh user@100.69.33.109 --no-build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HOST="${1:?usage: deploy-remote.sh <user@host | tailscale-name> [--no-build]}"
BUILD=1
for a in "${@:2}"; do [ "$a" = "--no-build" ] && BUILD=0; done

# Only lock when we are going to rebuild — install-app.sh already holds the lock
# when it calls us with --no-build, and re-acquiring it would deadlock.
if [ "$BUILD" = 1 ]; then
  . "$ROOT/scripts/_lock.sh"
  acquire_lock "$ROOT"
export PD_LOCK_HELD=1
  bash scripts/build-app.sh
fi
APP="$ROOT/ProcessDetective.app"
[ -d "$APP" ] || { echo "error: $APP not found." >&2; exit 1; }

# Braces are required: macOS ships bash 3.2, which is not UTF-8 aware when
# parsing variable names. In "$HOST…" it swallows the ellipsis bytes into the
# name and expands the unset "HOST…", which `set -u` turns into a fatal error.
echo "› Checking SSH to ${HOST}…"
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" 'echo ok' >/dev/null 2>&1; then
  echo "error: cannot SSH to '$HOST' without a password." >&2
  echo "  On the Mac mini: System Settings → General → Sharing → enable Remote Login." >&2
  echo "  Then from this Mac:  ssh-copy-id $HOST   (one-time key setup)." >&2
  exit 1
fi

REMARCH="$(ssh "$HOST" 'uname -m')"
LOCARCH="$(uname -m)"
if [ "$REMARCH" != "$LOCARCH" ]; then
  echo "WARNING: remote arch ($REMARCH) != local ($LOCARCH). The native launcher is compiled for $LOCARCH and will NOT run on $REMARCH." >&2
  echo "         Build on a $REMARCH Mac, or skip the native app there." >&2
fi

echo "› Syncing to $HOST:~/Applications/ProcessDetective.app …"
ssh "$HOST" 'mkdir -p ~/Applications'
rsync -az --delete "$APP/" "$HOST:Applications/ProcessDetective.app/"

echo "› Finalizing on $HOST (quarantine · sign · register)…"
ssh "$HOST" bash -s <<'REMOTE'
set -e
APP="$HOME/Applications/ProcessDetective.app"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
# A Developer ID signature is valid everywhere — never replace it with ad-hoc.
if codesign -dvv "$APP" 2>&1 | grep -q "Authority=Developer ID Application"; then
  echo "  Developer ID signed build — keeping signature."
else
  codesign --force --options runtime --sign - --entitlements /dev/stdin "$APP/Contents/MacOS/node" >/dev/null 2>&1 <<'ENT' || true
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
ENT
  codesign --force --options runtime --sign - "$APP" >/dev/null 2>&1 || true
fi
L="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$L" ] && "$L" -f "$APP" >/dev/null 2>&1 || true
echo "  installed on $(hostname -s): node=$("$APP/Contents/MacOS/node" -v 2>/dev/null || echo BROKEN) arch=$(uname -m)"
REMOTE

echo "✓ Deployed to $HOST  →  launch there with:  open ~/Applications/ProcessDetective.app"
