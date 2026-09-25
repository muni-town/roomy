# sendEvents write path

`space.roomy.space.sendEvents` (`packages/appserver/src/handlers/space.roomy.space.sendEvents.ts`).

## The write path must stay local

`sendEvents` completes using local resources only — the event-log DB, the
per-space and global DBs, and the read-state DB. No third-party HTTP call may
sit between the caller's request and its response.

The constraint comes from Bun: every HTTP handler in the process runs on one JS
thread, so `await fetch(...)` there yields the thread only when the third-party
I/O completes, and the DB round-trips issued by concurrent handlers queue behind
it on the shared worker links. One fetching write stalls unrelated endpoints on
every space, not just the writer's request.

Profile resolution is where the rule is easiest to break. `selectMessages`
hydrates author profiles, and hydration self-heals by fetching any author with
no row in the global `profiles` table — exactly the state of a brand-new
participant's first message. The fetch is not conditional on anything the write
path knows:

```
#fetchMessageSnapshots → selectMessages → hydrateProfiles → resolveProfiles
  → hydrateMissingProfiles → getProfilesRoomyFirst
    → https://api.bsky.app/xrpc/app.bsky.actor.getProfiles
```

What keeps the write path local:

- Internal readers of `selectMessages` pass `skipProfileHydration`, so the
  invalidation message-snapshot read gets message *rows*, not rendered messages.
  The indexed global-store read still happens — that keeps the diff close to what
  `roomy.room.getMessages` returns, which the client validates it against — and
  only the network half of hydration is skipped. The client resolves an unknown
  author on its next normal read.
- `resolveProfiles` / `hydrateProfiles` take `allowNetworkFetch` (default
  `true`); the write path passes `false`.
- A failed profile lookup backs off, so the pipeline does not re-ask for an
  unresolvable DID on every event (see "Unresolvable DIDs").

`perf/probe-sendevents.ts` reports every outbound fetch. Any non-zero
`outbound (non-local) fetches` value is a defect.

## Structure of the path

`onEventsApplied` runs inline in `StreamManager.sendEvents`
(`StreamManager.ts:242`). One write executes:

1. Authorization — batched once per request (below).
2. The event-log write transaction, including the `isSpaceRebuilding` probe.
3. `applyBatch` — a transaction against the per-space DB and the global DB.
4. Invalidation (`InvalidationRouter.onEventsApplied`): `#fetchMessageSnapshots`
   (one `selectMessages` per batch, read so `inferSignals` can build the
   `messageDiff` the client applies to its cache), the reply-edge lookup, and the
   mention-index writes.
5. The read-state lookups (see "Read-state indexing").

Each event runs its own `isSpaceRebuilding` probe and its own `applyBatch`
transaction, so the path costs roughly two sequential round-trips per event per
DB across three workers. Summed DB time is a few milliseconds — the DB is not
what makes a write slow.

### Authorization is memoized per request

`sendEvents` authorizes every event in a batch through one `WriteAuthContext`
(`auth/writeAuth.ts`), which carries a single `AccessMemo` + `FederationMemo`
for the request and calls `prewarmWriteAuthAccess` first, so every room the
batch touches resolves in one batched `roomAccessMany` pass.
`checkMessageAuthorOrAdmin` shares the memo too. Re-resolving a room — and the
caller's space standing — once per event would make authorization cost N × a
constant instead of a constant, which is what stretches the authorize phase on
a large batch.

*Residual:* reply targets are still one `entities` lookup per reply attachment,
inside the reply branch.

Regression test: `auth/writeAuth.test.ts` ("batched authorization").

## Cost profile

Measured with the probe against a real appserver and the real profile pipeline
(no stubbed fetcher), batch=1:

| config | p50 | throughput | outbound fetches |
|---|---|---|---|
| concurrency 1 | ~5 ms | ~145 req/s | 0 |
| concurrency 8 | ~25 ms | ~190 req/s | 0 |

## Unresolvable DIDs

Both profile fetch caches suppress a retry only *after a success*, because a
cache row is written from the fetch result. A DID that neither HappyView nor the
Bluesky appview can resolve — a brand-new DID, a `did:web`, an appview hiccup —
has no row to find, so `filterMissing` returns it again on every event and the
pipeline re-runs both lookups. Under concurrency the same author's N
simultaneous writes each issue their own copy.

A module-level backoff (`NEGATIVE_CACHE_TTL_MS`, 1 minute) in
`materialization/profiles.ts`, keyed by DID, bounds this:

- `isProfileFetchBackedOff(did)` — consulted by `getProfilesRoomyFirst` (skips
  both its HappyView and Bluesky legs) and by the read path's
  `hydrateMissingProfiles`, so one failed lookup suppresses every later event
  **and** every later reader.
- `recordUnresolvedProfiles(requested, resolved)` — called by the pipeline once
  every source it consults has been asked, and by `defaultGetProfiles`, which
  `space.roomy.user.getProfile` calls directly as a last resort.

