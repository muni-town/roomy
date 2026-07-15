#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://app-lite.roomy.chat)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  SCOPE STRING                                                              ║
# ║  IMPORTANT: Keep this in sync with src/lib/config.ts:                       ║
# ║    - APPSERVER_RPCS → rpc:<nsid>?aud=*                                     ║
# ║    - OAUTH_SCOPE rpc:/repo: quoted entries → verbatim                       ║
# ║    - OAUTH_SCOPE template literals (getServiceAuth, personalStream) →      ║
# ║      env-var-backed defaults below                                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

SCOPE="atproto"
SCOPE+=" rpc:app.bsky.actor.getProfiles?aud=*"
SCOPE+=" rpc:app.bsky.actor.getProfile?aud=*"
SCOPE+=" blob:*/*"

# ── Repo Scopes (blob uploads + handle writes) ───────────────────────────
SCOPE+=" repo:space.roomy.upload.v0"
SCOPE+=" repo:${VITE_STREAM_HANDLE_NSID:-space.roomy.space.handle.dev}"
SCOPE+=" repo:${VITE_PERSONAL_STREAM_NSID:-space.roomy.space.personal.dev}"

# ── Service auth (for direct/non-proxied XRPC calls) ───────────────────
SCOPE+=" rpc:com.atproto.server.getServiceAuth?aud=${VITE_APPSERVER_DID:-did:web:appserver.roomy.chat}"

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
SCOPE+=" rpc:space.roomy.message.getReactions?aud=*"
SCOPE+=" rpc:space.roomy.auth.getConnectionTicket?aud=*"
SCOPE+=" rpc:space.roomy.room.updateSeen?aud=*"
SCOPE+=" rpc:space.roomy.space.sendEvents?aud=*"
SCOPE+=" rpc:space.roomy.space.createSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.joinSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.leaveSpace?aud=*"
SCOPE+=" rpc:space.roomy.space.setHandle?aud=*"
SCOPE+=" rpc:space.roomy.space.getCalendarLink?aud=*"
SCOPE+=" rpc:space.roomy.space.getCalendarEvents?aud=*"
SCOPE+=" rpc:space.roomy.space.getActivityFeed?aud=*"

# ── Web push notification endpoints ──────────────────────────────────────
SCOPE+=" rpc:space.roomy.push.getVapidPublicKey?aud=*"
SCOPE+=" rpc:space.roomy.push.getPreferences?aud=*"
SCOPE+=" rpc:space.roomy.push.registerSubscription?aud=*"
SCOPE+=" rpc:space.roomy.push.unregisterSubscription?aud=*"
SCOPE+=" rpc:space.roomy.push.setPreferences?aud=*"

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

# Write first so the verification below can read the actual artifact
echo "$oauth_config" > build/oauth-client-metadata.json

echo "Scope: ${SCOPE:0:120}..."

# ── Build-time verification ──────────────────────────────────────────────
# Ensure every scope entry in config.ts (both RPC and repo) is present in
# the built OAuth metadata. This catches drift at build time instead of at
# the PDS consent screen. It reads the already-written
# oauth-client-metadata.json so we test the actual deployed artifact.
node -e "
const fs = require('fs');
const src = fs.readFileSync('src/lib/config.ts', 'utf-8');
const meta = fs.readFileSync('build/oauth-client-metadata.json', 'utf-8');
const parsed = JSON.parse(meta);
const scope = parsed.scope || '';
let hasErrors = false;

// Check APPSERVER_RPCS
const rpcMatch = src.match(/const APPSERVER_RPCS\s*=\s*\[([\s\S]*?)\]/);
if (rpcMatch) {
  const items = rpcMatch[1].split(/['\"]/).filter((_, i) => i % 2 === 1);
  const missing = items.filter((nsid) => !scope.includes('rpc:' + nsid));
  if (missing.length) {
    console.log('MISSING RPC SCOPES (from APPSERVER_RPCS):');
    missing.forEach(n => console.log('  ' + n));
    hasErrors = true;
  }
}

// Check OAUTH_SCOPE for rpc: and repo: entries (quoted strings only;
// template-literal entries like `repo:${CONFIG...}` are checked separately).
const scopeMatch = src.match(/export const OAUTH_SCOPE\s*=\s*\[([\s\S]*?)\]/);
if (scopeMatch) {
  const items = scopeMatch[1].split(/['\"]/).filter((_, i) => i % 2 === 1);
  const missingScopes = items
    .filter((s) => s.startsWith('repo:') || s.startsWith('rpc:'))
    .filter((s) => !scope.includes(s));
  if (missingScopes.length) {
    console.log('MISSING SCOPES (from OAUTH_SCOPE):');
    missingScopes.forEach(n => console.log('  ' + n));
    hasErrors = true;
  }
}

// Check that the getServiceAuth scope (a template literal in config.ts with a
// dynamic aud= value) is present by its static prefix. Without this scope
// the DirectXrpcClient cannot obtain service auth tokens.
if (!scope.includes('rpc:com.atproto.server.getServiceAuth?aud=')) {
  console.log('MISSING SCOPES (from OAUTH_SCOPE):');
  console.log('  rpc:com.atproto.server.getServiceAuth?aud=...');
  hasErrors = true;
}

if (hasErrors) {
  process.exit(1);
}
"
if [ $? -ne 0 ]; then
  echo "ERROR: Scopes from config.ts are missing from the OAuth scope." >&2
  echo "Add them to the SCOPE assembly in build-prod.sh" >&2
  exit 1
fi

echo "All appserver RPC scopes and repo scopes present — verification passed"

echo "Done! OAuth metadata written to build/oauth-client-metadata.json"