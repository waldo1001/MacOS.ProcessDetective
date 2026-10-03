#!/usr/bin/env bash
# Render icon/icon.html → icon/AppIcon.icns (+ a preview PNG) using headless
# Chrome to rasterize, then sips/iconutil to assemble the iconset. Run on demand;
# the built .icns is what the app bundle ships, so normal builds don't need Chrome.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/icon"
SRC="$OUT/icon.html"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "error: Google Chrome not found (used only to rasterize the SVG)." >&2; exit 1; }

TMP="$(mktemp -d)"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 --window-size=1024,1024 \
  --screenshot="$TMP/master.png" "file://$SRC" >/dev/null 2>&1
[ -f "$TMP/master.png" ] || { echo "error: render failed" >&2; exit 1; }

ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
gen(){ sips -z "$1" "$1" "$TMP/master.png" --out "$ICONSET/$2" >/dev/null; }
gen 16 icon_16x16.png;    gen 32 icon_16x16@2x.png
gen 32 icon_32x32.png;    gen 64 icon_32x32@2x.png
gen 128 icon_128x128.png; gen 256 icon_128x128@2x.png
gen 256 icon_256x256.png; gen 512 icon_256x256@2x.png
gen 512 icon_512x512.png; gen 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT/AppIcon.icns"
cp "$TMP/master.png" "$OUT/icon-preview.png"
rm -rf "$TMP"
echo "✓ $OUT/AppIcon.icns  (preview: $OUT/icon-preview.png)"
