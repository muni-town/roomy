# Progressive Scope Extension — Implementation Plan

**Date:** 2026-06-12 (updated 2026-07-02)
**Status:** Draft
**Packages:** `packages/appserver`, `packages/app-lite`, `packages/sdk`

## Goal

Allow app-lite to start with a minimal permission set at first login, then
progressively request additional scopes (e.g. Bluesky DMs) on-demand when the
user accesses a feature that needs them. Today, `OAUTH_SCOPE` is a single
static string requested upfront.

A critical piece not in the original design: **server-side tracking of
approved scopes**, so that re-logging in (new browser, cleared storage, expired
session) yields a session token for the **maximum access the user has already
consented to** — in one round-trip, with no unnecessary consent re-prompts.
This is implemented first, as groundwork for the later progressive scope work.

The motivating example is Bluesky DMs: Roomy acts as a DM client but must not
assume all users want to grant that access. A user who previously expanded to
`withDms` should get DM access back automatically on re-login. Future
permission sets (calendar, notifications, etc.) follow the same pattern.

---

## How ATProto OAuth Scopes Actually Work

This is the core finding that shapes the design. There are **two scope layers**:

### 1. `clientMetadata.scope` — the ceiling

The maximum set of scopes a client is *allowed* to ever request. The PDS
enforces this server-side (`oauth-provider/src/client/client.ts:294`):

```typescript
if (parameters.scope !== undefined) {
  const declaredScopes = this.metadata.scope?.split(' ')
  for (const scope of parameters.scope.split(' ')) {
    if (!declaredScopes.includes(scope)) {
      throw new InvalidScopeError(
        parameters,
        `Scope "${scope}" is not declared in the client metadata`,
      )
    }
  }
}
```

**Every scope token in an authorization request must exist in the metadata's
scope.** Requesting something outside it → `invalid_scope` error.

### 2. `authorize({ scope })` — the per-request request

Each call to `client.authorize()` may pass a `scope` that overrides
`clientMetadata.scope` for *that* request (`oauth-client.js:177`):

```javascript
scope: options?.scope ?? this.clientMetadata.scope,
```

### 3. Consent screen shows only the requested subset

The PDS consent UI (`oauth-provider-ui/src/components/utils/scope-description.tsx`)
parses the `scope` from the authorization request and renders *only those
permissions*. The user is never shown the full metadata ceiling.

Users may *narrow* granted scopes on the consent screen (e.g. uncheck email),
but can never broaden beyond what the request asked for
(`request-manager.ts:429`):

```typescript
// allows the user to REMOVE scopes from the request, but not to ADD new ones
const newScopes = existingScopes?.filter((s) => allowedScopes.has(s))
```

### 4. Tracking the grant

`OAuthSession.getTokenInfo()` returns the scope the token was actually granted,
including any narrowing the user did:

```typescript
const tokenInfo = await session.getTokenInfo(false);
tokenInfo.scope; // "atproto rpc:... blob:*/*"
```

### 5. No upgrade endpoint

There is **no incremental scope-upgrade endpoint**. Extending scope requires a
full re-authorization round-trip (`authorize` → redirect → `callback`). The
PDS shows consent for only the new/changed permissions.

### 6. Loopback vs public client difference

| | Loopback (dev) | Public (prod) |
|---|---|---|
| Scope lives in | `client_id` query param: `http://localhost?scope=...` | `oauth-client-metadata.json` `scope` field |
| Changing scope | Changes `client_id` → PDS sees a *different client* | `authorize({ scope })` override; client_id stable |
| Progressive extension | New client_id per scope set; old session parallel | Clean: same client, request subset then superset |

For the **public client**, progressive extension works cleanly: keep one
metadata file with the union ceiling, request a subset at login, request more
later. For the **loopback client** (dev only), changing the scope creates a new
client_id; `BrowserOAuthClient.signIn()` with the new scope still produces a
working new session, and the old one is effectively abandoned.

### 7. PDS remembers prior grants (key to server-side tracking)

The PDS tracks OAuth grants per `(client_id, user_did)`. When a client
re-authorizes with a scope that is a **subset of what was previously granted**,
the PDS issues a token without re-prompting. When the scope includes new
permissions not yet granted, the consent screen shows only the delta.

This means: if the appserver remembers the full scope a user previously
approved, the client can request that exact scope on every login. Returning
users get a max-access token with zero prompts. New permissions (added in a
later release) prompt only for the genuinely new scopes.

---

## Design

### Scope tiers

Define named scope tiers in a new `scopes.ts`. The `base` tier matches the
current `OAUTH_SCOPE`. Each additional tier is `base` plus its extras.

```
base      ── current OAUTH_SCOPE (core Roomy functionality)
withDms   ── base + Bluesky chat RPC scopes
```

### Metadata ceiling (public client)

