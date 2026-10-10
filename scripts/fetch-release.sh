#!/usr/bin/env bash
# Fetch the signed + notarized app from a GitHub release (built by
# .github/workflows/release.yml) and put it at ./ProcessDetective.app, where
# install-app.sh and deploy-remote.sh pick it up.
#
#   bash scripts/fetch-release.sh            # latest release
#   bash scripts/fetch-release.sh v0.1.1     # a specific tag
#
# Refuses anything that is not: checksum-matching, Developer ID signed by our
# team, notarized with a stapled ticket, and accepted by Gatekeeper.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TAG="${1:-}"
# Apple team that signs releases (public: it is embedded in every signed binary).
TEAM_ID="${PD_TEAM_ID:-92A2K3Q7NH}"

if [ "${PD_LOCK_HELD:-0}" != "1" ]; then
  . "$ROOT/scripts/_lock.sh"
  acquire_lock "$ROOT"
fi

command -v gh >/dev/null || { echo "error: gh (GitHub CLI) not found — brew install gh" >&2; exit 1; }
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
[ -n "$TAG" ] || TAG="$(gh release view -R "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
[ -n "$TAG" ] || { echo "error: no GitHub release found in $REPO — cut one with: npm run ship" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; type _release_lock >/dev/null 2>&1 && _release_lock' EXIT

echo "› Downloading $REPO $TAG…"
gh release download "$TAG" -R "$REPO" -D "$WORK" -p 'ProcessDetective-*.zip' -p 'SHA256SUMS.txt'
ZIP="$(ls "$WORK"/ProcessDetective-*.zip | head -1)"

echo "› Verifying checksum…"
( cd "$WORK" && shasum -a 256 -c SHA256SUMS.txt >/dev/null ) || { echo "error: checksum mismatch for $(basename "$ZIP")" >&2; exit 1; }

ditto -x -k "$ZIP" "$WORK/x"
NEW="$WORK/x/ProcessDetective.app"
[ -d "$NEW" ] || { echo "error: the zip does not contain ProcessDetective.app" >&2; exit 1; }

echo "› Verifying signature, notarization and Gatekeeper…"
codesign --verify --strict --deep "$NEW"
SIG="$(codesign -dvv "$NEW" 2>&1)"
grep -q "^Authority=Developer ID Application: .*($TEAM_ID)$" <<<"$SIG" \
  || { echo "error: not Developer ID signed by team $TEAM_ID" >&2; exit 1; }
grep -q "^TeamIdentifier=$TEAM_ID$" <<<"$SIG" || { echo "error: team identifier is not $TEAM_ID" >&2; exit 1; }
xcrun stapler validate "$NEW" >/dev/null || { echo "error: no stapled notarization ticket" >&2; exit 1; }
spctl -a -t exec "$NEW" 2>/dev/null || { echo "error: Gatekeeper rejects the app" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$NEW/Contents/Info.plist")"
rm -rf "$ROOT/ProcessDetective.app"
mv "$NEW" "$ROOT/ProcessDetective.app"
echo "✓ ProcessDetective.app $VERSION ($TAG) — notarized, Developer ID ($TEAM_ID)"
