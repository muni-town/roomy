# Pure Materialisation

**Date:** 2026-10-02
**Status:** Plan — no code changes yet
**Owner:** appserver

## 1. Problem

Materialisation currently mixes three responsibilities in one pass: applying an
event's SQL to the per-space DB, maintaining state that is *not* derived from the
event log (unread counters, embed data, profile fetches), and kicking off
process-local background work (search indexing, embed sweeping, push).

The first is a pure function of the log. The other two are not. The consequences
are visible today, before any replication:

- **A re-materialised space can order differently from the original.** For a live
  `createMessage` the page-selection key is `ulid(Date.now())` — the ingesting
  server's clock (`applyBatch.ts:219-222`, `sortIdx.ts:26-40`). A replay computes
  the same key from the event's own ULID instead (`applyBatch.ts:219-222`, the
  `isBackfill ? "event" : "arrival"` branch). Two derivations of the same log
  therefore produce different `entities.sort_idx` values, and `selectMessages`
  orders by `sort_idx`.
- **Replay safety depends on a flag, not on the operations being idempotent.**
  Unread counters are incremented (`applyBundle.ts:185-210`,
  `moveMessages.ts:202-220`) and decremented (`roomDerivedState.ts:92-117`). These
  are suppressed during replay only because every materialisation call site passes
  `isBackfill: true`. Any path that replays without that flag double-counts.
- **The per-space DB is not self-describing.** `space.roomy.space.setHandle`
  writes `comp_space.handle` directly and authors no event
  (`handlers/space.roomy.space.setHandle.ts:65-73`). A space rebuilt from the log
  loses its handle. Embed data (`comp_embed_link_data`) is written by the
  sweeper, never by the log, and is read on the message and activity-feed paths.

This matters because the per-space DB is the unit of scale. Making it a
deterministic projection of the log is what lets more than one process derive it,
lets a space be rebuilt without loss, and lets the write path stop waiting on
work that is not part of the event's meaning.

## 2. Definition of pure

The target invariant, stated so it can be tested:

> Given the same event log prefix and the same schema version, materialising it
> into a fresh per-space DB **twice, at different wall-clock times, on different
> processes, without network access** produces byte-identical derived state
> (modulo an explicit, documented exclusion list).

Three properties follow, and each is independently useful:

1. **Deterministic** — no clock, no PRNG, no ambient DB ordering in any derived value.
2. **Idempotent** — applying the same event twice leaves the same state as applying it once.
3. **Closed** — every derived value comes from the log; nothing outside the log writes the per-space DB.

Property 2 is what makes at-least-once delivery survivable. Property 3 is what
makes a replica correct. Property 1 is what makes the two agree.

## 3. Current violations

Buckets: **D** breaks determinism, **I** breaks idempotence, **C** breaks closure.
An item can be more than one.

### 3.1 `entities.sort_idx` carries the ingesting clock (D, I)

| Site | Behaviour |
|---|---|
| `applyBatch.ts:219-222` | Live `createMessage`: `ulid(canonicalMessageTimestamp(event, "arrival"))`. `"arrival"` is `Date.now()`. |
| `sortIdx.ts:26-40`, `:217-244` | `setMessageSortIdxByTimestamp` and `canonicalMessageTimestamp`; `TimestampSource = "event" \| "arrival"`. The write is guarded `where sort_idx is null`, so it is apply-once. |
| `sortIdx.ts:96` | `setMessageSortIdxByMove` — a moved message is keyed by the move event's own ULID time. |
| `sortIdx.ts:121` | `setMessageSortIdxByReorder` — reads neighbouring rows' `sort_idx` and writes a midpoint: an ambient read of the current table. |

Two distinct defects:

- **The clock.** The `"arrival"` branch exists deliberately: the message id is
  minted on the sender's device, so a skewed client clock would durably bury a
  message mid-history. That concern is real and must be preserved. What must
  change is that the *value chosen at ingest* has to be recorded in the log, so
  replay reproduces it instead of substituting a different rule.
- **The random suffix.** `ulid()` emits a 10-char time prefix plus 16 characters
  from a CSPRNG. Even the pure replay branch is not byte-reproducible, and two
  messages created in the same millisecond sort by a random tie-break that
  differs between derivations. The tie-break needs to be the log position.

### 3.2 Unread counters are increments (I, C)

