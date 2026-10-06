# Persistent Client Caches — Plan

**Date:** 2026-09-29
**Status:** P1 and P2 shipped, with two revisions since. P1 (the
`CachePersister` seam) merged as #333 (`c2ad8a1e`); P2 (the real storages,
restore-on-load, and the §5.3 restore validator) merged as #343 (`ba73c0db`).
§2–§5 are the design those phases implement, as revised by §5.1: the
persisted-snapshot age cap is gone (a snapshot is restored however old it is)
and a failed refetch is reported as stale data — a banner and a grey dot —
rather than as an error state. §6 is a **later, unconfirmed, unscheduled**
phase recorded so the proposal and the objections to it are not lost — it is
not a commitment.
**Next:** P3 — `TauriStorePersister` (the storage plugin, its capability, and
`CONFIG`-driven selection in the shell; also the iOS default per §4.1). Not
implemented and not dispatched; no open task tracks it. P3 is the last phase in
§7, and the §6 log stays unscheduled.
**Packages:** `packages/sdk`, `packages/app-lite`

## Goal

A returning user sees the rooms they were last in *immediately*, from a cache
that survived the reload, instead of an empty shell for the length of the first
`getMessages` round-trip. Meri's statement of the requirement (Muni Town, thread
`Client persistence`, 2026-09-26T22:15Z): *"if we have to refetch everything
every time it's unfortunate"*. The mechanism agreed in that thread is the
stale-while-revalidate shape: render what is cached, refetch what the user is
looking at, let the WebSocket reconciliation that already exists keep the view
correct from there.

The persistence layer must sit behind a seam, so the same cache can be stored by
whatever the platform offers — browser storage, Tauri's native storage, or
nothing at all — without the sync layer or the UI knowing which one it got.

Two properties were revised after P2 shipped, and §5.1/§5.1b are the current
statement: **the cache is not discarded for being old** (a snapshot is restored
however long ago it was written) and **a failed refetch is not an error state**
(the view keeps the value it has and the app says the refresh did not go
through).

---

## Verified starting point

Everything below is verified against `origin/next` = `1023f9bd`. Line anchors are
current paths in that tree. Measurements are named with what was measured; the
micro-benchmarks in §5.3 are from a throwaway script run against the
pinned `@tanstack/query-core` (`packages/sdk/package.json:97`), not
from a built app.

**The cache is TanStack Query, and it is deliberately memory-only.**
`packages/app-lite/src/lib/client.ts:53-69` builds the one `QueryClient` with
`staleTime: Infinity`, `refetchOnWindowFocus: false`, `refetchOnReconnect:
false`. Nothing else sets `gcTime`, so the library default applies: 5 minutes in
a browser (`@tanstack/query-core` `build/modern/removable.js:21`). Six call sites
set `gcTime: 0` — `queries/threads.ts:62,88`, `queries/links.ts:29,50`,
`queries/search.ts:50`, `queries/search-rooms.ts:46` — which means those entries
are collected as soon as nothing observes them.

**Freshness is the socket's job, not the clock's.** `client.ts:45-46` states the
contract: HTTP refetches happen only on WebSocket invalidation signals. The
signals arrive as `#invalidate` frames routed by
`packages/sdk/src/sync/router.ts:118` into `CacheAdapter.invalidate()`,
`#messageDiff` frames routed at `:122-137` into
`CacheAdapter.patch()` + `applyMessageDiff`, and `#roomMetadataDiff` /
`#roomActivityDiff` frames routed at `:139-247` into the board patchers.

**The read path already defends against its own slowness.**
`packages/app-lite/src/lib/queries/messages.ts:34-61` documents the race between
a slow `getMessages` (production p50 73 ms, spikes to seconds) and a
`#messageDiff` frame that patches the cache while that fetch is in flight, and
re-merges WS-delivered rows the resolved snapshot does not contain. The merge
sorts by the server's timeline key (`:52-59`).

