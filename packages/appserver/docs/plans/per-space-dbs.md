# Per-Space Database Architecture

**Date:** 2026-07-03
**Status:** Phase 1 (dual-write) + Phase 2 (read cutover, dual-write kept) + Phase 3 (remove monolithic) shipped. The monolithic materialised DB is gone; per-space DBs are the source of truth for space data, the global DB holds membership/profiles/entity index, and the event-log DB is the append-only source of truth. Phase 4 (worker pool) shipped — per-space DBs run on N pool workers; the global, read-state and event-log DBs each run on their own dedicated worker (so a slow query on one shared DB no longer blocks the other two).

## Problem

The appserver runs **one `Bun.Worker` thread** that owns all SQLite I/O process-wide. That single worker currently manages **three ATTACHed databases** — materialised views (`data/roomy.sqlite`), read-state (`data/roomy-readstate.sqlite`), and the append-only event log (`data/roomy-events.sqlite`) — accessed through one `AsyncDatabase` proxy over one `postMessage` queue. Every query, materialization batch, auth check, and embed sweep serializes through that queue. The perf review (`docs/.llm.perf-review.md`) documents the impact:

- 15–25 worker round-trips per materialized event
- 1.5–2.5M round-trips for a 100k-event space backfill
- All spaces' materialization queues on the same worker
- All HTTP read queries serialize behind writes

