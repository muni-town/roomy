# Per-Space Database Architecture

**Date:** 2026-07-03
**Status:** Design / Proposed

## Problem

The appserver uses a single SQLite database (`data/roomy.sqlite`) accessed through a single `Bun.Worker` thread. Every query, materialization batch, auth check, and embed sweep serializes through one `postMessage` queue. The perf review (`docs/.llm.perf-review.md`) documents the impact:

- 15–25 worker round-trips per materialized event
- 1.5–2.5M round-trips for a 100k-event space backfill
- All spaces' materialization queues on the same worker
- All HTTP read queries serialize behind writes

The root cause: **one DB file, one worker thread**. Most queries are scoped to a single space and are independent. Only a small minority join across spaces.

## Proposal

Split the monolithic DB into:

1. **Per-space DBs** (`data/spaces/<spaceDid>.sqlite`) — the majority of materialized data, independently queryable
2. **Global DB** (`data/global.sqlite`) — cross-space data (personal stream resolution, membership edges)
3. **Read-state DB** (`data/roomy-readstate.sqlite`) — user-scoped state (read positions, thread activity) — already separate, stays as-is

A **worker pool** (N = 4–8, matching CPU cores) handles per-space DB requests. Hash-based routing ensures the same space always hits the same worker, enabling handle caching and prepared-statement reuse.

## Data Classification

### Per-space DB (moved)

| Table | Purpose |
|---|---|
| `entities` | All space entities (rooms, messages, users, roles) |
| `edges` | Member/admin/ban edges, role-room links, room links |
| `comp_space` | Space config, backfill cursor |
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

### Global DB (stays)

| Table | Purpose |
|---|---|
| `comp_user_personal_stream` | User DID → personal stream DID |
| `edges` (joinedSpace/leftSpace labels only) | Personal stream → space membership |
| `schema_version` | Migration tracking |

### Read-state DB (stays separate)

| Table | Purpose |
|---|---|
| `read_positions` | Per-user, per-room read position + unread count |
| `user_thread_activity` | Per-user, per-thread last activity timestamp |

## Cross-Space Queries (the minority)

These queries touch data across spaces and need special handling:

1. **`getSpaces`** — reads `edges` for `joinedSpace` from personal stream (global DB), then fans out to per-space DBs for name/avatar/unread count
2. **`getActivityFeed` (no space filter)** — reads `activity_item` across all joined spaces. Fan-out to per-space DBs, merge in JS
3. **`getSpaceUnreadCount`** — joins `read_positions` (read-state DB) with `entities.stream_id`. With per-space DBs, `stream_id` moves to per-space DBs. Solution: store `stream_id` in `read_positions` directly, or query per-space DB for entity existence
4. **`userHydration`** — reads `comp_user_personal_stream` (global) and `edges` for `joinedSpace` (global). Pure global-DB work
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
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Global DB worker (1)                               │  │
│  │    data/global.sqlite                               │  │
│  │    comp_user_personal_stream, edges (joinedSpace)   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Read-state DB worker (1)                           │  │
│  │    data/roomy-readstate.sqlite                      │  │
│  │    read_positions, user_thread_activity              │  │
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

## Phase 1: Schema Split + Dual-Write

**Goal**: Create the per-space DB infrastructure and dual-write all materialization to both the old monolithic DB and the new per-space DBs. No behaviour change — the monolithic DB remains the source of truth for reads. This phase is fully reversible.

### 1a. New Schema Files

#### `src/db/schema-space.sql`

The per-space schema is the current `schema.sql` minus cross-space tables. Specifically, it drops:

- `comp_user_personal_stream` (moves to global DB)
- The `joinedSpace`/`leftSpace` edge labels (moves to global DB — but the `edges` table itself stays, just without those labels)

Everything else stays: `entities`, `edges`, `comp_space`, `comp_room`, `comp_content`, `comp_info`, `comp_user`, `comp_reaction`, all embed tables, `comp_bans`, `comp_invite`, `roles`, `member_roles`, `role_rooms`, `activity_item`, `comp_calendar_*`, `comp_page_edits`, `comp_comment`, `comp_discord_origin`, `comp_last_read`.

The schema version is tracked independently per space DB (a `space_schema_version` table). This lets us evolve per-space schemas without forcing a global re-materialization.

#### `src/db/schema-global.sql`

