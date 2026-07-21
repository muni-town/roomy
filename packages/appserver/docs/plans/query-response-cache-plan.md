# Query Response Cache Plan

**Date:** 2026-07-21
**Status:** Plan
**Parent doc:** `appserver-architecture.md`

## Problem

Since commit `49ed1a9f` (app-lite, design: "enrich internal links"), the appserver has been under heavy CPU load with response-time spikes under the same request volume. The root cause is a client-side fan-out: `MessageContent.svelte` imperatively mounts a `SpaceRoomBadge` for every internal link in every rendered message, and each badge issues 1–2 XRPC queries (`space.roomy.space.getMetadata`, `space.roomy.room.getMetadata`). The `room.getMetadata` handler is expensive — even after commit `cc10df71` halved its per-thread `roomAccess` cost, a single cold call still runs `hydrateUserMembership` + `requireRoomRead` + `listThreadActivity(20)` + 20× `roomAccess` (≈6 SQL statements each) + `getReadPositions` + `getReadPosition`, on the order of 130+ SQL statements. A virtualized chat with several internal links per message now triggers that work per badge, per scroll.

The client-side fan-out is being addressed separately (visibility gating, batched prefetch). This plan covers the **server-side general-purpose fix**: an in-memory response cache for XRPC queries that amortises expensive handler work across callers and across the per-badge fan-out, and that benefits *every* consumer of the cached queries, not just the badge path.

## Goal

A process-local, in-memory cache for selected XRPC query responses, keyed by `(nsid, params, callerDid)`, evicted by invalidation signals from the existing `InvalidationRouter`, with a TTL safety net. The cache must be correct under per-user response divergence (access decisions, unread counts, `activeThreads`) and must not serve stale data after any mutation path that changes a cached field.

## Non-goals

- Caching `room.getMessages`, `space.getThreads`, `room.getThreads`, `getActivityFeed`, or any cursor-paginated / diff-driven query. Those are already kept fresh by `#messageDiff` / `#roomMetadataDiff` frames applied directly to the client cache; server caching would duplicate that mechanism without the granularity.
- Caching procedures (mutations). Procedures emit invalidations; they are never cached.
- Cross-process / distributed caching. The appserver is currently single-process; a process-local `Map` is sufficient. If horizontal scaling is introduced later, the invalidation bus would need a pub/sub fan-out, which is out of scope here.
- Changing the wire format or lexicons. The cache is transparent to clients.

## Why the groundwork is sufficient

The invalidation system already emits everything a server cache needs:

1. **Event-driven coverage.** `invalidation/inferSignals.ts` has handlers for every event type that can change a `getMetadata` or `getSpaces` result: create/edit/delete/restore room, update room, update space info / sidebar config, join/leave space, add/remove admin, ban/unban, personal join/leave, create/remove room link, role create/delete/update, add/remove member role, set role-room permission, mark-read. `invalidateSpace` and `invalidateRoom` (lines 67–84) cover `space.getMetadata`, `room.getMetadata`, `getSpaces`, `getThreads`, `getMembers`.
2. **Procedure-driven coverage.** Procedure handlers that mutate appserver-local state emit directly via `router.emit()`: `updateSeen` (emits `room.getMetadata`, `space.getMetadata`, `getSpaces`), `createSpace`, `joinSpace`, `leaveSpace`, `setHandle`. Commit `9579eea0` closed the remaining gaps (`setHandle` now emits; `joinSpace`/`leaveSpace`/`createSpace` now also emit `getMetadata`; `handlePersonalLeaveSpace` now mirrors `handlePersonalJoinSpace`).
3. **Per-user scoping is modelled.** `QueryInvalidation.affectedUser` (`invalidation/types.ts:39–51`) distinguishes caller-scoped fields (`isAdmin`, `canRead`, `canWrite`, per-channel `unreadCount`/`lastRead`, `activeThreads`) from broadcast fields (space name, avatar, channel tree topology). `handleCreateMessage` uses it correctly: `space.getMetadata` is invalidated only for `event.user` (line 157) since only that user's `activeThreads` changed.
4. **The router is a singleton with a clean subscribe API** (`invalidation/router.ts:29–51, 125–130`). Today the only subscriber is the WS `SyncManager` (`sync/handler.ts:155`). Adding a cache listener is one call: `router.subscribe((events) => cacheEvict(events))`.