**The ordering key is server-owned.** `room.getMessages` pages by
`coalesce(sort_idx, id) desc, id desc` (`packages/appserver/src/queries/selectMessages.ts:223`,
with the keyset form at `:219-221`), served by
`idx_entities_room_sort_key (room, coalesce(sort_idx, id), id)`
(`packages/appserver/src/db/schema.sql:55-56`). `sort_idx` is the *server's*
arrival time (or a bridge's `timestampOverride`), not the sender's clock.
`applyMessageDiff` sorts by the same key (`packages/sdk/src/sync/diff.ts:47-50`),
and so does the `messages.ts` merge above. Three implementations of one key.

**The frame-to-cache seam already exists and is framework-agnostic.**
`packages/sdk/src/cache/adapter.ts:39-80` is `CacheAdapter` — `get`,
`invalidate`, `patch`, `patchAll` — and `:9-11` states the invariant: core never
imports a cache library. `packages/sdk/src/browser/tanstack.ts:70-169` is its
only implementation, wrapping a `QueryClient`; keys are canonicalised by
`packages/sdk/src/cache/query-key.ts:30-44`.

**The client already persists things, each with its own ad-hoc rule.**
`components/chat/scroll-position.svelte.ts:47-82` (localStorage, 24 h discard
window), `last-login.ts:59-62` (localStorage, guarded for SSR),
`error-recovery.ts:37-46,108-141` (sessionStorage, reload budget),
`push.svelte.ts:26,204,240,289` (localStorage, endpoint hint),
`nativeUpdate.svelte.ts:16-40` (localStorage, a preference). None of these is a
cache and none of them is the query cache.

**No persistence dependency is installed.** `@tanstack/query-persist-client-core`,
`query-async-storage-persister`, `query-sync-storage-persister` and `idb-keyval`
appear nowhere in `pnpm-lock.yaml`. `@tanstack/svelte-query` re-exports
`query-core` wholesale (`dist/index.d.ts:1`) and ships `useIsRestoring`,
`HydrationBoundary` and `useHydrate` (`:17-19`), so `dehydrate`/`hydrate` are
already reachable without a new package.

**The shells differ in what storage they have.** The web build is
`@sveltejs/adapter-static` with a registered service worker
(`packages/app-lite/svelte.config.js:10-19`); its fetch handler
is cache-first for build assets and network-first for everything else
(`src/service-worker.ts:88-142`), and it only writes a response into Cache
Storage when the request is same-host (`:122`), so XRPC responses against
`api.roomy.space` pass through it uncached. The Tauri
shell (`src-tauri/Cargo.toml:20-35`) registers `os`, `http`, `opener`, `process`,
`deep-link`, `log`, `single-instance` and `updater` — **no storage plugin**, so a
native store is a new capability, not a configuration change.

---

## 1. What "today" means, precisely

Three facts define the baseline the plan has to improve, and each one is the
thing a naive persistence layer gets wrong.

1. **A reload starts empty, and stays behind.** `createMessagesQuery`
   (`queries/messages.ts:24-64`) fetches on mount because the cache is empty.
   `preload.ts:128-188` prefetches the first page of at most
   `MAX_ROOM_PREFETCH = 12` rooms (`:65`) per space entry, and only once auth
   settles (`routes/+layout.svelte:81`). So on a cold load the *sidebar* can look
   full (space metadata is prefetched, `preload.ts:98-112`) while every room is
   empty until its own fetch lands.

2. **The first fetch after a reload is a fetch.** Because the entry is absent,
   `shouldLoadOnMount` is true and TanStack fetches regardless of `staleTime`.
   There is no path today where a room renders content that was not fetched in
   this page's lifetime.

3. **`staleTime: Infinity` means the cache is never *asked* to refresh.**
   `refetchOnWindowFocus: false` and `refetchOnReconnect: false` are set in
   `client.ts:63-64`, so the only refetch triggers are an explicit
   `invalidateQueries` — from a `#invalidate` frame, a topic (re)subscription
   (`packages/appserver/src/sync/handler.ts:359` sends room-scoped invalidations
   on `sub`), or the two recovery paths in `sync.svelte.ts:284-294` (seq gap /
   long backgrounding). This is the property that makes persistence dangerous:
   **a restored entry is fresh by construction, so nothing will refetch it.**

---

## 2. Near term: SWR over the existing cache

The near-term design is the one agreed in the thread: persist the query cache,
restore it on load, paint from it, and reconcile by refetching the page the user
is actually looking at. No event log, no client-side replay, no new server
endpoint. It is a special case of the first load where the first load has
something to show.

### 2.1 The sequence

```
reload
  ├─ await persister.load() → hydrate the snapshot into queryClient
  ├─ the keys just restored are invalidated (refetchType "none")
  │    → restored data is rendered, and marked stale without fetching
  ├─ queries mount → paint from the restored values immediately
  │    → the mount sees the query invalidated and refetches it
  ├─ the refetch resolves → setQueryData replaces the page
  └─ the WS #messageDiff / #roomMetadataDiff / #roomActivityDiff frames keep it live
```

Three details make this work rather than merely appear to work.

**Invalidation, not "refetch on mount".** After `hydrate`, a restored entry is
*not* stale (measured: `isStaleByTime(Infinity) === false`, §5.3), so
`refetchOnMount` will not fire — a restored view would sit there indefinitely.
The `#invalidate` frame machinery already produces the needed state: an
invalidation sets `isInvalidated` (`query-core` `build/modern/query.js:388-393`)
and `isStaleByTime` returns true for an invalidated query even under
`staleTime: Infinity` (`:127-138`). So the restore path invalidates the keys it
restored, and the ordinary mount/refetch machinery does the rest. Measured: after
`invalidateQueries({ refetchType: "none" })` on a hydrated entry, a later
observer mount refetches (`§5.3`, case A).

**The refetch must not clobber the frame stream.** The existing guard in
`queries/messages.ts:34-61` is exactly this defence and needs no change: it
re-merges WS-delivered rows on top of the resolved snapshot and re-sorts by the
server key. `hydrate` is the right entry point for the restore for a second
reason: it installs the entry as data-bearing and idle (`@tanstack/query-core`
`build/modern/hydration.js:140-150` resets `fetchStatus: "idle"`, and only
overwrites an existing entry when the snapshot is newer, `:110`), whereas writing
the same array with `queryClient.setQueryData` on a mounted query can race the
in-flight fetch and lose whichever resolved last.

**The restore is synchronous from the app's point of view, and that is a
deliberate choice.** The persister is asynchronous, so the app awaits `load()`
before hydrating — in the layout, before `startSync` (`routes/+layout.svelte:159`)
and before the route queries mount. That removes the restore-versus-mount race
that React's `PersistQueryClientProvider` exists to manage, and with it the need
for `isRestoring` gating in the components: by the time anything mounts, the
restore has either finished or been abandoned (§4.3). The cost is that the first
paint waits on a storage read; the answer is a short timeout on `load()` rather
than a provider-shaped gate.

### 2.2 What it buys

- The room you were last in renders its last-known page immediately on reload,
  in the installed PWA and the Tauri shells, where a reload is the user's normal
  way to return to the app.
- The sidebar's existing prefetch (`preload.ts:98-188`) stops being the only
  thing that survives navigation: a room's messages survive the *process*.
- No server work. No new XRPC. No change to the wire.

### 2.3 What it does not buy

- **Not a faster first load; a non-empty first load.** The refetch still happens
  for the visible room and still costs a round-trip. The gain is that the round
  trip is no longer the first thing between the user and any content.
- **Not a substitute for the refetch.** Everything restored is, by definition,
  from before the reload; the invalidation in §2.1 is what stops it from being
  served forever.
- **Not a fix for the cost of a cold *space*.** A room never visited on this
  device is not in the snapshot and fetches as today. Persistence does not
  narrow what a first-ever visit costs.

---

## 3. The persistence seam

### 3.1 Why storage hangs off the `CacheAdapter` seam

`CacheAdapter` (`packages/sdk/src/cache/adapter.ts:39-80`) is already the
framework-agnostic boundary the sync layer writes through, and its doc comment
(`:9-11`) already forbids core from importing a cache library. Persistence is a
second implementation concern *of the same cache*, so it belongs on the same
seam: the in-memory TanStack adapter is what the cache is *wired to*, and a
storage adaptor is what the cache's contents are *kept in*.

The plan therefore adds storage alongside `CacheAdapter` rather than introducing
a parallel hierarchy:

- **`CacheAdapter` stays the write/read surface for frames** — `get`,
  `invalidate`, `patch`, `patchAll`. Unchanged, and still the only thing
  `router.ts` talks to.
- **A new `CachePersister` is the storage surface** — load, save, clear — and
  it is keyed by the same canonical `QueryKey` (`query-key.ts:30-44`), so a
  persisted entry and a patched entry address the same row.

Keeping `CacheAdapter`'s four members unchanged is deliberate: `router.ts:257-266`
(`#applyOrInvalidate`) depends on `get` being synchronous and on `patch` being
observable immediately after it returns (`adapter.ts:33-38`). A store that is
asynchronous on the way *out* would break that contract; hence storage is a
separate, explicitly-asynchronous surface, and persistence is defined as
write-behind.

### 3.2 What a storage adaptor must implement

```ts
/** One persisted cache entry, exactly as the in-memory adapter holds it. */
interface PersistedEntry {
  key: QueryKey;        // canonical, via queryKey()
  state: unknown;       // the value get() returns for that key
  at: number;           // epoch ms this value was written
}

interface CachePersister {
  /** Every persisted entry, or empty when there is none / it is unreadable. */
  load(): Promise<PersistedEntry[]>;
  /** Replace the persisted set. Called throttled, never per frame. */
  save(entries: readonly PersistedEntry[]): Promise<void>;
  /** Drop everything. Called on logout and on a detected corrupt store. */
  clear(): Promise<void>;
}
```

Four rules an adaptor must satisfy, each of which exists because of a measured
or reported failure in §4:

1. **It never throws into the caller.** `load` returns `[]` and `save` resolves
   on failure; a storage error is a reportable diagnostic, not an application
   error. (The corrupt-store incident below surfaced as a login failure with no
   console error — the opposite discipline.)
2. **It is versioned.** `load` must reject a snapshot written by a different
   persisted-shape version, and `save` must write that version. A shape change
   (a new field in the row the cache holds) must not be able to produce a
   half-understood entry.
3. **It is scoped to an account.** The snapshot carries the DID it was written
   for; `load` returns `[]` when the current DID differs. (§4.4.)
4. **It is bounded.** `save` truncates to a configured budget and reports what
   it dropped. Unbounded growth is how the reported corruption happened.

### 3.3 The named adaptors

| Adaptor | Where it is used | Storage | Notes |
|---|---|---|---|
| `IndexedDbPersister` | browser (web app, PWA) | IndexedDB, one object store | The default on the web. Asynchronous throughout, structured-clone-free (values are JSON-shaped already). Subject to the quota and corruption behaviour in §4.1. |
| `TauriStorePersister` | Tauri shells (desktop, iOS, Android) | a native key-value store via a Tauri plugin | The native path Meri named. Also the **fallback on iOS**, where IndexedDB under Tauri is reported unreliable (§4.1) — the shell's storage is not subject to the webview's IndexedDB implementation. |
| `LocalStoragePersister` | fallback where IndexedDB is unavailable or has failed | `localStorage` | Small, synchronous, 5 MB-class budget. Enforces a hard byte cap and drops the oldest entries first. This is the "always have a local storage fallback" rule. |
| `MemoryPersister` | tests, SSR, and any consumer with no storage | a `Map` | Not persistence: it makes the seam total, so the app has exactly one code path and tests exercise it. |

Web Push's transport registry (`packages/appserver/src/push/transports/types.ts`,
`PUSH_TRANSPORTS`) is the precedent for this shape — a registry keyed by kind,
where the transport never throws and reports an outcome. The persistors should
read like its siblings.