| Site | Behaviour |
|---|---|
| `applyBundle.ts:185-197` | Thread room: insert `read_positions` for every user in `user_thread_activity` tracking the thread, `unread_count = 1`. Reads `max(sort_idx)` from the per-space DB as `seen_up_to`. |
| `applyBundle.ts:200-210` | Channel: `update read_positions set unread_count = unread_count + 1 where room_id = ?`. |
| `moveMessages.ts:202-210,216-220` | `+1` in the destination room, both branches. |
| `roomDerivedState.ts:92-117` | `decrementUnreadForRemovedMessages` — subtracts per reader whose read position is below the moved/deleted message. |
| `deleteMessage.ts:89` | Calls the same decrement helper for the delete path. |

Two problems. The operation is a read-modify-write against state that is not in
the log, so it is neither deterministic nor idempotent; and the source of truth
being read (`user_thread_activity`, `read_positions`) lives in a different
database from the one being materialised.

A counter is the wrong representation for a value that can be recomputed. The
durable facts are the read position (`seen_up_to`, log-derived) and the message
set (log-derived); `unread_count` is their difference. Storing the difference
means every event that adds or removes a message must remember to adjust it —
which is exactly where the current complexity, and the replay hazard, come from.

### 3.3 Non-log writers to the per-space DB (C)

| Site | Writes | Assessment |
|---|---|---|
| `handlers/space.roomy.space.setHandle.ts:65-73` | `comp_space.handle`, `updated_at` | **Unrecoverable from the log.** Must become an event. |
| `streams/StreamManager.ts:400` | `insert into entities` for a new space | Recoverable — the space's own `addAdmin` event creates the row on replay. |
| `streams/StreamManager.ts:418` | `delete from entities` on a failed create | Best-effort cleanup; harmless if the space never materialises. |
| `queries/joinedSpaces.ts:186,191,218,223` | `entities` seeding + `edges` (`joinedSpace` / `leftSpace`) | Exported but **no production caller** — `createSpace` uses `recordGlobalMembership`. Dead API surface that breaks closure. |
| `auth/access.ts:265,581` → `queries/roomAccessProjection.ts:262` | `room_access` (read-path warm) | Derived cache of log data. Benign **provided** replay invalidates it — which `applyBatch.ts:248-272` does. |
| `queries/threadActivity.ts:233` → `queries/roomActivityProjection.ts:350` | `room_activity` (read-path warm) | Same. |
| `embed/enricher.ts:298,329,382` | `comp_embed_link_data` | **Not derived from the log at all.** Moves out (see §3.5). |

The read-path warms are acceptable: they are caches of values the log determines,
and they are rebuilt on replay. The rule to hold is *a non-materialisation writer
may only write a value the log already determines, and must be invalidated by
replay.* `setHandle` and `comp_embed_link_data` break that rule.

### 3.4 Clock columns (D, cosmetic)

Not all of these affect behaviour, but each one makes two derivations differ
byte-for-byte, which hides real divergence in a diff.

- `comp_space.backfilled_to` / `updated_at` — `applyBatch.ts:531-541`.
- `activity_item.created_at` / `updated_at` — schema defaults
  (`schema-space.sql:346-347`), set at `activityItem.ts` and
  `roomDerivedState.ts`. (`last_activity_at` is log-derived and correct.)
- `comp_embed_link.created_at` / `updated_at` — set at enrichment time.
- `entities.created_at` — SDK `ensureEntity` falls back to `Date.now()` for
  non-ULID ids.
- Synthetic `spaceMeta` / profile materialisers bake `Date.now()` into
  `comp_space`, `comp_info`, `comp_room`.
- Global: `pending_links.created_at` (`applyBatch.ts:629`),
  `space_stats.updated_at` (`applyBatch.ts:513-524`), `profiles.updated_at`.

### 3.5 Work that is not projection (C)

- **Network on the materialisation path.** `StreamManager.ts:238` calls
  `ensureProfilesRoomyFirst`, which fetches from HappyView or the Bluesky
  appview (`materialization/profiles.ts`, `roomyProfile.ts`). It runs inside the
  live write path, and its result lands in the **global** `profiles` table — the
  per-space `comp_user`/`comp_info` writes were already dropped
  (`profiles.ts:563-567`). It is slow, non-deterministic, and duplicated per
  replica.
- **In-memory enqueues.** Search indexing (`applyBatch.ts:590,641,647,676`),
  embed-sweeper and push pokes (`StreamManager.ts:288,349`). These are
  process-local work queues; a second process would either duplicate or lose the
  work.