## Design

### Cache key

```
key := `${nsid}:${canonicalParamsJson}:${userDid ?? "anon"}`
```

`canonicalParamsJson` is `JSON.stringify` of params with keys sorted alphabetically — identical to the canonicalisation the client already does in `packages/sdk/src/cache/query-key.ts`. Reuse that helper (export it or duplicate the ~10-line sort) so server and client keys are structurally identical and a future shared invalidation log could address both.

The caller DID **must** be part of the key. `getMetadata` responses contain `isMember`, `isAdmin`, `canRead`, `canWrite`, per-channel `unreadCount`/`lastRead`, and per-user `activeThreads`. A cache keyed only on `(nsid, params)` would leak access decisions and unread state between users. Anonymous callers share a single `"anon"` bucket.

### Alternatives considered: keying on a permission class instead of `userDid`

It is tempting to key on a *permission-equivalence class* rather than the raw DID. Within a space, users who share the same role set and ban state form an equivalence class for the access fields (`canRead`/`canWrite` on each room, `isMember`/`isAdmin`), so in principle many members could share one cache entry for the access-shaped portion of a response. This is **not adopted in v1**, for three reasons:

1. **The strictly-per-DID fields defeat sharing for the hot queries.** `room.getMetadata` returns `unreadCount`, `lastRead`, and `recentThreads[].unreadCount`/`lastRead` — caller-only read state with no natural grouping. `space.getMetadata` likewise carries per-channel `unreadCount`/`lastRead` and per-user `activeThreads`. Even with a perfect permission-class key, two users in the same class cannot share a response body without re-stitching per-user read-state into it. The badge-fan-out queries that motivate this plan are exactly the ones carrying those fields.
2. **Class computation is itself the cost being avoided.** Deriving a `permissionClassId` requires resolving the caller's roles and ban state per space — the `roomAccess` / `hydrateUserMembership` work the cache exists to skip. A two-layer design (shared access-shaped body keyed by class + per-DID read-state overlay) would pay the class computation on lookup and add an overlay merge on every hit, against a saving that is mostly already captured by the per-request `createAccessMemo` (`handlers/space.roomy.room.getMetadata.ts:57`).
3. **The shared-cache multiplier is absent.** The payoff of class-keying is largest under a shared/distributed cache, where N users in one class share one edge entry. The plan is process-local (Non-goals), so within one process the per-DID entries already hit the same memory — there is no shared-cache multiplier to recover, only a working-set reduction.

**Cheaper first move if the per-DID working set later pressures `maxEntries`:** split each response into a *broadcast half* (space name/avatar/handle/joinPolicy, room name/kind/defaultAccess/parentChannelId, channel-tree topology) cached with **no `userDid`** in the key, and a *per-user half* (access bits + read-state + `activeThreads`) cached under `userDid`. The broadcast half is served once per `(nsid, params)` to every caller; the per-user handler then only computes access + read-state. This captures most of the sharing benefit of class-keying without computing a class id, and it composes with the existing per-request access memo (which could be promoted to cache-scoped, keyed by `(spaceId, userDid)`, so a second badge for the same space skips membership re-hydration entirely). Tracked as a conditioned follow-up below.

### Alternatives considered: quantizing cursor-paginated queries for shared caching

A proposed variant of cursor pagination is to fix page boundaries at modular offsets ("return the items in bucket `floor(offset / B)`") so the bucket key is stable across callers and a shared/edge cache can deduplicate. This is **not adopted**, for three reasons:

1. **These queries are already fresh on the client via diff frames.** `getMessages`/`getThreads`/`getActivityFeed` are kept up to date by `#messageDiff` / `#roomMetadataDiff` applied directly to the client cache (Non-goals, line 19). A server cache for these lists would duplicate that mechanism without its granularity — a new message would land in the client via a diff while the server's bucket entry still holds the old membership unless evicted.
2. **Head-insert invalidation would sweep every bucket.** Cursors exist precisely to keep pages stable under inserts/deletes *ahead* of the cursor. Modular offset buckets have the opposite property: an insert at the head of a channel shifts every bucket's membership by one, so every cached bucket for that room becomes stale on each new message. In a chat system where inserts concentrate at the head, this is the worst case — constant full-bucket invalidation. Quantizing the boundary does not change the invalidation fan-out.
3. **The shared-cache benefit does not exist while the cache is process-local.** The deduplication payoff is an edge/CDN effect; within one process, per-cursor entries already share memory, so quantization is pure cost (wider invalidation, coarser API) for no gain.

