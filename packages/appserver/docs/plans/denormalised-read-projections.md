# Denormalised read projections

**Date:** 2026-09-21
**Status:** R1 merged (`room_access` projection); R2 merged (`#roomActivityDiff`);
R3 merged (`room_activity` projection); R6 merged (profile fetch off the read path)
**Task:** TASK-173 (R1), TASK-174 (R2), TASK-175 (R3), TASK-199 (R6)

## Summary

The appserver's read cost is dominated not by scans but by **per-item access
resolution**: `roomAccess` runs 1–3 SQL round-trips *per room*, and the read
handlers that list rooms run it per room. `room.getMetadata` and
`room.getThreads` each spend **36 of their ~50 DB round-trips** re-deriving the
same room→space→parent→default_access facts for the same rooms, on every
request, for every caller. That is the join being paid per read.

Meanwhile a **single live message emits 7 WebSocket frames per subscribed
client**, 5 of which are `#invalidate` frames that each force an HTTP refetch.
With 4 subscribers that is 16 refetches per message, each of which re-runs the
above per-room access resolution. This is the fanout Meri asked about: 5
invalidations → 5 full read endpoints → ~137 DB round-trips *per client*.

This document plans denormalised projections for the read side, and reports all
three rounds: the `room_access` projection maintained on live events and warmed
on read miss (R1), the `#roomActivityDiff` that replaces the ordering-driven
invalidations (R2), and the `room_activity` projection that makes board reads
independent of channel size (R3) — measured before/after in each case.

## Context: what is actually slow (measured, not assumed)

Production, last 7 days (Mimir `roomy_xrpc_request_duration_seconds`):

| endpoint | req / 7d | p50 | p95 |
|---|---:|---:|---:|
| `space.getActivityFeed` | 410,958 | 40 ms | 3,125 ms |
| `space.sendEvents` | 156,545 | 145 ms | 227 ms |
| `room.getMessages` | 155,361 | 21 ms | 69 ms |
| `space.getMetadata` | 115,070 | 41 ms | 279 ms |
| `space.getSpaces` | 76,937 | 9 ms | 96 ms |
| `room.getMetadata` | 56,637 | 7 ms | 349 ms |
| `room.getThreads` | 26,488 | 10 ms | 450 ms |
| `space.getThreads` | 3,414 | 10 ms | 3,439 ms |

Two things stand out. First, the **mean/p50 are small but the tails are 10–100×
the median** — `room.getMetadata` p50 7 ms against p95 349 ms. Second, the
process-local query cache is only **29.6 % hit rate** (`roomy_cache_hits_total`
181 / `roomy_cache_misses_total` 431 per hour, `roomy_cache_size` 204), so the
cache is not absorbing this.

Local probe (`perf/probe-projections.ts`, 12 channels + 12 threads, 1200
messages, 100 readers), DB round-trips per request split by destination worker:

| endpoint | p50 | db-rtt | of which `space` worker |
|---|---:|---:|---:|
| `room.getMetadata` | 1.87 ms | **53** | 47 |
| `room.getThreads` | 3.12 ms | **50** | 46 |
| `space.getThreads` | 15.90 ms | 19 | 14 |
| `space.getActivityFeed` | 2.34 ms | 15 | 11 |
| `room.getMessages` | 1.12 ms | 11 | 8 |
| `space.getMetadata` | 2.35 ms | 19 | 10 |

Per-statement attribution for `room.getThreads` (1 request, 50 round-trips):

```
  13  select e.stream_id as space_id, cr.default_access ... where e.id = ?     <- resolveRoom
  13  select head from edges where tail = ? and label = 'link' ...             <- resolveRoom (parent)
  12  select default_access from comp_room where entity = ?                    <- resolveRoom (parent access)
   1  select ... from entities e join comp_room cr ... limit 13                <- the actual thread list
   1  select e.room, max(coalesce(cc.timestamp, ...)) ... group by e.room      <- activity
   ...
```

**36 of 50 round-trips are `roomAccess` re-deriving room facts for 13 threads**
(`auth/access.ts:resolveRoom`). Nothing about those facts changed between
threads, or between requests.

### The fanout

Measured on the same probe, one live `createMessage` with 4 subscribed sync
clients:

```
  sendEvents latency: 22.9ms
  frames per client: 7
  frame kinds: #messageDiff:1  #roomMetadataDiff:1  #invalidate:5
  #invalidate nsids: room.getMetadata, room.getThreads, space.getThreads,
                     space.getActivityFeed, space.getMetadata
  => 4 clients x 4 reads = 16 HTTP requests per message
  refetch storm per client: 137 DB round-trips
```

`#messageDiff` is free (it patches the client cache). The other **6 frames are
5 invalidations + 1 unread diff**, and 4 of the 5 invalidations land on
endpoints that carry the per-room access N+1 above. That is the amplification:
one 22 ms write becomes 16 reads totalling ~550 DB round-trips across 4 clients.

Note `space.getMetadata` is invalidated **only for the message author**
(`inferSignals.ts:428`, `affectedUser = event.user`) — the probe's single
client is the author, so it sees 5. For a non-author client it is 4.

### Scaling

`space.getThreads` at 19 round-trips moves 7 ms → 42 ms when the hot channel
grows 500 → 4000 messages, with the round-trip count unchanged. That is
`threadActivity.ts`'s latest-message query, which has **no `LIMIT` per group**:
it reads every message in every room in scope to pick one per room. Isolated:
500 messages → 1.46 ms; 8000 → 13.16 ms, returning **8001 rows to keep 2**.

## The projection: `room_access`

### Why this one first

It is the only cost on the list that is
(a) paid on **every** room-listing read, (b) **O(rooms)** rather than O(1),
(c) **not** already cached (the query cache is per-`(nsid, params, did)` and
29.6 % hit rate), and (d) derived from a **small, event-stable input set** —
`entities.stream_id`, `comp_room.default_access`, and the canonical `link`
edge. A projection here is cheap to maintain and cannot drift far.

The other candidates are ranked in §Staging below.

### Schema

