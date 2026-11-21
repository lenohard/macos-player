#!/usr/bin/env bash
set -euo pipefail

# Corner Web icon only. The desktop app keeps its hand-made build/icon.icns|ico|png.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p src/renderer/web-public "$work/icon.iconset"
sips -s format png build/corner-web.svg --out "$work/source.png" >/dev/null
sips -z 512 512 "$work/source.png" --out src/renderer/web-public/corner-logo.png >/dev/null
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$work/source.png" --out "$work/icon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$work/source.png" --out "$work/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$work/icon.iconset" -o build/corner-web.icns
printf 'Generated Corner Web icon (build/corner-web.icns, src/renderer/web-public/corner-logo.png).\n'