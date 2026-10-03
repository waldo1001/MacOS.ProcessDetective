#!/usr/bin/env bash
# Build ProcessDetective.app — a native macOS app that launches a BUNDLED Node
# runtime and shows the dashboard in a WKWebView window.
#
# The bundle is self-contained (own node binary, production deps only) and every
# Mach-O is signed with the hardened runtime, so the same build either runs
# locally (ad-hoc, default) or goes through notarization (scripts/notarize.sh).
#
#   bash scripts/build-app.sh                                  # ad-hoc signed
#   SIGN_IDENTITY="Developer ID Application: …" bash scripts/build-app.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="$ROOT/ProcessDetective.app"

# Never wipe the bundle while another build/deploy/notarization is using it.
# Callers that already hold the lock (install-app.sh, deploy-remote.sh,
# notarize.sh) set PD_LOCK_HELD=1 so we do not deadlock on our own lock.
if [ "${PD_LOCK_HELD:-0}" != "1" ]; then
  . "$ROOT/scripts/_lock.sh"
  acquire_lock "$ROOT"
fi
NODE="${PD_NODE:-$(command -v node || true)}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
VERSION="$(node -p "require('./package.json').version")"

if [ -z "$NODE" ]; then echo "error: node not found on PATH" >&2; exit 1; fi
if ! command -v swiftc >/dev/null; then echo "error: swiftc not found (install Xcode Command Line Tools)" >&2; exit 1; fi

echo "› Compiling TypeScript…"
npm run build >/dev/null

echo "› Assembling app bundle…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# Runtime payload: compiled JS + PRODUCTION deps only. Dev deps (esbuild, vite,
# rollup, fsevents) carry unsigned Mach-O binaries that notarization rejects.
cp -R dist "$APP/Contents/Resources/app/"
cp package.json package-lock.json "$APP/Contents/Resources/app/"
echo "› Installing production dependencies into the bundle…"
( cd "$APP/Contents/Resources/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent )
rm -f "$APP/Contents/Resources/app/package-lock.json"

# Bundled Node runtime. Shipped next to the launcher so codesign treats it as
# nested code; the launcher prefers it over any Node on the host.
echo "› Bundling Node $("$NODE" -v) ($(uname -m))…"
cp "$NODE" "$APP/Contents/MacOS/node"
chmod +x "$APP/Contents/MacOS/node"

# App icon (prebuilt; regenerate with scripts/make-icon.sh).
ICON_LINE=""
if [ -f "$ROOT/icon/AppIcon.icns" ]; then
  cp "$ROOT/icon/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  ICON_LINE="  <key>CFBundleIconFile</key><string>AppIcon</string>"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Process Detective</string>
  <key>CFBundleDisplayName</key><string>Process Detective</string>
  <key>CFBundleExecutable</key><string>ProcessDetective</string>
  <key>CFBundleIdentifier</key><string>community.macos.processdetective</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
${ICON_LINE}
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "› Compiling native launcher…"
swiftc -O native/AppMain.swift -o "$APP/Contents/MacOS/ProcessDetective" \
  -framework Cocoa -framework WebKit
chmod +x "$APP/Contents/MacOS/ProcessDetective"

# Guard: the only Mach-O files in the bundle must be the two we sign below.
# Anything else would be an unsigned binary that notarization rejects.
STRAY="$(find "$APP" -type f ! -path "$APP/Contents/MacOS/*" -print0 | xargs -0 file | grep -E 'Mach-O' || true)"
if [ -n "$STRAY" ]; then
  echo "error: unexpected Mach-O files in bundle:" >&2; echo "$STRAY" >&2; exit 1
fi

# Sign inside-out with the hardened runtime. Ad-hoc ("-") by default — same
# flags as a release build, so entitlement problems show up locally, not at
# notarization time. A real identity adds a secure timestamp (notarization
# requires it).
echo "› Signing (identity: $SIGN_IDENTITY)…"
TS="--timestamp=none"; [ "$SIGN_IDENTITY" != "-" ] && TS="--timestamp"
codesign --force --options runtime $TS --sign "$SIGN_IDENTITY" \
  --entitlements native/node.entitlements "$APP/Contents/MacOS/node"
codesign --force --options runtime $TS --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --strict --deep "$APP"

# Local builds: clear quarantine so the bundle opens without a Gatekeeper prompt.
[ "$SIGN_IDENTITY" = "-" ] && xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

SIZE="$(du -sh "$APP" | cut -f1)"
echo "✓ Built $APP ($SIZE, v$VERSION)"
echo "  Open it with:  open '$APP'   (or double-click in Finder)"