**Viable variant if list-caching becomes a goal later:** *time-bucketed* activity ("activity for day `D`"), not count-bucketed. Time buckets have natural invalidation (evict the bucket whose time window an event timestamps into), compose with diff frames (an insert only invalidates the single time bucket it falls in), and match the real access pattern (users scroll recent activity, not arbitrary offsets). This would be a different API shape, not a modification of the existing cursor endpoints, and is out of scope for v1.

### Store

```ts
interface CacheEntry {
  value: unknown;          // the handler's validated JSON response
  expiresAt: number;       // Date.now() + ttl, used only as a safety net
  insertedAt: number;      // for LRU eviction and metrics
}

class QueryCache {
  #store = new Map<string, CacheEntry>();  // Map preserves insertion order → LRU by re-insert on hit
  #maxEntries: number;                     // e.g. 4096
  #ttlMs: number;                          // e.g. 60_000

  get(key): { value } | undefined;         // returns undefined if missing or expired (and deletes)
  set(key, value): void;                   // evicts oldest when full
  evict(key): void;
  evictPrefix(prefix: string): void;       // for broadcast invalidations (sweep all userDids for an nsid+params)
}
```

- **LRU:** `Map` preserves insertion order. On a hit, `delete` then `set` to move the entry to the newest position. On `set` when full, delete `#store.keys().next().value`.
- **TTL is a safety net, not the authority.** The invalidation signals are the correctness mechanism. The TTL only guards against a missed signal (e.g. a future event type added without an `inferSignals` handler). A 60s TTL is generous; the goal is "stale for at most 60s after an unmodelled mutation," not "fresh for 60s."
- **No negative caching of errors.** A 401/403/404/500 is not stored. Only successful (2xx) handler results are cached. (A 404 for a missing space *could* be cached briefly with the same invalidation as a 200, since `createSpace` emits `getMetadata`/`getSpaces` — but the cost saving is marginal and the risk of caching a transient 404 from a race is not worth it. Skip in v1.)

### Integration point: the XRPC router

The cache wraps the query dispatch in `xrpc/router.ts`, **not** inside individual handlers. This keeps handlers pure and lets the cache be enabled per-NSID via a config set.

Current dispatch (`xrpc/router.ts:170`):
```ts
const result = await route.handler(params as QueryParams, auth);
const validated = route.outputSchema
  ? validateOutputOrThrow(route.outputSchema, result, nsid)
  : result;
return Response.json(validated);
```

Wrapped dispatch (sketch):
```ts
const cacheable = CACHEABLE_NSIDS.has(nsid);
const userDid = (auth as { did?: string | null }).did ?? null;
let key: string | undefined;
if (cacheable) {
  key = queryCacheKey(nsid, params, userDid);
  const hit = queryCache.get(key);
  if (hit) return Response.json(hit.value);
}

const result = await route.handler(params as QueryParams, auth);
const validated = route.outputSchema
  ? validateOutputOrThrow(route.outputSchema, result, nsid)
  : result;
if (cacheable && key) queryCache.set(key, validated);
return Response.json(validated);
```

Notes:
- **Validation happens once on insert.** Cached `validated` is returned directly; `validateOutputOrThrow` does not re-run on hits. This is correct because the cached value is the post-validation object and the schema does not change at runtime.
- **Auth still runs on every request.** The auth verifier (`this.#auth(req)`) executes before the cache lookup, so auth failures never hit the cache and a revoked token does not get served a cached response for a user it can no longer auth as. The caller DID in the key is the *resolved* auth DID, not a header value.
- **Procedures and sync are untouched.** The wrapper is inside the `route.kind === "query"` branch only.

### Cacheable set

```ts
const CACHEABLE_NSIDS = new Set<QueryNsid>([
  "space.roomy.space.getMetadata",
  "space.roomy.room.getMetadata",
  "space.roomy.space.getSpaces",
]);
```

