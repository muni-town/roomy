#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${BRIDGE_DB_PATH:-/data/bridge.sqlite}"

mkdir -p "$(dirname "$DB_PATH")"

if [ ! -f "$DB_PATH" ]; then
  echo "[entrypoint] no local DB found; attempting Litestream restore"
  litestream restore -if-replica-exists -config /etc/litestream.yml "$DB_PATH"
else
  echo "[entrypoint] existing DB at $DB_PATH; skipping restore"
fi

exec litestream replicate -config /etc/litestream.yml -exec "bun run /app/dist/index.js"