`oauth-client-metadata.json`'s `scope` field becomes the **union of all tiers**.
At first login, app-lite requests only `base`. The consent screen shows only
base permissions. When the user opens the DMs feature, app-lite requests
`withDms`; the consent screen shows only the DM additions.

### Server-side scope tracking

Store the raw scope string each user has consented to, on the appserver, in the
**readstate database** (`data/roomy-readstate.sqlite`). This DB survives
materialisation schema resets — unlike the main DB, which is wiped and
reconstructed from the Leaf event log. It already holds per-user state
(`read_positions`, `user_thread_activity`) and is the established home for
appserver-owned, per-user, non-reconstructible data.

The stored scope is the **last-granted** scope (most recent consent), not a
high-water mark. This respects explicit consent narrowing — if the user
unchecked a scope on the consent screen, the stored value reflects that, and
the user is not silently re-granted it on next login.

Two new appserver endpoints support this:

1. **`space.roomy.auth.getLoginScope`** (query, **unauthenticated**) — takes a
   handle, resolves it to a DID server-side (the appserver already has
   `IdResolver` from `@atproto/identity`), returns the stored scope (or null).
   Called *before* the user has a token, so `signIn()` can include the right
   scope. The `did` in the response saves the client a separate resolution call.

2. **`space.roomy.auth.recordScopeGrant`** (procedure, authenticated) — takes
   the scope string from `getTokenInfo()`, upserts the stored grant for
   `auth.did`. Fire-and-forget — failure is non-fatal; the session works
   regardless, and it self-heals on next login.