The TTL is one minute rather than the stale-handle cooldown's hour to keep
staleness bounded: a DID that resolves nowhere today may be a user whose Roomy
profile record HappyView has not indexed yet, and messages should not render with
a blank name long after the record exists. **Tradeoff:** for one minute after a
failed lookup, a profile that becomes resolvable in that window is not
re-fetched; the fetch cost becomes one lookup per DID per minute instead of one
per event and per reader.

The ordering in `sendEvents` leaves blank profiles unaffected. Step 4
(`ensureProfilesRoomyFirst`, the blank-profile protection) runs *before* the
invalidation router in the same call, so it has already attempted its fetch and
written whatever it could resolve — the snapshot read is a re-read by
construction. The backoff stops only the *retry* of a lookup that just failed.

## Read-state indexing

Both `read_positions` queries `sendEvents` issues filter by `room_id` alone:

- the createMessage unread bump (`update read_positions ... where room_id = ?`)
  and the `getRoomReadPositionUsers` read `inferSignals` does to build the
  `roomMetadataDiff`;
- the delete/move unwind
  (`select ... from read_positions where room_id = ? and unread_count > 0`).

The primary key is `(user_did, room_id)`; a `room_id`-only filter cannot use it
(the leading column is `user_did`), so SQLite plans a full `SCAN read_positions`
for each. `read_positions` is **global across every space** — one row per
(reader, room) — so scan cost is proportional to total readership on the
deployment, not to the room being written to: a single-room write pays for every
reader everywhere. At production shape (10M rows, 50k rooms × 200 readers) one
scan is ~1.1 s, and a 50-delete `sendEvents` batch runs one unwind per distinct
room.

The room-scoped lookups therefore require `idx_read_positions_room on
read_positions(room_id)`, declared in `readStateSchema.sql`. The schema file is
exec'd on every open regardless of version, so existing databases gain the index
at next boot without a version bump or migration task. A composite
`(room_id, unread_count)` is not used: the wider index does not help here and
roughly doubles the write cost of the createMessage unread bump, which updates
every reader row for the room.

Regression coverage: `src/db/readStateDb.test.ts` asserts the query PLAN (not
just index presence — an unused index would leave the scan) for all three
room-scoped statements, and that an already-current database gains the index on
open.

## Open follow-ups

Ordered by value/effort. None is the current bottleneck; #1 and #2 matter as
write volume grows.

1. **Collapse round-trips per event.** The per-event `isSpaceRebuilding` probe
   and the per-event `applyBatch` transaction are the obvious targets — both
   could be one read / one transaction per batch.
2. **In-flight coalescing for concurrent readers of the same DID.**
   `profileStore.ts` has no in-flight coalescing — unlike
   `hydration/userHydration.ts`, which dedupes concurrent calls for the same
   user via an in-flight map. The negative cache removes the *steady-state*
   stampede (N events by one unresolved author now cost one lookup, not N), but
   N *simultaneous* first-time lookups for the same DID still issue N parallel
   fetches before any of them records a result. An in-flight map keyed by DID is
   a direct port of the pattern in `userHydration.ts`.
3. **Radical redesign.** The write path materializes inline (event log write →
   decode → profiles → `applyBatch` → invalidation → DB). That is what makes
   writes slow and reads cheap, which is the stated trade. If writes become the
   constraint, the durable shape is: append to the event log and return, then
   materialize on a worker that consumes the log. That inverts the coupling —
   reads already tolerate eventual consistency here (`applyBatch` is idempotent
   and cursor-driven, `isBackfill` already distinguishes replay). The cost is
   that the client's `messageDiff` would not be synchronous with
   `sendEvents`, so the client needs an optimistic path (it already generates
   ULIDs client-side for exactly this).

## Harness

`perf/probe-sendevents.ts` boots the real appserver against a seeded space and
reports latency percentiles, DB round-trips split by destination DB, stage
timings inside `StreamManager.sendEvents`, and every outbound fetch with its
stack.

```bash
APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
  bun run packages/appserver/perf/probe-sendevents.ts --batch 1 --iterations 30
```

Add `--production-profiles` to leave `getProfiles` unset so materialisation uses
the real HappyView-first / Bluesky pipeline. Without it the probe stubs the
fetcher, which also stubs out the pipeline's own network behaviour — the stub
hides exactly the fetches the write path must not make, so a write path that
looks network-free under it can still be issuing one HTTP call per event.

`--read-state-rooms N [--read-state-readers M]` seeds a production-shaped
`read_positions` table before measuring. This matters because `read_positions` is
global and its write-path lookups are room-scoped: with an empty table (the
default) both plans are trivially fast, which hides a missing `room_id` index.
Seeding 20000 rooms × 50 readers makes the default createMessage probe show the
room-scoped read-state cost.

Run the probe alone — it is sensitive to machine load.