### 3.4 What stays in core

Core (the SDK, and `client.ts`) owns everything that decides *whether a
restored value may be trusted*; an adaptor owns only *bytes in, bytes out*:

- **The key set.** Which queries are persisted. Not the adaptor's decision —
  an adaptor that accepted a `save` would otherwise persist `gcTime: 0`
  entries that are collected immediately.
- **The ordering invariant** of §5.3.
- **The staleness contract** of §5.1–§5.2.
- **The account scope check** of §4.4.
- **The degradation rule** of §4.3.
- **The write schedule** (throttle, and the final flush on
  `visibilitychange`/`beforeunload`). The cache changes on every diff frame
  (`router.ts:122-137`), so writing per change would put a disk write on the
  frame path; the save must be debounced and off that path.

`client.ts` is the composition point — it already owns the `QueryClient`, and it
is where the persister is chosen (`CONFIG`-driven, so the Tauri shell can select
the native store without a second code path).

---

## 4. Failure modes

These are the reason this plan is not "call `persistQueryClient` and ship". Each
is named with the evidence available in the tree or the thread.

### 4.1 IndexedDB corruption and quota eviction

**Reported, in this thread, on a real device (2026-09-25T23:47Z onward).** A user
could not log in at all, with **no console and no network error**; the only
surface was a browser exception reading roughly *"the current transaction
exceeded its quota limitations"*. It resolved by clearing cookies. The diagnosis
recorded in the thread is that IndexedDB had been corrupted — plausibly by
growing past a size at which the browser became aggressive with quota while disk
space was briefly short.