**Why unauthenticated for `getLoginScope`:** The whole point is to fetch the
stored scope *before* initiating OAuth, so the `signIn()` call can include the
right scope. There's a chicken-and-egg: you need a token to call authenticated
endpoints, but you need the scope to get a token. Resolving handle→DID
server-side breaks the cycle. The stored scope is not sensitive — it's a list
of public permission token strings (they're in the client metadata). Rate-limit
the endpoint to prevent handle-resolution abuse (the existing `rateLimit.ts`
infrastructure applies).

**Why the raw scope string, not a tier name:** Tiers are a client-side UX
abstraction; the server shouldn't know about `withDms`. The raw string handles
consent narrowing correctly and is forward-compatible with new tiers without
schema changes.

**Why `user_did` alone (no client identifier):** There is one app-lite client
today. If we later have multiple clients (desktop, mobile) with different scope
ceilings, add a `client_id` column. Until then, `user_did` PK is sufficient.

### Client-side tracking

On `init()` and after any re-authorization, call `session.getTokenInfo()` and
store the granted scope in `$state`. Expose `hasScope(tier)` so feature gates
can check whether a capability is available before use.

### Re-authorization flow

A `requestScopeExpansion(tier)` function persists the desired tier to
`sessionStorage`, then calls `login(handle, { scope: SCOPE_SETS[tier] })`,
which redirects to the PDS. On return, `init()` detects the pending tier,
refreshes the granted scope from the token, and verifies the expansion
succeeded. The same `init()` that runs after every callback also calls
`recordScopeGrant`, so expansions persist for future re-logins automatically.

---

## File Structure

### Appserver

```
packages/appserver/src/
  db/
    readStateSchema.sql                              ← ADD user_oauth_grants table
    readStateDb.ts                                   ← Bump READSTATE_SCHEMA_VERSION
  handlers/
    space.roomy.auth.getLoginScope.ts                ← NEW — unauthenticated query
    space.roomy.auth.recordScopeGrant.ts             ← NEW — authenticated procedure
  index.ts                                           ← Register both new routes
```

### App-lite

```
packages/app-lite/src/lib/
  scopes.ts                  ← NEW — scope tier definitions + helpers + reconcileScope()
  config.ts                  ← MODIFIED — drop OAUTH_SCOPE (moved to scopes.ts)
  auth.svelte.ts             ← MODIFIED — grant tracking + expansion flow + server sync
  client.ts                  ← MODIFIED — add pxUnauth() for unauthenticated XRPC
  components/
    ScopeGate.svelte         ← NEW — reusable "needs more permissions" gate
packages/app-lite/static/
  oauth-client-metadata.json ← NEW — public client metadata (union ceiling)
```

### SDK

No change required — `scope` already flows through `login()` → `signIn()` →
`authorize()`. The server-side integration is entirely in app-lite's
`auth.svelte.ts` and the new appserver endpoints.

### Lexicons

Two new lexicon JSON files for the new endpoints:
```
packages/sdk/src/schemas/lexicons/
  space.roomy.auth.getLoginScope.json
  space.roomy.auth.recordScopeGrant.json
```

---

## Implementation

### 1. `src/lib/scopes.ts` (new)

```typescript
import { CONFIG } from "./config";

/** All appserver RPCs the thin client calls. Must match config.ts. */
const APPSERVER_RPCS = [
  "space.roomy.space.getSpaces",
  "space.roomy.space.getMetadata",
  "space.roomy.space.getThreads",
  "space.roomy.space.getRoles",
  "space.roomy.space.getMembers",
  "space.roomy.space.getInvites",
  "space.roomy.room.getMetadata",
  "space.roomy.room.getMessages",
  "space.roomy.room.getThreads",
  "space.roomy.message.getMessage",
  "space.roomy.auth.getConnectionTicket",
  "space.roomy.room.updateSeen",
  "space.roomy.space.sendEvents",
  "space.roomy.space.createSpace",
  "space.roomy.space.joinSpace",
  "space.roomy.space.leaveSpace",
  "space.roomy.space.setHandle",
  "space.roomy.space.getCalendarLink",
  "space.roomy.space.getCalendarEvents",
  "space.roomy.space.getActivityFeed",
  "space.roomy.auth.getLoginScope",
  "space.roomy.auth.recordScopeGrant",
];

/** Scopes required by all Roomy core functionality (the current OAUTH_SCOPE). */
const BASE_SCOPES = [
  "atproto",
  "rpc:app.bsky.actor.getProfiles?aud=did:web:api.bsky.app%23bsky_appview",
  "rpc:app.bsky.actor.getProfile?aud=did:web:api.bsky.app%23bsky_appview",
  "blob:*/*",
  "repo:space.roomy.upload.v0",
  `repo:${CONFIG.profileSpaceNsid}`,
  `repo:${CONFIG.personalStreamNsid}`,
  ...APPSERVER_RPCS.map((nsid) => `rpc:${nsid}?aud=*`),
] as const;

/** Additional scopes for Bluesky DMs (chat.bsky.convo.* etc.). */
const DM_SCOPES = [
  "chat.bsky.actor.deleteAccount",
  "chat.bsky.actor.exportAccountData",
  "chat.bsky.convo.acceptConvo",
  "chat.bsky.convo.deleteMessageForSelf",
  "chat.bsky.convo.getConvoAvailability",
  "chat.bsky.convo.getConvoForMembers",
  "chat.bsky.convo.getConvo",
  "chat.bsky.convo.getLog",
  "chat.bsky.convo.leaveConvo",
  "chat.bsky.convo.listConvos",
  "chat.bsky.convo.muteConvo",
  "chat.bsky.convo.removeReaction",
  "chat.bsky.convo.sendMessageBatch",
  "chat.bsky.convo.unmuteConvo",
  "chat.bsky.convo.addReaction",
  "chat.bsky.convo.updateAllRead",
  "chat.bsky.convo.updateRead",
  "chat.bsky.moderation.getActorMetadata",
  "chat.bsky.moderation.getMessageContext",
  "chat.bsky.moderation.updateActorAccess",
].map((lxm) => `rpc:${lxm}?aud=did:web:api.bsky.chat%23bsky_chat`);

function buildScope(scopes: readonly string[]): string {
  return scopes.join(" ");
}

/**
 * Named scope tiers. Each tier is a superset of the previous.
 * The `base` tier is what we request at first login.
 */
export const SCOPE_SETS = {
  base: buildScope(BASE_SCOPES),
  withDms: buildScope([...BASE_SCOPES, ...DM_SCOPES]),
} as const;

export type ScopeSetName = keyof typeof SCOPE_SETS;

/**
 * Union of every scope across all tiers. This is the ceiling we put in
 * `oauth-client-metadata.json` so the PDS allows any tier to be requested.
 */
export const FULL_SCOPE_CEILING = buildScope(
  Object.values(SCOPE_SETS)
    .flatMap((s) => s.split(" "))
    .filter((v, i, arr) => arr.indexOf(v) === i), // dedupe
);

/** Parse a scope string into a Set for membership checks. */
export function parseScopes(scope: string): Set<string> {
  return new Set(scope.split(" ").filter(Boolean));
}

/** True if every scope in the named tier is present in `grantedScope`. */
export function hasScopeSet(grantedScope: string, tier: ScopeSetName): boolean {
  const required = parseScopes(SCOPE_SETS[tier]);
  const granted = parseScopes(grantedScope);
  for (const s of required) if (!granted.has(s)) return false;
  return true;
}

/**
 * Given a stored scope from a previous login, reconcile it against the
 * current tier definitions and ceiling:
 *   1. Intersect with FULL_SCOPE_CEILING (drop scopes we no longer request)
 *   2. Union with base (ensure minimum functionality)
 *   3. Dedupe
 *
 * This handles the case where a future release removes scopes from a tier —
 * the stored scope may contain tokens no longer in the metadata ceiling.
 * Requesting them would cause the PDS to reject with invalid_scope.
 */
export function reconcileScope(
  stored: string,
  baseScope: string,
  ceiling: string,
): string {
  const ceilingSet = parseScopes(ceiling);
  const baseSet = parseScopes(baseScope);
  const storedSet = parseScopes(stored);

  const result = new Set<string>();
  // Always include base
  for (const s of baseSet) result.add(s);
  // Include stored scopes that are still in the ceiling
  for (const s of storedSet) {
    if (ceilingSet.has(s)) result.add(s);
  }
  return [...result].join(" ");
}
```

> **Note:** `APPSERVER_RPCS` is currently duplicated in `config.ts`. When this
> lands, move the single source of truth into `scopes.ts` and have `config.ts`
> import it (or vice-versa) to avoid drift.

### 2. `src/lib/config.ts` (modified)

Remove the `OAUTH_SCOPE` export and the inline `APPSERVER_RPCS` (now in
`scopes.ts`). `CONFIG` keeps its NSID fields — `scopes.ts` imports them.

```diff
- export const OAUTH_SCOPE = [ ... ].join(" ");
```

### 3. Appserver: `user_oauth_grants` table

New table in the **readstate DB** (`packages/appserver/src/db/readStateSchema.sql`):

```sql
create table if not exists user_oauth_grants (
  user_did       text primary key,
  granted_scope  text not null,          -- raw scope string from getTokenInfo()
  updated_at     integer not null default (unixepoch() * 1000)
) strict;
```

Bump `READSTATE_SCHEMA_VERSION` in `readStateDb.ts`.

### 4. Appserver: `getLoginScope` handler

```typescript
// packages/appserver/src/handlers/space.roomy.auth.getLoginScope.ts

import { idResolver } from "../xrpc/auth.ts";
import { openReadStateDb } from "../db/readStateDb.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetLoginScopeResult {
  did: string;
  scope: string | null;
}

export const getLoginScopeHandler: QueryHandler<
  QueryParams,
  GetLoginScopeResult
> = async (params: QueryParams, _auth: AuthCtx) => {
  const handle = params.handle;
  if (typeof handle !== "string" || handle === "") {
    throw new XrpcError(400, "InvalidRequest", "handle is required");
  }

  // Resolve handle → DID using the appserver's existing IdResolver.
  const did = await idResolver.handle.resolve(handle);
  if (!did) {
    throw new XrpcError(404, "NotFound", `Could not resolve handle: ${handle}`);
  }

  // Look up the stored scope grant (if any).
  const readStateDb = openReadStateDb();
  const row = readStateDb
    .prepare("select granted_scope from user_oauth_grants where user_did = ?")
    .get(did) as { granted_scope: string } | null;

  return {
    did,
    scope: row?.granted_scope ?? null,
  };
};
```

> **Note:** This handler is intentionally unauthenticated — `auth.did` will be
> `null`. The XRPC router's `prodAuthVerifier` returns `{ did: null }` when no
> Bearer token is present, and handlers decide what anonymous callers may do.
> This handler ignores `auth` entirely. Rate-limit via `rateLimit.ts` to
> prevent handle-resolution abuse.

### 5. Appserver: `recordScopeGrant` handler

```typescript
// packages/appserver/src/handlers/space.roomy.auth.recordScopeGrant.ts

import { openReadStateDb } from "../db/readStateDb.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RecordScopeGrantBody {
  scope?: unknown;
}

export const recordScopeGrantHandler: ProcedureHandler<
  RecordScopeGrantBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: RecordScopeGrantBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  if (typeof body.scope !== "string" || body.scope === "") {
    throw new XrpcError(400, "InvalidRequest", "scope is required");
  }

  const readStateDb = openReadStateDb();
  readStateDb
    .prepare(
      `insert into user_oauth_grants (user_did, granted_scope, updated_at)
       values (?, ?, unixepoch() * 1000)
       on conflict(user_did) do update set
         granted_scope = excluded.granted_scope,
         updated_at = excluded.updated_at`,
    )
    .run(userDid, body.scope);
};
```

### 6. Appserver: route registration

In `packages/appserver/src/index.ts`:

```typescript
import { getLoginScopeHandler } from "./handlers/space.roomy.auth.getLoginScope.ts";
import { recordScopeGrantHandler } from "./handlers/space.roomy.auth.recordScopeGrant.ts";

// Add to the router chain:
const router = new XrpcRouter(prodAuthVerifier)
  .procedure("space.roomy.auth.recordScopeGrant", {
    handler: recordScopeGrantHandler,
  })
  .query("space.roomy.auth.getLoginScope", {
    handler: getLoginScopeHandler,
  })
  // ... existing routes ...
```

### 7. App-lite: `client.ts` — add `pxUnauth()`

```typescript
import { transport } from "@roomy-space/sdk/browser";

const { DirectXrpcClient, resolveAppserverHttpOrigin } = transport;

let directXrpc: InstanceType<typeof DirectXrpcClient> | null = null;
let appserverUrl: string | null = null;

// ... existing px() setup ...

/**
 * Get an unauthenticated XRPC client for endpoints that don't require auth
 * (e.g. getLoginScope, which is called before the user has a token).
 */
export function pxUnauth(): InstanceType<typeof DirectXrpcClient> {
  if (!directXrpc) {
    // If we already have an authenticated client, reuse its URL.
    const url = appserverUrl
      ?? resolveAppserverHttpOrigin(CONFIG.appserverDid);
    // DirectXrpcClient works without a ServiceAuthClient for unauthenticated
    // calls — it just won't attach a Bearer token.
    return new DirectXrpcClient(
      typeof url === "string" ? url : url,
      CONFIG.appserverDid,
      null as any, // no service auth
    );
  }
  return directXrpc;
}
```

> This is a sketch — the exact `DirectXrpcClient` API may need adjustment to
> support a "no auth" mode. The key requirement is: call `getLoginScope`
> without a Bearer token.

### 8. App-lite: `auth.svelte.ts` (modified)

Add grant tracking, a `hasScope()` getter, the expansion flow, and server-side
scope sync.

```typescript
import { Agent } from "@atproto/api";
import {
  login as sdkLogin,
  logout as sdkLogout,
  initSession,
  saveAppserverDid,
  type OAuthSession,
} from "@roomy-space/sdk/browser";
import { CONFIG } from "./config";
import {
  SCOPE_SETS,
  FULL_SCOPE_CEILING,
  hasScopeSet,
  reconcileScope,
  type ScopeSetName,
} from "./scopes";
import { px, pxUnauth } from "./client";

let agent = $state<Agent | null>(null);
let session = $state<OAuthSession | null>(null);
let authenticated = $state(false);
let initializing = $state(true);
let initError = $state<string | null>(null);
let grantedScope = $state<string>("");
let currentHandle = $state<string>("");

const PENDING_EXPANSION_KEY = "pending-scope-expansion";

export const auth = {
  get session() {
    return session;
  },
  get authenticated() {
    return authenticated;
  },
  get initializing() {
    return initializing;
  },
  get initError() {
    return initError;
  },
  /** The scope the current token was actually granted (post user-narrowing). */
  get grantedScope() {
    return grantedScope;
  },
  /** True if the current grant covers the named scope tier. */
  hasScope(tier: ScopeSetName): boolean {
    return hasScopeSet(grantedScope, tier);
  },
};

export async function init() {
  saveAppserverDid(CONFIG.appserverDid);
  try {
    const result = await initSession(CONFIG.appserverDid, {
      port: CONFIG.port,
      scope: SCOPE_SETS.base,
      usePublicClient: CONFIG.usePublicClient,
    });
    if (result) {
      session = result.session;
      agent = result.agent;
      authenticated = true;

      // Read back what was actually granted (may be narrower than requested).
      const tokenInfo = await session.getTokenInfo(false);
      grantedScope = tokenInfo.scope;

      // Persist the granted scope to the server for next login.
      // Fire-and-forget — failure is non-fatal.
      try {
        await px().recordScopeGrant({ scope: grantedScope });
      } catch {
        // Non-fatal: session works regardless; self-heals on next login.
      }

      // Returning from a scope expansion? Verify it took.
      const pending = sessionStorage.getItem(PENDING_EXPANSION_KEY) as ScopeSetName | null;
      if (pending && pending in SCOPE_SETS) {
        sessionStorage.removeItem(PENDING_EXPANSION_KEY);
        if (!hasScopeSet(grantedScope, pending)) {
          console.warn(`Scope expansion to "${pending}" was not granted`);
        }
      }

      // Set up direct XRPC transport (existing logic)...
    }
  } catch (err) {
    initError = String(err);
  } finally {
    initializing = false;
  }
}

export async function login(handle: string) {
  currentHandle = handle;
  saveAppserverDid(CONFIG.appserverDid);

  // Fetch the scope the user previously approved (if any).
  // Unauthenticated — happens before we have a token.
  let scope = SCOPE_SETS.base;
  try {
    const res = await pxUnauth().getLoginScope({ handle });
    if (res.scope) {
      // Intersect with current ceiling (handles removed scopes) and
      // union with base (ensures minimum functionality).
      scope = reconcileScope(res.scope, SCOPE_SETS.base, FULL_SCOPE_CEILING);
    }
  } catch {
    // Non-fatal: fall back to base scope.
  }

  // Remember the page the user was on for return-URL navigation.
  const returnUrl = currentReturnUrl();

  await sdkLogin(CONFIG.appserverDid, handle, {
    port: CONFIG.port,
    scope,
    usePublicClient: CONFIG.usePublicClient,
    state: returnUrl,
  });
}

/**
 * Re-authorize with an expanded scope tier. Redirects to the PDS consent
 * screen; this promise does NOT resolve in the current page (browser navigates).
 * The consent screen shows only the scopes NOT already covered by the existing
 * session, so users aren't re-prompted for things they already granted.
 */
export async function requestScopeExpansion(tier: ScopeSetName): Promise<void> {
  if (!currentHandle) throw new Error("Not authenticated — no handle to re-authorize");
  sessionStorage.setItem(PENDING_EXPANSION_KEY, tier);
  await sdkLogin(CONFIG.appserverDid, currentHandle, {
    port: CONFIG.port,
    scope: SCOPE_SETS[tier],
    usePublicClient: CONFIG.usePublicClient,
  });
}

export async function logout() {
  if (session) await sdkLogout(session);
  authenticated = false;
  location.reload();
}
```

> The `init()` code shown here focuses on the scope-related additions. The
> existing return-URL navigation, direct XRPC setup, error recovery, and
> profile fetching remain as-is — only the `getTokenInfo()` + `recordScopeGrant`
> block is new.

### 9. `src/lib/components/ScopeGate.svelte` (new)

A reusable gate that renders its children only when the required tier is
granted, otherwise shows a "grant permissions" prompt.

```svelte
<script lang="ts">
  import { auth, requestScopeExpansion } from "$lib/auth.svelte";
  import type { ScopeSetName } from "$lib/scopes";

  let { tier, title, description, children }: {
    tier: ScopeSetName;
    title: string;
    description: string;
    children: import("svelte").Snippet;
  } = $props();

  let expanding = $state(false);

  async function expand() {
    expanding = true;
    try {
      await requestScopeExpansion(tier);
    } catch (err) {
      console.error("Scope expansion failed:", err);
    } finally {
      expanding = false;
    }
  }
</script>

{#if auth.hasScope(tier)}
  {@render children()}
{:else}
  <div class="scope-gate">
    <h2>{title}</h2>
    <p>{description}</p>
    <button onclick={expand} disabled={expanding}>
      {expanding ? "Redirecting…" : "Grant permission"}
    </button>
  </div>
{/if}
```

Usage:

```svelte
<ScopeGate
  tier="withDms"
  title="Direct Messages"
  description="Roomy needs permission to read and send Bluesky DMs."
>
  <DmInbox />
</ScopeGate>
```

### 10. `static/oauth-client-metadata.json` (new, production only)

The `scope` field is the **union ceiling** (`FULL_SCOPE_CEILING`). This is what
allows app-lite to later request tiers beyond `base` without the PDS rejecting
them.

```json
{
  "client_id": "https://app.roomy.chat/oauth/client-metadata.json",
  "client_name": "Roomy",
  "client_uri": "https://roomy.chat",
  "redirect_uris": ["https://app.roomy.chat/oauth/callback"],
  "response_types": ["code"],
  "grant_types": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "scope": "<FULL_SCOPE_CEILING value here>",
  "dpop_bound_access_tokens": true
}
```

> The exact `client_id` and `redirect_uris` depend on deployment. The critical
> field for this feature is `scope` — it must contain every token from every
> tier. Generate it with `FULL_SCOPE_CEILING` at build time.

---

## End-to-End Flows

### First login (new user)

```
1. User enters handle
2. login(handle) → getLoginScope(handle) → { scope: null }  ← no prior grant
3. signIn({ scope: SCOPE_SETS.base })                        ← base only
4. PDS consent: shows base permissions
5. User consents → callback → init()
6. getTokenInfo() → grantedScope = "atproto rpc:... (base scopes)"
7. recordScopeGrant({ scope: grantedScope })                 ← stored on server
```

### Re-login (returning user, previously expanded to withDms)

```
1. User enters handle (new browser, cleared storage)
2. login(handle) → getLoginScope(handle)
     → { did: "...", scope: "atproto rpc:... chat.bsky.convo.* ..." }
3. reconcileScope(stored, base, ceiling)
     → scope = base ∪ stored (already a superset of base)
4. signIn({ scope: reconciled })                             ← full scope
5. PDS consent: no new permissions → issues token silently
6. callback → init()
7. getTokenInfo() → grantedScope = full scope
8. recordScopeGrant({ scope: grantedScope })                 ← refreshed
```

User gets DM access immediately, no consent prompt.

### Scope expansion (existing user, first time accessing DMs)

```
1. User clicks "Direct Messages" → ScopeGate shows "Grant permission"
2. requestScopeExpansion("withDms")
     → sessionStorage.setItem(PENDING_EXPANSION_KEY, "withDms")
     → signIn({ scope: SCOPE_SETS.withDms })
3. PDS consent: shows only DM scopes (delta from current grant)
4. User consents → callback → init()
5. getTokenInfo() → grantedScope = base + dms
6. recordScopeGrant({ scope: grantedScope })                 ← stored for next time
7. hasScopeSet(grantedScope, "withDms") → true               ← gate opens
```

### User narrowed consent on re-login

```
1. User re-logs in, unchecks DM scopes on consent screen
2. getTokenInfo() → grantedScope = base only (no dms)
3. recordScopeGrant({ scope: grantedScope })                 ← narrowed record
4. hasScopeSet("withDms") → false                            ← gate re-shows
```

On next re-login, `getLoginScope` returns the narrowed scope. The user is NOT
silently re-granted DMs. They must re-expand via ScopeGate if they want DMs
back. This respects explicit user choice.

---

## Scope Detection Strategies

Two complementary approaches for deciding *when* to trigger expansion:

### A. Proactive (feature-gate check)

Best when the app knows up-front that a route needs extra scopes (e.g. navigating
to `/messages`):

```typescript
import { goto } from "$app/navigation";

export async function openDms() {
  if (!auth.hasScope("withDms")) {
    // ScopeGate component handles the prompt, or call directly:
    await requestScopeExpansion("withDms");
    return; // browser redirects away; flow resumes in init()
  }
  goto("/messages");
}
```

### B. Reactive (intercept insufficient-scope errors)

Best as a safety net for when a request fails because the token lacks a scope.
Bluesky's PDS returns `403` with an `insufficient_scope`-style error when a
token can't perform an RPC.

```typescript
function isInsufficientScopeError(err: unknown): boolean {
  // @atproto errors carry an `error` field; adjust to actual error shape
  return Boolean(
    err && typeof err === "object" &&
    "error" in err && (err as any).error === "invalid_scope"
  );
}

async function guardedXrpc<T>(
  fn: () => Promise<T>,
  requiredTier?: ScopeSetName,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (requiredTier && isInsufficientScopeError(err)) {
      await requestScopeExpansion(requiredTier);
      // Browser has navigated away; this line is unreachable in practice.
    }
    throw err;
  }
}
```

**Recommendation:** Start with (A) for known feature boundaries. Add (B) later
as a fallback once the exact PDS error shapes are confirmed against the live
server.

---

## Edge Cases & Considerations

### Progressive scope edge cases

- **User denies the expansion.** `init()` checks `hasScopeSet()` after the
  redirect and logs a warning. The `ScopeGate` re-renders showing the prompt
  again. The feature stays gated until the user consents.

- **User narrows consent.** The PDS lets users uncheck scopes on the consent
  screen. `getTokenInfo().scope` reflects this. `hasScope()` correctly reports
  `false` if the user unchecked a needed scope — the gate re-shows the prompt.

- **Loopback client (dev) scope churn.** Each tier has a different `client_id`
  (scope is in the query param). Re-authorizing with `withDms` creates a new
  client; the old `base` session is abandoned in IndexedDB. Acceptable for dev.
  Consider running `session.signOut()` on the old session before expansion to
  avoid stale entries.

- **`login_hint` reuse.** `sdkLogin(handle, ...)` passes the handle through
  `authorize()` as `login_hint`, so the PDS pre-fills the account and skips
  re-entry — the user only sees the consent delta, not a full sign-in.

- **Existing sessions in production.** Users who logged in before this change
  have a `base` grant. The metadata's new union ceiling doesn't retroactively
  grant them DMs — they still need to expand via `requestScopeExpansion`. This
  is correct and expected.

- **Scope string length.** The union ceiling can get long. For the loopback
  client, long `client_id` query strings may hit URL limits; the public client
  (production) uses a URL-based `client_id` with no such limit. Dev loopback
  should stay on `base` only.

### Server-side tracking edge cases

- **Stored scope contains removed scopes.** A future release removes
  `chat.bsky.convo.deleteAccount` from the DM tier. A returning user's stored
  scope still contains it. If the client requests it, the PDS rejects with
  `invalid_scope` (not in the client metadata ceiling). **Fix:**
  `reconcileScope()` intersects the stored scope with `FULL_SCOPE_CEILING`
  before requesting. Removed scopes are silently dropped.

- **Stored scope is a strict subset of base.** Possible if a user logged in
  with an older, more minimal `base` definition. `reconcileScope()` unions
  with current `base`, so they always get at least base. The PDS may prompt for
  new base scopes not in the old grant.

- **Appserver loses the readstate DB.** If lost, all stored scopes are gone.
  Users fall back to `base` on next login and re-expand as needed. Graceful
  degradation — no corruption, just a minor UX regression (one extra consent
  prompt for previously-expanded users). **Mitigation:** include the readstate
  DB in the appserver's backup strategy (separate from the materialisation DB,
  which is disposable).

