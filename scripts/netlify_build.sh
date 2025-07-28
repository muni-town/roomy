#!/bin/env bash

set -ex

# Install dependencies
# deno upgrade
# deno install
# deno run build

export NETLIFY=true

pnpm install
pnpm build-web-app

target_url=""
if [ "$PULL_REQUEST" = "true" ]; then
  target_url="$DEPLOY_PRIME_URL"
else 
  target_url="$URL"
fi

# Add oauth-client configuration
echo "{
  \"client_id\": \"$target_url/oauth-client.json\",
  \"client_name\": \"Roomy\",
  \"client_uri\": \"$target_url\",
  \"logo_uri\": \"$target_url/favicon.png\",
  \"tos_uri\": \"$target_url\",
  \"policy_uri\": \"$target_url\",
  \"redirect_uris\": [\"$target_url/oauth/callback\"],
  \"scope\": \"atproto transition:generic transition:chat.bsky\",
  \"grant_types\": [\"authorization_code\", \"refresh_token\"],
  \"response_types\": [\"code\"],
  \"token_endpoint_auth_method\": \"none\",
  \"application_type\": \"web\",
  \"dpop_bound_access_tokens\": true
}" > packages/app/build/oauth-client.json

mv packages/app/build .