Three consequences the design must absorb:

1. **Quota eviction is normal, not exceptional.** A browser may evict an origin's
   storage under pressure. `navigator.storage.persist()` is a *request* — it is
   not granted on iOS, and it does not prevent corruption.
2. **Failure may be silent and partial.** The reported case produced no
   application-visible signal until an unrelated operation failed. A persister
   that assumes "no exception at save time" therefore cannot assume the bytes
   are later readable.
3. **The failure must not be able to reach login.** Session restoration is a
   different store on the same origin: `@atproto/oauth-client-browser` keeps the
   OAuth session in its own IndexedDB database
   (`dist/indexed-db-store.js:6-67`). Cache persistence must not share a
   database with it, and a cache-store failure must never be able to fail
   session restore. **Separate database, separate name, no shared transaction.**

**iOS/Tauri warning, in the same thread (2026-09-26T06:25Z):** newer iOS versions
under Tauri hit "weird issues" with IndexedDB, and a localStorage fallback should
always exist. The reported fix on the application side was to patch the
`@atproto` libraries — which is precisely the code path the app cannot rely on
for its *own* cache. The plan's answer, in order: use the native store on iOS
(`TauriStorePersister`), fall back to `LocalStoragePersister`, and treat
IndexedDB as the web-only default.

### 4.2 The localStorage fallback

`localStorage` is synchronous and small. Under this design that is a feature and
a hazard:

- **Feature:** it cannot be "not yet ready", so it has no load race, and it fails
  loudly (`QuotaExceededError`) rather than by eviction.
- **Hazard:** a value that exceeds the cap throws at save time, and a synchronous
  5 MB write on the main thread is a jank source. The adaptor therefore enforces
  a byte budget smaller than the platform's (a few hundred KB of the 5 MB class),
  writes only throttled (§3.4), and drops oldest-first.

The existing call sites already demonstrate both halves of the discipline and
should be followed, not replaced: `last-login.ts:59-62` guards for the absence of
a DOM, `error-recovery.ts:128` ignores a storage failure rather than failing the
operation it was assisting.

### 4.3 The degradation rule

**A corrupt, absent, evicted, wrong-version, or wrong-account cache must
degrade to today's behaviour: an empty cache that fetches. It must never
degrade to a wrong view.**

Concretely, in order of what is guaranteed:

| Situation | Required behaviour |
|---|---|
| No snapshot (first run, cleared, evicted) | Empty cache. Queries fetch on mount, exactly as `main`. |
| Snapshot written by another persisted-shape version | Discard silently, empty cache. |
| Snapshot written for another DID | Discard silently, empty cache. |
| `load` throws / the store is unreadable | Log a diagnostic, empty cache, and switch to the fallback adaptor for the rest of the session. |
| An entry inside an otherwise valid snapshot is malformed | Drop **that entry**, keep the rest. An entry that cannot be understood is absent, not empty-valued. |
| A restored entry's data fails its shape check | Drop that entry (§5.3). Never render an unvalidated row. |

Age is deliberately absent from the table: a snapshot is restored however old it
is (§5.1), so there is no age at which the app prefers nothing to something it
already had.

**A partial restore is acceptable; a partial entry is not.** This is why the rule
is stated per-entry: the failure that matters is not "we lost the cache" (that is
`main`), it is "we kept enough of the cache to show something wrong".

### 4.4 Two failure modes specific to persistence, not storage

- **Account bleed.** The store is per-origin, not per-account. Logging out calls
  `location.reload()` (`auth.svelte.ts:532-554`), so unless logout clears the
  snapshot first, the next account's first load restores the previous account's
  rooms. `logout()` must `clear()` the persister before it reloads; the DID
  buster on `load` (§3.2 rule 3) is the second line of defence.
- **Stale-and-fresh confusion after a *deploy*.** A persisted entry can outlive
  the shape of the row it holds. `dehydrate`/`hydrate` will carry it across
  (`@tanstack/query-core` hydrates whatever `state` says, §5.3 case B), so the
  persisted-shape version of §3.2 rule 2 must be derived from the build identity
  the app already computes (`vite.config.ts:12-18` inlines `__BUILD_ID__`;
  `src/routes/build.json/+server.ts:16-22` serves the same value; `build-id.ts:30-57`
  is the resolver). A new bundle is a legitimate reason to drop the snapshot.

---

## 5. The staleness and reconciliation contract

### 5.1 What is shown, and for how long