These three are:
- **Hot:** `space.getMetadata` and `room.getMetadata` are fetched by the sidebar, by navigation, and now by every `SpaceRoomBadge`. `getSpaces` is fetched on every space-list render and invalidated on join/leave/create.
- **Expensive:** all three run `hydrateUserMembership` + multiple `roomAccess`/`spaceAccess` calls + read-position queries. `room.getMetadata` is the worst (130+ SQL statements cold).
- **Fully covered by invalidation signals.** Every field in their responses is invalidated by a modelled event or procedure emit (verified against `inferSignals.ts` and the procedure handlers post-`9579eea0`).

Explicitly **not** in v1:
- `getMessages` / `getThreads` / `getActivityFeed` — cursor-paginated, already fresh via `#messageDiff` / `#roomMetadataDiff` applied client-side.
- `getMembers` / `getRoles` / `getInvites` — lower traffic; can be added later with the same pattern once v1 proves out.
- `getMessage` / `getReactions` — message-level, covered by diff frames.

### Eviction listener

A second `InvalidationRouter` subscriber, registered in `createAppserver` alongside the SyncManager subscription:

```ts
const cacheUnsub = invalidationRouter.subscribe((events) => {
  for (const e of events) {
    if (e.kind !== "queryInvalidation") continue;
    const { nsid, params, affectedUser } = e.signal;
    const paramPrefix = queryCacheKey(nsid, params, ""); // prefix up to the userDid slot
    if (affectedUser) {
      // Per-user field changed (unread, access, activeThreads): evict only
      // that user's entry, plus the anon entry if the field is anon-visible.
      queryCache.evict(queryCacheKey(nsid, params, affectedUser));
      queryCache.evict(queryCacheKey(nsid, params, "anon"));
    } else {
      // Broadcast field changed (space name, avatar, channel topology): evict
      // every caller's entry for this nsid+params.
      queryCache.evictPrefix(paramPrefix);
    }
  }
});
```

The `evictPrefix` sweep iterates the `Map` and deletes matching keys. For a 4096-entry cache this is at most a few microseconds per invalidation event; invalidation batches are small (one per event batch, deduplicated by the router). If profiling later shows the sweep is hot, swap the store for a two-level `Map<nsidParams, Map<userDid, CacheEntry>>` so broadcast eviction is O(1) on the outer key. Start with the flat map for simplicity.

**Lifecycle:** `cacheUnsub` is registered in `createAppserver` after `InvalidationRouter.setInstance` and before the server starts. On `close()`, call `cacheUnsub()` and clear the cache, mirroring `InvalidationRouter.resetInstance()` in the existing close path (`appserver.ts:468–472`).

### Per-user correctness: the field matrix

The cache key includes `userDid` because responses diverge per caller. The eviction logic honours `affectedUser` because not every field is per-user. The matrix that determines correctness:

| Field in response                | Per-user? | Invalidated by (signal)                          |
|----------------------------------|-----------|--------------------------------------------------|
| `space.getMetadata.name/avatar`  | no        | broadcast `invalidateSpace`                      |
| `space.getMetadata.handle`       | no        | `setHandle` emit (broadcast)                     |
| `space.getMetadata.joinPolicy`   | no        | broadcast `invalidateSpace`                      |
| `space.getMetadata.isMember`     | yes       | `joinSpace`/`leaveSpace` emit (affectedUser)     |
| `space.getMetadata.isAdmin`      | yes       | add/remove admin event (affectedUser)            |
| `space.getMetadata.sidebar[*]`   | mixed     | channel/room/link/role events (broadcast)        |
| `sidebar[*].unreadCount/lastRead`| yes       | `updateSeen` emit, `roomMetadataDiff` (affected) |
| `sidebar[*].activeThreads`       | yes       | `handleCreateMessage` (affectedUser = author)    |
| `room.getMetadata.canRead/canWrite` | yes | role **assignment** (add/remove member role, ban) → affectedUser; role **permission** edit (`setRoleRoomPermission`) → broadcast (see note below) |
| `room.getMetadata.unreadCount`   | yes       | `updateSeen` emit, `roomMetadataDiff`            |
| `room.getMetadata.recentThreads` | yes       | `handleCreateMessage` (affectedUser = author)    |
| `getSpaces[*].*`                 | yes       | join/leave/create + unread diffs (affectedUser)  |

The rule the eviction listener implements: **if `affectedUser` is set, evict that user's entry (and anon, for fields visible to anon); otherwise sweep all users for that `(nsid, params)`.** This is correct for every row in the matrix because `inferSignals` already sets `affectedUser` exactly when the changed field is caller-scoped.

