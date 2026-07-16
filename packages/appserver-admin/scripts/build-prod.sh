#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://admin.roomy.space)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ── Scope string ──────────────────────────────────────────────────────────
# Admin dashboard only needs read access to spaces/rooms/messages plus
# admin endpoints. No repo scopes (no blob uploads, no handle writes).

SCOPE="atproto"
SCOPE+=" rpc:app.bsky.actor.getProfile?aud=*"
SCOPE+=" rpc:com.atproto.server.getServiceAuth?aud=${VITE_APPSERVER_DID:-did:web:appserver.roomy.chat}"

# ── Appserver RPCs (read queries) ────────────────────────────────────────
SCOPE+=" rpc:space.roomy.space.getSpaces?aud=*"
SCOPE+=" rpc:space.roomy.space.getMetadata?aud=*"
SCOPE+=" rpc:space.roomy.space.getThreads?aud=*"
SCOPE+=" rpc:space.roomy.space.getRoles?aud=*"
SCOPE+=" rpc:space.roomy.space.getMembers?aud=*"
SCOPE+=" rpc:space.roomy.space.getInvites?aud=*"
SCOPE+=" rpc:space.roomy.room.getMetadata?aud=*"
SCOPE+=" rpc:space.roomy.room.getMessages?aud=*"
SCOPE+=" rpc:space.roomy.room.getThreads?aud=*"
SCOPE+=" rpc:space.roomy.message.getMessage?aud=*"
SCOPE+=" rpc:space.roomy.auth.getConnectionTicket?aud=*"
SCOPE+=" rpc:space.roomy.getFlags?aud=*"

# ── Admin RPCs (write operations) ────────────────────────────────────────
SCOPE+=" rpc:space.roomy.admin.connectSpace?aud=*"
SCOPE+=" rpc:space.roomy.admin.materializeSpace?aud=*"
SCOPE+=" rpc:space.roomy.admin.getFlags?aud=*"
SCOPE+=" rpc:space.roomy.admin.setFlag?aud=*"
SCOPE+=" rpc:space.roomy.admin.clearFlag?aud=*"

# Build the OAuth client metadata JSON
oauth_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-metadata.json",
  "client_name": "Roomy Admin",
  "client_uri": "$target_url",
  "logo_uri": "$target_url/favicon.png",
  "redirect_uris": ["$target_url/"],
  "scope": "${SCOPE}",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}
EOF
)

echo "$oauth_config" > build/oauth-client-metadata.json

echo "Scope: ${SCOPE:0:120}..."
echo "Done! OAuth metadata written to build/oauth-client-metadata.json"
