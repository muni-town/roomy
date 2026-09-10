#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://docs.roomy.space)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ── Scope string ──────────────────────────────────────────────────────────
# Derived from the endpoint registry so it can't drift: every registered XRPC
# method gets an rpc:<nsid>?aud=* scope. Admin endpoints are included — the
# appserver enforces its own admin allowlist, so non-admins get 403s.

SCOPE="$(node scripts/gen-oauth-scope.mjs)"

# Build the OAuth client metadata JSON
oauth_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-metadata.json",
  "client_name": "Roomy Docs",
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