Added to `src/db/schema-space.sql` (per-space DB — the projection is
space-scoped, like everything it derives from), and to `src/db/schema.sql`
(the in-memory schema `toAsyncDb` uses, since unit tests exercise access checks
directly rather than through the worker's schema loader):

```sql
create table if not exists room_access (
  room_id           text primary key,
  space_id          text not null,
  parent_channel_id text
) strict;

create index if not exists idx_room_access_space on room_access(space_id);
```

Purely additive, so every existing per-space DB gains it at next open — the
schema file is exec'd on every open regardless of version
(`worker.ts:initializeVersionedSchema`) — with **no `SPACE_SCHEMA_VERSION` bump
and therefore no forced blue-green rebuild**.

### What is projected, and what deliberately is not

The projection carries the **structural** half of `resolveRoom`'s answer:
`space_id` (from `entities.stream_id`) and `parent_channel_id` (from the
canonical `'link'` edge, whose `json_extract` predicate was the most expensive
of the three queries).

`default_access` is **not** projected — it is always read live from `comp_room`,
batched across the room ids and their parent ids. This is not caution for its
own sake; it is a correctness requirement discovered during this round:

> **Finding.** The first implementation projected `default_access`, and the
> e2e suite failed `space.roomy.search.messages > room scope enforces read
> access for non-members` — a room whose `comp_room.default_access` was set to
> `none` still returned search results to a non-member. The projection had
> cached an authorisation input in a table the live-event path could not keep
> up to date for a write that didn't go through it.

`default_access` is a **security input that any writer of `comp_room` can
change**, and the projection is only maintained on the live write path (never
during replay, per the constraint). A replayed `updateRoom` inside a boot gap,
or any out-of-band write, would serve a stale access decision. Structure is
safe to project because it changes only through room/link lifecycle events, and
because a stale structural row is recoverable — the fallback is always the live
table. **A projection that is wrong about authorisation is not worth the query
it saves.**

### Maintenance

**Live events upsert.** The projection is written from `applyBatch`'s
per-event chunk loop as **one extra statement inside the per-event transaction
that already exists** — measured at **zero additional worker round-trips**
(§Results). The statement re-derives rows for just the rooms the event touched:

```sql
insert into room_access (room_id, space_id, parent_channel_id)
select e.id, e.stream_id, p.head
  from entities e
  left join edges p on p.tail = e.id and p.label = 'link'
       and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
 where e.id in (?, ...)
   and e.stream_id is not null
on conflict (room_id) do update set
  space_id = excluded.space_id, parent_channel_id = excluded.parent_channel_id
```

Affected rooms per event type — the **complete** set of events that write the
projection's inputs, derived by reading the SDK materialisers rather than
guessing:

| event | SDK source |
|---|---|
| `room.createRoom.v0` | `events/room.ts:60-77` |
| `room.updateRoom.v0` | `events/room.ts:109-140` |
| `room.deleteRoom.v0` | `events/room.ts:145-168` |
| `room.restoreRoom.v0` | `events/room.ts:145-168` |
| `link.createRoomLink.v0` | `events/link.ts:26` |
| `link.removeRoomLink.v0` | `events/link.ts:80` |
| `query.spaceMeta.v0` (synthetic) | `events/synthetic.ts:180-250` |

**Rematerialisation deletes instead.** `maintainRoomAccess` takes `isBackfill`
and, when set, issues `delete from room_access where ...` rather than an
upsert. Population during replay is out of scope, as required — but a replayed
*structural* change must not leave a stale row behind, and a delete is
invalidation rather than population. The next read warms the row from the
replayed data. `applyBatch` passes `true` from `reMaterializeFromLocalEvents`
(`reMaterialize.ts:263-265`) and `false` from `StreamManager.sendEvents`
(`StreamManager.ts:245`).

Verified end-to-end (throwaway harness, output in §Results): after a
replayed batch the table has **0 rows**, and the first read afterwards returns
the correct answer and warms the row; after a live batch it has the expected
rows immediately.

### Read path — the projection is a cache, warmed on miss

`resolveRoom` (`auth/access.ts`) reads the projection; on a hit it takes
`space_id`/`parent_channel_id` from it and reads the live `default_access` for
the room and (if any) its parent. On a **miss** it falls back to the live
tables, then **writes the row it just derived** (the warm), so the next read
hits. Read-path warming precedent already exists in this codebase
(`ensureReadPositions`, `queries/readPositions.ts`).

`roomAccessMany` (`access.ts`) takes its structure from one batched projection
read and its access values from one batched `comp_room` read — replacing the
three queries the pre-projection path needed (room rows, parent links, parent
access).

Every projection read **fails soft**: a handle without the table (a sync
adapter whose schema predates it) is treated as a miss and degrades to the
pre-projection path, logged once per process. The projection is an
optimisation, so it must never be a correctness dependency.

Two call sites had to change for the projection to pay off at all: both
`room.getThreads` and `room.getMetadata` resolved access in a
`for` / `Promise.all` loop of individual `roomAccess` calls. `roomAccess` is
memoised but **not** batched, so each distinct thread was its own round-trip.
Both now use `roomAccessMany`, collapsing the page to one access pass.

### Why not a once-per-batch write at the end of materialisation

Attempted and rejected on measurement, as asked. Two variants:

- **Per-batch (a separate post-loop transaction).** Costs one extra worker
  round-trip per batch, and — because `applyBatch` never throws and advances
  `materialization_cursor` past failed chunks (`applyBatch.ts:411-429`) — a
  projection written in a *separate* transaction from the event that dirtied it
  can be left stale by exactly the failure mode the cursor tolerates.
- **Per-event (inside the existing transaction) — chosen.** Measured at **0
  additional worker round-trips** (§Results), and atomically consistent with
  the write that dirtied it.

So: the once-per-batch variant is *not* cheaper, and it is less correct. The
per-event statement inside the existing transaction wins on both axes, which
is why code simplicity never had to be traded against cost.

## What this does NOT do

- **It does not touch rematerialisation.** No projection is written with
  `isBackfill: true`. A blue-green rebuild produces a DB with an empty
  `room_access`; the first read per room warms it.
- **It does not make the fanout smaller.** It makes each refetch cheaper. The
  5 invalidations per message are a separate change (§Staging R2).
- **It does not fold caller-scoped fields in.** `canRead`/`canWrite` stay
  computed per request from the caller's roles/bans/membership.

## Rejected designs

**Caller-scoped access projection** (`(user_did, room_id) → canRead/canWrite`).
Tempting — it would collapse the whole `computeRoomAccess` chain — but the key
space is `users × rooms × spaces`, and the invalidation set is every role
assignment, role-permission edit, ban, join, leave and room-policy change. The
existing query cache already tries the equivalent thing at
`(nsid, params, did)` granularity and only hits 29.6 %. The per-caller half is
also the *cheap* half once the room facts are projected: role grants are one
batched query, and space access is already memoised per request
(`auth/access.ts:createAccessMemo`).

**Projecting the rendered sidebar / thread list itself.** Rejected: the payload
is caller-scoped (`unreadCount`, `lastRead`, `activeThreads`, access-filtered
channel sets), so the projection key would be per-caller, and the invalidation
set is every message (unread), every read receipt, every role change. High
write amplification, low hit rate.

**Materialising the activity window per room into a wide row.** Already done —
`activity_item` is a projection of exactly this kind (one row per room, rolling
5-message window). The remaining cost in `getActivityFeed` is not the window
but the per-message hydration (media, link embeds, reactions) across a
per-space fan-out; that is R3 below, and its shape is different.

## Staging

**R1 — `room_access` projection (this round).** Collapses 36 of ~50 round-trips
in `room.getMetadata` / `room.getThreads`, and 38 → 1 in the `roomAccessMany`
paths (`space.getMetadata`, `space.getActivityFeed`, `space.getThreads`).

**R2 — cut the invalidations that force the refetches (DONE — see §Results R2).**
This is where the fanout actually shrinks, and R1 is what makes it safe:
- `room.getMetadata` and `room.getThreads` were invalidated by *every*
  `createMessage`, as was `space.getThreads` — all three reorder on latest
  activity. They now receive a **`roomActivityDiff`**: one broadcast frame
  carrying the single board row that moved (room, latest timestamp, preview,
  newest author), which the client upserts and moves to the front.
- The boards' *cached bodies* are still stale, so they are **evicted from the
  server response cache without a client frame** (`cacheEvictionOnly`) — a
  fresh page load has no diff to apply and must not be served the old order,
  while a live client must not be told to refetch.
- Result: 5 invalidations → 2 (activity feed, author-scoped metadata), i.e.
  **20 refetches per message → 8** (4 clients × 5 → 4 × 2), and **91 → 34 DB
  round-trips per client** when measured on that commit — the merged base
  carries two additional link-index invalidations, so the same measurement
  there reads **7 → 4** and **102 → 45** (see §Results R2).

The plan expected this to be "a diff, not an invalidation" via
`roomMetadataDiff`. It is a **separate broadcast frame** instead: that frame is
caller-scoped (sent once per affected user), so folding structural,
identical-for-everyone board fields into it would put the same board row on the
wire once per reader.

**R3 — `space.getThreads` / `getActivityFeed` projection (DONE — see §Results R3).**
`fetchRoomActivity` (`threadActivity.ts`) read every message in scope to pick the
latest per room (measured: 8001 rows → 2 at 8000 messages), which is why
`space.getThreads` grew with channel size, not with the number of rooms on the
page. The fix is the `room_activity` projection — `(room_id) → latest_message_id,
latest_at, recent_authors` — maintained inside the same per-event transaction as
`room_access` (zero additional worker round-trips, measured), with the read path
falling back to the scan and warming on a miss.

The plan expected this to share `activity_item`'s update path. It does not, and
should not: `activity_item` is the **feed** projection (a rolling 5-message
window plus denormalised names, read by `getActivityFeed`), while
`room_activity` is a **reduction** (a per-author maximum over the room's entire
history, which no rolling window can produce). They share a maintenance
*mechanism* — one statement in `applyBatch`'s per-event transaction — which is
the part that made the cost argument work.

**R4 — `selectMessages` embed/reaction pre-join.** Lower value than expected:
measured at 20k messages with 4000 reactions and 5000 link embeds, the base
rows cost 0.119 ms and the reactions batch 0.494 ms. Not the bottleneck; defer
until the page size grows.

**Not staged: `getMessages` pagination.** Its cost is flat in room size
(`idx_entities_room_sort`, measured 0.103 ms for the base query) and 11
round-trips total. There is no join to move.

## Measurement

`perf/probe-projections.ts` (new) measures both halves per run:

- **Read cost** — p50/p95/p99/max per endpoint, plus DB round-trips by
  destination worker, via a `WorkerLink.prototype.send` interceptor (the
  technique from `probe-sendevents.ts:92-105`).
- **Fanout** — opens N real sync connections, subscribes `room:` + `space:`
  topics, sends one live message through the real HTTP write path, counts
  frames per client and by type, then issues and times the follow-up reads the
  invalidations imply.

Run: `APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true bun run
packages/appserver/perf/probe-projections.ts --label <before|after>`

The query cache is disabled in the probe (`disableQueryCache: true`) so the
projection is measured on its own rather than being masked by the in-memory
cache.

## Results — R1

Probe: `perf/probe-projections.ts`, fixture = 12 channels + 12 threads, 1200
messages in the hot channel, 100 readers, 4 sync clients, 30 iterations. Query
cache disabled so the projection is measured on its own.

### Read cost

| endpoint | p50 before | p50 after | **db-rtt before** | **db-rtt after** | reduction |
|---|---:|---:|---:|---:|---:|
| `room.getMetadata` | 1.87 ms | 1.92 ms | **53** | **21** | **−60 %** |
| `room.getThreads` | 3.12 ms | 1.42 ms | **50** | **18** | **−64 %** |
| `space.getThreads` | 15.90 ms | 13.81 ms | 19 | 18 | −5 % |
| `space.getActivityFeed` | 2.34 ms | 1.96 ms | 15 | 15 | 0 % |
| `space.getMetadata` | 2.35 ms | 2.38 ms | 19 | 19 | 0 % |
| `room.getMessages` | 1.12 ms | 1.48 ms | 11 | 11 | 0 % |

Per-destination split after: `room.getMetadata` 15 space / 5 readstate / 1
global; `room.getThreads` 14 space / 3 readstate / 1 global. The `space`-worker
column is where the projection acts; readstate and global are untouched.

> **Method note — read these as round-trip counts, not latencies.** p50 moves
> by well under a millisecond because with 12 threads the workload is small
> enough that ~35 saved round-trips cost ~0.5 ms of worker time. Round-trips
> are the machine-independent measure, and they are what scales: the removed
> work is ~3 round-trips *per room listed*, so the saving grows with the
> sidebar, while the remaining count does not. Latency differences at this
> fixture size are within run-to-run noise and should not be quoted as an
> improvement.

### Fanout (one live message, 4 subscribed clients)

The frame set is **unchanged** — this round does not reduce fanout, only the
cost of each refetch, exactly as scoped:

```
  frames per client: 7   (#messageDiff:1  #roomMetadataDiff:1  #invalidate:5)
  => 4 clients x 4 reads = 16 HTTP requests per message
```

| refetch storm per client | before | after |
|---|---:|---:|
| DB round-trips | **137** | **72** (−47 %) |
| `room.getMetadata` | 53 | 21 |
| `room.getThreads` | 50 | 18 |
| `space.getThreads` | 19 | 18 |
| `space.getActivityFeed` | 15 | 15 |

Across 4 clients that is ~550 → ~290 DB round-trips per single message posted.

### Write-side cost of maintaining the projection

Measured with a `WorkerLink.prototype.send` counter over one `applyBatch` of 5
`createRoom` events (throwaway harness):

| | worker round-trips | projection rows |
|---|---:|---:|
| projection step disabled | 12 | 0 |
| projection step enabled | **12** | 5 |

**Zero additional worker round-trips.** The statement rides inside the
per-event transaction `applyBatch` already opens; only its payload grows.

### Rematerialisation constraint (the hard one)

Throwaway harness replaying a `createRoom` → `createRoom(thread)` →
`createRoomLink` batch through the real `applyBatch`:

```
after remat (isBackfill:true):
  projection rows: 0          <- remat populated nothing, as required
  roomAccess(thread) canRead=true defaultAccess=readwrite parentChannelId=01M30S...
  projection row after the read (warmed): did:plc:bg-space parent=01M30S...

after a LIVE batch (isBackfill:false):
  projection rows: 2          <- channel + thread, maintained inline
  thread row: parent=01M30S...
```

The rebuild leaves the table empty; the first read is still correct and warms
it. No backfill of projections is ever performed.

### Tests

`bun test --cwd packages/appserver`: **1064 pass, 1 skip, 0 fail** (baseline on
`next` before this work: 1056 pass, 1 skip, 0 fail). `tsc --noEmit`: 0 errors.

Eight new tests, all defending observable behaviour rather than implementation:

- `queries/roomAccessProjection.test.ts` (4): a live event upserts with the
  parent link; **the same event during backfill deletes rather than populates**;
  events that cannot affect the projection produce no step; malformed/unknown
  events are inert.
- `auth/access.test.ts` (4): a projected room resolves **identically** to an
  unprojected one (including the thread-clamps-to-parent rule); an access change
  written directly to `comp_room` is observed with a warmed projection; a
  re-parented room is not wrongly denied; `roomAccessMany` agrees with
  `roomAccess` for projected and unprojected rooms side by side.

The projection tests were mutation-checked: corrupting `space_id` in the
projection reader fails 5 of them, confirming they exercise the projected path
rather than passing through the fallback.

## Results — R2

R2 replaces the ordering-driven invalidations a `createMessage` emits with a
**`#roomActivityDiff`** broadcast, plus a **cache-eviction-only** invalidation
for the same queries. Measured with the same probe on the same base commit
(fixture: 20 rooms, 12 threads, 1200 messages in the hot channel, 100 readers,
4 sync clients, 30 iterations), `--label merged-before` vs `--label
merged-after`:

| per client, one live message | before | after |
|---|---:|---:|
| frames | **9** | **7** |
| `#invalidate` frames | **7** | **4** |
| refetch storm (HTTP reads) | **7** | **4** |
| refetch storm (DB round-trips) | **102** | **45** (−56 %) |
| across 4 clients (reads) | 28 | **16** (−43 %) |

The invalidated NSIDs that disappeared are exactly the three boards:
`room.getMetadata`, `room.getThreads`, `space.getThreads`. The four that remain
are the link-index pair (`room.getLinks`, `space.getLinks` — added by the link
aggregation work), `space.getActivityFeed` (its items hydrate media/link-embeds
per message — a shape the activity diff does not carry, so it stays a refetch),
and the author-scoped `space.getMetadata` (`activeThreads`). A batch of N
messages in one room collapses to **one** activity diff (verified end-to-end),
because each is a superseding snapshot of the same row.

### The probe had to be fixed to see this

`perf/probe-projections.ts` derived its "refetch storm" from a **hardcoded**
list of the four endpoints the old invalidations named. It therefore kept
printing ~16 requests per message regardless of the frames actually received —
it could not observe the change it exists to measure. It now derives the
follow-up reads from the observed `#invalidate` frames (and reports the frame
kinds), so the number moves with the code. This is why the R1 table above and
this one are computed the same way but not comparable across the two commits.

### Why a new frame instead of extending `roomMetadataDiff`

The plan called for extending `roomMetadataDiff`. That frame is **per-user** —
`#routeRoomMetadataDiff` sends one copy to each affected user's connections,
because its unread delta is caller-scoped. The board fields are the opposite:
identical for every reader. Folding them in would put the same board row on the
wire once per reader, so they ride a **broadcast** frame instead (one per
connection subscribed to the room, its parent channel, or the space).

Consequently the per-user board field — each row's `unreadCount` / `unread` —
is patched from the *metadata* frame (which knows that user's delta), not from
the activity diff. The two frames arrive together for the same event, so neither
leaves the other's fields stale.

### Pagination: the diff can fail, and says so

Both boards are infinite queries. A patch is only faithful when the room is on
the cached first page (otherwise the room must displace a row the client never
loaded) **and** the message advances the room's `latestTimestamp` — the board
column is the room's MAX message time, so a Discord-bridged message carrying an
old `timestampOverride` does not move the row. In either case the applicator
returns `undefined` and the router **invalidates that query instead** — the
pre-diff behaviour. `CacheAdapter` gained `get` for this: choosing between
patch and refetch requires seeing the previous value.

This is what keeps the optimisation honest: the client never asserts an order
the server would not return.

### Tests

`bun test --cwd packages/appserver`: **1090 pass, 1 skip, 0 fail** (on the
merged base); `tsc
--noEmit`: 0 errors. `pnpm --filter @roomy-space/sdk test`: **224 pass**;
`pnpm --filter app-lite check`: 0 errors.

- `invalidation/inferSignals.test.ts` — createMessage emits a `roomActivityDiff`
  carrying the new message, and the three boards are evicted **without** a
  client frame while the activity feed is not.
- `invalidation/router.test.ts` — a batch keeps only the **last** activity diff
  per room (a superseding snapshot, unlike the delta-carrying
  `roomMetadataDiff`), and keeps different rooms separate.
- `sync/handler.test.ts` — a `cacheEvictionOnly` signal never reaches a
  connection; a `roomActivityDiff` reaches the room + parent + space topics
  **once**, validated against the published frame schema; and it is withheld
  from a connection that cannot read the room (the frame carries a message
  preview and its author).
- `sdk/src/sync/roomActivityDiff.test.ts` (11) — the patchers move the row to
  the front keeping the page length, merge the author into `latestMembers` to
  reproduce the server's 3-newest aggregate, and return a **miss** for the
  unrepresentable cases (room not on the cached page, non-advancing timestamp).
- `sdk/src/sync/router.test.ts` — patches a cached board, invalidates one it
  cannot patch, and leaves uncached ones alone.
- `e2e/roomActivityFanout.test.ts` (2) — through the real write path: one
  message produces **zero** board invalidations and one activity diff that
  satisfies the wire schema; a 5-message batch produces **one** diff carrying
  the last message. Verified to fail on pre-R2 code (the diff frame never
  arrives, so the test times out).


## Results — R3

Measured with `perf/probe-projections.ts`, same fixture for both sides (12
channels + 12 threads, 3000 messages in the hot channel unless stated, 100
readers, 5 sync clients, 20 iterations, query cache disabled), `--label` before
vs after. Each figure was reproduced twice.

### Read cost

`space.getThreads` is the endpoint this round is for: it lists every room in the
space, so it pays `fetchRoomActivity` for all of them.

| fixture | before p50 | after p50 | before p95 | after p95 |
|---|---:|---:|---:|---:|
| 3000 messages in the hot channel | **29.5 / 31.8 / 33.5 ms** | **1.8 / 3.3 / 1.8 ms** | 33.4 / 39.0 / 40.6 ms | 4.5 / 7.3 / 4.5 ms |
| 500 messages | 9.6 ms | 1.8 ms | 12.0 ms | 16.1 ms |
| 8000 messages | **78.7 ms** | **1.8 ms** | 86.9 ms | 6.1 ms |

**Read latency stops depending on channel size.** 500 → 8000 messages (16×) moved
the pre-projection p50 by 8.2× (9.6 → 78.7 ms) and the R3 p50 not at all (1.8 →
1.8 ms). That flat line is the whole point of the round: the remaining work is
O(rooms on the page), and the 12-room/12-thread fixture is smaller than the
production sidebar. (The 500-message `after` p95 of 16.1 ms is a first-run
outlier — the repeat reads 1.8 ms p50 / 4.5 ms p95.)

Round-trips move the other way, and honestly so: `space.getThreads` 18 → 17. The
projection answers a page in **two** reads (the reduced rows, then the board
shape) while the scan used four, but the *dominant* cost was never the number of
statements — it was the row count they returned and the JS reduction over it. A
round-trip count is the wrong instrument for this change; rows scanned is the
right one (8001 → 12 at the 8000-message fixture, i.e. per room rather than per
message).

The other endpoints are untouched, as staged: `room.getThreads` 18 → 16,
`room.getMetadata` 21 → 19 (both now serve threads from the projection),
`getActivityFeed` 15 → 15 and `getMetadata` 19 → 19 (R4's shape).

### Write-side cost of maintaining the projection

Throwaway harness, one 50-message `sendEvents` batch through the real write path,
`WorkerLink.prototype.send` counted (same technique as the probe):

| | worker round-trips | of which per-space |
|---|---:|---:|
| before (no `room_activity` step) | **865** | 660 |
| after (step enabled) | **865** | 660 |

**Zero additional worker round-trips** — the statement rides inside the per-event
transaction `applyBatch` already opens, exactly as `room_access` does. The
projection adds one statement per *message* event, and a create is merged in
place (O(1) in room size) rather than rebuilt, so a bridge posting live messages
never pays a per-room re-aggregation.

### Fanout

Unchanged, as scoped — R3 makes each refetch cheaper, it does not reduce their
number:

```
  frames per client: 7   (#messageDiff:1  #roomMetadataDiff:1  #roomActivityDiff:1  #invalidate:4)
  #invalidate nsids: room.getLinks, space.getLinks, space.getActivityFeed, space.getMetadata
  refetch storm per client: 4 requests, 45 DB round-trips
```

The four remaining invalidations are the link-index pair, the activity feed
(whose items hydrate media/link embeds per message — a shape the activity diff
does not carry), and the author-scoped `space.getMetadata`.

### Rematerialisation constraint

Same rule as R1, and enforced the same way: replay **invalidates**, never
populates. `maintainRoomActivity` deletes the row on a backfilled
`createMessage`/`deleteMessage`/`moveMessages`, and the read path falls back to
the live scan for any page that is not fully projected.

Deletes and moves take this further than R1 needed to: the projection is
invalidated by the event's own transaction and then **rebuilt from the
post-event tables** in the materialiser's side-effect stage, so a room keeps its
projection across a delete or a move instead of dropping back to the scan. That
rebuild runs on backfill too, for the same reason `rebuildActivityWindow` does —
a replay must leave the projection describing the data the replay just wrote. A
rebuild is not population.

### Tests

`bun test --cwd packages/appserver`: **1115 pass, 1 skip, 0 fail** (baseline on
`next` before this work: 1102 pass, 1 skip, 0 fail). `tsc --noEmit`: 0 errors.

- `queries/roomActivityProjection.test.ts` (5) — the maintenance contract: a live
  create merges in with its room, timestamp and author; a message older than the
  recorded latest does not displace it (the bridged-`timestampOverride` case);
  delete and move invalidate the rooms they name; **the same create during
  backfill deletes rather than populates**; events that cannot move a room's
  latest message produce no step, and malformed payloads are inert.
- `queries/threadActivity.test.ts` (+4, beside the 21 existing) — read parity:
  the projected board equals the scanned board for threads with messages, empty
  rooms, a legacy forward reference, and a room whose newest message was deleted.
  Each asserts the projection actually answered (not a silent fallback), so the
  comparison cannot pass trivially.
- `e2e/roomActivityProjection.test.ts` (4) — through the real write path
  (`sendEvents` → materialise → projection maintenance → board read): a live
  message; a **delete** dropping the message from the board; a **move** updating
  both rooms; and projected-equals-scan after a mixed sequence of creates, a
  delete, a thread, and an empty room.

The parity tests were mutation-checked: forcing the projected reader to always
miss fails 23 of the 25 `threadActivity` tests, confirming they exercise the
projected path rather than passing through the fallback.

### Two parity defects found and fixed

The projection and the scan must return the *same board* — that is the contract
that lets a read fall back at any time. Getting there surfaced two real
divergences, both in the pre-existing scan:

1. **Latest message on a timestamp tie.** The scan folded rows in query-return
   order and kept the first at a given timestamp; the projection picks the
   highest message id. Two messages can share a millisecond (created together, or
   bridged with sender-supplied times), and the two paths disagreed on which one
   was "latest". The tie-break is now stated once — highest id wins — and applied
   in both. This was found by the e2e test, not by inspection.
2. **`fetchRoomActivity` hardcoded `kind: "thread"` and `name: null`.** No
   consumer reads those fields today — `listThreadActivity` derives them from its
   own room rows (with the real label and name), and `space.roomy.search.rooms`
   sets them on its result items itself, using this helper only for the
   `activity.*` columns. So this was not a live bug, and it is recorded here as
   what it was: a latent wrong fact (a channel would report itself as a thread)
   that the parity test surfaced the moment the projection started reading the
   room's real label. Both paths now report the truth. The honest framing matters
   more than the fix — a doc that calls a dead field a user-visible defect is
   worse than one that says "unused, and now consistent".

A third, unrelated defect was found in the test helpers: `seedMembership` wrote
the membership edge user→space, while `isAdmin`/`isMember` read space→user, so a
caller seeded as an admin was denied by every check that actually ran. Nothing
depended on the old direction; the helper is corrected rather than worked around.

## Results — R7: the response cache was evicting itself

### The symptom, measured

Production, `/health/cache` and `/metrics` over a 22-minute live sample
(33 scrapes, 2026-10-01T03:02–03:24Z):

| quantity | value |
|---|---|
| `roomy_cache_hits_total` | ~1,590 (rising ~2 / 40 s) |
| `roomy_cache_misses_total` | ~5,940 (rising ~14 / 40 s) |
| `roomy_cache_evictions_total` | ~4,440 (rising ~3 / 40 s) |
| `roomy_cache_size` | 124–129 |
| evictions per `sendEvents` write | **0.55** |
| hit rate | **21 %** |

`roomy_cache_size` sits at ~125 against `APPSERVER_QUERY_CACHE_MAX_ENTRIES`
(4096), so **none** of the 4,440 evictions can be LRU capacity: every one is an
invalidation. The cache was inserted into and thrown away at the same rate,
which is why it never moved the p95 it was extended to cover
(`getActivityFeed` 3,125 ms, `space.getThreads` 3,439 ms).

Measured on the probe fixture (cold DB, `--cache`), hit-vs-miss latency on the
*same* page is **2.65 ms (miss — the handler runs) against 0.15 ms (hit)**.
The ratio therefore controls how many readers pay the handler.

### The mechanism: the feed's params and its signals name different things

`space.getActivityFeed` is a per-CALLER query spanning every space the caller
joined; its `spaceId` param is a *filter*, not an identity. Every signal that
staled it was emitted with **empty params** (`inferSignals.ts`, eight sites:
create/edit/delete/move message, reaction, delete room, join/leave), and
`paramsSubset` (`cache/queryCacheKey.ts:74`) reads an empty signal as a subset
of every entry — so **one write anywhere flushed every reader's every page for
that NSID.**

Confirmed end-to-end before changing anything (three spaces, cache enabled):

| step | hits / misses / evictions |
|---|---|
| warm 3 spaces' pages | 0 / 3 / 0 |
| re-read them | **3** / 3 / 0 |
| one write into space A | 3 / 3 / **3** |

All three spaces' pages went; only one had changed. On the probe fixture
(two spaces, 20 rounds) a write into space 1 left **0/20** of space 2's pages
cached.

`space.getThreads` is **not** affected by this: its pages are keyed by
`spaceId` and its signals carry the same `spaceId`, so subset matching evicts
exactly the pages that changed. The evictions it does take are the fixture's
write-then-read loop doing what it says; the fix leaves its behaviour
unchanged.

### The fix

The signal now carries the space the write touched, and the cache matches it by
**feed coverage** — which spaces a page includes — instead of by param subset
(`cache/activityFeedCoverage.ts`, `QueryCache.evictActivityFeed`). An
un-scoped signal (join/leave, which restates the whole feed for one caller)
still evicts every page, scoped to `affectedUser` when set, so the
no-stale-reads direction is unchanged.

The client-facing `#invalidate` frame is unaffected: `sync/handler.ts` renders
every `getActivityFeed` signal as the unfiltered `{}` key, which is what the
client's own query keys prefix-match. Signals that differ only by `spaceId` now
collapse to one client frame per emission scope, so a batch spanning two spaces
does not put identical bytes on the wire twice.

### Result

Probe fixture, `--cache`, 20 rounds, identical seed:

| | before | after |
|---|---|---|
| space 1's page cached after a write into space 1 | 0/20 | 0/20 (correctly stale) |
| **space 2's page cached after a write into space 1** | **0/20** | **20/20** |
| run totals (hits / misses) | 215 / 145 | 235 / 125 |
| run evictions | 103 | 83 |

Per-NSID counters were added (`roomy_cache_nsid_{hits,misses,evictions}`,
`/health/cache`'s `byNsid`) because the aggregate ratio cannot distinguish "the
cache is too small" from "one endpoint is flushed by every write". This fix was
diagnosed through the second, and the first stays invisible without it.

## Assessment: decoupling the `sendEvents` 200 from materialisation

Meri's observation 1 is correct in principle — `StreamManager.sendEvents`
awaits the full materialisation before the XRPC router returns its empty 200
(`router.ts:257-260`) — but the change is **not** a small one, and it interacts
badly with three existing properties. This section is the assessment asked for;
no code was changed for it.

### Where the boundary actually is

The write path is already two-phase, and the phases are already independent:

1. **Append** — one atomic `transaction` on the dedicated events worker
   (`StreamManager.ts:212`): N `insert into stream_events ... select max(idx)+1`,
   a `stream_state` upsert, and a `start_idx` read. Different DB, different
   worker, no shared transaction with anything below.
2. **Materialise** — `applyBatch` into the per-space worker, plus global and
   read-state writes, under a per-space savepoint mutex, then
   `InvalidationRouter.onEventsApplied`, then the push poke, then the raw-event
   listeners (`StreamManager.ts:220-350`).

Everything in phase 2 runs before the 200 today. Phase 1 alone is ~1 round-trip;
phase 2 is ~38 round-trips per event (`docs/sendevents-write-path-review.md:249`),
plus profile hydration and the `resolveReplyToAuthors` batch.

The natural cut is exactly between them, and the machinery to host the deferred
half already exists: `#streamQueues` is already a per-stream promise chain
(`StreamManager.ts:132-147`) that guarantees phase 2 runs in `idx` order per
stream. Deferring means appending to that chain without awaiting it.

### Guarantees that change

| # | Guarantee today | After |
|---|---|---|
| 1 | **Read-your-writes for the sender.** `await sendEvents` ⇒ the per-space row exists. Asserted by `handlers/space.roomy.space.sendEvents.test.ts:154-167`. | Lost. Nothing in the 200 carries an idx or materialised watermark, so the sender's own immediate refetch can miss its message. |
| 2 | **Diff-before-return.** `#messageDiff` is produced and delivered inline; the client reconciles its optimistic placeholder by ULID only when that frame arrives (`app-lite/src/lib/mutations/pending-sends.svelte.ts:89`). | The frame arrives later. Benign *because* the optimistic path exists — but the reconciliation window widens from "one request" to "one materialisation". |
| 3 | **Push freshness bound.** Jobs are built at materialise time and dropped when canonical age > `PUSH_MAX_MESSAGE_AGE_MS` (5 min, `push/freshness.ts`). | Deferral past 5 min silently drops live pushes. Only bites under a backlog, but it fails *silently*. |
| 4 | **Invariant: a live write materialises.** `isBackfill:false` is what enables unread bumps and diffs (`applyBundle` gates, `router.ts:61`). | Unchanged in intent — but the deferred work must still be tagged live. If a deferred batch were ever replayed through the boot path instead, it would be `isBackfill:true` and produce **no diff and no unread bump**. |
| 5 | **409 on a rebuilding space.** `isSpaceRebuilding` is checked *before* the append, and the contract is deliberately "exactly-once or rejected, never double-applied" (`blue-green-read-serving.md:185-200`). | Survives only if the gate stays on the append side. If materialisation is deferred across a blue-green swap, the deferred batch lands on a DB that no longer exists. |

### Failure modes

- **Crash between append and materialise.** Today this is already survivable:
  boot replay covers the gap (`reMaterialize.ts:162-178`, cursor at
  `materialized_to + 1`). But it is currently a *narrow* race, and boot replay
  is fire-and-forget and runs with `isBackfill:true` — so the recovered gap
  produces **no WS diff and no unread bump**. Deferring makes this the normal
  path rather than the exception.
- **Backlog ⇒ stale reads with no signal.** A space whose materialisation
  worker is saturated serves reads that silently lag the event log. Today the
  saturation surfaces as write latency (a visible, bounded symptom); deferred,
  it surfaces as correctness drift with no backpressure signal.
- **Partial batch.** `applyBatch` never throws: it counts per-event failures
  and advances `materialization_cursor` past them (`applyBatch.ts:277-284,
  411-429`). A 200 returned *before* that batch runs means the caller is told
  "accepted" for events that may be silently skipped. Today the 200 at least
  follows the attempt.
- **Double-apply risk on retry.** The XRPC caller's natural reaction to an
  ambiguous result is to retry. The append is an unconditional insert into
  `stream_events` keyed `(stream_id, idx)` (`eventsSchema.sql:4-13`) with idx
  recomputed as `max(idx)+1`, so **a retried batch appends duplicates at new
  idx** — this is already true today and is *worsened* by decoupling, because
  the client now cannot distinguish "not yet materialised" from "not accepted".

### Recommendation

**Do not ship the decoupling as a latency fix.** Measured, it buys little and
risks a lot:

- `sendEvents` p50 in production is already **145 ms**, and the local probe
  shows the *synchronous* write path completing in 22.9 ms with a realistic
  fixture. The latency is not dominated by materialisation at this scale.
- The write path's worst documented offender was third-party HTTP inside the
  write (`sendevents-write-path-review.md`), already fixed; the remaining
  N+1 (`checkWriteAuth` per event, `roomAccess` per room) is fixable *without*
  changing the consistency contract, and `roomAccessMany` already exists.
- The 5-min push freshness bound and the `isBackfill` split mean a deferred
  path needs a third classification ("deferred-live") threaded through
  `applyBundle`, `inferSignals` and the push gate before it is correct.

**If it is pursued anyway**, the prerequisites, in order:
1. **Make the 200 carry a watermark.** Return `{ idx }` (or `{ cursor }`) so a
   caller can poll `space.roomy.sync.getEvents` for materialisation progress —
   this restores guarantees 1 and 5. `materialization_cursor`
   (`schema-space.sql:348`) is the right watermark; nothing on the read path
   reads it today.
2. **Make deferred work explicitly live.** A `materializeMode: "live" |
   "backfill" | "deferred"` threaded to `applyBundle`, so a crash-recovered
   deferred batch still emits diffs and unread bumps.
3. **Bound the backlog and signal it.** A per-space queue depth exposed as a
   metric (there is currently **no** metric for materialisation lag), with the
   append returning 503 above a ceiling rather than drifting silently.
4. **Idempotent append.** Dedupe on event ULID (`insert ... on conflict do
   nothing` after a unique index on `(stream_id, event_id)`), so retries are
   safe — a prerequisite for any "accepted but not applied" contract, and worth
   doing independently.

Steps 1 and 4 are worth doing regardless of whether the decoupling ships.

## Question asked: does normal operation avoid rematerialisation?

**Yes, and here is the code path that proves it.** `reMaterializeFromLocalEvents`
is called once per boot, fire-and-forget (`index.ts:76`). For each stream it:

1. checks the per-space schema (`reMaterialize.ts:114-115`, `checkSpaceSchema`);
2. reads the per-space cursor (`:162-165`) and the log's `max(idx)` (`:168-172`);
3. **skips when `materializedTo >= latest`** (`:175-178`) — no event read, no
   materialisation.

A healthy deployment therefore replays nothing and logs
`re-materialization: all N streams already up to date` (`:188-193`). The
cursor is advanced by every live write (`applyBatch.ts:422-429`), so the gap is
normally zero.

Three exceptions force work: a `SPACE_SCHEMA_VERSION` bump (full blue-green
rebuild — measured at 655 s for 4,153 streams / 435,986 events,
`blue-green-read-serving.md:256-263`), a genuine crash gap, and one **newly
identified defect** (below).

### Three documentation/code mismatches found (all pre-existing)

1. **"Regenerated lazily on first access" is not implemented.**
   `README.md:37-40`, `db.ts:122-125` and `worker.ts:321-323` all claim a
   per-space DB is populated by re-materialising on first access.
   `openSpaceDb` creates an empty schema'd file and returns
   (`worker.ts:325-341`); no read handler replays. After a volume restore,
   spaces serve **empty** until the alphabetical boot sweep reaches them.
   `reMaterialize.ts:57-58` repeats the claim ("re-materialized on demand when
   first accessed").
2. **A live write can permanently strand history.** No write path checks for a
   gap *below* the cursor. If a live `sendEvents` lands in a fresh/empty space
   DB, `applyBatch` sets the cursor to that batch's max idx; a later boot sweep
   then sees `materializedTo >= latest` and skips — so idx `0..N` is never
   materialised by any path. Today this is masked because boot replay usually
   runs first; **it becomes routine the moment writes stop waiting for
   materialisation.**
3. **Stale wipe comments.** `db.ts:26-30` ("a bump wipes and re-derives every
   per-space DB") describes pre-blue-green behaviour; the worker never wipes on
   mismatch (`worker.ts:343-348`). The per-space cost claim at
   `reMaterialize.ts:130-131` ("one round-trip per space" for the entity_space
   backfill) is also understated: the worker scans every entity row and inserts
   per entity (`worker.ts:752-762`).

Mismatches 1 and 2 are why the projection is designed as a **warm-on-read
cache** rather than a rebuilt-per-remat table: any projection populated only
during rematerialisation would inherit both defects.


## Results — R5: what is left after R3 (TASK-194)

Meri reported that `space.getThreads` was *still* slow on large spaces after R3
landed. Measured on Little Fox's 2.8 GB dataset (`packages/appserver/data`,
4276 space DBs, 448,565 entities), against the space with the most traffic —
`did:plc:gnwy2zbm3hu4gfdawzxmpb2s`, 434 rooms (18 channels / 416 threads),
123,225 messages, `limit=50` so a board page is 50 rooms. Instrument:
`perf/probe-getthreads.ts` (this round's addition), which classifies every
`WorkerLink.send` round-trip by the statement that issued it and reports rows
and bytes returned as well as time.

### The projection never existed in production

Per-stage measurement of one page, on the dataset as installed:

| stage | rtt | rows | kB | min ms |
|---|---:|---:|---:|---:|
| `b.scan.latest_message` (every message body, to keep 50) | 1 | 1724 | 636.1 | 8.82 |
| `b.scan.latest_ts` | 2 | 206 | 24.9 | 7.11 |
| `a.page_query` | 1 | 51 | 4.9 | 1.44 |
| `b.projection_read` | 1 | 0 | 0.0 | — |
| `b.projection_warm` | 1 | 0 | 0.0 | — |
| **TOTAL** | 24 | 2337 | 674.5 | |

**Projection hit rate: 0 of 10 requests.** Every read logged `[room_activity]
projection unavailable; falling back to the live activity scan: no such table`.
The reason is in the installed data: those space DBs are stamped
`space_schema_version = 1` and the current version is `2` (`db.ts:31`), so
neither `room_activity` (R3) nor `room_access` (R1) exists in them at all —
`room_access` is missing from the same DBs, which is why the 36-round-trip N+1
R1 removed is still being paid too.

That is a data-deployment fact, not a code defect: on a current-schema space the
projection works exactly as designed. Applying the current schema to a copy of
the same DB and letting the read path warm takes the full board walk (9 pages,
419 rooms) **1793 ms → 87 ms**, with the per-page floor at 9.6 ms. Reproducing
the post-blue-green state (tables present, rows invalidated, which is what
`reMaterialize` leaves behind) puts the walk back at ~3000 ms: the warm is
per-page, and the first page after a rebuild pays `scan + insert` for its 50
rooms.

So there are two costs, and R3's projection addresses only the first:

1. **Cold projection** — the fallback scan, on every page of every board load,
   until every room in the space has been read once. This is the dominant cost
   in production today, and it is O(messages in scope) per page.
2. **A rebuild resets it to cold** — the warm is a cache with no backfill, by
   design (a projection populated during rematerialisation would inherit the two
   defects in §"Mismatches found against the code" above), so every deploy that
   bumps `SPACE_SCHEMA_VERSION` returns every space to (1).

### R5 — the scan stops shipping message bodies it throws away

Fixing (2) means a backfill, which the invariants above rule out; the honest
change is to make (1) cheap. It was dominated not by the SQL but by the payload
crossing the worker boundary: the latest-message statement returned **every
message in scope with its decoded body** so the JS fold could pick one per room
— 1724 rows and **196 kB of bodies to keep 50**, each row structured-cloned
across the thread.

R5 splits that statement in two — pick the winner by `(timestamp, id)` from the
ordering columns alone, then fetch content for the 50 kept ids — and gives
`scanRoomActivity` an in-process implementation (`db.backend === "sqlite"`) that
runs the same reduction as ONE statement with the body columns restricted to the
window's `rn = 1` row. Both branches produce byte-identical answers; the parity
tests assert that, and the `sqlite` backend is the only one where the extra SQL
is free (there is no boundary to cross).

Same request, same fixture (projection-less DB), 12 measured requests:

| | rtt | rows/req | kB/req | min ms/req | board walk (9 pages) |
|---|---:|---:|---:|---:|---:|
| before | 24 | 2337 | 674.5 | ~27 | 1793 ms |
| after | 24 | 2337 | **193.7** | ~19 | 1293 ms |
| Δ | 0 | 0 | **−480.8 kB (−71%)** | | −28% |

`kB/req` is the stall-free number: it counts the bytes a worker response has to
carry back, so it does not move with machine load the way a timer does. On this
2-vCPU VM the wall-clock figures swing ±100 ms per page from unrelated stalls (a
bare `select 1` round-trip shows the same 70 ms tail; a `Bun.serve` returning
`ok` does too), so the row/byte columns are the honest comparison and the timings
are indicative.

Honest summary of what R5 buys: **~71% less data over the boundary and ~28% off
a full board walk on a cold space**, for one query split and one in-process
branch. It is not a fix for (2) — a backfill remains the only thing that would
remove the cold cost entirely, and it is still ruled out by the rematerialisation
invariant. The larger remaining lever is the deployment question at the top of
this section: production's per-space DBs are on schema version 1, so every board
read pays for a projection that was built to remove exactly this work.

## R6 — the profile fetch leaves the read path (TASK-199)

The R1–R5 rounds all cut *DB* work. This one is about the other thing inside
the same requests: the read path's on-demand profile hydration, which is a
third-party HTTP round-trip to HappyView/Bluesky.

### How it was found

Prod Tempo, a sample of `space.roomy.room.getMessages` traces, split by phase:

```
  215ms  getMessages           206ms  selectMessages   8ms requireRead  0ms openDb
  693ms  getMessages           682ms  requireRead     10ms selectMessages
  813ms  getMessages           762ms  requireRead     48ms selectMessages
  263ms  getMessages           259ms  selectMessages  3ms openDb
```

`openDb` (entity→space resolution) is 0–2 ms throughout, so the DB round-trips
are not the tail. The probe agrees: the same endpoint is p50 4.6 ms against a
local appserver with the profile network stubbed. The 50× difference between
those two numbers is the profile fetch, and it sits in a span with no children —
i.e. inside `selectMessages`, in `resolveFromGlobalDb` → `hydrateMissingProfiles`.

Measured directly with a local HappyView-compatible upstream delayed N ms
(`perf/`-style throwaway harness, both refs, same fixture):

| | upstream 0 ms | upstream +300 ms | delta |
|---|---:|---:|---:|
| **before** — read path awaits the fetch | 19 ms | **315 ms** | **+296 ms** |
| **after** — fetch is detached | 3 ms | 5 ms | **+2 ms** |

1:1 before, flat after. The write path (`sendEvents` → `ensureProfilesRoomyFirst`
before `applyBatch`) was measured the same way and is **still 1:1** (+292 ms for
+300 ms) — see §Not changed below for why that one stays.

Three cases, because the code path differs:

| store state | before | after |
|---|---|---|
| no `profiles` row (cold) | awaits — 308 ms @ 300 ms upstream | detached |
| row older than the 30-min TTL | awaits — 307 ms @ 300 ms upstream | detached |
| row within the TTL | 3 ms, no fetch | 3 ms, no fetch |

The middle row is why this was worth doing: `PROFILE_REFRESH_TTL_MS` (TASK-187)
re-fetches every stale row, so a long-lived member paid the network leg on their
next message-list read every 30 minutes, not once.

### What changed

- `resolveFromGlobalDb` reads the global store and **starts the fetch detached**
  (`startHydration`) instead of awaiting it. The caller returns the pre-fetch
  values; the fetch's write-back is visible to the next read.
- The in-memory cache entries for DIDs whose fetch is still running are
  **dropped when it settles**, so the next read re-reads the row rather than
  serving the pre-fetch positive for the remaining 60 s of its TTL.
- **In-flight dedup by DID** (`hydrationInflight`), mirroring `inFlightLinks`
  in `embed/enricher.ts`. Without it the deferral multiplies the fetches:
  measured on the real pipeline, 25 concurrent readers of one cold author
  produced **25** upstream requests. Batching was never the problem — one page
  with 13 distinct cold authors makes **1** request at batch size 16.
- **Every outbound profile call is bounded** (`fetchTimeout.ts`, default 3 s,
  `PROFILE_FETCH_TIMEOUT_MS`). They previously had *no* timeout: `fetch`
  imposes none, so a HappyView/PDS/appview that accepted the connection and
  then said nothing held the request open forever. `AbortSignal.timeout` also
  covers a stalled body read, which a manual `setTimeout(() => abort())` around
  the response alone would not. The four call sites — HappyView batch, HappyView
  single-DID, Bluesky appview, PDS `getRecord` — are each driven against a
  black-hole server in `profileFetchBounds.test.ts`.

### What this costs, stated plainly

On a **cold store** (no row) the first read now renders the author as the DID
until something else refetches that page. This is the one real regression and it
is worth being precise about:

- It is the state the pre-change code already reached whenever the fetch
  **failed**, errored, or was backed off by the negative cache — `hydrateMissingProfiles`
  swallows failures and returns the same incomplete result. The deferral reaches
  it sooner; it does not invent it.
- The page is not permanently wrong. Any later refetch picks the row up — a
  `sub` to the room (which emits `#invalidate` for `room.getMessages`), a
  resync, or the write-path materialisation that fills the row for every
  `createMessage` author on a live space in the first place.
- It cannot happen in steady state: the fresh-row case above is 0 fetches and
  unchanged, and the write path materialises the author before the message is
  ever readable.

Not changed, and why: the **write path** (`StreamManager` awaiting
`ensureProfilesRoomyFirst` before `applyBatch`) is still 1:1 with the upstream.
Deferring it would leave a push notification naming a sender by DID — the badge
is dispatched from the same batch (§Assessment, guarantee 3) — and on a
migration or backfill replay the fetch is awaited per chunk with no request
waiting anyway. Reported rather than done.

### Results

`bun test --isolate --cwd packages/appserver`: **1136 pass, 1 skip, 0 fail**
on the branch, against **1131 pass, 1 skip, 0 fail** on the base measured in
the same session — the delta is the 13 tests below (net +5, since three of the
four TASK-187 hydration cases were replaced by three). `tsc --noEmit`: 0 errors.

The suite now runs 250–310 s against this VM's 2 cores and is sensitive to
concurrent load: with the box at load 30 (several suites started by hand), even
the **unmodified base** fails to finish inside a 1200 s cap, stalling in the
same place. Compare runs only when nothing else is running.

New coverage, all mutation-checked (reverting each change fails the test):

- `queries/selectMessages.test.ts` (3 rewritten/added) — the read returns while
  the fetch is still gated open; a row the fetch wrote is visible on the next
  read; 8 concurrent readers of one cold author issue **one** fetch.
- `fetchTimeout.test.ts` (4) — a black-hole server is aborted, a stalled body
  read is aborted, a caller's own signal still works, a responsive server is
  unaffected.
- `materialization/profileFetchBounds.test.ts` (4) — the same against each
  real call site, so a future profile fetch that bypasses `fetchWithTimeout` is
  caught.
