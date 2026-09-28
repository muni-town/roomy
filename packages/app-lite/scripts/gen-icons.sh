#!/usr/bin/env bash
# Regenerate every platform's app icon from src-tauri/icons.manifest.json.
#
# The artwork lives in static/icons/icon-512.png (the manifest's `default`).
# To change the app icon: replace that file, run this script, commit the
# result. CI runs the same generation, so the committed icons/ are only what
# a local build uses.
#
# Usage: ./scripts/gen-icons.sh
set -euo pipefail

# Pinned to match the version the iOS workflow step drives; the options-server
# handshake between a driver and the generated xcode-script is version
# sensitive, so a skew shows up as a confusing build error.
TAURI_CLI_VERSION=2.12.0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

echo "Generating icons from src-tauri/icons.manifest.json..."
pnpm dlx "@tauri-apps/cli@$TAURI_CLI_VERSION" icon ./src-tauri/icons.manifest.json

# `ios init` synthesises the AppIcon catalog from the CLI's own template icon
# and `tauri icon` overwrites it there once the catalog exists (icon.rs
# prefers gen/apple/Assets.xcassets/AppIcon.appiconset, falling back to
# icons/ios). Strip the alpha channel the CLI always encodes: App Store
# Connect rejects an app icon containing one, and actool does not remove it.
CATALOG="src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset"
if [ -d "$CATALOG" ]; then
  python3 "$SCRIPT_DIR/flatten-png-alpha.py" "$CATALOG"/*.png
  if sips -g hasAlpha "$CATALOG"/*.png 2>/dev/null | grep -q 'hasAlpha: yes'; then
    echo "error: AppIcon entries still contain an alpha channel" >&2
    exit 1
  fi
else
  echo "note: no iOS catalog at $CATALOG (run 'tauri ios init' to create it)"
fi

echo "Done."