- **Global dual-writes.** `entity_space` (`applyBatch.ts:202,619`), `pending_links`
  (`:629`), `space_stats` (`:518`). Content-idempotent via `insert or ignore`,
  but each carries a materialise-time clock and each is a write to a single
  shared file.

## 4. Target model

Split by *what the value is a function of*, not by which file it currently lives in:

| Value | Function of | Home |
|---|---|---|
| Message ordering (`sort_idx`) | Log position + recorded ingest timestamp | Per-space projection |
| Room/space content, roles, edges, reactions | Log | Per-space projection |
| `room_access`, `room_activity` | Log (denormalised cache) | Per-space projection, rebuilt on replay |
| Unread counts | Log + read positions | Read-state, recomputed — not incremented |
| Embed metadata | Outbound HTTP | Global/gateway, never per-space |
| Profiles | Network index | Global/gateway |
| Search index, push, embed sweeps | Log (as work items) | Lease-partitioned background workers |

Two consequences worth stating plainly:

- **Materialisation stops writing read-state entirely.** It writes exactly one
  database. Everything in `applyBundle`'s read-state section (§3.2) and the
  `readStateDb` parameter threading (`applyBatch.ts:585,668`; `:486-489` on the
  delete path) goes away.
- **The per-space DB becomes rebuildable.** After this, `data/spaces/*.sqlite`
  is a pure function of `roomy-events.sqlite`, and blue-green rebuild is a
  correctness-preserving operation rather than a data-loss risk.

## 5. Work plan

Ordered so each step is independently shippable and independently useful. Steps
1 and 2 are prerequisites for replication; steps 3–5 are cleanups that the
modelling work makes possible.

### Step 1 — Deterministic ordering keys

**Change.** Make the ingest-time ordering timestamp an explicit part of the
event, so replay reproduces it rather than substituting a different rule.

- Record the ingest timestamp on the event at append time (an extension field or
  a column on `stream_events`), and have `setMessageSortIdxByTimestamp` read it on
  both the live and replay paths. The `isBackfill ? "event" : "arrival"` branch
  (`applyBatch.ts:219-222`) disappears; the choice is made once, at ingest, and
  is then data.
- Replace the random tie-break in `ulid()` with the log position (`idx`) so equal
  timestamps order identically across derivations.
- Apply the same treatment to `setMessageSortIdxByMove` (`sortIdx.ts:96`) and
  `setMessageSortIdxByReorder` (`sortIdx.ts:121`), which currently read
  neighbouring rows to compute a midpoint.

**Why first.** It is the only item that changes what is written at ingest, so it
needs to land before anything starts relying on replica equivalence. It also
removes a latent bug: a space rebuilt today can order differently from the
original.

**Acceptance.** Materialise the same log twice — once live, once via
`reMaterializeFromLocalEvents` — and assert `entities.sort_idx` is identical for
every message. Assert equal-timestamp messages order by `idx`.

**Migration.** Existing per-space DBs hold clock-derived keys. A
`SPACE_SCHEMA_VERSION` bump forces a blue-green rebuild, which recomputes them
from the log through the existing begin → replay → commit path. No bespoke
migration.

### Step 2 — Remove the non-log writers

**Change.**

- `setHandle`: author an event (`space.roomy.space.updateSpaceHandle.v0` or a
  field on the existing space-info event) and derive `comp_space.handle` in the
  materialiser. Until the event exists in the log, the handler is the only writer
  and a rebuild silently drops the handle.
- `createStream`: write the `entities` row through an event, or accept that it is
  recreated on replay and document the create path as event-first.
- Audit the read-path warms (`room_access`, `room_activity`) to confirm every
  replay path invalidates them rather than merging into stale rows.

**Acceptance.** For every per-space table, a test that materialises a log,
records the table, then rebuilds from the same log and asserts equality. Tables
with a non-materialisation writer must fail this test today and pass after.

### Step 3 — Move unread out of the materialiser

**Change.** Delete the read-state writes from `applyBundle`, `moveMessages` and
`deleteMessage`, along with the `readStateDb` parameter. Unread becomes a value
derived from the read position and the message set, computed where it is read.

This is the largest behavioural change and needs its own design pass; the
constraint to hold is that the *stored* representation must be recomputable
rather than incrementally maintained. Two viable shapes:

- store `seen_up_to` only and derive the count on read (a per-room range count,
  which the `room_activity` and `activity_item` projections can serve without
  scanning messages); or
- keep a stored count but recompute it from the log plus `seen_up_to` on any
  event that changes the message set, rather than adjusting it.