- **Shown from cache:** any restored entry, immediately, exactly as it was
  stored.
- **For how long:** until the entry is refetched — with no age limit on the
  restore itself, and no age limit on what is kept. A value from a snapshot
  written weeks ago is still shown while the room refetches, because the
  alternative is an empty view. The refetch, not a clock, is what replaces it:
  the restore invalidates every key it hydrates (§2.1), so the room the user
  opens fetches immediately (`queries/messages.ts`), and the WebSocket keeps it
  live from there. Nothing is discarded on the grounds of age — a snapshot that
  old is exactly the case persistence exists for.
- **Which entries are persisted at all:** queries, not mutations. Within those,
  success-status, non-error, and not `gcTime: 0`. The `gcTime: 0` queries
  (`threads.ts:62,88`, `links.ts:29,50`, `search.ts:50`, `search-rooms.ts:46`)
  are excluded structurally: they are collected the moment nothing observes them,
  so persisting them would store entries the cache is about to drop. Errors are excluded
  because the app already caches them deliberately (`routes/+layout.svelte:166-178`
  discusses the "Not authenticated" case) and a stale error is strictly worse
  than no error.
- **`gcTime` is `Infinity` for the persisted set.** An in-memory entry the cache
  collects is one the next snapshot omits, so collecting an unobserved entry
  discards the room the user was not looking at — which is the set persistence
  exists to keep. TanStack's browser default is 5 minutes
  (`removable.js:21`), so the override is not optional; the six `gcTime: 0` call
  sites keep their opt-out, and are excluded structurally as above.

### 5.1b A failed refetch is stale data, not an error state

A refetch that fails leaves the query holding the value it already had with
`status: "error"` alongside it — TanStack's `isRefetchError` — so the value is
still there to render. Under `staleTime: Infinity` and a WebSocket-only
freshness authority that is the ordinary case, not an exception: an unreachable
appserver fails the refetch behind every mounted query at once.

Two rules follow, and they are what the views and the indicators implement:

- **With data, the view stays.** Every error branch is guarded on there being
  nothing to fall back on (`isLoadingError`, not `isError`), so a failed
  revalidation re-renders the last good value instead of an error message.
- **Without data, the view reports it.** An initial fetch that failed has left
  nothing on screen and nothing to show, so the view's own error state is the
  only thing that can say so.

`query-health.ts` reads the first case off the cache — `status: "error"` with
`data !== undefined` — and `query-health.svelte.ts` recomputes that count on
every cache update, so a successful refetch clears the indication without
anything remembering which query failed. The indicators are the banner above
the content (`StaleDataBanner.svelte`) and the dot on the sidebar user card
(grey for stale, red only when there is neither a socket nor a fallback).

A recoverable session/auth failure is not a special case here: it is what
`error-recovery.ts` is for, and it reloads within a second of the first failed
query. Until it does, the value genuinely is stale, and saying so is accurate.

### 5.2 When a refetch is triggered

Four triggers, all of which already exist except the first:

1. **On restore.** Every key the restore installs is invalidated with
   `refetchType: "none"` (`§2.1`). This marks it stale without starting the
   fetch, so a query that is *never mounted* is never fetched — the user pays
   only for what they look at, which is the property that makes the thread's
   whole debate resolvable (§6.3).
2. **On mount.** The invalidation from (1) makes the mount refetch
   (`query-core` `queryObserver.js:447-452`). This is the "refetch the page you
   are looking at".
3. **On subscription.** A room-topic `sub` already triggers room-scoped
   invalidations (`packages/appserver/src/sync/handler.ts:359`), so re-entering
   a room refetches it even if (1) was somehow skipped.
4. **On a signal.** `#invalidate` frames, and the recovery paths for a seq gap or
   a long backgrounding (`sync.svelte.ts:284-294`, `:303-316`), exactly as today.

### 5.3 What must NOT be trusted from cache: the ordering key