- **Multiple devices / browsers.** The scope grant is per-`user_did`, not
  per-device. Expansion on one device propagates to all on next login. This is
  the desired "max access they have already approved" behavior.

- **Race condition: concurrent logins.** Two tabs logging in simultaneously
  with the same handle both call `getLoginScope` (same stored scope), both
  request it, both callbacks call `recordScopeGrant`. Last write wins. No
  corruption — both write the same (or very similar) scope.

- **`recordScopeGrant` failure.** Non-fatal. The client has its session
  regardless. The server just won't remember the grant for next time. It
  self-heals within one login cycle.

---

## Rollout Phases

Server-side scope tracking is implemented first, as groundwork — it provides
the infrastructure (new endpoints, readstate table, scope reconciliation) that
the progressive scope tiers build on. Even with only a `base` tier, the
server-side tracking ensures re-logging users get their previously-approved
scope (which, at this stage, is always `base` — but the plumbing is in place).

### Phase 1 — Server-side scope storage (groundwork)

1. Add `user_oauth_grants` table to `readStateSchema.sql`, bump
   `READSTATE_SCHEMA_VERSION`.
2. Implement `getLoginScope` handler: resolve handle→DID, query stored scope.
   Unauthenticated; rate-limited.
3. Implement `recordScopeGrant` handler: upsert scope for authenticated DID.
4. Register routes in `index.ts`.
5. Generate lexicon JSON files for both endpoints.