The first is cleaner and makes idempotence structural. It costs a read-path
change in every place that reads `unread_count` today.

**Acceptance.** Applying a batch twice produces identical `read_positions`.
Replaying a space's full log from empty produces the same unread state as
materialising it live.

### Step 4 — Move embed data out of the per-space DB

**Change.** `comp_embed_link_data` is written only by the sweeper and read by
`selectMessages`, `activityFeed` and `links`. Move it to the global/gateway layer
keyed by URL, where the sweeper already works, and have the read paths join
against it in JS rather than reading a per-space row. The `comp_embed_link`
(which links a message contains) stays per-space — that part *is* log-derived.

**Why.** It is the one per-space table with no log provenance, and it is on the
read hot path, so any second derivation of a space renders bare links.

**Acceptance.** A freshly rebuilt space serves enriched link cards without having
run the sweeper.

### Step 5 — Take network and process-local work off the path

**Change.**

- Move profile hydration off `StreamManager.sendEvents` (`StreamManager.ts:238`).
  Reads should resolve profiles from the global store at read time, and
  materialisation should not block on a network fetch.
- Make the search indexer, embed sweeper and push dispatcher lease-owned rather
  than started-per-process, so a second process neither duplicates nor loses
  their work. The voice reconciler's conditional-upsert lease is the existing
  pattern.

**Acceptance.** Materialisation performs no outbound network calls (assertable by
failing the test on `fetch`). Background loops run on exactly one owner.

## 6. Invariants to pin

| # | Invariant | Where proven |
|---|---|---|
| P1 | Two derivations of the same log produce identical `sort_idx` for every message | Step 1 |
| P2 | Equal-timestamp messages order by log position, not randomly | Step 1 |
| P3 | For every per-space table, rebuild-from-log equals live state | Step 2 |
| P4 | Applying a batch twice leaves read-state unchanged | Step 3 |
| P5 | Materialisation performs no outbound network I/O | Step 5 |
| P6 | A rebuilt space serves enriched links without the sweeper | Step 4 |
| P7 | No per-space table has a writer outside materialisation (+ documented caches) | Steps 2, 4 |

The general form of P3/P7 is worth automating: a harness that materialises a log
into `:memory:`, snapshots every table, rebuilds, and diffs. That test fails today
for `comp_embed_link_data`, and would have caught `setHandle`.

## 7. Risks and open questions

- **Ordering is user-visible.** Changing `sort_idx` derivation re-sorts existing
  spaces on the next rebuild. The schema bump makes that a deliberate, one-time
  event rather than a silent drift, but it should be a known consequence.
- **`reorderMessage` is genuinely order-dependent.** A reorder is defined relative
  to its neighbours, so it cannot be a pure function of the single event — it
  needs the surrounding order, which *is* log-derived, but the midpoint arithmetic
  must be pinned so that the same neighbourhood yields the same key. Fractional
  indexing with a deterministic tie-break is the likely answer.
- **Step 3 changes read behaviour.** If `unread_count` becomes derived, every
  reader of that column changes. The `read_positions` table is read by the sidebar,
  the activity feed, the push digest gate and the room metadata endpoint; the
  blast radius is the main cost of the step, and is why it is sequenced after the
  cheaper, more contained steps.
- **`isBackfill` still matters after this work** — but only for signal emission
  (whether a diff and an unread bump are produced), not for read-state safety.
  With materialisation pure, replaying into a fresh DB can never corrupt anything;
  the flag only decides what the *client* is told. That is a much smaller contract
  to reason about than today's.
- **Open:** `recordPersonalSpaceMembership` (`queries/joinedSpaces.ts:175`),
  `recordLeftSpaceEdge` (`:210`) and `removeLeftSpaceEdge` (`:239`) write per-space
  `entities`/`edges` rows, are exported, and have no production caller —
  `createSpace` uses `recordGlobalMembership` (`space.createSpace.ts:123`). The
  module's header comment still claims `createSpace` uses them. Delete them, or
  route them through events; do not leave an unguarded second writer in the tree.

## 8. Related documents

| Document | Relevance |
|---|---|
| [`per-space-dbs.md`](per-space-dbs.md) | The per-space split; data classification and cross-space queries |
| [`blue-green-read-serving.md`](blue-green-read-serving.md) | Rebuild machinery this work depends on and reuses for migration |
| [`denormalised-read-projections.md`](denormalised-read-projections.md) | Read-path projections; measured endpoint costs |
| [`readstate-sharding-review.md`](readstate-sharding-review.md) | Why read-state stays one file |
