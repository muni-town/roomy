#!/usr/bin/env bash
set -euo pipefail

# ── Roomy appserver Docker entrypoint ────────────────────────────────────
#
# Litestream backups are OPTIONAL. If S3 credentials are not configured (e.g.
# the Railway S3 bucket isn't linked yet), the app runs directly with no
# backups — so the container never crashes just because backups aren't set up.
#
# When S3 IS configured, the entrypoint restores the appserver's static
# SQLite databases from S3 (via Litestream) when no local copy exists, then
# starts the app wrapped in `litestream replicate` so every WAL change is
# continuously copied to the backup bucket.
#
# On Railway the appserver's SQLite databases live on a persistent volume at
# /data, so they survive deploys. If a DB is absent/corrupt at boot (first
# deploy, or manual reset) it is restored from the S3 backup; otherwise the
# existing file wins and replication simply continues.
#
# ── Fail-closed safety ───────────────────────────────────────────────────
# Because /data is a persistent volume, a redeploy with a failed/missing
# backup still has its local DBs and does not silently discard data. The
# fail-closed check remains a safety net for the case where a local DB is
# absent AND no backup is restorable: we refuse to start fresh unless the
# operator has explicitly opted in via LITESTREAM_ALLOW_FRESH_START=true.
#
# Only the STATIC DBs (see litestream.yml) are restored. Per-space DBs under
# /data/spaces/ are derived and regenerate lazily via re-materialisation
# from the event log on first access, so they are intentionally not
# replicated or restored here.
#
# ── Shadow follower ──────────────────────────────────────────────────────
# ROOMY_SHADOW=1 also starts the Rust core as a follower beside the Bun
# service: it replays the production event log into its own data directory and
# serves nothing. It runs unprivileged (`shadow`), niced and ioniced, and it is
# supervised here — a follower that dies is restarted, never the container. Off
# by default, and the Bun service starts either way: see start_shadow().

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/spaces"

# ── Shadow follower configuration ────────────────────────────────────────
# The follower's data directory. `/shadow` is the image's default and is not on
# the volume unless a volume covers it; set ROOMY_DATA_DIR=/data/shadow to keep
# the projection beside the log (which roughly doubles the derived data on the
# volume, and survives a restart).
SHADOW_DATA_DIR="${ROOMY_DATA_DIR:-/shadow}"
# The log it replays: the owner's, not its own. Read, never written — the guard
# in start_shadow() refuses a follower that could write it.
SHADOW_EVENTS_DB="${ROOMY_EVENTS_DB:-$DATA_DIR/roomy-events.sqlite}"
SHADOW_HEALTH_ADDR="${ROOMY_HEALTH_ADDR:-127.0.0.1:8089}"
SHADOW_MAX_OPEN_SPACES="${ROOMY_MAX_OPEN_SPACES:-64}"

# The follower's address-space ceiling. Every open SQLite connection owns a page
# cache — SQLite's default is 2 MiB — and a worker holds one connection per space
# it follows: 64 spaces are 128 MiB. The Tokio runtime adds a 2 MiB stack per
# core (128 MiB on a 64-core host), the binary and its batch buffers are ~40 MiB,
# and glibc reserves up to 64 MiB of address space per arena (2 arenas, set below:
# 128 MiB). That is ~424 MiB, so 1 GiB leaves ~600 MiB of headroom and still stops
# a runaway follower from taking the host's memory with it.
SHADOW_AS_LIMIT="${ROOMY_SHADOW_AS_LIMIT:-1073741824}"

