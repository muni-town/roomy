#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://app-lite.roomy.chat)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# Build the scope string to match what app-lite uses
oauth_config="{
  \"client_id\": \"$target_url/oauth-client-metadata.json\",
  \"client_name\": \"Roomy Lite\",
  \"client_uri\": \"$target_url\",
  \"logo_uri\": \"$target_url/favicon.png\",
  \"redirect_uris\": [\"$target_url/\"],
  \"scope\": \"atproto rpc:app.bsky.actor.getProfiles?aud=did:web:api.bsky.app%23bsky_appview rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview blob:*/* rpc:space.roomy.space.getSpaces?aud=* rpc:space.roomy.space.getMetadata?aud=* rpc:space.roomy.space.getThreads?aud=* rpc:space.roomy.space.getRoles?aud=* rpc:space.roomy.space.getMembers?aud=* rpc:space.roomy.space.getInvites?aud=* rpc:space.roomy.room.getMetadata?aud=* rpc:space.roomy.room.getMessages?aud=* rpc:space.roomy.room.getThreads?aud=* rpc:space.roomy.msg.getMessage?aud=* rpc:space.roomy.auth.getConnectionTicket?aud=* rpc:space.roomy.room.updateSeen?aud=* rpc:space.roomy.space.sendEvents?aud=* rpc:space.roomy.space.getCalendarLink?aud=* rpc:space.roomy.space.getCalendarEvents?aud=*\",
  \"grant_types\": [\"authorization_code\", \"refresh_token\"],
  \"response_types\": [\"code\"],
  \"token_endpoint_auth_method\": \"none\",
  \"application_type\": \"web\",
  \"dpop_bound_access_tokens\": true
}"

echo "$oauth_config"

echo "$oauth_config" > build/oauth-client-metadata.json

echo "Done! OAuth metadata written to build/oauth-client-metadata.json"
