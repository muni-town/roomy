#!/usr/bin/env bash
# Bring up the bridge end to end and run its integration tests.
#
# What this proves that `cargo test --workspace` cannot: a real homeserver pushes
# a real transaction, the bridge relays it into a real appserver, and the admin
# API answers. The unit tests cover the state machine; this covers the wiring.
#
# Usage:
#   scripts/matrix-bridge-e2e.sh            # Synapse (the default profile)
#   scripts/matrix-bridge-e2e.sh continuwuity
#
# Requires docker with compose v2 and a Rust toolchain at ~/.cargo/bin.
#
# The appserver runs in APPSERVER_TEST_MODE with an in-memory database, so the
# test needs no PDS, no OAuth, and no network beyond the compose network.
set -euo pipefail

# A stack that never becomes ready must fail, not hang. Every wait below is
# bounded; this ceiling backstops the script as a whole.
SECONDS=0
MAX_SECONDS=${MATRIX_E2E_MAX_SECONDS:-2400}

PROFILE="${1:-synapse}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.cargo/bin:${PATH}"
COMPOSE=(docker compose -f compose.matrix.yaml)
PROJECT=roomy-matrix-e2e

log() { printf '\n=== [%ss] %s ===\n' "$SECONDS" "$*" >&2; }

# Fail loudly if the whole run has gone on too long.
check_deadline() {
    if [ "$SECONDS" -gt "$MAX_SECONDS" ]; then
        log "the stack did not come up within ${MAX_SECONDS}s"
        exit 1
    fi
}

cleanup() {
    status=$?
    log "collecting logs"
    "${COMPOSE[@]}" --project-name "$PROJECT" logs --no-color --tail 200 > /tmp/matrix-bridge-e2e.log 2>&1 || true
    log "tearing down"
    "${COMPOSE[@]}" --project-name "$PROJECT" --profile synapse --profile continuwuity down -v >/dev/null 2>&1 || true
    # The appserver and the stub PDS run on the host, so compose does not stop
    # them. A leftover appserver holds :8080 and the next run fails at boot.
    if [ -f /tmp/matrix-bridge-e2e.pids ]; then
        while read -r pid; do
            kill "$pid" 2>/dev/null || true
        done < /tmp/matrix-bridge-e2e.pids
        rm -f /tmp/matrix-bridge-e2e.pids
    fi
    exit "$status"
}
trap cleanup EXIT

# ── appserver ────────────────────────────────────────────────────────────────
# Started on the host rather than in compose: the integration test reads it
# directly, and its test-mode auth needs no PDS.
log "starting the appserver in test mode"
(
    cd packages/appserver
    APPSERVER_TEST_MODE=true \
    APPSERVER_PORT=8080 \
    RATE_LIMIT_DISABLED=true \
    bun run src/index.ts
) > /tmp/matrix-bridge-appserver.log 2>&1 &
APPSERVER_PID=$!
echo "$APPSERVER_PID" >> /tmp/matrix-bridge-e2e.pids

appserver_ready=false
for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 http://127.0.0.1:8080/xrpc/_health >/dev/null 2>&1 \
        || curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
        appserver_ready=true
        break
    fi
    sleep 1
done
if [ "$appserver_ready" != true ]; then
    log "the appserver did not answer on :8080 within 60s"
    tail -40 /tmp/matrix-bridge-appserver.log >&2 || true
    exit 1
fi
log "appserver up"

# ── PDS ──────────────────────────────────────────────────────────────────────
# The bridge uploads Matrix media to the bridge account's PDS and refers to it as
# `atblob://<did>/<cid>`. A test stack has no PDS account, so a stub serving
# `createSession` and `uploadBlob` stands in; without it the attachment path
# cannot run at all.
log "starting the stub PDS"
bun scripts/matrix-bridge-stub-pds.ts 9998 > /tmp/matrix-bridge-pds.log 2>&1 &
PDS_PID=$!
echo "$PDS_PID" >> /tmp/matrix-bridge-e2e.pids
for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:9998/xrpc/_health >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! curl -fsS --max-time 2 http://127.0.0.1:9998/xrpc/_health >/dev/null 2>&1; then
    log "the stub PDS did not answer on :9998"
    exit 1
fi
log "stub PDS up"

# ── homeserver + bridge ───────────────────────────────────────────────────────
# The compose file's default profile is Synapse; continuwuity selects its own.
if [ "$PROFILE" = "continuwuity" ]; then
    export BRIDGE_E2EE_MODE=off
    COMPOSE_PROFILE=(--profile continuwuity)
    BRIDGE_SERVICE=bridge-continuwuity
    HOMESERVER_SERVICE=continuwuity
else
    COMPOSE_PROFILE=()
    BRIDGE_SERVICE=bridge
    HOMESERVER_SERVICE=homeserver
fi
export POSTGRES_PASSWORD=roomy-e2e-postgres
export HOMESERVER_DOMAIN=matrix.roomy.local
export BRIDGE_DID=did:web:bridge.roomy.local
export APPSERVER_URL=http://host.docker.internal:8080
export APPSERVER_DID=did:web:api.roomy.space
# The appserver runs in test mode, where this header is the whole of auth, so
# the bridge addresses it as this DID instead of needing a PDS session.
export APPSERVER_TEST_DID="did:plc:e2ebridgetest"
# The bridge still logs in to a PDS: that session is what authorises its blob
# uploads, which is how a Matrix attachment becomes an `atblob://` reference.
export ATPROTO_IDENTIFIER="bridge.test"
export ATPROTO_APP_PASSWORD="stub-password"
export PDS_URL="http://host.docker.internal:9998"

