#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/../src-tauri" && pwd)"

SRC="$TAURI_DIR/android"
DST="$TAURI_DIR/gen/android"

if [ ! -d "$SRC" ]; then
  echo "error: source directory not found: $SRC" >&2
  exit 1
fi

if [ ! -d "$DST" ]; then
  echo "error: target directory not found: $DST" >&2
  exit 1
fi

echo "Copying android assets..."
echo "  src: $SRC"
echo "  dst: $DST"

cp -v "$SRC/app/build.gradle.kts" "$DST/app/build.gradle.kts"
cp -rv "$SRC/app/src/main/res/." "$DST/app/src/main/res/"

if [ -d "$SRC/app/src/main/play" ]; then
  cp -rv "$SRC/app/src/main/play/." "$DST/app/src/main/play/"
  cp -v "$SCRIPT_DIR/../static/icons/icon-512.png" "$DST/app/src/main/play/icon.png"
fi

echo "Done."