**The persisted shape must be the same shape, in the same order, that the server
pages by.** The client sorts by `coalesce(sort_idx, id)` with `id` as tie-break
in three places (`queries/messages.ts:52-59`, `sdk/src/sync/diff.ts:47-50`, and
the server's own `selectMessages.ts:223`). A cache restored in a different order —
or restored from a snapshot written before the ordering key was changed, or
restored with `sort_idx` dropped — puts a row somewhere the server's page never
puts it, and nothing repairs it, because (measured) a hydrated entry is *not*
stale.

Measured, against the pinned `query-core`:

| Case | Result |
|---|---|
| `hydrate` of a fresh entry, then `isStaleByTime(Infinity)` | `false` — a mount would **not** refetch |
| the same, after `invalidateQueries({ refetchType: "none" })` | `true` — a mount **would** refetch (a real observer was observed to refetch exactly once) |
| an entry whose stored array is in the wrong order | restored verbatim, and not stale — **the wrong order persists** |
| a `dehydrate`/`hydrate` round trip of 10,000 message rows | 4.81 MiB of JSON, stringify ~103 ms, parse ~87 ms, dehydrate ~0.1 ms, hydrate ~1.3 ms |
| the same at 2,500 rows / 1,000 rows | 1.20 MiB / 0.48 MiB, ~12 ms / ~4 ms combined serialize+parse |
| `hydrate` of an entry with a key but `data` of the wrong type | accepted verbatim — the query is built, not validated |
| `hydrate` of an entry with **no** `queryKey` | accepted; the query is built with `queryKey: undefined` and no hash |
| `hydrate` of an entry with a non-numeric `dataUpdatedAt` | accepted; `isStaleByTime(Infinity)` then returns `true` (the NaN comparison fails open) |

So the contract is:

- **`sort_idx` is part of the persisted row and must survive the round trip.**
  A row restored without it is not a row the client can order — the fallback
  (`id`) is a *different* key for exactly the messages where the two disagree
  (bridged backfill, `timestampOverride`, moves).
- **A restored list must be validated, not trusted.** On load, re-sort every
  restored `getMessages` list by the same comparator the diff applicator uses
  and drop any element that does not parse as a `Message`
  (`packages/sdk/src/schemas/queries/_message.ts:92-130` — `id`, `content`,
  `authorDid`, `authorName`, `timestamp` required; `sort_idx` optional *by
  schema*, which is why the check is on the round trip, not on the type).
  Re-sorting is cheap and idempotent; a wrong view is not recoverable.
- **`hydrate` is not a validator, and the snapshot must not lean on it.**
  Measured: it accepts a wrong-typed `data`, an entry with no `queryKey` at all
  (building a query with `queryKey: undefined`), and a non-numeric
  `dataUpdatedAt`. Two of those three produce a wrong view or a never-refetching
  entry. The snapshot's own shape check (§3.2 rules 2–3) and the per-entry
  validator above are the only things standing between a corrupt snapshot and
  the timeline.

### 5.4 The rest of the trust boundary

- **Caller-scoped fields are the user's, not the room's.** `getSpaces` carries
  `unreadCount` and `isAdmin` (`packages/sdk/src/schemas/queries/getSpaces.ts:20-24`);
  `room.getMetadata` carries `canWrite`, `unreadCount` and `lastRead`
  (`getRoomMetadata.ts:15-17,27-29`). These are already the reason invalidations
  are filtered per user on the wire (`invalidation/types.ts:44-74`,
  `affectedUser`). Persisted under the account buster of §3.2 rule 3 they are
  safe; persisted without it they are a cross-account leak.
- **`#roomMetadataDiff` unread deltas are *deltas*.** Replaying or re-applying
  one is not idempotent. This is why persistence stores the *resulting* query
  values (which is what `dehydrate` gives) and not the frames that produced
  them — a distinction §6 turns on.
- **Optimistic sends are not persisted, on purpose.**
  `mutations/pending-sends.svelte.ts:12-26` states it: *"Nothing here survives a
  reload: this is in-place optimistic UI, not an outbox."* A persisted
  placeholder would be restored as if the server had it, and — because the
  snapshot is not stale — nothing would reconcile it. Persistence must exclude
  any row whose delivery state is pending or failed.
- **The mutation cache is not persisted.** `app-lite` has no `createMutation`
  call sites; the mutation cache only exists to route errors to
  `error-recovery.ts` (`client.ts:57-59`). Persisting it would add surface with
  nothing behind it.

---

## 6. Later phase — the diffs/invalidations log (**unconfirmed, not scheduled**)

Recorded because Meri proposed it in the thread and explicitly invited analysis,
and because the analysis argues against it as a second phase. **This is the
plan's proposal, not a decision.** Nothing here should be built without a
separate decision.

### 6.1 The proposal

Instead of refetching a room, keep an append-only log on the client of
everything that goes over the WebSocket — the `#messageDiff` ops and the
`#invalidate` signals — in a transformed/denormalised form, and replay it from a
`since` cursor on reconnect (Meri, 2026-09-26T22:17Z). The claimed wins, both
stated in the thread: it is more efficient than refetching, and it saves
appserver compute because the server does not recompute the joins
(2026-09-27T01:08Z).

### 6.2 The objections

Recorded as raised, in order:

- **Replay competes with a cheaper query.** If the user was away a day, replaying
  every missed frame across busy spaces is *less* efficient than refetching the
  individual pages they look at (2026-09-27T01:07Z), and the client only needs
  enough to fill the screen (01:09Z).
- **Replay needs a server-side cursor it does not have.** Offline cursors mean the
  appserver keeps history and can replay it, rather than answering "what is the
  latest" from its database (01:13Z) — and per-client cursors kept for offline
  clients is a new server obligation (01:10Z).
- **ATProto does not give a persisted event stream to cursor against.** The
  records are the source of truth; write notifications from the space host are
  live, not a log (01:13Z–01:16Z). Persisting them for clients is an extra
  appserver responsibility, not a given.
- **Debug cost.** *"Adding more complicated client state also made things harder
  to debug... you couldn't just refresh and have a new, up-to-date view if
  something went wrong with the syncing"* (01:17Z). A reload that rebuilds from
  the server is the recovery affordance; a cache with its own applied-log is not.
- **Meri's acceptance** (01:06Z): *"im jumping two steps ahead in my thinking.
  You're describing the reasonable first step. I agree"* — with the log as the
  later step.

### 6.3 Analysis

The disagreement is narrower than it reads, and the seam in §3 is what narrows it.

1. **The SWR phase already delivers the efficiency argument's outcome, without
   the log.** The log's justification is "do not refetch everything". Restore +
   invalidate-everything-but-refetch-on-mount (§5.2) refetches *only what the
   user looks at*, which is the same set the log would replay to, and it needs no
   new state. The log's remaining advantage is narrower than the thread suggests:
   it would replace the *page refetch* for a room the user returns to, not the
   set of rooms refetched.
2. **Where the log could still win is the case SWR handles worst:** a room whose
   cached page has scrolled past the refetch window — the user scrolls up into
   history that the page refetch did not cover. A replay of the missed ops would
   keep that history correct without a paged refetch. It is worth noting this is
   only a win if the client is holding history the server would otherwise have to
   re-page, i.e. it is a win proportional to how much history is persisted
   (and §4.1 is a reason to persist little).
3. **The log needs the ordering invariant more strictly than the cache does, not
   less.** A replayed op sequence applied to a restored list must produce the
   server's order. `applyMessageDiff` already sorts by the server key
   (`diff.ts:47-50`) and is idempotent for `add`/`update` by construction
   (`map.set`), so replay is order-tolerant *for message ops* — but the
   `#roomMetadataDiff` unread deltas are additive and would be replayed twice if
   the log's `since` and the cache's restore overlap. A log phase must therefore
   record *when* a delta was applied relative to the snapshot, which is exactly
   the "complicated client state" cost named in §6.2.
4. **A `since` cursor has no server contract today.** The appserver's cursor
   handling is explicitly a stub: the `cursor` client message currently answers
   with a full invalidation for every subscribed topic
   (`packages/appserver/src/sync/handler.ts:293-298`), and the per-connection
   `seq` (`:134`, incremented at `:527`, `:622`, `:654`) is a gap *detector*, not
   a replay cursor — it is assigned per connection and resets on reconnect.
   Building the log phase means building the server side of it first, against
   ATProto records rather than a guaranteed event log.
5. **The cheap version of the log is not a log.** If the goal is "do not refetch
   what did not change", the server-side response cache already does it for the
   queries it covers (`packages/appserver/src/cache/index.ts:36-49`) — deliberately
   excluding cursor-paginated and diff-driven queries
   (`packages/appserver/docs/plans/query-response-cache-plan.md:19`). A client log
   would be the client-side mirror of a mechanism already rejected there on the
   grounds that the diff frames keep those lists fresh.

**Recommendation.** Do not schedule the log. Revisit only if a measured case
appears that (a) SWR's page refetch cannot cover and (b) is worth a server-side
replay cursor. The measurement that would justify it is a persisted-history
depth the page refetch cannot reach.

### 6.4 What the log phase would inherit, if it is ever scheduled

- A `since`-cursor contract on `space.roomy.sync.subscribe` that survives
  reconnect, with the same access filtering as the live path
  (`handler.ts:388-420`).
- A decision on whether the appserver persists write notifications for replay,
  or refuses to and serves "latest" only — the ATProto-native question Zicklag
  raised and did not resolve.
- The delta-vs-snapshot rule of §6.3(3), enforced rather than documented.
- The same trust boundary as §5.3–§5.4. A replay path is a second writer to the
  timeline and must obey the ordering invariant identically.

---

## 7. Phasing

Format follows the other plans in this directory. Each phase is reviewable on
its own; none of this is dispatched from this document.
| Phase | Scope | Base | Status |
|---|---|---|---|
| P1 | The `CachePersister` interface, the in-memory impl, and the key-set / version / account-scope rules in the SDK. No storage yet; the app is unchanged. | `next` | Merged #333 (`c2ad8a1e`) |
| P2 | `IndexedDbPersister` + `LocalStoragePersister`, restore-on-load and invalidate-on-restore in `client.ts`, `gcTime` raised for the persisted subset, `logout()` clears — **and the restore validator of §5.3**. The validator is part of this phase, not a follow-up: P2 without it restores rows nothing has checked. | P1 | Merged #343 (`ba73c0db`) |
| P2.1 | No age limit on a restore (`gcTime` is `Infinity`), and a failed refetch reported as stale data — the views guarded on `isLoadingError`, the banner and the sidebar dot — instead of an error state (§5.1, §5.1b). | P2 | Shipped with the revisions above |
| P3 | `TauriStorePersister`: the storage plugin, its capability, and `CONFIG`-driven selection in the shell. Also the iOS default, per §4.1. | P2 | Not started — dispatchable |
| — | The log (§6) | not scheduled | — |

---

## 8. Open questions for Meri

Decision-shaped, with the plan's recommendation where it has one. Questions
1, 3, 4 and 6 were settled by the P1/P2 implementations — persistence is always
on, the budget is a count cap, the snapshot version is derived from the build
id, and the persisted set is the SDK's `isPersistableQuery` rule (queries,
success, non-error, not `gcTime: 0`) rather than a hardcoded list. Question 2
was settled against the plan's own proposal: there is no age limit at all
(§5.1), so the question is no longer "how old may a snapshot be" but "what does
the app show while the refetch that would replace it is failing" (§5.1b).
Question 5 (the §6 log phase) remains the one open decision.