### Phase 2 — Client scope refactor (no behavior change)

1. Extract `OAUTH_SCOPE` into `scopes.ts` with a single `base` tier.
2. Add `reconcileScope()`, `parseScopes()`, `hasScopeSet()` helpers.
3. Add the two new appserver RPCs to `APPSERVER_RPCS` (so their `rpc:` scopes
   are in `base`).
4. Verify login/init still work identically. No metadata changes yet.

### Phase 3 — Client-side grant tracking + server sync

1. Add `grantedScope` state + `hasScope()` getter to `auth.svelte.ts`.
2. Call `getTokenInfo()` in `init()`, store the result.
3. Call `recordScopeGrant()` in `init()` after `getTokenInfo()` (fire-and-forget).
4. Add `pxUnauth()` to `client.ts` for unauthenticated XRPC calls.
5. Modify `login()` to call `getLoginScope` and use `reconcileScope()` result.
6. Land the `ScopeGate` component (unused, ready).
7. Still only `base` tier exists — but re-login now uses stored scope.

### Phase 4 — Public client metadata ceiling

1. Deploy `oauth-client-metadata.json` with `scope` = union ceiling.
2. Verify `base` login still works against it.

### Phase 5 — First extension (`withDms`)

1. Add `DM_SCOPES` to `scopes.ts`, define `withDms` tier.
2. Wire a DMs entry point behind `ScopeGate tier="withDms"`.
3. Test the re-authorization round-trip against a real PDS.
4. Verify: expansion → `recordScopeGrant` stores broader scope → re-login gets
   it back without re-prompting.