# ── Optional Litestream ──────────────────────────────────────────────────
# If any required S3 var is missing, the app runs directly (no backups). This
# keeps the container deployable before the bucket is linked and avoids the
# "bucket required for s3 replica" crash.
S3_CONFIGURED=1
if [ -z "${S3_BUCKET:-}" ] || [ -z "${S3_ENDPOINT:-}" ] || \
   [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "[entrypoint] S3 backup not configured (need S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)."
  echo "[entrypoint] Running WITHOUT Litestream backups."
  S3_CONFIGURED=0
fi

if [ "$S3_CONFIGURED" = "1" ]; then
  # Set to "true" ONLY to force a fresh start when S3 is unreachable and no
  # backup can be restored (e.g. first deploy against a misconfigured bucket).
  ALLOW_FRESH_START="${LITESTREAM_ALLOW_FRESH_START:-false}"

  # Static DBs replicated by litestream.yml. The event-log DB is the append-only
  # source of truth; read-state is a persistent source of truth; global holds
  # membership/profiles. Per-space DBs are derived and excluded.
  STATIC_DBS=(
    "$DATA_DIR/roomy-events.sqlite"
    "$DATA_DIR/roomy-readstate.sqlite"
    "$DATA_DIR/global.sqlite"
  )

  # SQLite database files begin with the 16-byte magic "SQLite format 3\0".
  # Used to detect a corrupt/truncated local DB so we restore over it instead of
  # trusting a bad file.
  is_valid_sqlite() {
    local db="$1"
    [ -f "$db" ] || return 1
    [ "$(head -c 16 "$db" 2>/dev/null)" = $'SQLite format 3\0' ]
  }

  restore_or_fail() {
    local db="$1"

    if [ -f "$db" ] && is_valid_sqlite "$db"; then
      echo "[entrypoint] existing valid DB at $db; skipping restore"
      return 0
    fi

    if [ -f "$db" ]; then
      echo "[entrypoint] WARNING: existing DB at $db is not a valid SQLite file; restoring over it" >&2
      rm -f "$db" "$db-wal" "$db-shm"
    fi

    echo "[entrypoint] no local DB at $db; attempting Litestream restore"
    # -if-replica-exists: exit 0 when the replica is absent (S3 reachable) OR
    # when it was restored; exit non-zero when S3 is unreachable/misconfigured.
    if litestream restore -if-replica-exists -config /etc/litestream.yml "$db"; then
      echo "[entrypoint] restored $db (or no backup exists yet)"
      return 0
    fi

    # Restore failed because S3 is unreachable/misconfigured. Do NOT start fresh
    # unless explicitly allowed, to avoid silently discarding data.
    if [ "$ALLOW_FRESH_START" = "true" ]; then
      echo "[entrypoint] WARNING: restore failed for $db; starting fresh (LITESTREAM_ALLOW_FRESH_START=true)" >&2
      return 0
    fi

    echo "[entrypoint] ERROR: no local DB and restore failed for $db (S3 unreachable or misconfigured)." >&2
    echo "[entrypoint] Refusing to start fresh to avoid data loss." >&2
    echo "[entrypoint] If this is intentional, set LITESTREAM_ALLOW_FRESH_START=true." >&2
    exit 1
  }

  for db in "${STATIC_DBS[@]}"; do
    mkdir -p "$(dirname "$db")"
    restore_or_fail "$db"
  done
fi

# ── The shadow follower ──────────────────────────────────────────────────
# The space DIDs the follower follows. Derived from the owner's per-space
# databases rather than configured: the follower replays every space the owner
# materialises, and a manual list is a list that goes stale on the next space.
shadow_spaces() {
  local db name out=""
  for db in "$DATA_DIR"/spaces/*.sqlite; do
    [ -e "$db" ] || continue
    name="${db##*/}"
    out="${out:+$out,}${name%.sqlite}"
  done
  printf '%s' "$out"
}

