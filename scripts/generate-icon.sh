#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT_DIR/src/renderer/public/corner-logo.png"
ICONSET="$ROOT_DIR/build/icon.iconset"
OUTPUT="$ROOT_DIR/build/icon.icns"

if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "This script requires macOS sips and iconutil." >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "Logo source not found: $SOURCE" >&2
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

cleanup() {
  rm -rf "$ICONSET"
}
trap cleanup EXIT

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$OUTPUT"
printf 'Generated %s\n' "$OUTPUT"
