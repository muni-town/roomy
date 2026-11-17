#!/usr/bin/env bash
set -euo pipefail

# ── Rust appserver Docker entrypoint ─────────────────────────────────────
#
# Three things the binary cannot do for itself on a platform it does not know
# about, then the process.
#
#   1. Bind to the port the platform routes to. The binary reads
#      ROOMY_HTTP_ADDR and defaults to 127.0.0.1:8080, which is the right
#      default for a developer's machine and an invisible container on Railway,
#      where traffic arrives on $PORT from outside the network namespace.
#
#   2. Make the data directory usable. A volume mounted at ROOMY_DATA_DIR
#      arrives owned by root and covers the image's own copy, so the process
#      cannot create `/data/spaces` or write the databases it opens. That is
#      repaired here, and the binary then runs as an unprivileged user.
#
#   3. Tell an owner which spaces to materialise. An owner opens the spaces it
#      is given and never discovers new ones — discovery belongs to a follower
#      — so an owner with no ROOMY_SPACES serves nothing, whatever the log
#      holds. A restored or pre-existing log therefore has to be turned into a
#      space list here.
#
# No step may fail the container: a deployment that starts and serves nothing is
# a bug to read about in the log, not a crash loop. The script ends in `exec`,
# so the binary is PID 1's direct child and receives the platform's stop signal
# itself.

# A value that is set but blank counts as unset, the rule the binary follows for
# every path variable: a template that renders an empty value says nothing.
unset_if_blank() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    unset "$name" || true
  fi
}

unset_if_blank ROOMY_DATA_DIR
unset_if_blank ROOMY_EVENTS_DB
unset_if_blank ROOMY_HTTP_ADDR
unset_if_blank ROOMY_SPACES

ROOMY_DATA_DIR="${ROOMY_DATA_DIR:-/data}"
export ROOMY_DATA_DIR

# ── The listener ─────────────────────────────────────────────────────────
# Railway sets PORT and routes the service's public address to it. 8080 is the
# fallback so the image also runs under a plain `docker run`.
if [ -z "${ROOMY_HTTP_ADDR:-}" ]; then
  ROOMY_HTTP_ADDR="0.0.0.0:${PORT:-8080}"
  export ROOMY_HTTP_ADDR
fi
echo "[entrypoint] listening on $ROOMY_HTTP_ADDR"

# ── The data directory ────────────────────────────────────────────────────
# A volume mounted at ROOMY_DATA_DIR arrives owned by root and covers the
# image's own /data, so the unprivileged process cannot create `/data/spaces`
# inside it or write the databases it opens. Running as root is what lets this
# be repaired: the directory is handed to `roomy`, and the binary then runs as
# `roomy` below. Without root — no volume, or one the platform already owns —
# nothing is repaired, and a directory that cannot be created is a line rather
# than a dead container.
prepare_data_dir() {
  if ! mkdir -p "$ROOMY_DATA_DIR/spaces"; then
    echo "[entrypoint] cannot create $ROOMY_DATA_DIR/spaces as uid $(id -u); databases will not be writable"
    return 0
  fi
  if [ "$(id -u)" = 0 ]; then
    chown -R roomy:roomy "$ROOMY_DATA_DIR"
  fi
}

prepare_data_dir

# ── The spaces an owner materialises ─────────────────────────────────────
# The event log's `dids` table is the set of streams the log holds: one row per
# DID it carries events for, which is what the owner's space list is. Reading
# it beats a hand-kept list, which goes stale the first time a space is added.
#
# Every failure mode here is the same non-event: no file, no table, no rows, or
# no sqlite3 — the variable stays unset, and the process starts as it would
# have started without this block.
EVENTS_DB="${ROOMY_EVENTS_DB:-$ROOMY_DATA_DIR/roomy-events.sqlite}"
export ROOMY_EVENTS_DB="$EVENTS_DB"

derive_spaces() {
  local rows count spaces
  [ -f "$EVENTS_DB" ] || {
    echo "[entrypoint] ROOMY_SPACES unset and no log at $EVENTS_DB; nothing derived"
    return 0
  }

  rows="$(sqlite3 -readonly "$EVENTS_DB" "select did from dids" 2>/dev/null)" || {
    echo "[entrypoint] ROOMY_SPACES unset; could not read dids from $EVENTS_DB; nothing derived"
    return 0
  }
  rows="$(printf '%s' "$rows" | tr -d '\r' | sed '/^[[:space:]]*$/d')"
  if [ -z "$rows" ]; then
    echo "[entrypoint] ROOMY_SPACES unset and $EVENTS_DB holds no dids; nothing derived"
    return 0
  fi

  count="$(printf '%s\n' "$rows" | wc -l | tr -d '[:space:]')"
  spaces="$(printf '%s' "$rows" | paste -sd, -)"
  ROOMY_SPACES="$spaces"
  export ROOMY_SPACES
  echo "[entrypoint] derived $count spaces from $EVENTS_DB"
}

if [ -z "${ROOMY_SPACES:-}" ]; then
  derive_spaces || true
else
  echo "[entrypoint] using ROOMY_SPACES from the environment"
fi

# ── The process ──────────────────────────────────────────────────────────
# The binary runs as `roomy`, never as the uid this script may hold: repairing
# a mounted volume's ownership needs root, serving traffic does not. `exec`
# leaves the binary as PID 1's direct child, so the platform's stop signal
# reaches it.
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=roomy --regid=roomy --init-groups roomy-appserver "$@"
fi
exec roomy-appserver "$@"
