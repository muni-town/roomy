#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://app-lite.roomy.chat)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  SCOPE STRING                                                              ║
# ║  IMPORTANT: Keep this in sync with src/lib/config.ts (APPSERVER_RPCS).     ║
# ║  Every NSID in APPSERVER_RPCS must appear here as rpc:<nsid>?aud=*.        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

SCOPE="atproto"
SCOPE+=" rpc:app.bsky.actor.getProfiles?aud=did:web:api.bsky.app%23bsky_appview"
SCOPE+=" rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview"
SCOPE+=" blob:*/*"

# ── Appserver RPCs (must match APPSERVER_RPCS in config.ts) ──────────────
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
SCOPE+=" rpc:space.roomy.room.updateSeen?aud=*"
SCOPE+=" rpc:space.roomy.space.sendEvents?aud=*"
SCOPE+=" rpc:space.roomy.space.createSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.joinSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.leaveSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.getCalendarLink?aud=*"
SCOPE+=" rpc:space.roomy.space.getCalendarEvents?aud=*"

# ── Build-time verification ──────────────────────────────────────────────
# Ensure every NSID in APPSERVER_RPCS (config.ts) is present in the scope.
# This catches drift at build time instead of at the PDS consent screen.
MISSING=$(SCOPE="${SCOPE}" node -e "
const fs = require('fs');
const src = fs.readFileSync('src/lib/config.ts', 'utf-8');
const match = src.match(/const APPSERVER_RPCS\s*=\s*\[([\s\S]*?)\];/);
if (!match) { console.error('Could not parse APPSERVER_RPCS from config.ts'); process.exit(1); }
const items = match[1].split(/['\"]/).filter((_, i) => i % 2 === 1);
const scope = process.env.SCOPE || '';
const missing = items.filter(nsid => !scope.includes('rpc:' + nsid));
if (missing.length) {
  console.log(missing.join('\n'));
}
")
if [ -n "$MISSING" ]; then
  echo "ERROR: The following NSIDs from APPSERVER_RPCS are missing from the scope string:" >&2
  echo "$MISSING" | sed 's/^/  /' >&2
  echo "Add them to the SCOPE assembly in build-prod.sh" >&2
  exit 1
fi

# Build the OAuth client metadata JSON
oauth_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-metadata.json",
  "client_name": "Roomy Lite",
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

echo "Scope: ${SCOPE:0:120}..."
echo "$oauth_config"

echo "$oauth_config" > build/oauth-client-metadata.json

echo "Done! OAuth metadata written to build/oauth-client-metadata.json"