# Start the follower, or say why not, and return. It never fails the container:
# the Bun service is the deployment and the follower is an addition to it.
start_shadow() {
  SHADOW_SUPERVISOR=""
  [ "${ROOMY_SHADOW:-0}" = "1" ] || return 0

  local spaces problems=""
  spaces="$(shadow_spaces)"

  # The three ways a follower starts and does nothing useful, or does something
  # harmful, are all silent at launch. They are checked here, together, so one
  # restart reports all of them rather than one per restart.
  if [ -z "$spaces" ]; then
    problems="${problems}ROOMY_SPACES would be empty ($DATA_DIR/spaces holds no *.sqlite), "
  fi
  if [ "${ROOMY_OWNERSHIP:-}" != "follower" ]; then
    problems="${problems}ROOMY_OWNERSHIP is \"${ROOMY_OWNERSHIP:-unset}\" (must be \"follower\"; anything else means owner), "
  fi
  if [ -z "${ALLOY_URL:-}" ]; then
    problems="${problems}ALLOY_URL is unset (the follower would have no telemetry), "
  fi
  if [ "$(realpath -m "$SHADOW_DATA_DIR")" = "$(realpath -m "$DATA_DIR")" ]; then
    problems="${problems}ROOMY_DATA_DIR is $DATA_DIR, the owner's own directory (the follower needs one of its own), "
  fi
  if [ -n "$problems" ]; then
    echo "[entrypoint] shadow: not starting the follower — ${problems%, }"
    return 0
  fi

  mkdir -p "$SHADOW_DATA_DIR"
  chown shadow:roomy-shadow "$SHADOW_DATA_DIR"

  # The DAC guard: the follower must not be able to write the log it replays.
  # The binary opens it read-only, and this is the permission that makes that a
  # property of the deployment rather than of one code path.
  if setpriv --reuid=shadow --regid=roomy-shadow --clear-groups /usr/bin/test -w "$SHADOW_EVENTS_DB"; then
    echo "[entrypoint] shadow: not starting the follower — uid shadow ($(id -u shadow)) can write $SHADOW_EVENTS_DB ($(stat -c '%a %U:%G' "$SHADOW_EVENTS_DB")); the follower must not be able to write the log it replays"
    return 0
  fi

  echo "[entrypoint] shadow: following $spaces — log $SHADOW_EVENTS_DB, data $SHADOW_DATA_DIR, health $SHADOW_HEALTH_ADDR, uid shadow ($(id -u shadow)), as-limit $SHADOW_AS_LIMIT"

  # The child's environment, spelled out rather than inherited. The four values
  # the log sink reads are passed when they are set, so what the follower logs
  # with is what this script was told, not whatever else the container happens to
  # carry. An unset value stays unset: the binary's default applies.
  local -a shadow_env=(
    MALLOC_ARENA_MAX=2
    ROOMY_DATA_DIR="$SHADOW_DATA_DIR"
    ROOMY_EVENTS_DB="$SHADOW_EVENTS_DB"
    ROOMY_SPACES="$spaces"
    ROOMY_OWNERSHIP=follower
    ROOMY_HEALTH_ADDR="$SHADOW_HEALTH_ADDR"
    ROOMY_MAX_OPEN_SPACES="$SHADOW_MAX_OPEN_SPACES"
  )
  local name
  for name in ALLOY_URL APP_ENV BUILD_ID RUST_LOG; do
    if [ -n "${!name:-}" ]; then
      shadow_env+=("$name=${!name}")
    fi
  done

  # The target by host only: ALLOY_URL may carry credentials and this line reaches
  # the container log. Whether the sink exists at all is the other half of "will
  # the follower's lines be in Grafana".
  if [ -n "${ALLOY_URL:-}" ]; then
    local host="${ALLOY_URL#*://}"
    host="${host%%/*}"
    host="${host##*@}"
    echo "[entrypoint] shadow: log sink enabled — $host (env ${APP_ENV:-unknown}, build ${BUILD_ID:-unknown})"
  else
    echo "[entrypoint] shadow: log sink disabled (ALLOY_URL unset); the follower logs to stdout only"
  fi

  # The supervisor. A crash restarts the follower with backoff; the subshell is
  # backgrounded before the app starts, so nothing here delays or blocks it, and
  # nothing it does can take the container down.
  (
    # Job control, so the follower starts with SIGINT at its default disposition.
    # A command backgrounded by a non-interactive shell is started with SIGINT
    # ignored, and an ignored signal survives `exec`: without this the child
    # arrives at `stop_child`'s `kill -INT` immune to it, ignores the interrupt
    # its shutdown path is built on, and is terminated by the watchdog instead.
    set -m
    child=""
    backoff=1

    # SIGINT, not SIGTERM: the follower's shutdown path is the ctrl-c path, and
    # that is the one that drains its Loki queue before exiting. A follower that
    # will not take it is told to terminate, so a restart is bounded.
    stop_child() {
      [ -n "$child" ] || return 0
      ( sleep 8; kill -TERM "$child" 2>/dev/null ) &
      watchdog=$!
      kill -INT "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      kill "$watchdog" 2>/dev/null || true
      wait "$watchdog" 2>/dev/null || true
      child=""
    }
    trap 'stop_child; exit 0' TERM INT

    while :; do
      started="$(date +%s)"
      prlimit --as="$SHADOW_AS_LIMIT" -- \
        setpriv --reuid=shadow --regid=roomy-shadow --clear-groups \
        env "${shadow_env[@]}" \
        nice -n 19 ionice -c3 /usr/local/bin/roomy-appserver --role worker &
      child=$!

      status=0
      wait "$child" || status=$?
      child=""

      ran="$(( $(date +%s) - started ))"
      [ "$ran" -ge 60 ] && backoff=1
      echo "[entrypoint] shadow: follower exited (status $status) after ${ran}s; restarting in ${backoff}s"
      # A child sleep, so the TERM trap above interrupts the backoff instead of
      # waiting it out.
      sleep "$backoff" &
      wait $! 2>/dev/null || true
      [ "$backoff" -lt 60 ] && backoff="$(( backoff * 2 ))"
    done
  ) &
  SHADOW_SUPERVISOR=$!
  return 0
}

start_shadow

# Run the app under `litestream replicate` when backups are configured: Litestream
# monitors the static databases and replicates changes to S3 continuously, while
# forwarding signals to the Bun process.
if [ "$S3_CONFIGURED" = "1" ]; then
  APP_CMD=(litestream replicate -config /etc/litestream.yml \
    -exec "bun run packages/appserver/src/index.ts")
else
  APP_CMD=(bun run packages/appserver/src/index.ts)
fi

if [ -z "$SHADOW_SUPERVISOR" ]; then
  exec "${APP_CMD[@]}"
fi

# With a follower to stop, the app is a child of this shell: SIGTERM has to reach
# both, and the follower's interrupt path flushes its Loki sink before it exits.
"${APP_CMD[@]}" &
app_pid=$!
trap 'kill -TERM "$app_pid" "$SHADOW_SUPERVISOR" 2>/dev/null || true' TERM INT

status=0
wait "$app_pid" || status=$?

kill -TERM "$SHADOW_SUPERVISOR" 2>/dev/null || true
wait "$SHADOW_SUPERVISOR" 2>/dev/null || true
exit "$status"