---

## Open Questions

1. **Should `getLoginScope` also return the tier name** (e.g. `"withDms"`) so
   the client can pre-select UI state? Or should the client always derive tier
   from the scope string via `hasScopeSet`? **Recommendation:** derive from
   scope string — the server shouldn't know about client-side tier names.

2. **Should we store a high-water mark** (max ever approved) **or last-granted**
   (most recent consent)? This design uses last-granted, which respects
   narrowing. A high-water mark would silently re-grant revoked permissions.
   **Recommendation:** last-granted, as designed. If we later want "remember
   that you once had DMs" as a UI hint without auto-granting, add a separate
   `max_approved_scope` column.

3. **Should the appserver proactively refresh the stored scope** (e.g. after a
   token refresh that might have narrowed)? No — token refresh doesn't change
   scope. Only re-authorization (consent flow) changes scope, and that's when
   we record. A refresh that fails due to revoked scope would trigger
   re-auth, which records again.

4. **Rate limiting for `getLoginScope`**: The endpoint does handle→DID
   resolution, which hits the PLC directory / DNS. Should be rate-limited per
   IP. The existing `rateLimit.ts` can handle this. What limit? Suggest
   matching the login attempt rate limit (whatever that is — currently
   unbounded, which is a separate issue).

5. **`pxUnauth()` implementation**: The exact `DirectXrpcClient` API may need
   adjustment to support a "no auth" mode. The key requirement is: call
   `getLoginScope` without a Bearer token. Confirm against the actual
   `DirectXrpcClient` constructor when implementing Phase 3.

---

## References

- ATProto OAuth spec: https://atproto.com/specs/oauth
- PDS scope validation: `oauth-provider/src/client/client.ts:294`
- PDS consent narrowing: `oauth-provider/src/request/request-manager.ts:429`
- Consent UI scope rendering: `oauth-provider-ui/src/components/utils/scope-description.tsx`
- Client authorize scope override: `@atproto/oauth-client` `oauth-client.js:177`
- Token scope introspection: `@atproto/oauth-client` `OAuthSession.getTokenInfo()`
- Readstate DB pattern: `packages/appserver/src/db/readStateDb.ts`
- Existing per-user write pattern: `packages/appserver/src/handlers/space.roomy.room.updateSeen.ts`
- Handle/DID resolution: `packages/appserver/src/xrpc/auth.ts` (`IdResolver`)
- Auth verifier (anonymous fallback): `packages/appserver/src/xrpc/auth.ts:70-76`