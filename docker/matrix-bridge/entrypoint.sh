#!/bin/sh
# First boot for the Roomy ↔ Matrix bridge.
#
# Everything here is idempotent: a container restarted onto the same volume
# reuses the tokens, the config, and the crypto device rather than generating a
# new identity. That matters more than it looks — a regenerated as_token makes
# the homeserver reject every send, and a regenerated crypto device loses every
# room key the bridge has received.
#
# Two modes:
#   serve   the normal path: write config if absent, then run the bridge.
#   probe   run the capability check and exit; used by the healthcheck.
set -eu

CONFIG="${BRIDGE_CONFIG:-/data/config.toml}"
DATA_DIR="$(dirname "$CONFIG")"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# A named volume is created root-owned, because the image declares /data before
# this process ever runs. Take ownership of the two writable trees, then drop to
# the unprivileged user that serves requests — the bridge holds an appservice
# token and an app-server password, and neither should be owned by root-readable
# only if that means the service cannot write them at all.
if [ "$(id -u)" = "0" ]; then
    chown -R roomybridge:roomybridge "$DATA_DIR" "${BRIDGE_SHARED_DIR:-/shared}" 2>/dev/null || true
    # setpriv ships with Debian's util-linux, so the runtime needs no extra
    # package to drop privileges.
    exec setpriv --reuid=roomybridge --regid=roomybridge --init-groups "$0" "$@"
fi

# ── tokens ────────────────────────────────────────────────────────────────────
# Generated once and kept. 32 bytes of base64url each, which is what the
# homeserver's registration expects.
token_file="$DATA_DIR/tokens.env"
if [ ! -f "$token_file" ]; then
    log "generating appservice tokens"
    umask 077
    {
        printf 'BRIDGE_AS_TOKEN=%s\n' "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
        printf 'BRIDGE_HS_TOKEN=%s\n' "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
        printf 'BRIDGE_GHOST_PREFIX=%s\n' "_roomy"
    } > "$token_file"
    umask 022
    chmod 600 "$token_file"
else
    log "reusing the tokens from $token_file"
fi
# shellcheck disable=SC1090
. "$token_file"

# ── config ────────────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG" ]; then
    log "writing $CONFIG"
    umask 077
    cat > "$CONFIG" <<EOF
# Generated on first boot. Values that are true for the whole process live here;
# which space a Matrix room is bridged into is a row in the bridge's database,
# created through the admin API.

[homeserver]
url = "${HOMESERVER_URL:-http://homeserver:8008}"
domain = "${HOMESERVER_DOMAIN:-matrix.roomy.local}"
as_token = "${BRIDGE_AS_TOKEN}"
hs_token = "${BRIDGE_HS_TOKEN}"
sender_localpart = "${BRIDGE_SENDER_LOCALPART:-_roomy_bridge}"

[bridge]
listen = "0.0.0.0:29331"
db_path = "${DATA_DIR}/bridge.sqlite"
bridge_did = "${BRIDGE_DID:-did:web:bridge.roomy.space}"
hostname = "${HOMESERVER_DOMAIN:-matrix.roomy.local}"
# The address the homeserver reaches this container on. Loopback is the
# bridge's own, not the homeserver's, so a compose deployment must name the
# service; the registration and the capability probe both depend on this.
transaction_url = "${BRIDGE_TRANSACTION_URL:-http://bridge:29331}"
ghost_prefix = "${BRIDGE_GHOST_PREFIX}"
backfill_limit = ${BRIDGE_BACKFILL_LIMIT:-50}
max_depth = ${BRIDGE_MAX_DEPTH:-2}

[bridge.e2ee]
# off | preferred | required
#
# \`required\` refuses to start unless the capability probe passes, which is the
# right setting for an operator who has decided encrypted rooms must work.
mode = "${BRIDGE_E2EE_MODE:-preferred}"

[appserver]
url = "${APPSERVER_URL:-https://api.roomy.space}"
did = "${APPSERVER_DID:-did:web:api.roomy.space}"
# Address the appserver as this DID instead of minting a service-auth token.
# Only for an appserver running in APPSERVER_TEST_MODE; empty everywhere else.
test_did = "${APPSERVER_TEST_DID:-}"

[atproto]
pds_url = "${PDS_URL:-https://bsky.social}"
identifier = "${ATPROTO_IDENTIFIER:-}"
app_password = "${ATPROTO_APP_PASSWORD:-}"
EOF
    umask 022
    chmod 600 "$CONFIG"
else
    log "reusing $CONFIG"
fi

# ── registration ──────────────────────────────────────────────────────────────
# The homeserver needs a registration whose url points at this container and
# whose tokens match the config. Rendering it here means the two cannot drift.
# Written to a volume the homeserver container also mounts, so the two cannot
# disagree about tokens or the namespace. `BRIDGE_SHARED_DIR` is `/shared` in the
# bundled image and unused by an operator who installs the registration by hand.
registration="$DATA_DIR/registration.yaml"
log "writing $registration"
umask 077
roomy-matrix-bridge --config "$CONFIG" --print-registration > "$registration"
umask 022
chmod 644 "$registration"

if [ -d "${BRIDGE_SHARED_DIR:-/shared}" ]; then
    shared="${BRIDGE_SHARED_DIR:-/shared}/registration.yaml"
    log "publishing the registration to $shared"
    cp "$registration" "$shared"
    chmod 644 "$shared"
fi

case "${1:-serve}" in
    serve)
        log "starting the bridge"
        exec roomy-matrix-bridge --config "$CONFIG"
        ;;
    probe)
        exec roomy-matrix-bridge --config "$CONFIG" --check-homeserver
        ;;
    registration)
        exec cat "$registration"
        ;;
    *)
        exec "$@"
        ;;
esac