```sql
create table if not exists global_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

create table if not exists comp_user_personal_stream (
  user_did text primary key,
  personal_stream_did text not null,
  resolved_at integer not null default (unixepoch() * 1000)
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

- `joinedSpace`/`leftSpace` edges (from `personalJoinSpace`/`personalLeaveSpace` events)
- `comp_user_personal_stream` (from personal stream resolution)

These writes need to go to the global DB instead of (or in addition to) the per-space DB. The materializer's `streamId` determines which DB to use: if `streamId` is a personal stream, the `joinedSpace`/`leftSpace` edges go to the global DB.

**Detection**: Check if `streamId` matches a known personal stream DID (from `comp_user_personal_stream`). Or simpler: always write `joinedSpace`/`leftSpace` edges to the global DB, and all other edge labels to the per-space DB. The materializer statements are opaque SQL — we need to route them based on the table being written.

**Routing approach**: The `applyBundle` function inspects each statement's SQL to determine the target DB:

```typescript
function targetDb(sql: string, mainDb: DbLike, spaceDb: DbLike, globalDb: DbLike): DbLike {
  if (sql.includes('comp_user_personal_stream')) return globalDb;
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
  personalStreamDid: StreamDid,
  options: SelectSpacesOptions = {},
): Promise<SpaceRow[]> {
  // Step 1: get space DIDs from global DB (as today)
  const spaceDids = await globalDb.query(`
    select tail from edges
    where head = ? and label = 'joinedSpace'
  `).all<{ tail: string }>([personalStreamDid]);

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

```typescript
export async function selectActivityFeed(
  globalDb: DbLike,
  userDid: string,
  personalStreamDid: string,
  scope: ActivityFeedScope,
): Promise<{ feed: ActivityFeedItem[]; cursor: string | null }> {
  // Step 1: get joined space DIDs from global DB
  const spaceDids = await globalDb.query(`
    select tail from edges where head = ? and label = 'joinedSpace'
  `).all<{ tail: string }>([personalStreamDid]);

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

The read-state DB (`read_positions`, `user_thread_activity`) stays separate. It's already in its own file and accessed through its own worker. No changes needed here.

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

3. **Dual-write from here on**: Once the per-space DB is populated, all subsequent materialization writes to both DBs.

### 1i. Rollback Plan

Phase 1 is fully reversible:

1. Stop the appserver
2. Delete the per-space DB directory (`data/spaces/`)
3. Delete the global DB (`data/global.sqlite`)
4. Restart with the old code

The monolithic DB is always kept in sync during Phase 1, so there's no data loss. The per-space DBs and global DB are derived data that can be regenerated.

---

## Phase 2: Cutover Reads

**Goal**: All per-space queries read from per-space DBs. Monolithic DB is read-only.

### Changes

1. **Handler reads switch to per-space DBs**: Every handler that currently reads from `openDb()` (monolithic) reads from `openDb(spaceDid)` (per-space) instead.

2. **Cross-space queries use global DB + fan-out**: `getSpaces`, `getActivityFeed` (no filter) use the fan-out pattern described above.

3. **Monolithic DB becomes read-only**: Remove all write paths to the monolithic DB. Keep it mounted for rollback safety.

4. **Remove dual-write from materializers**: `applyBatch` and `applyBundle` only write to the per-space DB.

5. **Remove global pending-links dual-write**: The embed sweeper reads from the global `pending_links` table (which is still dual-written during materialization). This is the one dual-write that stays — it's the sweeper's index, not a backup.

### Verification

Run the full test suite with the monolithic DB in read-only mode. All tests should pass without writing to the monolithic DB.

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

---

## Effort Estimate

| Phase | Files changed | New files | Estimated time |
|---|---|---|---|
| Phase 1: Schema split + dual-write | ~20 | ~6 | 1–1.5 weeks |
| Phase 2: Cutover reads | ~15 | 0 | 3–5 days |
| Phase 3: Remove monolithic DB | ~10 | 0 | 1–2 days |
| **Total** | | | **2–3 weeks** |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Space DB file doesn't exist yet** | `openDb(spaceDid)` creates + initializes on first access. Materializer creates it before writing. |
| **Race: materializer writes while handler reads** | WAL mode allows concurrent readers. The pool worker serializes reads and writes for a space through its message queue. |
| **Space DB gets corrupted** | Each space DB is independent. Recovery: delete the space DB file and re-materialize from Leaf. |
| **Too many open file descriptors** | LRU cache in each pool worker. Close least-recently-used DB handles when cache exceeds limit. |
| **Startup backfill with thousands of spaces** | Pool workers open space DBs on demand. Backfill concurrency is bounded by pool size. |
| **Embed sweeper needs to scan all spaces** | Global `pending_links` index table, dual-written during materialization. |
| **Migration: existing monolithic DB** | Phase 1 dual-write populates per-space DBs gradually. On first access to each space, backfill from the monolithic DB. |
| **Test infrastructure churn** | Every test that seeds a DB needs to seed the per-space DB too. The `e2e/helpers.ts` seed functions are the bulk of the test churn. |
