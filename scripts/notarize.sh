#!/usr/bin/env bash
# Release build: sign with Developer ID, notarize with Apple, staple, and zip.
#
#   bash scripts/notarize.sh                      # auto-picks the Developer ID identity
#   bash scripts/notarize.sh --profile=PD-notary  # notarytool keychain profile (default)
#   bash scripts/notarize.sh --identity="Developer ID Application: Dynex (92A2K3Q7NH)"
#   bash scripts/notarize.sh --no-build           # re-notarize the existing bundle
#
# One-time setup (see docs/RELEASING.md):
#   1. Developer ID Application certificate in the login keychain.
#   2. xcrun notarytool store-credentials PD-notary --apple-id <id> --team-id <team>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/_lock.sh"
acquire_lock "$ROOT"
export PD_LOCK_HELD=1

PROFILE="PD-notary"
IDENTITY=""
BUILD=1
for a in "$@"; do
  case "$a" in
    --profile=*)  PROFILE="${a#--profile=}" ;;
    --identity=*) IDENTITY="${a#--identity=}" ;;
    --no-build)   BUILD=0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)"
fi
if [ -z "$IDENTITY" ]; then
  echo "error: no 'Developer ID Application' certificate in the keychain." >&2
  echo "  Create one: Xcode → Settings → Accounts → (team) → Manage Certificates → + → Developer ID Application" >&2
  exit 1
fi
# Credentials: the keychain profile locally; in CI the NOTARY_* environment
# variables (app-specific password), so no profile has to be stored first.
if [ -n "${NOTARY_APPLE_ID:-}" ] && [ -n "${NOTARY_TEAM_ID:-}" ] && [ -n "${NOTARY_PASSWORD:-}" ]; then
  AUTH=(--apple-id "$NOTARY_APPLE_ID" --team-id "$NOTARY_TEAM_ID" --password "$NOTARY_PASSWORD")
  AUTH_HINT="--apple-id \$NOTARY_APPLE_ID --team-id \$NOTARY_TEAM_ID --password \$NOTARY_PASSWORD"
else
  AUTH=(--keychain-profile "$PROFILE")
  AUTH_HINT="--keychain-profile $PROFILE"
fi
if ! xcrun notarytool history "${AUTH[@]}" >/dev/null 2>&1; then
  echo "error: notarytool credentials not found or not working ($AUTH_HINT)." >&2
  echo "  Store a profile once (interactive, asks for an app-specific password):" >&2
  echo "    xcrun notarytool store-credentials $PROFILE --apple-id <apple-id> --team-id <team-id>" >&2
  echo "  or set NOTARY_APPLE_ID, NOTARY_TEAM_ID and NOTARY_PASSWORD." >&2
  exit 1
fi

APP="$ROOT/ProcessDetective.app"
if [ "$BUILD" = 1 ]; then SIGN_IDENTITY="$IDENTITY" bash scripts/build-app.sh; fi
[ -d "$APP" ] || { echo "error: $APP not found." >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
OUT="$ROOT/release"
mkdir -p "$OUT"
ZIP="$OUT/ProcessDetective-$VERSION.zip"

echo "› Zipping for submission…"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "› Submitting to Apple notary service (this usually takes 1–5 minutes)…"
LOG="$OUT/notarize-$VERSION.log"
# No grep -q in the pipeline: it closes the pipe on first match, tee dies with
# SIGPIPE, and pipefail reports a failure for an accepted submission.
xcrun notarytool submit "$ZIP" "${AUTH[@]}" --wait 2>&1 | tee "$LOG" || true
if ! grep -q "status: Accepted" "$LOG"; then
  ID="$(grep -m1 -E '^\s*id:' "$LOG" | awk '{print $2}' || true)"
  echo "✗ Notarization not accepted. See $LOG" >&2
  [ -n "$ID" ] && echo "  Details:  xcrun notarytool log $ID $AUTH_HINT" >&2
  exit 1
fi

echo "› Stapling ticket…"
xcrun stapler staple "$APP" >/dev/null
xcrun stapler validate "$APP" >/dev/null

echo "› Gatekeeper check…"
spctl -a -vv -t exec "$APP" 2>&1 | sed 's/^/  /'

# Re-zip AFTER stapling so the ticket travels with the app.
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "✓ Notarized release: $ZIP"
echo "  Anyone can unzip and double-click it — no right-click → Open, no quarantine tricks."