1. **Is persistence opt-in, or always on?** A user-visible setting ("keep the
   last messages on this device") makes the storage failure modes of §4 the
   user's choice and gives a clean answer for shared devices; always-on is
   simpler and gets the benefit to everyone. *Recommendation: always on, with a
   setting only if a reviewer wants one; the data is the same data the app
   already fetched and already holds in memory.*
2. **Is there a `maxAge`, and what is the eviction policy?** ~~24 hours is the
   proposal~~ **Settled: no `maxAge`.** A snapshot is restored however old it
   is; the restore's invalidation is what replaces it, and discarding on age
   threw away exactly the rows persistence exists to keep. Eviction is still by
   count, oldest-written first (§3.2 rule 4).
3. **The storage budget, and what happens at it.** How much is persisted per
   account (room count × page size), and is the response to hitting the budget
   to drop oldest, drop least-recently-*visited*, or refuse to persist more?
   *Recommendation: least-recently-visited, capped by count rather than bytes,
   so the cap is deterministic across adaptors.*
4. **Does the snapshot die at a version boundary?** §4.4 proposes dropping the
   snapshot when the build id changes. That is the safest rule and costs a
   cold-ish first load after every deploy — which is the common case for a
   frequently-deployed client. The alternative is to version only the persisted
   *shape* and accept that the row schema can move under it.
5. **Is the log phase in or out?** §6 recommends out, with the trigger for
   revisiting stated. Recorded here as a decision for Meri, not resolved by this
   plan.
6. **Scope of the persisted set.** §5.1 proposes the message list plus the
   metadata queries; `getActivityFeed` and the thread boards are paginated and
   server-evicted differently. Should the first phase persist only
   `room.getMessages` and the non-paginated metadata, and leave the boards to
   fetch?

---

## References

**Client cache and queries**

- `packages/app-lite/src/lib/client.ts:45-69` — the one `QueryClient`;
  `staleTime: Infinity`, no `gcTime` override.
- `packages/app-lite/src/lib/query-health.ts`,
  `query-health.svelte.ts`, `components/layout/StaleDataBanner.svelte` — the
  stale-data rule, its reactive binding, and the banner (§5.1b).
- `packages/app-lite/src/lib/components/sidebar/SidebarUserCard.svelte` — the
  connection dot (online / stale / offline).
- `packages/app-lite/src/lib/queries/messages.ts:20-64` — the message read path,
  its WS-diff/refetch race guard, and the ordering key.
- `packages/app-lite/src/lib/queries/spaces.ts:19-33`,
  `room-metadata.ts:23-41`, `activity-feed.ts:22-46`, `threads.ts:40-89` — the
  other query shapes and their `gcTime: 0` sites.
- `packages/app-lite/src/lib/preload.ts:19-40,53-65,98-188` — the existing
  in-session prefetch and its cap.
- `packages/app-lite/src/lib/mutations/pending-sends.svelte.ts:12-26,170-193` —
  delivery state is deliberately not persisted.
- `packages/app-lite/src/routes/+layout.svelte:73,81,159-178` — restore,
  prefetch, sync start, invalidate-on-auth-transition.
- `packages/app-lite/src/lib/auth.svelte.ts:532-554` — logout reloads the page.

**The SDK seam**

- `packages/sdk/src/cache/adapter.ts:9-11,39-80` — the `CacheAdapter` contract and
  the no-cache-library invariant.
- `packages/sdk/src/cache/query-key.ts:30-44` — canonical key construction.
- `packages/sdk/src/browser/tanstack.ts:25,70-169,177-183` — the only
  implementation; coalescing and `cancelRefetch: false`.
- `packages/sdk/src/sync/router.ts:118,122-137,139-247,257-266` — frame routing
  and the patch-or-invalidate decision.
- `packages/sdk/src/sync/diff.ts:30-51` — `applyMessageDiff` and the ordering
  comparator.
- `packages/sdk/src/sync/connection.ts:18-19,32-42,706` — topic resubscription on
  reconnect; `Topic.cursor` is stream-scoped.
- `packages/sdk/src/schemas/queries/_message.ts:92-130` — the row shape the
  restore validator checks.

**The server contract the cache depends on**

- `packages/appserver/src/queries/selectMessages.ts:184-227` — the page SQL, the
  keyset cursor, and the ORDER BY.
- `packages/appserver/src/db/schema.sql:47-56` — the matching index.
- `packages/appserver/src/cache/index.ts:36-49` and
  `packages/appserver/docs/plans/query-response-cache-plan.md:19` — what the
  server caches, and why the list queries are excluded.
- `packages/appserver/src/sync/handler.ts:293-298,359,527,735-831` — the cursor
  stub, sub-time invalidations, and the per-connection `seq`.
- `packages/appserver/src/invalidation/types.ts:44-74` — per-user invalidation
  scoping.

**Storage precedent and platform facts**

- `packages/app-lite/src/lib/components/chat/scroll-position.svelte.ts:47-82` —
  the app's existing 24 h localStorage cache.
- `packages/app-lite/e2e/cache-stale.spec.ts`,
  `e2e/client-cache-restore.spec.ts`, `e2e/cache-snapshot.ts` — what the restore
  and the stale-data path are asserted end to end against.
- `packages/app-lite/src/lib/last-login.ts:59-62`,
  `error-recovery.ts:37-46,108-141`, `push.svelte.ts:26,204,289` — guarded
  storage access and the ignore-on-failure discipline.
- `packages/app-lite/svelte.config.js:10-19`,
  `packages/app-lite/src/service-worker.ts:88-142` — the static build and what the
  service worker does and does not intercept.
- `packages/app-lite/vite.config.ts:12-18`,
  `packages/app-lite/src/routes/build.json/+server.ts:16-22`,
  `packages/app-lite/src/lib/build-id.ts:30-57` — the build identity a snapshot
  version can key off.
- `packages/app-lite/src-tauri/Cargo.toml:20-35` — the plugins the shell has
  today; there is no storage plugin.
- `@atproto/oauth-client-browser@0.3.39`
  `dist/indexed-db-store.js:6-67` — the session store that must stay separate.
- `@tanstack/query-core@5.100.10` `build/modern/query.js:127-138,388-393`,
  `queryObserver.js:447-452`, `removable.js:21`, `hydration.js:15-46,70-160` —
  staleness, invalidation, the mount-fetch decision, the `gcTime` default, and
  what `dehydrate`/`hydrate` do and do not check.
