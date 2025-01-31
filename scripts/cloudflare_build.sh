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
  "client_id": "https://roomy.muni.town/oauth-client.json",
  "client_name": "Roomy",
  "client_uri": "https://roomy.muni.town",
  "logo_uri": "https://roomy.muni.town/favicon.png",
  "tos_uri": "https://roomy.muni.town",
  "policy_uri": "https://roomy.muni.town",
  "redirect_uris": ["https://roomy.muni.town/oauth/callback"],
  "scope": "atproto transition:generic transition:chat.bsky",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}' > dist/oauth-client.json
