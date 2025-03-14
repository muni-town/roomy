#!/bin/env bash

set -ex

# Install deno
curl -fsSL https://deno.land/install.sh | sh
deno="$HOME/.deno/bin/deno"

# Install dependencies
$deno install --allow-scripts
$deno run build

# Add oauth-client configuration
echo '{
  "client_id": "https://dev.roomy.chat/oauth-client.json",
  "client_name": "Roomy",
  "client_uri": "https://dev.roomy.chat",
  "logo_uri": "https://dev.roomy.chat/favicon.png",
  "tos_uri": "https://dev.roomy.chat",
  "policy_uri": "https://dev.roomy.chat",
  "redirect_uris": ["chat.roomy.dev:/oauth/callback"],
  "scope": "atproto transition:generic transition:chat.bsky",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "native",
  "dpop_bound_access_tokens": true
}' > dist/oauth-client.json