log "building the bridge image"
"${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" build "$BRIDGE_SERVICE"

log "starting $HOMESERVER_SERVICE and the bridge"
"${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" up -d postgres "$HOMESERVER_SERVICE"

# Wait for the homeserver before the bridge, whose first act is a capability
# probe against it. The result is checked: a loop that logs "healthy" on the
# deadline would report a stack that is not up and fail at some later step.
homeserver_ready=false
for _ in $(seq 1 120); do
    if "${COMPOSE[@]}" --project-name "$PROJECT" ps --format json "$HOMESERVER_SERVICE" \
        | grep -q '"Health":"healthy"'; then
        homeserver_ready=true
        break
    fi
    sleep 2
done
if [ "$homeserver_ready" != true ]; then
    log "$HOMESERVER_SERVICE did not become healthy within 240s"
    "${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" logs --no-color --tail 60 "$HOMESERVER_SERVICE" >&2 || true
    exit 1
fi
log "$HOMESERVER_SERVICE healthy"

# `--no-deps`: the homeserver is already healthy — this script waited for it
# above. Without it compose re-evaluates the dependency chain and can block
# there indefinitely, which is what an earlier run did: it sat in this command
# for half an hour after reporting the homeserver healthy.
timeout 120 "${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" \
    up -d --no-deps "$BRIDGE_SERVICE"

# Wait for the admin API to answer, and then *check* it did. A loop that breaks
# on success but falls through on the deadline would log "bridge up" and fail at
# some later step, hiding the reason.
bridge_ready=false
for _ in $(seq 1 90); do
    if curl -fsS --max-time 5 "http://127.0.0.1:29331/_roomy/admin/v1/health" >/dev/null 2>&1; then
        bridge_ready=true
        break
    fi
    sleep 2
done
if [ "$bridge_ready" != true ]; then
    log "the bridge did not answer /_roomy/admin/v1/health within 180s"
    "${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" logs --no-color --tail 60 "$BRIDGE_SERVICE" >&2 || true
    exit 1
fi
log "bridge up"

# ── the probe result ──────────────────────────────────────────────────────────
log "capability probe"
PROBE_OUTPUT=$(curl -fsS --max-time 30 http://127.0.0.1:29331/_roomy/admin/v1/capabilities | tee /dev/stderr)
echo "$PROBE_OUTPUT" > /tmp/matrix-bridge-capabilities.json

# ── fixtures the tests address ────────────────────────────────────────────────
# The bridge mints its appservice token on first boot and keeps it on the data
# volume; the registration it writes carries the same token. Reading it from
# there is what lets the test act as the appservice user, which is how a
# transaction is provoked at all.
log "collecting fixtures"
AS_TOKEN=$("${COMPOSE[@]}" --project-name "$PROJECT" "${COMPOSE_PROFILE[@]}" \
    exec -T "$BRIDGE_SERVICE" sed -n 's/^BRIDGE_AS_TOKEN=//p' /data/tokens.env)
if [ -z "$AS_TOKEN" ]; then
    log "the bridge did not publish an as_token; the integration tests cannot run"
    exit 1
fi

# The appserver runs in test mode, where `X-Test-Did` is the whole of auth. The
# tests read a space's messages and its members through it, so they need both a
# space that exists and a room inside it.
export E2E_TEST_DID="did:plc:e2ebridgetest"
SPACE_DID=$(curl -fsS -X POST "http://127.0.0.1:8080/xrpc/space.roomy.space.createSpace" \
    -H "X-Test-Did: $E2E_TEST_DID" -H 'Content-Type: application/json' \
    -d '{"name":"matrix bridge e2e","description":"","allowPublicJoin":true}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["spaceId"])')
# There is no `createRoom` procedure: a room is created by sending a
# `space.roomy.room.createRoom.v0` event, and the event's ulid becomes the room
# id. Both ids are minted here so the test knows the room without reading it
# back.
ROOMY_ROOM=$(python3 -c 'import time,random,sys; alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ"; t=int(time.time()*1000); s="".join(random.choice(alphabet) for _ in range(16)); sys.stdout.write(("".join(alphabet[(t >> (5*(9-i))) & 31] for i in range(10)))+s)')
curl -fsS -X POST "http://127.0.0.1:8080/xrpc/space.roomy.space.sendEvents" \
    -H "X-Test-Did: $E2E_TEST_DID" -H 'Content-Type: application/json' \
    -d "{\"spaceId\":\"$SPACE_DID\",\"events\":[{\"id\":\"$ROOMY_ROOM\",\"\$type\":\"space.roomy.room.createRoom.v0\",\"kind\":\"space.roomy.channel\",\"name\":\"bridge\"}]}" \
    >/dev/null
log "space $SPACE_DID, room $ROOMY_ROOM"

# ── integration tests ─────────────────────────────────────────────────────────
log "running integration tests"
export E2E_HOMESERVER_URL=http://127.0.0.1:8008
export E2E_APPSERVER_URL=http://127.0.0.1:8080
export E2E_HOMESERVER_DOMAIN="$HOMESERVER_DOMAIN"
export E2E_BRIDGE_URL=http://127.0.0.1:29331
export E2E_SENDER_LOCALPART=_roomy_bridge
export E2E_AS_TOKEN="$AS_TOKEN"
export E2E_SPACE_ID="$SPACE_DID"
export E2E_ROOMY_ROOM_ID="$ROOMY_ROOM"

cargo test -p roomy-matrix-bridge --test e2e -- --ignored --test-threads=1

log "integration tests passed"