**Note on role-permission vs role-assignment asymmetry (row above):** a role *assignment* (`handleAddMemberRole`/`handleRemoveMemberRole`, `inferSignals.ts:477–496`) changes one user's `canRead`/`canWrite` and emits with `affectedUser = targetUser` — only that user's entry is evicted, which is correct. A role *permission* edit (`handleSetRoleRoomPermission`, `inferSignals.ts:498–514`) changes `canRead`/`canWrite` for **every** member of that role, so it emits **broadcast** (no `affectedUser`) and the sweep evicts all callers' entries for the affected `roomId`/`spaceId`. The listener honours both correctly because it keys off `affectedUser`, not off the event type. This distinction is worth calling out because the matrix otherwise lumps "role events" together; the two sub-cases have opposite eviction scopes.

### The anon case

`space.getMetadata` allows anonymous read for non-banned callers (the handler explicitly does not require membership, `space.roomy.space.getMetadata.ts:88–97`). Anon responses contain empty sidebars and no per-user fields, so anon entries are invalidated by:
- Broadcast signals (space name/avatar/topology) — sweep includes anon.
- Per-user signals — anon entry is also evicted defensively, because anon `canRead`/`canWrite` can change when a space flips `allow_public_join` (handled by broadcast `invalidateSpace`, so the per-user branch is redundant but safe).

Anon entries are cheap (empty sidebar) and rarely hot; the defensive eviction is fine.

## Implementation phases

### Phase 1 — Cache primitive + unit tests

**Files:** `src/cache/queryCache.ts` (new), `src/cache/queryCache.test.ts` (new), `src/cache/queryCacheKey.ts` (new).

- `queryCacheKey(nsid, params, userDid)` — canonical key string. Reuse `packages/sdk/src/cache/query-key.ts` canonicalisation (export it, or copy the sort-and-stringify — it is 10 lines and depends only on `JSON.stringify`).
- `QueryCache` class with `get` / `set` / `evict` / `evictPrefix` / `clear`, LRU via `Map` re-insert, TTL on read, `maxEntries` cap.
- Unit tests: hit/miss, TTL expiry, LRU eviction at cap, `evictPrefix` sweeps all userDids for an nsid+params, per-user keys are independent.

### Phase 2 — Router integration

**Files:** `src/xrpc/router.ts` (edit), `src/appserver.ts` (edit), `src/cache/index.ts` (new).

- Add an optional `queryCache?: QueryCache` and `cacheableNsids?: Set<string>` to `XrpcRouter` constructor (or a `setQueryCache` method). Default absent → no caching, preserves existing test behaviour.
- Wrap the query dispatch (lines 149–175) with the lookup/insert logic from the Design section. Only consult the cache when `cacheableNsids.has(nsid)`.
- In `createAppserver`, instantiate `QueryCache` and pass it to `buildRouter` (or set after construction). Register the eviction subscriber on `invalidationRouter`.
- On `close()`, unsubscribe and clear the cache.
- `CACHEABLE_NSIDS` constant lives in `src/cache/index.ts` and is imported by the router.

### Phase 3 — Eviction wiring + tests

**Files:** `src/cache/evictListener.ts` (new), `src/cache/evictListener.test.ts` (new).

- `attachCacheEvictionListener(router, queryCache)` → returns unsubscribe. Implements the per-user-vs-broadcast logic from the Design section.
- Tests: feed synthetic `queryInvalidation` events (with and without `affectedUser`) and assert the right keys are evicted and the wrong ones are retained. Use a stub `QueryCache` that records `evict`/`evictPrefix` calls.
- Integration test in `src/appserver.test.ts` (the E2E factory smoke test): boot `createAppserver`, hit `space.getMetadata` twice for the same `(spaceId, userDid)`, assert the handler runs once (spy on the handler or on `openDb`). Then emit an invalidation, hit again, assert the handler runs a second time.

### Phase 4 — Production readiness

- **Metrics:** expose `query_cache_hits`, `query_cache_misses`, `query_cache_evictions`, `query_cache_size` via the existing stats endpoint (`space.roomy.admin.push.getStats` or equivalent). Without these, a regression in hit-rate is invisible.
- **Config:** `APPSERVER_QUERY_CACHE_MAX_ENTRIES` (default 4096), `APPSERVER_QUERY_CACHE_TTL_MS` (default 60000), `APPSERVER_QUERY_CACHE_ENABLED` (default true, with a kill switch for instant rollback if a correctness bug surfaces).
- **Observability check:** confirm via the e2e perf harness (`docs/plans/appserver-e2e-perf.md`) that the badge fan-out scenario shows a >90% cache hit rate after the first scroll frame.