The root cause: **one materialised-DB file, one worker thread**. (The event-log DB is append-only and read only by `reMaterializeFromLocalEvents` on boot plus the materializer's event reads — it is not on the read hot path and is out of scope for the split.) Most *read* queries are scoped to a single space and are independent. Only a small minority join across spaces.

> **Context update since this doc was written.** Leaf is no longer part of the Roomy stack — the appserver owns its own event store (`data/roomy-events.sqlite`) and re-materializes from it on boot (`reMaterializeFromLocalEvents`). All "re-materialize from Leaf" references below are updated to "re-play from the local event store". The event-log DB itself is not split; it stays as one file.

## Proposal

Split the materialised-views DB into:

1. **Per-space DBs** (`data/spaces/<spaceDid>.sqlite`) — the majority of materialized data, independently queryable
2. **Global DB** (`data/global.sqlite`) — cross-space data (membership edges)
3. **Read-state DB** (`data/roomy-readstate.sqlite`) — user-scoped state (read positions, thread activity) — already a separate file, stays as-is

> The **event-log DB** (`data/roomy-events.sqlite`) is a fourth database that is **not split** by this plan. It is the append-only source of truth and is shared across spaces; re-materialization reads it sequentially per stream on boot. It is owned by the same single worker today and stays there — per-space query workers only handle materialised views.

A **worker pool** (N = 4–8, matching CPU cores) handles per-space DB requests. Hash-based routing ensures the same space always hits the same worker, enabling handle caching and prepared-statement reuse.

## Data Classification

### Per-space DB (moved)

| Table | Purpose |
|---|---|
| `entities` | All space entities (rooms, messages, users, roles) |
| `edges` | Member/admin/ban edges, role-room links, room links |
| `comp_space` | Space config |
| `comp_room` | Room metadata (label, default_access, deleted) |
| `comp_content` | Message content |
| `comp_info` | Names, avatars, descriptions |
| `comp_user` | User profiles within space context |
| `comp_reaction` | Message reactions |
| `comp_embed_image` / `comp_embed_video` / `comp_embed_file` / `comp_embed_link` | Media embeds |
| `comp_embed_link_data` | Cached enriched embed data |
| `comp_bans` | Banned users |
| `comp_calendar_link` / `comp_calendar_event` | Calendar integration |
| `comp_page_edits` / `comp_comment` | Page edits |
| `comp_discord_origin` | Discord bridge |
| `comp_last_read` | Legacy unread counter |
| `roles` / `member_roles` / `role_rooms` | Role-based access control |
| `activity_item` | Activity feed |
| `comp_invite` | Invite tokens |
| `materialization_cursor` | Per-stream materialization cursor (re-play progress) — currently in the materialised DB, moves per-space so each space DB tracks its own re-materialization progress |

### Global DB (stays)

| Table | Purpose |
|---|---|
| `edges` (joinedSpace/leftSpace labels only) | User DID → space membership (`head = userDid`, `tail = spaceDid`) |
| `schema_version` | Migration tracking for the global schema |

> Note: `comp_space.backfilled_to` — the eager-backfill cursor — moves to the per-space DB's `materialization_cursor` (above). The global DB has no per-space cursor.
>
> **Personal stream removal (2026-08):** The `comp_user_personal_stream` table and the `resolvePersonalStreamDid` resolver have been removed. `joinedSpace`/`leftSpace` edges now use `userDid` as `head` directly — no personal-stream DID indirection. The global DB is smaller than originally planned.
>
> **`leftSpace` durability (in scope for this plan):** Today `leftSpace` edges are written *only* by the `leaveSpace` handler directly (`recordLeftSpaceEdge`) — no event creates them. The `PersonalLeaveSpace` materialiser merely deletes the `joinedSpace` edge; the space-side `LeaveSpace` materialiser deletes the `member` edge. The global DB is derived/regenerable (see §1h/§1i), so any rebuild from the event log silently drops left-space history: `getSpaces?includeLeft=true` stops showing previously-left spaces until the user rejoins. **Making `leftSpace` durable across rebuilds is a prerequisite of this plan** — see the new §"Prerequisite: Event-Back the leftSpace Edge" below, because the split's recovery paths all depend on rebuild-from-event-log being lossless.

### Read-state DB (stays separate)

| Table | Purpose |
|---|---|
| `read_positions` | Per-user, per-room read position + unread count |
| `user_thread_activity` | Per-user, per-thread last activity timestamp |

> Today the read-state DB is a **separate file** (`data/roomy-readstate.sqlite`) but is **not** a separate worker — it is opened and `ATTACH`ed into the same single worker as the materialised DB (`worker.ts` `handleInit`). This plan keeps the read-state DB as its own file; whether it also gets a dedicated worker is a separate decision. The split target diagram below shows it on a dedicated worker for clarity of the proposed topology.

## Cross-Space Queries (the minority)

These queries touch data across spaces and need special handling:

1. **`getSpaces`** — reads `edges` for `joinedSpace` from the global DB (`head = userDid`), then fans out to per-space DBs for name/avatar/unread count
2. **`getActivityFeed` (no space filter)** — reads `activity_item` across all joined spaces. Fan-out to per-space DBs, merge in JS
3. **`getSpaceUnreadCount`** — joins `read_positions` (read-state DB) with `entities.stream_id`. With per-space DBs, `stream_id` moves to per-space DBs. Solution: store `stream_id` in `read_positions` directly, or query per-space DB for entity existence
4. **`userHydration`** — reads `edges` for `joinedSpace` from the global DB (`head = userDid`). Pure global-DB work
5. **Embed sweeper** — reads `comp_embed_link` / `comp_embed_link_data` across all spaces. Solution: maintain a global `pending_links` index table, dual-written during materialization
6. **`inferSignals` → `handleCreateMessage`** — calls `selectMessages` which reads per-space data. Already per-space; just needs the right DB handle

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Main Thread                          │
│                                                           │
│  HTTP handlers → openDb(spaceDid) → pool-backed handle    │
│  WS sync handler → routes signals by space                │
│  Embed sweeper → reads global pending-links index         │
│  reMaterializeFromLocalEvents → reads event-log DB        │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Global DB worker (1)                               │  │
│  │    data/global.sqlite                               │  │
│  │    edges (joinedSpace/leftSpace, head = userDid)   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Read-state DB (1 worker, or ATTACHed as today)     │  │
│  │    data/roomy-readstate.sqlite                      │  │
│  │    read_positions, user_thread_activity              │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Event-log DB (not split — stays single)            │  │
│  │    data/roomy-events.sqlite                         │  │
│  │    stream_events, stream_state, dids, did_keys,     │  │
│  │    did_owners (append-only source of truth)         │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Space DB worker pool (N=4-8)                       │  │
│  │                                                      │  │
│  │  Worker 0 ── LRU cache ── data/spaces/<A>.sqlite    │  │
│  │  Worker 1 ── LRU cache ── data/spaces/<B>.sqlite    │  │
│  │  Worker 2 ── LRU cache ── data/spaces/<C>.sqlite    │  │
│  │  Worker 3 ── LRU cache ── data/spaces/<D>.sqlite    │  │
│  │                                                      │  │
│  │  hash(spaceDid) % poolSize → worker N               │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Worker Pool Design

**Dispatch**: `hash(spaceDid) % poolSize` ensures the same space always hits the same worker. This lets the worker cache the `Database` handle and prepared statements.

**LRU cache per worker**: Each worker maintains a `Map<spaceDid, Database>` with an LRU eviction policy (e.g., max 100 open DBs per worker). On cache miss, the worker opens the file, applies schema if needed, and caches the handle.

**Schema-on-first-access**: When a worker opens a space DB for the first time, it runs `CREATE TABLE IF NOT EXISTS ...` for the per-space schema. This is idempotent and fast.

**Request protocol**: The existing `WorkerRequest` type gains an optional `spaceDid` field. Pool workers ignore it for global-DB-style requests; space workers use it to select the DB file.

**Concurrency model**: Space A's materialization runs on worker 2. Space B's runs on worker 5. They are truly concurrent — separate processes, separate SQLite files, no lock contention. Reads for different spaces also run on different workers concurrently. Reads for the same space serialize (hash routing), which is fine — SQLite serializes writes anyway.

---

## Prerequisite: Event-Back the `leftSpace` Edge

**Why:** Every recovery path in this plan — §1h's alternative rebuild from the event log, §1i's "global DB can be regenerated", and the corruption-recovery row in the risks table — assumes the global DB is fully reconstructible by replaying `data/roomy-events.sqlite`. Today that is false for `leftSpace` edges: they are written only by the `leaveSpace` handler (`recordLeftSpaceEdge`), no event materialises them, so a rebuild drops left-space history (`getSpaces?includeLeft=true` loses previously-left spaces until rejoin). This must be fixed before Phase 1's dual-write starts, or the global DB becomes the one piece of state that cannot be regenerated.

**Change — membership lives in the global DB, on the space-side join/leave events (no personal events):**

The historical divide between *personal join intent* (`personal.joinSpace`) and *in-space join registration* (`space.joinSpace`) came from an architectural limitation (a separate personal stream) that has since been removed. Membership is now tracked in one place — the global DB — and the space-side events are the single source:

1. **`JoinSpace`** (`space.roomy.space.joinSpace.v0`) writes the `joinedSpace` edge (`head = user`, `tail = space`) and deletes any `leftSpace` edge. Routed to the global DB by §statementRouting, so joining writes membership.
2. **`LeaveSpace`** (`space.roomy.space.leaveSpace.v0`) deletes the `joinedSpace` edge and writes a `leftSpace` edge. Routed to the global DB, so leaving removes membership and records history for `getSpaces?includeLeft=true`.
3. **`personal.joinSpace` / `personal.leaveSpace` events and their materialisers are removed.** The SDK no longer defines them; `writeAuth` no longer rejects them (they don't exist); replay skips any historical `personal.*` events in the log.

   **Replay respects leaves (migration guarantee):** membership is reconstructed from the `space.joinSpace` *and* `space.leaveSpace` events that the handlers have always emitted into the space stream, applied **in `idx` order**. A `space.joinSpace` writes the `joinedSpace` edge; the `space.leaveSpace` that follows it (when the user left) deletes that edge and writes `leftSpace`. So a full wipe + replay of the event log does **not** re-add users who left — their `joinedSpace` edge is removed by the replayed `leaveSpace`, and only the `leftSpace` marker survives. This is verified by `applyBatch.test.ts` ("replaying join+leave in order does not re-add a departed user").
4. **Handler fast-path stays, dual-writing to the global DB:** `createSpace`/`joinSpace` write the `joinedSpace` edge (and `leaveSpace` the `leftSpace` edge) directly to both the monolithic DB (Phase-1 read source) and the global DB (`openGlobalDb()`) for read-after-write consistency; the materialiser is the idempotent durability backstop.

**Migration:** This is a materialiser-logic change, not a schema change. Bump `SCHEMA_VERSION` (appserver `db.ts`) so the wipe+replay rebuilds edges from the now-complete materialiser output. Because the change is *additive* (new edges on replay), no data is lost by the wipe; existing handler-written `leftSpace` edges are dropped and re-derived from `space.leaveSpace` events in the log.

**Caveat — history before this change:** `leftSpace` edges that exist *before* this prerequisite ships were created by handlers only; their corresponding `space.leaveSpace` events ARE in the event log, so replay reconstructs them. The only lossless gap is a leave that happens between the last schema wipe and this prerequisite — i.e. current production left markers do not survive the first wipe. That is the accepted, pre-existing rebuild behavior this prerequisite fixes going forward.

**Verification:** seed events → run `reMaterializeFromLocalEvents` on a wiped DB → assert `joinedSpace`/`leftSpace` edges exist for users whose `space.joinSpace`/`space.leaveSpace` events replayed; `getSpaces` (incl. `?includeLeft=true`) reflects them; the global DB matches the monolithic DB's membership edges.

## Phase 1: Schema Split + Dual-Write

**Goal**: Create the per-space DB infrastructure and dual-write all materialization to both the old monolithic DB and the new per-space DBs. No behaviour change — the monolithic DB remains the source of truth for reads. This phase is fully reversible.

> **Depends on**: the §Prerequisite (event-backed `leftSpace`) shipping first — Phase 1's dual-write and the global DB's "regenerable" property both assume it.

### 1a. New Schema Files

#### `src/db/schema-space.sql`

The per-space schema is the current `schema.sql` minus cross-space tables. Specifically, it drops:

- The `joinedSpace`/`leftSpace` edge labels (moves to global DB — but the `edges` table itself stays, just without those labels)

Everything else stays: `entities`, `edges`, `comp_space`, `comp_room`, `comp_content`, `comp_info`, `comp_user`, `comp_reaction`, all embed tables, `comp_bans`, `comp_invite`, `roles`, `member_roles`, `role_rooms`, `activity_item`, `comp_calendar_*`, `comp_page_edits`, `comp_comment`, `comp_discord_origin`, `comp_last_read`.

`materialization_cursor` also moves here (one row per stream, currently a single global table in the materialised DB). `reMaterializeFromLocalEvents` reads it per-space to decide which streams need replay; moving it per-space means each space DB is self-describing about its own re-materialization state and a schema-version wipe on one space DB doesn't force re-materialization of others.

The schema version is tracked independently per space DB (a `space_schema_version` table). This lets us evolve per-space schemas without forcing a global re-materialization.

> **Update (blue-green read serving):** a schema bump no longer wipes a stale
> per-space DB. The worker serves reads from the old DB while a temp new-schema
> DB is rebuilt from the event log and atomically swapped in. See
> `docs/plans/blue-green-read-serving.md` for the current behavior.

#### `src/db/schema-global.sql`

```sql
create table if not exists global_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

create table if not exists edges (
  head text not null,
  tail text not null,
  label text not null,
  payload text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000),
  primary key (head, tail, label)
) strict;
create index if not exists idx_edges_label on edges(label);
create index if not exists idx_edges_label_head on edges(label, head);
create index if not exists idx_edges_label_tail on edges(label, tail);
```

Only `joinedSpace` and `leftSpace` edges live here. All other edge labels (member, admin, role-room, room links) stay in per-space DBs.

#### `src/db/schema-pending-links.sql` (optional, for embed sweeper)

```sql
create table if not exists pending_links (
  space_did text not null,
  message_id text not null,
  url text not null,
  created_at integer not null default (unixepoch() * 1000),
  primary key (space_did, message_id, url)
) strict;
```

This is a global index of pending embed enrichments, dual-written during materialization so the embed sweeper doesn't need to iterate all space DBs.

### 1b. New Infrastructure Files

#### `src/db/pool.ts` — Worker pool client

```typescript
export class DatabasePool {
  private workers: Worker[];
  private nextWorker = 0; // for round-robin fallback

  constructor(count: number, workerPath: string) {
    this.workers = Array.from({ length: count }, () => new Worker(workerPath));
  }

  /** Get a pool-backed DB handle for a specific space. */
  forSpace(spaceDid: string): PoolDbHandle {
    const workerIndex = hash(spaceDid) % this.workers.length;
    return new PoolDbHandle(this.workers[workerIndex]!, spaceDid);
  }

  /** Get a handle to any worker (for global-DB-style requests). */
  any(): PoolDbHandle {
    const workerIndex = this.nextWorker++ % this.workers.length;
    return new PoolDbHandle(this.workers[workerIndex]!);
  }

  close() { this.workers.forEach(w => w.terminate()); }
}
```

`PoolDbHandle` implements `DbLike` — it sends requests to its pinned worker with the `spaceDid` attached. The worker uses `spaceDid` to select/open the correct DB file.

#### `src/db/spaceWorker.ts` — Worker script

The existing `worker.ts` is refactored into `spaceWorker.ts`. Key changes:

- **Init**: receives pool config (data directory, max cached DBs). Does NOT open any DB at startup.
- **Request handling**: each request carries an optional `spaceDid`. If present, the worker opens (or retrieves from LRU cache) `data/spaces/{spaceDid}.sqlite`, applies schema if new, then executes the SQL against that DB.
- **LRU cache**: `Map<spaceDid, { db: Database, lastUsed: number }>`. On eviction, closes the DB handle. Max size configurable (default 100).
- **Prepared statement cache**: per-DB `Map<string, Statement>` keyed by SQL text. Cleared when the DB handle is evicted.
- **No global DB**: the global DB and read-state DB are handled by separate dedicated workers (or the existing single-worker pattern).

#### `src/db/globalDb.ts` — Global DB singleton

Wraps a single worker (or reuses the existing `AsyncDatabase` pattern) for `data/global.sqlite`. Exposes `openGlobalDb()` returning a `DbLike` handle.

### 1c. Materializer Changes

#### `SpaceMaterializer` gets a pool-backed DB

Currently `SpaceMaterializer` receives a single `db: DbLike` (the monolithic DB). With the pool:

```typescript
// Current
const mat = await SpaceMaterializer.start({
  db: openDb(),  // monolithic
  streamDid,
  ...
});

// Phase 1
const mat = await SpaceMaterializer.start({
  db: openDb(),           // monolithic (still the source of truth)
  spaceDb: pool.forSpace(streamDid),  // per-space DB (dual-write target)
  streamDid,
  ...
});
```

#### `applyBatch` dual-writes

`applyBatch` currently takes `db: DbLike` and writes to it. In Phase 1, it takes two DB handles:

```typescript
export async function applyBatch(
  mainDb: DbLike,     // monolithic DB (source of truth)
  spaceDb: DbLike,    // per-space DB (dual-write target)
  streamId: StreamDid,
  events: DecodedStreamEvent[],
  opts: ApplyBatchOpts,
): Promise<MaterializationStats>
```

The function applies each event's bundle to `mainDb` (as today), then applies the same bundle to `spaceDb`. The cursor advance transaction runs on both DBs.

**Optimization**: The dual-write can be done sequentially (mainDb first, then spaceDb) to keep the monolithic DB as the authoritative source. If the spaceDb write fails, the monolithic DB is still consistent. The spaceDb can be repaired by re-materializing that space.

#### `applyBundle` dual-writes side effects

`applyBundle` has side effects beyond the materializer statements: sortIdx updates, activity item upserts, unread counter increments, thread activity tracking. These also need to run against both DBs.

The cleanest approach: `applyBundle` takes both DB handles and runs each operation against both. Since these are idempotent (sortIdx is deterministic, activity_item upserts, unread counters are additive), running them twice is safe.

```typescript
export async function applyBundle(
  mainDb: DbLike,
  spaceDb: DbLike,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
): Promise<void> {
  // Apply materializer statements to both DBs
  for (const statement of bundle.statements) {
    await runStatement(mainDb, statement);
    await runStatement(spaceDb, statement);
  }

  // Side effects: run against both
  await setMessageSortIdxByTimestamp(mainDb, bundle.event);
  await setMessageSortIdxByTimestamp(spaceDb, bundle.event);
  // ... etc
}
```

#### Global DB writes during materialization

Some materializer statements write to tables that now live in the global DB:

- `joinedSpace`/`leftSpace` edges (from `personalJoinSpace`/`personalLeaveSpace` events — `head = userDid`)

These writes need to go to the global DB instead of (or in addition to) the per-space DB. Always write `joinedSpace`/`leftSpace` edges to the global DB, and all other edge labels to the per-space DB. The materializer statements are opaque SQL — we need to route them based on the table being written.

**Routing approach**: The `applyBundle` function inspects each statement's SQL to determine the target DB:

```typescript
function targetDb(sql: string, mainDb: DbLike, spaceDb: DbLike, globalDb: DbLike): DbLike {
  if (sql.includes("'joinedSpace'") || sql.includes("'leftSpace'")) return globalDb;
  return spaceDb;
}
```

This is fragile. A better approach: tag statements in the materializer output with a target hint. But the SDK materializers are pure functions returning opaque SQL. The pragmatic Phase 1 approach: route by table name in the SQL string. The set of global-DB tables is small and stable.

### 1d. Handler Changes

#### `openDb()` becomes `openDb(spaceDid?)`

```typescript
// Current
const db = openDb();

// Phase 1 — per-space handlers
const db = openDb(spaceId);  // returns pool-backed per-space DB handle

// Cross-space handlers (getSpaces, getActivityFeed without filter)
const globalDb = openGlobalDb();
const spaceDb = openDb(spaceId);  // for per-space details
```

Every handler that takes a `spaceId` parameter changes its `openDb()` call to `openDb(spaceId)`. Handlers that don't have a space context (e.g., `getConnectionTicket`) use `openGlobalDb()`.

#### `getSpaces` — fan-out pattern

```typescript
export async function selectJoinedSpaces(
  globalDb: DbLike,
  userDid: UserDid,
  options: SelectSpacesOptions = {},
): Promise<SpaceRow[]> {
  // Step 1: get space DIDs from global DB (as today)
  const spaceDids = await globalDb.query(`
    select tail from edges
    where head = ? and label = 'joinedSpace'
  `).all<{ tail: string }>([userDid]);

  // Step 2: fan-out to per-space DBs for details
  const spaceRows = await Promise.all(
    spaceDids.map(async (row) => {
      const spaceDb = openDb(row.tail);
      const spaceRow = await spaceDb.query(`
        select cs.entity, cs.handle, ci.name, ci.avatar, ci.description,
               cs.allow_public_join, cs.allow_member_invites,
               cs.sidebar_config
        from comp_space cs
        left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?
      `).get(row.tail);
      // ... resolve unread count, membership, etc.
      return rowToSpace(spaceDb, spaceRow, userDid);
    })
  );

  return spaceRows;
}
```

The fan-out runs in parallel across the pool. Each space's detail query hits a different worker (or the same worker for same-space hashes, which is fine for reads).

#### `getActivityFeed` (no space filter) — fan-out + merge

export async function selectActivityFeed(
  globalDb: DbLike,
  userDid: string,
  membershipDid: string,
  scope: ActivityFeedScope,
): Promise<{ feed: ActivityFeedItem[]; cursor: string | null }> {
  // Step 1: get joined space DIDs from global DB
  const spaceDids = await globalDb.query(`
    select tail from edges where head = ? and label = 'joinedSpace'
  `).all<{ tail: string }>([membershipDid]);
  // Step 2: fan-out to each space's activity_item table
  const perSpaceFeeds = await Promise.all(
    spaceDids.map(async (row) => {
      const spaceDb = openDb(row.tail);
      return spaceDb.query(`
        select ... from activity_item where space_id = ?
        order by last_activity_at desc limit ?
      `).all([row.tail, scope.limit]);
    })
  );

  // Step 3: merge and sort in JS
  const merged = perSpaceFeeds.flat().sort(
    (a, b) => b.last_activity_at - a.last_activity_at
  ).slice(0, scope.limit);

  // ... hydrate messages, unread counts, embeds
}
```

This is the most expensive cross-space query. For a user in 50 spaces, it's 50 parallel queries. Each is a simple indexed lookup (`idx_activity_item_space`), so they're fast. The merge is O(N log N) in JS. For the common case (user in <20 spaces), this is negligible.

**Optimization for later**: Cache the merged feed with a TTL, or maintain a global `activity_item` table (dual-written) for the no-filter case.

### 1e. Embed Sweeper Changes

The embed sweeper currently reads `comp_embed_link` and `comp_embed_link_data` from the monolithic DB. With per-space DBs, it needs to find pending links across all spaces.

**Phase 1 approach**: Dual-write a global `pending_links` table during materialization. When `detectAndStoreLinks` runs (inside `applyBatch`), it writes to both the per-space `comp_embed_link` table AND the global `pending_links` table.

```typescript
// In applyBatch, after detectAndStoreLinks:
if (detected.length > 0) {
  // Dual-write to global pending-links index
  await globalDb.run(
    `insert or ignore into pending_links (space_did, message_id, url, created_at)
     values (?, ?, ?, ?)`,
    ...detected.map(url => [streamId, eventId, url, Date.now()])
  );
}
```

The sweeper then reads from `pending_links` (global DB) to find work, and writes enrichment results to the per-space `comp_embed_link_data` table (via the pool).

When enrichment completes, the sweeper deletes the row from `pending_links`:

```typescript
await globalDb.run(
  `delete from pending_links where space_did = ? and url = ?`,
  [spaceDid, url]
);
```

### 1f. Read-State DB Changes

The read-state DB (`read_positions`, `user_thread_activity`) stays separate. It's already in its own file; today it's `ATTACH`ed into the single materialised-DB worker rather than having its own worker, but the split keeps it as its own file (and optionally its own worker — see the architecture diagram). No changes needed here.

However, `getSpaceUnreadCount` currently joins `read_positions` with `entities` by `stream_id`:

```sql
select coalesce(sum(rp.unread_count), 0) as total
from readstate.read_positions rp
join entities e on e.id = rp.room_id
where rp.user_did = ? and e.stream_id = ?
```

With per-space DBs, `entities` moves to per-space DBs. This join breaks.

**Fix**: Store `stream_id` (space DID) directly in `read_positions`:

```sql
-- Add space_did column to read_positions
alter table read_positions add column space_did text not null default '';
-- Backfill: join with entities during migration
update read_positions set space_did = (
  select stream_id from entities where id = room_id
);
```

Then the query becomes:

```sql
select coalesce(sum(unread_count), 0) as total
from read_positions
where user_did = ? and space_did = ?
```

This is a one-time schema migration on the read-state DB. The `space_did` column is populated during the dual-write phase (every unread counter update writes `space_did` alongside `room_id`).

### 1g. Test Infrastructure Changes

#### `e2e/helpers.ts` seed functions

The seed functions (`seedSpace`, `seedRoom`, `seedMessage`, etc.) currently take a raw `Database` handle and write to it. They need minimal changes — they just write to whatever DB handle they're given.

The test setup code that creates the DB handle changes:

```typescript
// Current
const db = new Database(":memory:");
seedSpace(db, spaceId, userDid);

// Phase 1
const db = new Database(":memory:");  // monolithic (still used)
const spaceDb = new Database(":memory:");  // per-space DB
seedSpace(db, spaceId, userDid);
seedSpace(spaceDb, spaceId, userDid);  // dual-write
```

Or, the test helper creates a dual-write wrapper:

```typescript
function createTestDb(): { mainDb: Database; spaceDb: Database } {
  return {
    mainDb: new Database(":memory:"),
    spaceDb: new Database(":memory:"),
  };
}
```

#### `appserver.test.ts` lifecycle

The `beforeEach` reset needs to also close the pool:

```typescript
beforeEach(() => {
  closeDb();           // close monolithic DB
  closeGlobalDb();     // close global DB
  closePool();         // close all pool workers
  _resetMaterializerRegistry();
  _resetHydrationInflight();
  _resetEmbedSweeper();
});
```

#### Materializer tests

Tests that exercise `applyBatch` or `SpaceMaterializer` directly need to provide both DB handles:

```typescript
// Current
const stats = await applyBatch(mainDb, streamId, events, opts);

// Phase 1
const stats = await applyBatch(mainDb, spaceDb, streamId, events, opts);
```

### 1h. Migration: Populating Per-Space DBs from Existing Data

On first startup after the Phase 1 deploy, existing spaces have data in the monolithic DB but no per-space DB files. The migration strategy:

1. **Lazy creation**: When a space is first accessed (materialization or read), check if `data/spaces/{spaceDid}.sqlite` exists. If not, create it and backfill from the monolithic DB.

2. **Backfill query**: For a given `stream_id`, copy all rows from the monolithic DB to the per-space DB:

```sql
-- Copy entities
insert into space.entities (id, stream_id, room, sort_idx, created_at, updated_at)
select id, stream_id, room, sort_idx, created_at, updated_at
from main.entities where stream_id = ?;

-- Copy comp_space
insert into space.comp_space (...)
select ... from main.comp_space where entity = ?;

-- Copy all other per-space tables similarly
```

This is a one-time copy per space. For a space with 100k events, this is ~100k rows. It's fast (single SQLite transaction, no round-trips).

> **Cross-stream profiles resolve from the global store (2026-08):**
> `comp_user`/`comp_info` are global (one Roomy profile per user) and a
> user's profile entity lives in THEIR OWN stream, not the space's stream.
> The per-space backfill therefore only copies stream-scoped profile rows;
> cross-stream authors/members (the common case) resolve at read time from
> the global `profiles` table via `queries/profileStore.ts`, which keeps a
> short-TTL in-memory cache so the per-space read hot path
> (`getMessages`/`getMembers`/...) doesn't hit the global DB on every
> message. This avoids duplicating all user profiles into every per-space DB.

> **Alternative recovery path**: instead of copying from the monolithic DB, a space DB can always be rebuilt from scratch by replaying the local event log (`reMaterializeFromLocalEvents` for that stream). The event-log DB (`data/roomy-events.sqlite`) is append-only and never wiped, so deleting a corrupted space DB file and re-running re-materialization for that stream is always safe. The copy-from-monolithic path is just faster because it avoids re-running the materializer.

> **Global DB backfill**: the `joinedSpace`/`leftSpace` edges for the global DB come from the same lazy-creation pass — copy `edges` rows with those labels from the monolithic DB, or (after the §Prerequisite ships) simply replay the event log for the affected streams. The §Prerequisite's event-backing is what makes "regenerate the global DB from the log" a safe recovery claim here and in §1i.

3. **Dual-write from here on**: Once the per-space DB is populated, all subsequent materialization writes to both DBs.

### 1i. Rollback Plan

Phase 1 is fully reversible:

1. Stop the appserver
2. Delete the per-space DB directory (`data/spaces/`)
3. Delete the global DB (`data/global.sqlite`)
4. Restart with the old code

The monolithic DB is always kept in sync during Phase 1, so there's no data loss. The per-space DBs and global DB are derived data that can be regenerated — provided the §Prerequisite (event-backed `leftSpace`) has shipped; without it, a regenerated global DB drops left-space history.

---

## Phase 2: Cutover Reads

**Goal**: All per-space queries read from per-space DBs. Monolithic DB is read-only.

> **Status (2026-08):** Read cutover shipped while KEEPING dual-write. Per the
> operator's directive, we cut over reads to the per-space DBs but did NOT make
> the monolithic DB read-only or remove dual-write — the monolithic DB stays
> dual-written and correct so we can validate the migration in production and
> roll back by flipping reads back. Items 3–5 below (removing write paths) are
> deferred to Phase 3.

### Changes

1. **Handler reads switch to per-space DBs**: Every handler that currently reads from `openDb()` (monolithic) reads from `openDb(spaceDid)` (per-space) instead.

   - Space-scoped handlers (`getMetadata`, `getMembers`, `getRoles`, `getInvites`, `getSpaceSummary`, `getThreads`, `setHandle`, `sendEvents`, `joinSpace`, `leaveSpace`) open `openSpaceDb(spaceId)`.
   - Room/message-scoped handlers (`getMessages`, `getThreads`, `getRoomSummary`, `getMetadata`, `getMessage`, `getReactions`, `updateSeen`) resolve the owning space via `openSpaceDbForEntity(entityId)` (a cheap monolithic `entities.stream_id` lookup — the monolithic DB is still dual-written and correct) and then read from the per-space DB.
   - Read-state queries (`read_positions`, `user_thread_activity`) are NOT split and stay on the monolithic handle (`openDb()`), since the per-space DBs have no readstate tables.
   - `getProfile` is a genuinely cross-space query (no space context). Profiles are global (the atproto collection lexicon defines one Roomy profile per user), so they live in a new global `profiles` table in the global DB. `getProfile` reads from there; the profile fetch path (`insertProfiles`/`insertProfilesWithExtras`) and the `SetUserProfile` materialiser write to it. Per-space DBs keep a denormalised copy (`comp_user`/`comp_info`) for fast per-space reads (getMembers, getMessages, ...).

2. **Cross-space queries use global DB + fan-out**: `getSpaces`, `getActivityFeed` (no filter) use the fan-out pattern described above.

   - `getSpaces` reads `joinedSpace`/`leftSpace` edges from the global DB, then fans out to each space's per-space DB for display fields + membership truth; the read-state unread-count aggregate still reads from the monolithic handle.
   - `getActivityFeed` (no filter) reads joined-space DIDs from the global DB, fans out to each space's per-space DB for `activity_item` + message/embed/reaction data, merges/sorts in JS, and reads unread counts from the monolithic handle.

3. **Monolithic DB becomes read-only**: Remove all write paths to the monolithic DB. Keep it mounted for rollback safety. — **DEFERRED** (dual-write kept for production validation).

4. **Remove dual-write from materializers**: `applyBatch` and `applyBundle` only write to the per-space DB. — **DEFERRED** (dual-write kept).

5. **Remove global pending-links dual-write**: The embed sweeper reads from the global `pending_links` table (which is still dual-written during materialization). This is the one dual-write that stays — it's the sweeper's index, not a backup. — **DEFERRED** (dual-write kept).

### Verification

Run the full test suite with the monolithic DB in read-only mode. All tests should pass without writing to the monolithic DB. — **NOT YET**: with dual-write kept, the monolithic DB is still written; this verification applies once items 3–5 land in Phase 3.

---

## Phase 3: Remove Monolithic DB

**Goal**: Delete the monolithic DB and all associated infrastructure.

### Changes

1. **Delete `data/roomy.sqlite`** (or archive for a grace period)
2. **Remove `src/db/schema.sql`** (replaced by `schema-space.sql` + `schema-global.sql`)
3. **Remove `src/db/worker.ts`** (replaced by `spaceWorker.ts` + `globalDb.ts`)
4. **Remove `src/db/asyncDatabase.ts`** (replaced by `pool.ts`)
5. **Clean up `src/db/db.ts`**: `openDb()` becomes `openDb(spaceDid)` with no fallback to monolithic
6. **Remove dual-write code paths** from materializers
7. **Remove `SCHEMA_VERSION`** from `db.ts` (per-space DBs have their own version tracking)

> **Do NOT delete `data/roomy-events.sqlite`** or `src/db/eventsSchema.sql`. The event-log DB is the append-only source of truth and stays as a single shared file/worker regardless of this split. The worker that owns the event-log DB may merge with the global-DB worker or stay standalone — either is fine, but it is separate from the per-space pool.

---

## Phase 4: Worker Pool (Parallelise SQLite I/O)

**Goal**: Move the per-space DBs off the single shared worker onto a pool of N workers, so different spaces' materialization and reads run on different threads in parallel. This is the payoff the whole split was designed for — Phases 1–3 only split the *files*; the single worker that serializes all SQLite I/O is still the bottleneck the plan's problem statement identified.

> **Status (2026-08):** Pending. The split is currently file-level only. `src/db/db.ts` creates one `WorkerLink` (one `Bun.Worker`); `AsyncDatabase.forSpace(spaceDid)` routes every space to that same thread. The worker owns the per-space DBs, the global DB, the read-state DB, and the event-log DB. The LRU cache (`spaceDbs`), prepared-statement cache (`preparedStmts`), and the materialization queue all live in that one worker.

### Current Bottleneck

Every SQLite operation — every per-space read, every materialization batch, every auth check, every embed-sweep write — serializes through one `postMessage` queue into one worker thread. The perf review (`docs/.llm.perf-review.md`) measured 15–25 worker round-trips per materialized event and 1.5–2.5M round-trips for a 100k-event space backfill. Because all spaces share the worker, one busy space's materialization delays every other space's reads and writes.

### Target Topology

```
┌──────────────────────────────────────────────────────────────┐
│                        Main Thread                            │
│  HTTP handlers → openSpaceDb(spaceDid) → pool-backed handle    │
│  WS sync → routes signals by space → pool-backed handle       │
│  reMaterializeFromLocalEvents → reads event-log DB            │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Per-space worker pool (N = 4–8, ~CPU cores)            │  │
│  │  hash(spaceDid) % N → pinned worker                     │  │
│  │  Worker 0 ── LRU cache ── data/spaces/<A>.sqlite        │  │
│  │  Worker 1 ── LRU cache ── data/spaces/<B>.sqlite        │  │
│  │  ...                                                    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Global DB worker (1) — data/global.sqlite              │  │
│  │  edges, profiles, entity_space, pending_links           │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Read-state worker (1) — data/roomy-readstate.sqlite    │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Event-log worker (1) — data/roomy-events.sqlite        │  │
│  │  (append-only source of truth; NOT split)               │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Changes

1. **`src/db/pool.ts` — `DatabasePool`.** Owns N `WorkerLink`s. `forSpace(spaceDid)` returns a handle pinned to `hash(spaceDid) % N`; `any()` round-robins for global-style requests. `PoolDbHandle` stamps the `spaceDid` + `targetDb: "space"` route onto every request, exactly as `AsyncDatabase.forSpace` does today — so the pool is a drop-in replacement for the single `WorkerLink` behind `openSpaceDb`.

2. **Stable hash.** `hash(spaceDid)` must be deterministic across restarts so a space always lands on the same worker (keeps its LRU handle + prepared statements warm). Use a stable string hash (FNV-1a or xxhash64 over the DID bytes), not `Math.random` or a per-process seed. Document that the mapping is stable *within* a pool size; changing N re-distributes spaces (acceptable — caches just re-warm).

3. **Per-worker LRU + prepared-statement caches.** Each pool worker keeps its own `spaceDbs` LRU map and `preparedStmts` map (already the shape in `worker.ts`; the pool just gives each worker its own instance). Because routing is stable, a space's handle stays warm in its pinned worker's cache.

4. **Global / read-state / event-log stay on dedicated workers.** `openGlobalDb()`, `openReadStateDb()`, `openEventsDb()` each get their own single `WorkerLink` (or share one non-pool worker). They are not part of the pool — they are low-traffic, cross-space, and (for the event log) append-only.

5. **`db.ts` wiring.** `openSpaceDb(spaceDid)` returns `pool.forSpace(spaceDid)`; `openGlobalDb`/`openReadStateDb`/`openEventsDb` return their dedicated handles. `openSpaceDbForEntity` still reads the global `entity_space` index first, then `pool.forSpace(spaceDid)`.

6. **Materialization routing.** `SpaceMaterializer` for stream S writes through `pool.forSpace(S)`. Different streams' materializers now run on different workers concurrently. `reMaterializeFromLocalEvents` replays streams with bounded concurrency (up to the pool size, `DEFAULT_REMATERIALIZE_CONCURRENCY`), so different streams' event-log *reads* still hit the single event-log worker but their *writes* (applyBatch, sortIdx, activity upserts) land on different pool workers in parallel — which is where the round-trip cost is.

7. **Embed sweeper.** Reads `pending_links` from the global worker, groups by space, and writes enrichment results through `pool.forSpace(spaceDid)` — so enrichment writes for different spaces land on different pool workers.

### Cross-Space Queries: How They Behave on a Pool

This is the subtle part. Cross-space queries fan out to many per-space DBs, and the pool changes *where* those fan-out requests run. The main thread already merges results in JS (`Promise.all` in `selectJoinedSpaces`, `selectActivityFeed`), so the merge logic is unchanged — but the parallelism of the fan-out now depends on hash distribution.

**`getSpaces` (`selectJoinedSpaces`)** — reads `joinedSpace`/`leftSpace` edges from the global worker, then `Promise.all`s one `querySpaceRow` + `getSpaceUnreadCount` per space. On a pool:
- The N per-space detail queries dispatch to `hash(spaceDid) % N` workers. If the user's spaces hash to distinct workers, they run truly in parallel; if they collide onto one worker, they serialize exactly as today.
- `getSpaceUnreadCount` is itself two round-trips: read-state worker (read_positions) + pool worker (channels). These are independent per space and can overlap across spaces.

**`getActivityFeed` (no filter)** — reads joined-space DIDs from the global worker, then fans out one `activity_item` page per space to the pool, merges/sorts in JS. Same hash-distribution caveat. The merge is O(N log N) in JS for N spaces — negligible for the common <20-space case, but worth benchmarking at N=50.

**`openSpaceDbForEntity`** — global `entity_space` lookup (global worker) → per-space handle (pool worker). Two workers, two round-trips, but only one per-space request.

**`getSpaceUnreadCount`** — read-state worker + pool worker per space. Already cross-worker today (read-state is a separate file); the pool just moves the per-space half onto a pool worker.

**Embed sweeper** — global `pending_links` read (global worker) → per-space enrichment writes (pool workers). The write fan-out parallelizes across the pool.

**Key insight for evaluation:** the pool only helps a cross-space query if the spaces it touches are spread across workers. A user in 3 spaces that all hash to worker 0 sees no read-path speedup. So the *correctness* of cross-space queries must be verified independently of the *performance* win, and the performance win must be measured with realistic space sets, not a single space.

### Evaluation

#### 1. Correctness (must pass regardless of hash distribution)

- **Full suite on a pool.** The existing 466+ appserver tests run against an isolated single worker. Add a pool-aware test harness that boots N=2–4 workers and runs the same suite; every test must pass identically. This catches routing bugs (wrong worker, dropped route, cross-worker state leakage).
- **Cross-space equivalence.** For a fixed set of spaces, assert `getSpaces`, `getActivityFeed`, `getSpaceUnreadCount`, and `openSpaceDbForEntity` return byte-identical results whether the spaces land on one worker or spread across N. Concretely: run the query with N=1 (all on one worker) and N=4, and diff the outputs. This proves the pool doesn't change semantics — only scheduling.
- **Hash-collision stress.** Force a pathological case (a user whose spaces all hash to the same worker) and assert the cross-space queries still return correct results — just not faster. This is the "correctness independent of performance" guarantee.
- **Determinism.** Assert `hash(spaceDid) % N` is stable across two pool instantiations (same space → same worker index), so caches/prepared statements are actually reused.
- **Failure isolation.** Kill one pool worker mid-request; assert only the spaces pinned to it fail, other spaces' queries succeed, and the failed space recovers on the next request (re-materialize from the event log).

#### 2. Performance (the actual win)

- **Materialization throughput.** Extend `scripts/bench-materialize.ts` to run the same backfill with pool sizes 1, 2, 4, 8 and report events/sec and total wall time. This is the headline metric — the plan's problem statement is about materialization round-trips. Expect the biggest gain here because backfill writes are the round-trip-heavy path.
- **Cross-space fan-out latency.** Add a bench that seeds a user in N spaces (N = 5, 20, 50) and times `getSpaces` and `getActivityFeed` at pool sizes 1 vs 4. Report p50/p95/p99. This directly measures whether the fan-out parallelizes in practice.
- **Hash distribution.** Generate a realistic set of space DIDs (real `did:plc:*` values) and assert they distribute within ±20% of uniform across N workers. Flag pathological clustering (e.g. a prefix that collides) before it ships.
- **Round-trip count.** Instrument the pool to count worker round-trips per query and per materialized event; compare against the single-worker baseline (15–25/event today).

#### 3. Observability

- **Per-worker stats.** Expose per-worker queue depth, in-flight requests, round-trips, LRU cache hit rate, and evictions. Add a `/health/pool` endpoint (mirroring `/health/embed`, `/health/push`) so production can see whether the pool is actually spreading load or collapsing onto one worker.
- **Hash→worker map.** Log or expose the `spaceDid → worker` mapping so an operator can reason about why a given space is slow (is it alone on a hot worker?).

#### 4. Operational

- **Graceful pool-size change.** Changing N re-distributes spaces (caches re-warm). Verify a rolling restart with a different N doesn't corrupt or lose data — space DBs are on disk and independent, so this should be safe; the test is that reads after the change return correct data.
- **Rollback.** The pool is a pure scheduling change over the same on-disk per-space DBs. Rollback = stop, set N=1 (or revert to the single `WorkerLink`), restart. No data migration. Verify the single-worker path still works as a fallback.

### Risks

| Risk | Mitigation |
|---|---|
| **Cross-space fan-out doesn't parallelize** (user's spaces collide on one worker) | Correctness is unaffected; only speed. Measure hash distribution; if real DIDs cluster, switch to a better hash or a two-level scheme (e.g. hash on a per-space salt). |
| **Event-log worker becomes the backfill bottleneck** | Backfill replays streams with bounded concurrency (up to the pool size), so the event-log *reads* are still serialized per stream on the single event-log worker while the *writes* parallelize across the pool. If event-log reads dominate, consider sharding the event log (out of scope) or accepting the read-bound ceiling. |
| **More workers = more open file descriptors** | Per-worker LRU cap (default ~100) bounds open handles per worker; N workers × cap is the ceiling. Tune cap down if FD limits are hit. |
| **Worker crash takes out a space** | Each space DB is independent and re-materializable from the event log. Pool worker crash only affects spaces pinned to it; they recover on next access. |
| **Hash instability across restarts** | Use a stable hash (FNV-1a/xxhash over DID bytes), not a per-process seed. Changing N re-distributes but is safe (caches re-warm). |
| **Test harness churn** | The pool-aware harness reuses the existing isolated-worker test path; add a pool mode rather than rewriting tests. |



## Effort Estimate

| Phase | Files changed | New files | Estimated time |
|---|---|---|---|
| Prerequisite: event-back `leftSpace` | ~4 (SDK materialisers, appserver `SCHEMA_VERSION` bump, tests) | 0 | 1–2 days |
| Phase 1: Schema split + dual-write | ~20 | ~6 | 1–1.5 weeks |
| Phase 2: Cutover reads | ~15 | 0 | 3–5 days |
| Phase 3: Remove monolithic DB | ~10 | 0 | 1–2 days |
| Phase 4: Worker pool | ~6 (db.ts, pool.ts, worker.ts, asyncDatabase.ts, tests, bench) | 1 (pool.ts) | 3–5 days |
| **Total** | | | **2.5–4 weeks** |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Space DB file doesn't exist yet** | `openDb(spaceDid)` creates + initializes on first access. Materializer creates it before writing. |
| **Race: materializer writes while handler reads** | WAL mode allows concurrent readers. The pool worker serializes reads and writes for a space through its message queue. |
| **Too many open file descriptors** | LRU cache in each pool worker. Close least-recently-used DB handles when cache exceeds limit. |
| **Space DB gets corrupted** | Each space DB is independent. Recovery: delete the space DB file and re-materialize from the local event log (`reMaterializeFromLocalEvents` for that stream). The event-log DB is append-only and never wiped. |
| **Embed sweeper needs to scan all spaces** | Global `pending_links` index table, dual-written during materialization. |
| **Migration: existing monolithic DB** | Phase 1 dual-write populates per-space DBs gradually. On first access to each space, backfill from the monolithic DB. |
| **Test infrastructure churn** | Every test that seeds a DB needs to seed the per-space DB too. The `e2e/helpers.ts` seed functions are the bulk of the test churn. |
| **Global DB rebuild drops left-space history** | `leftSpace` edges are handler-only today; rebuilding the global DB from the event log loses them. Mitigated by the §Prerequisite (event-back `leftSpace` via the `space.leaveSpace`/`space.joinSpace` materialisers) before Phase 1's dual-write starts. |
