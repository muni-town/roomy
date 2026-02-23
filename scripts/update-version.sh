#!/usr/bin/env sh

set -e

CURRENT_VERSION=$(jq -r .version packages/app/src-tauri/tauri.conf.json)
echo "Current version: $CURRENT_VERSION"

# Parse version components
IFS='.-' read -r MAJOR MINOR PATCH SUFFIX <<< "$CURRENT_VERSION"

echo ""
echo "Select version increment:"
echo "1) increment major version ($MAJOR -> $((MAJOR + 1)))"
echo "2) increment minor version ($MINOR -> $((MINOR + 1)))"
echo "3) increment patch version ($PATCH -> $((PATCH + 1)))"
read -p "Enter choice [1-3]: " CHOICE

case $CHOICE in
  1)
    NEW_VERSION="$((MAJOR + 1)).0.0"
    ;;
  2)
    NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
    ;;
  3)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

# Preserve suffix if exists (e.g., -alpha)
if [ -n "$SUFFIX" ]; then
  NEW_VERSION="$NEW_VERSION-$SUFFIX"
fi

echo ""
echo "new version is $NEW_VERSION"

read -p "Proceed with version bump? [y/N]: " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted"
  exit 0
fi

# Check if working tree is clean
if ! git diff-index --quiet HEAD --; then
  echo ""
  echo "Warning: Working tree is not clean"
  read -p "Continue anyway? [y/N]: " DIRTY_CONFIRM
  if [ "$DIRTY_CONFIRM" != "y" ] && [ "$DIRTY_CONFIRM" != "Y" ]; then
    echo "Aborted"
    exit 0
  fi
fi

jq --arg version "$NEW_VERSION" '.version = $version' packages/app/src-tauri/tauri.conf.json > tmp.$$.json && mv tmp.$$.json packages/app/src-tauri/tauri.conf.json

echo ""
echo "Updated version to $NEW_VERSION"

read -p "Commit changes? [y/N]: " COMMIT_CONFIRM
if [ "$COMMIT_CONFIRM" = "y" ] || [ "$COMMIT_CONFIRM" = "Y" ]; then
  git add ./packages/app/src-tauri/tauri.conf.json
  git commit -m "chore: bump version to $NEW_VERSION"
  git tag v$NEW_VERSION -m "tag version $NEW_VERSION"
  echo "Changes committed"
fi

echo "Done!"