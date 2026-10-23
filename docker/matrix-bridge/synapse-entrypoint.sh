#!/bin/sh
# Configure and start Synapse with the appservice registration the bridge wrote.
#
# Two things have to be true before Synapse will carry an encrypted bridge:
#
#  * the registration names the bridge's URL and tokens, and sets
#    `org.matrix.msc3202` and `io.element.msc4190` — these are per-registration
#    flags in Synapse, not homeserver-wide settings, and without them
#    `/transactions` carries neither device lists nor to-device messages;
#  * the bridge container has written its registration to the shared volume.
#
# `generate` is only run when there is no config, so a restart onto the same
# volume keeps the signing key and the database rather than re-provisioning.
set -eu

DATA=/data
# The bridge container writes this onto the shared volume; both mounted it at
# `/shared`. Reading it from `/data` would look right in a single-container
# deployment and silently never see the file here.
REGISTRATION="${BRIDGE_SHARED_DIR:-/shared}/registration.yaml"
CONFIG="$DATA/homeserver.yaml"

log() { printf '[synapse] %s\n' "$*" >&2; }

if [ ! -f "$CONFIG" ]; then
    log "generating the Synapse config"
    python -m synapse.app.homeserver \
        --server-name "${HOMESERVER_DOMAIN:-matrix.roomy.local}" \
        --config-path "$CONFIG" \
        --generate-config \
        --report-stats=no
fi

# Point Synapse at Postgres. Written every boot so a changed password takes
# effect, and kept out of the generated file so a regeneration cannot lose it.
python - "$CONFIG" <<'PY'
import os
import sys

path = sys.argv[1]
with open(path) as handle:
    text = handle.read()

# `--generate-config` binds the listener to loopback only, which is right for a
# single-host install and wrong here: the bridge reaches this homeserver by its
# service name, from another container. Left alone, every request from the
# bridge is refused at the socket while the healthcheck (which runs inside this
# container, against localhost) reports healthy.
loopback = "    - ::1\n    - 127.0.0.1"
if loopback in text:
    text = text.replace(loopback, "    - 0.0.0.0")
elif "    - 0.0.0.0" not in text:
    print(
        "[synapse] warning: no loopback listener found to widen; leaving listeners as configured",
        file=sys.stderr,
    )

registration = os.environ.get("BRIDGE_SHARED_DIR", "/shared") + "/registration.yaml"
registration_block = (
    f"app_service_config_files:\n  - {registration}"
    if os.path.exists(registration)
    else "# no appservice registration yet; the bridge writes it on first boot"
)

marker = "# --- roomy-matrix: managed block ---"
if marker in text:
    text = text.split(marker)[0].rstrip() + "\n"

block = f"""
{marker}
database:
  name: psycopg2
  args:
    user: synapse
    password: "{os.environ.get('POSTGRES_PASSWORD', '')}"
    database: synapse
    host: postgres
    port: 5432
    cp_min: 5
    cp_max: 10

# The appservice registration the bridge container writes. Synapse refuses to
# start when a registration it names is missing, and on a first boot there is
# none: the bridge cannot write one until this homeserver answers its capability
# probe. So the line appears only once the file exists, and a restart after the
# bridge has written it — which the bridge container asks for — loads it.
{registration_block}

# MSC3202 and MSC4190 are enabled per registration (see the registration file),
# but Synapse also needs the experiment switched on at the homeserver level for
# the encryption paths to run.
experimental_features:
  msc3202_transaction_extensions: true
  msc3202_device_masquerading: true
  msc2409_to_device_messages_enabled: true
  msc4190_appservice_device_management: true

rc_login:
  address:
    per_second: 0.17
    burst_count: 3
  account:
    per_second: 0.17
    burst_count: 3
  failed_attempts:
    per_second: 0.17
    burst_count: 3

# The integration suite creates a room per case and one bridge per room; the
# default limits are sized for a client, not for a test that does that back to
# back.
rc_message:
  per_second: 100
  burst_count: 200
rc_registration:
  per_second: 10
  burst_count: 100
# `createRoom` has its own limiter (burst 10 by default), which a bridge's
# first-run provisioning of many channels reaches.
rc_room_creation:
  per_second: 100
  burst_count: 200
rc_invites:
  per_room:
    per_second: 100
    burst_count: 200
  per_user:
    per_second: 100
    burst_count: 200
  per_issuer:
    per_second: 100
    burst_count: 200
rc_joins:
  local:
    per_second: 100
    burst_count: 200
  remote:
    per_second: 100
    burst_count: 200

enable_room_list_search: false
"""

with open(path, "w") as handle:
    handle.write(text + block)
PY

log "starting Synapse"
exec python -m synapse.app.homeserver --config-path "$CONFIG"
