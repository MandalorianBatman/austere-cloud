#!/usr/bin/env bash
# Renders scripts/og/og.html to src/og.png (1200x630) and the favicon to src/apple-touch-icon.png (180x180).
# Needs Google Chrome and Barlow Condensed Bold (OFL): pass the .ttf path as $1. The font is used for the raster only; it is not shipped.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../src"
font="${1:?usage: render.sh path/to/BarlowCondensed-Bold.ttf}"
chrome="${CHROME:-google-chrome}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/og.html" "$tmp/og.html"
cp "$font" "$tmp/BarlowCondensed-Bold.ttf"
shot() { "$chrome" --headless=new --no-sandbox --hide-scrollbars --force-device-scale-factor=1 --window-size="$1" --screenshot="$2" "$3" >/dev/null 2>&1; }
shot 1200,630 "$src/og.png" "file://$tmp/og.html"
# Same artwork as /favicon.svg (src/site.ts FAVICON_SVG), full bleed.
svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000000"/><path d="M16 5 27 26H21.4L16 15.2 10.6 26H5z" fill="none" stroke="#F2553C" stroke-width="3"/><path d="M11.5 22h9" stroke="#F2553C" stroke-width="3"/></svg>'
printf '<!doctype html><style>*{margin:0}svg{display:block;width:180px;height:180px}</style>%s' "$svg" > "$tmp/icon.html"
shot 180,180 "$src/apple-touch-icon.png" "file://$tmp/icon.html"
