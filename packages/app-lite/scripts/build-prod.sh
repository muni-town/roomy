#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")/.."

# ── Build identity ───────────────────────────────────────────────────────
# The served bundle must be able to name its commit (it is exposed as
# /build.json and inlined as __BUILD_ID__; see src/lib/build-id.ts). In the
# Docker build `Dockerfile.app-lite` already sets BUILD_ID from
# RAILWAY_GIT_COMMIT_SHA, so this only fills the gap for builds run outside
# that image — a local `scripts/build-prod.sh`, where nothing supplies it yet.
# First 8 chars, matching the Dockerfile's expansion and the appserver /
# discord-bridge id format, so the three are comparable in one query.
if [ -z "${BUILD_ID:-}" ] && [ -n "${RAILWAY_GIT_COMMIT_SHA:-}" ]; then
  export BUILD_ID="${RAILWAY_GIT_COMMIT_SHA:0:8}"
fi
if [ -z "${BUILD_ID:-}" ] && command -v git >/dev/null 2>&1; then
  BUILD_ID="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$BUILD_ID" ]; then
    export BUILD_ID="${BUILD_ID:0:8}"
    echo "BUILD_ID not supplied; using local git HEAD ${BUILD_ID} ($(git branch --show-current 2>/dev/null || echo detached))"
  fi
fi
if [ -z "${BUILD_ID:-}" ]; then
  # OPERATIONAL, not cosmetic: a deploy built without git metadata cannot be
  # named afterwards. Report it loudly rather than serving a bundle whose
  # commit no one can recover.
  echo "WARNING: BUILD_ID is unset and no git commit could be resolved;" >&2
  echo "         /build.json will report commit \"unknown\" for this build." >&2
fi

pnpm build

target_url=${OAUTH_HOST:?"OAUTH_HOST must be set (e.g. https://app-lite.roomy.chat)"}

echo "Generating OAuth client configuration..."
echo "OAuth Host URL: $target_url"

# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  SCOPE STRING                                                              ║
# ║  The scope ceiling is defined ONCE in src/lib/scopes.ts                     ║
# ║  (FULL_SCOPE_CEILING). This script derives SCOPE from it. The only         ║
# ║  env-dependent tokens (stream-handle NSID, appserver DID) are read by      ║
# ║  scopes.ts itself from VITE_STREAM_HANDLE_NSID / VITE_APPSERVER_DID — so    ║
# ║  the metadata always carries the environment's values, byte-identical to   ║
# ║  what config.ts's OAUTH_SCOPE would request.                               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

SCOPE="$(
  node --experimental-strip-types -e 'import("./src/lib/scopes.ts").then((m) => process.stdout.write(m.FULL_SCOPE_CEILING))'
)"

# Build the OAuth client metadata JSON
oauth_shared=$(
  cat <<EOF
  "client_name": "Roomy Lite",
  "client_uri": "$target_url",
  "logo_uri": "$target_url/favicon.png",
  "scope": "${SCOPE}",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "dpop_bound_access_tokens": true
EOF
)

oauth_web_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-metadata.json",
  "redirect_uris": ["$target_url/"],
  "application_type": "web",
  ${oauth_shared}
}
EOF
)

oauth_native_config=$(
  cat <<EOF
{
  "client_id": "$target_url/oauth-client-native.json",
  "redirect_uris": ["space.roomy:/","$target_url/"],
  "application_type": "native",
  ${oauth_shared}
}
EOF
)

# Write first so the verification below can read the actual artifact
echo "$oauth_web_config" > build-staging/oauth-client-metadata.json
echo "$oauth_native_config" > build-staging/oauth-client-native.json

echo "Scope: ${SCOPE:0:120}..."

# ── Build-time verification ──────────────────────────────────────────────
# Ensure every tier's scopes are a subset of the metadata ceiling, and the
# shipped metadata's scope is exactly the ceiling. The ceiling (and the tiers)
# are now the single source of truth in src/lib/scopes.ts, so this catches any
# drift where a tier gained a scope the metadata no longer declares (which
# would make the PDS reject it with invalid_scope). It reads the already-written
# oauth-client-metadata.json so we test the actual deployed artifact.
node --experimental-strip-types -e "
import { readFileSync } from 'node:fs';
import('./src/lib/scopes.ts').then((m) => {
  const meta = JSON.parse(readFileSync('build-staging/oauth-client-metadata.json', 'utf-8'));
  const scope = meta.scope || '';
  let hasErrors = false;

  const ceilingScopes = m.parseScopes(m.FULL_SCOPE_CEILING);
  for (const [tier, tierScope] of Object.entries(m.SCOPE_SETS)) {
    for (const s of m.parseScopes(tierScope)) {
      if (!ceilingScopes.has(s)) {
        console.log('MISSING SCOPE (tier ' + tier + ' not in ceiling): ' + s);
        hasErrors = true;
      }
    }
  }

  // The shipped metadata scope must be exactly the ceiling (byte-identical).
  if (scope !== m.FULL_SCOPE_CEILING) {
    console.log('MISMATCH: shipped metadata scope != FULL_SCOPE_CEILING');
    hasErrors = true;
  }

  if (hasErrors) process.exit(1);
  console.log('All tier scopes present in ceiling, metadata scope == ceiling — verification passed');
}).catch((e) => { console.error(e); process.exit(1); });
"
if [ $? -ne 0 ]; then
  echo "ERROR: A tier scope is missing from the metadata ceiling, or the" >&2
  echo "shipped scope drifts from src/lib/scopes.ts FULL_SCOPE_CEILING." >&2
  echo "Fix the tier/ceiling definitions in src/lib/scopes.ts." >&2
  exit 1
fi

# ── Build-identity verification ─────────────────────────────────────────
# The service is only nameable if the artifact says which commit it is. A
# deploy whose bundle carries no id cannot be tied to a revision afterwards,
# so fail the build here rather than publish an unnameable bundle (same
# contract as the OAuth-scope verification above: test the artifact that ships,
# not the intention). `build.json` is a prerendered route, so its absence means
# the route did not make it into the output at all.
if [ ! -f build-staging/build.json ]; then
  echo "ERROR: build-staging/build.json is missing — the deployed bundle would" >&2
  echo "       carry no build identity. Is src/routes/build.json/+server.ts present?" >&2
  exit 1
fi
built_commit="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("build-staging/build.json","utf8")).commit)')"
if [ -z "$built_commit" ]; then
  echo "ERROR: build-staging/build.json has an empty commit — present but" >&2
  echo "       meaningless, indistinguishable from a real id downstream." >&2
  exit 1
fi
if [ "$built_commit" = "unknown" ]; then
  # Not fatal: a rebuild of already-built source, or a build in an environment
  # with no git metadata, is legitimate. It must still be visible in the log.
  echo "WARNING: this build reports commit \"unknown\" — the bundle cannot name" >&2
  echo "         its commit, so a later deploy-revision audit cannot either." >&2
else
  echo "Build identity: commit ${built_commit} (served as /build.json)"
fi
echo "Done! OAuth metadata written to build-staging/oauth-client-metadata.json"

# ── Publish atomically ──────────────────────────────────────────────────
# The static server serves `build/` live, so never let a partial build leak
# in. Swap staging into place in one shot; the previous build is kept briefly
# as build.old and dropped after. A failed `pnpm build` above leaves build/
# untouched (staging is only moved after everything succeeded).
rm -rf build.old
if [ -e build ]; then mv build build.old; fi
mv build-staging build
rm -rf build.old
echo "Published build/ atomically (old copy at build.old until removed)"