## Verification

- **Correctness:**
  - Unit tests for `QueryCache` LRU/TTL/prefix-eviction.
  - Unit tests for the eviction listener covering per-user vs broadcast signals.
  - Integration test in `src/appserver.test.ts`: cache hit skips handler; invalidation causes next call to re-run handler; per-user invalidation does not evict another user's entry.
  - The existing 25 test files / ~240 tests must continue to pass. The cache must be injectable but default-off for unit tests that use mocked DBs and assert on handler call counts — those tests should construct `XrpcRouter` without a cache, exactly as today.
- **Performance:**
  - The e2e perf harness should show `room.getMetadata` and `space.getMetadata` p50 latency drop by the handler cost on cache hit (i.e. near-zero) and p99 drop similarly, with hit rate >90% on the badge-fan-out scenario.
  - SQL statement count per request (via `bun:sqlite` tracing or a debug counter) should drop from ~130 to ~0 for cached `room.getMetadata` calls.
- **Safety:**
  - Confirm no `db.run` / direct write path outside the materializer and procedure handlers can change a cached field without emitting a signal. The audit performed for this plan found only: test seed helpers (not production), the embed enricher (writes `comp_embed_link*`, not cached), the readstate worker migrations (schema, not data), and `updateSeen`/`setHandle`/`createSpace`/`joinSpace`/`leaveSpace` (all emit). No production write path bypasses the router.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| A future event type is added without an `inferSignals` handler, serving stale data. | TTL safety net (60s). Add a comment in `inferSignals.ts` pointing at the cache as a consumer. Add a test that asserts every `AppliedEvent` type has a handler. |
| A future procedure mutates a cached field without `router.emit`. | Same TTL. Add a lint/test that any handler importing `openDb` and calling `db.run` must also import `Router`. |
| Per-user leak if a key is ever constructed without `userDid`. | The `queryCacheKey` helper always takes a `userDid` arg (null → `"anon"`); there is no overload that omits it. Test that anon and authenticated keys for the same params are distinct. |
| Memory growth under many users × many spaces. | `maxEntries` cap with LRU. 4096 entries × ~2KB average response ≈ 8MB worst case. Tunable via env. |
| Broadcast `evictPrefix` sweep is O(n) over the cache. | Start with flat map; if profiling shows it hot, promote to two-level `Map<nsidParams, Map<userDid, CacheEntry>>` for O(1) broadcast eviction. The API does not change. |
| Test suite breaks because handlers are no longer called on every request. | Cache is opt-in at the router level; tests construct `XrpcRouter` without it. The integration test in Phase 3 is the only test that enables it. |

## Out of scope (explicit follow-ups)

- Client-side visibility gating and batched prefetch for `SpaceRoomBadge` (reduces *requests*; this cache reduces *cost per request*; both are wanted and independent).
- Promoting `getMembers` / `getRoles` / `getInvites` into the cacheable set (same pattern, lower payoff).
- Two-level store for O(1) broadcast eviction (only if profiling demands it).
- Cross-process invalidation (only if the appserver is horizontally scaled).
- Caching `getMessages` / `getThreads` / `getActivityFeed` (different freshness model; would need to compose with `#messageDiff`).
- **Permission-class / shared-key caching** (keying on a permission-equivalence class instead of `userDid`). Rejected for v1 in "Alternatives considered" above. Conditioned on either (a) the per-DID working set pressures `maxEntries` with a low hit-rate, or (b) the cache becoming shared/distributed, where the class-key deduplication multiplier actually materialises. The cheaper first move before class-keying is splitting broadcast fields out of the per-user response and caching them with no `userDid` in the key, plus promoting the per-request access memo to cache-scoped.
- **Time-bucketed activity feed** as a cacheable list query (different API shape from the existing cursor endpoints; composes with diff frames via single-bucket invalidation). Only worth pursuing if list-level server caching becomes a goal — the current diff-frame model already keeps these fresh on the client. Count-bucketed / modular-offset pagination of the existing cursor endpoints is explicitly rejected (see "Alternatives considered").