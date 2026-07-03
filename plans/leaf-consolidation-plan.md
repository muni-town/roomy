
## Phase 1: Events Database + Local Stream Creation + Direct Ingestion

### Goal
Eliminate Leaf dependency for event writes and stream creation. Events are stored in a **separate SQLite database** (`events.db`) from the materialized views (`roomy.sqlite`). This means the materialization DB can be safely wiped and re-derived from the events DB without data loss.

### Database Architecture

Three SQLite databases managed by the Bun.Worker:

| DB | File | Purpose | Schema versioned? |
|---|------|---------|-------------------|
| `main` | `data/roomy.sqlite` | Materialized views (entities, edges, comp_*) | Yes — `SCHEMA_VERSION` bump wipes + re-derives |
| `readstate` | `data/roomy-readstate.sqlite` | Per-user read state | Yes — `READSTATE_SCHEMA_VERSION` |
| `events` | `data/roomy-events.sqlite` | Raw event log (stream_events, stream_state) | **No** — append-only, never wiped |

The events DB is ATTACH'd to the main DB as `events` schema, so cross-DB queries work:
```sql
SELECT * FROM events.stream_events WHERE stream_id = ? ORDER BY idx;
```

### Files to Create

#### `packages/appserver/src/streams/StreamManager.ts` (NEW)
A replacement for `getConnectedSpace()` / `sendEventsToStream()` that:
- Writes events directly to `events.stream_events` table
- Materializes inline via `applyBatch()`
- Emits invalidation signals via the router
- Creates new streams locally (generates DID, writes seed events)

```typescript
// Core API:
export class StreamManager {
  constructor(db: DbLike, invalidationRouter?: InvalidationRouter)
  
  // Send events to a stream (write + materialize + invalidate)
  async sendEvents(streamDid: StreamDid, events: Event[], userOverride?: string): Promise<void>
  
  // Create a new stream locally
  async createStream(adminDid: UserDid): Promise<StreamDid>
  
  // Get the latest event index for a stream
  async getLatestEventIdx(streamDid: StreamDid): Promise<StreamIndex>
}
```

**`sendEvents()` implementation:**
1. Encode each event to CBOR bytes
2. Assign sequential `idx` values (SELECT COALESCE(MAX(idx), -1) + 1 FROM events.stream_events WHERE stream_id = ?)
3. INSERT into `events.stream_events` (stream_id, idx, user, payload, signature)
4. Decode events back to `DecodedStreamEvent[]`
5. Call `ensureProfilesForBatch()`
6. Call `applyBatch()` to materialize
7. Call `invalidationRouter.onEventsApplied()` for live events
8. Call `pokeEmbedSweeper()` for createMessage events

**`createStream()` implementation:**
1. Call `createStreamDid(appserverDid, appserverUrl, signingKey)` to register a new DID PLC
2. Insert space entity row: `INSERT INTO entities (id, stream_id) VALUES (?, ?)`
3. Write addAdmin event to events.stream_events
4. Call `sendEvents()` with the seed events from `createDefaultSpaceEvents()`
5. Return the new stream DID

#### `packages/appserver/src/db/eventsSchema.sql` (NEW)
Schema for the events database (never wiped, append-only):
```sql
-- Raw event log. One row per event per stream.
-- NEVER delete or modify rows — this is the source of truth.
create table if not exists stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    primary key (stream_id, idx)
) strict;

create index if not exists idx_stream_events_stream_id 
    on stream_events (stream_id, idx);

-- Per-stream metadata (latest event idx, etc.)
create table if not exists stream_state (
    stream_id text primary key,
    latest_event integer not null default 0
) strict;
```

### Files to Modify

#### `packages/appserver/src/db/types.ts`
Add `eventsDbPath` to `initOpts` (no version — events DB is append-only, never wiped):
```typescript
initOpts?: {
  mainDbPath?: string;
  readStateDbPath?: string;
  eventsDbPath?: string;
  schemaVersion?: string;
  readStateSchemaVersion?: string;
};
```

#### `packages/appserver/src/streams/did.ts` (NEW)
DID creation via PLC directory using `@did-plc/lib`:
```typescript
import { StreamDid } from "@roomy-space/sdk";
import { createOp } from "@did-plc/lib";
import type { Keypair } from "@atproto/crypto";

const PLC_DIRECTORY = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

/**
 * Create a new DID PLC for a stream, registered with the PLC directory.
 * Mirrors Leaf's `create_did()` in `leaf-server/src/did.rs`.
 *
 * The signing key is the appserver's own key (initialized at startup).
 * The key is NOT stored per-stream — the appserver doesn't sign events
 * (Leaf's signatures were never used). The DID document includes a
 * service endpoint pointing at the appserver.
 */
export async function createStreamDid(
  appserverDid: string,
  appserverUrl: string,
  signingKey: Keypair,
): Promise<StreamDid> {
  const { op, did } = await createOp({
    signingKey: signingKey.did(),
    handle: "",
    pds: appserverUrl,
    rotationKeys: [signingKey.did()],
    signer: signingKey,
  });

  const resp = await fetch(`${PLC_DIRECTORY}/${did}`, {
    method: "POST",
    body: JSON.stringify(op),
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`PLC directory error: ${resp.status}: ${await resp.text()}`);
  }

  return StreamDid.assert(did);
}
```

**Dependencies to add:** `@did-plc/lib` to `packages/appserver/package.json`. The appserver already depends on `@atproto/api` which transitively provides `@atproto/crypto` (needed for `Keypair`).

**Signing key initialization:** The appserver needs a signing key at startup. This should be loaded from env or generated once and cached:
```typescript
// In appserver.ts or index.ts:
import { EcdsaKeypair } from "@atproto/crypto";
const signingKey = await EcdsaKeypair.create();
```
The key is used only for PLC DID creation (signing genesis operations). It is NOT used for event signing.

**Risk:** PLC directory availability. If the PLC directory is unreachable when creating a stream, space creation fails. Mitigation: retry with backoff, or fall back to `did:web:` for local/dev environments.

#### `packages/appserver/src/db/worker.ts`
Add events DB handling alongside the existing `mainDb` and `readStateDb`:

1. Add `let eventsDb: Database | null = null;` in the state section
2. In `handleInit()`:
   - Open `eventsDb` at `opts.eventsDbPath ?? "data/roomy-events.sqlite"`
   - Apply `eventsSchema.sql` (no version check — never wiped)
   - ATTACH to mainDb: `mainDb.exec("attach database '...' as events")`
3. No new request types needed — the events DB is accessed via the `events.` prefix on SQL queries through the main DB connection

#### `packages/appserver/src/db/db.ts`
Add events DB path (no version — events DB is append-only, never wiped):
```typescript
export function openDb(opts: OpenDbOptions = {}): AsyncDatabase {
  // ...
  db.init({
    mainDbPath: path,
    readStateDbPath: process.env.READSTATE_DB_PATH ?? "data/roomy-readstate.sqlite",
    eventsDbPath: process.env.EVENTS_DB_PATH ?? "data/roomy-events.sqlite",
    schemaVersion: SCHEMA_VERSION,
    readStateSchemaVersion: READSTATE_SCHEMA_VERSION,
  });
  // ...
}
```

**Do NOT bump `SCHEMA_VERSION`.** The materialization DB is unchanged. The events DB is new and additive.

#### `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts`
Replace the Leaf proxy with direct ingestion:

| Change | Detail |
|--------|--------|
| Remove import | `sendEventsToStream` from `../serviceClient.ts` |
| Remove import | `getOrCreateMaterializer` from `../materialization/registry.ts` |
| Add import | `StreamManager` from `../streams/StreamManager.ts` |
| Replace line 95 | `await sendEventsToStream(...)` → `await streamManager.sendEvents(...)` |
| Remove lines 97-104 | Fire-and-forget `getOrCreateMaterializer()` call (materialization is synchronous now) |
| Add | Get `StreamManager` instance (singleton, similar to `openDb()`) |

New flow:
1. Validate input (unchanged)
2. Check auth (unchanged)
3. Validate + authorize each event (unchanged)
4. Write to `events.stream_events` + materialize inline via `StreamManager.sendEvents()`
5. Return

#### `packages/appserver/src/handlers/space.roomy.space.createSpace.ts`
Replace Leaf stream creation with local creation:

| Change | Detail |
|--------|--------|
| Remove import | `getServiceClient, getConnectedSpace` from `../serviceClient.ts` |
| Remove import | `getOrCreateMaterializer` from `../materialization/registry.ts` |
| Add import | `StreamManager` from `../streams/StreamManager.ts` |
| Add import | `createStreamDid` from `../streams/did.ts` |
| Replace lines 105-107 | `client.createSpace()` → `streamManager.createStream(callerDid)` |
| Replace lines 124, 127-133 | `space.sendEvents()` / `space.sendEvent()` → `streamManager.sendEvents()` |
| Replace lines 153-161 | `personalSpace.sendEvent()` → `streamManager.sendEvents()` |
| Replace lines 171-174 | `getOrCreateMaterializer()` + `await mat.backfillDone` → remove (materialization is inline) |
| Replace lines 178-179 | `getOrCreateMaterializer(personalStreamDid).drain()` → remove |
| Keep lines 182-199 | Direct invalidation signal emission (still needed) |

New flow:
1. Validate input (unchanged)
2. Create stream locally via `StreamManager.createStream()` (generates DID, writes addAdmin event)
3. Write seed events via `StreamManager.sendEvents()`
4. Write joinSpace event via `StreamManager.sendEvents()`
5. Write personal.joinSpace to personal stream via `StreamManager.sendEvents()`
6. Record membership in local DB (unchanged)
7. Emit direct invalidation signal (unchanged)

#### `packages/appserver/src/handlers/space.roomy.space.joinSpace.ts`
Replace `getConnectedSpace()` with `StreamManager`:

| Change | Detail |
|--------|--------|
| Remove import | `getConnectedSpace` from `../serviceClient.ts` |
| Add import | `StreamManager` from `../streams/StreamManager.ts` |
| Replace lines 145, 156 | `getConnectedSpace().sendEvent()` → `streamManager.sendEvents()` |

#### `packages/appserver/src/handlers/space.roomy.space.leaveSpace.ts`
Same pattern as joinSpace.

#### `packages/appserver/src/handlers/space.roomy.admin.connectSpace.ts`
Replace `getConnectedSpace().fetchRooms()` with direct SQL query:

| Change | Detail |
|--------|--------|
| Remove import | `getConnectedSpace, getServiceClient` |
| Add import | `openDb` from `../db/db.ts` |
| Replace lines 45-47 | Query `comp_room` + `comp_info` directly via SQL |
| Replace line 49 | Return hardcoded or DB-derived `serviceDid` |

The `fetchRooms()` call returns `{ id, name, kind, deleted, parent }`. This can be replaced with:
```sql
SELECT r.entity as id, i.name, r.label as kind, r.deleted, null as parent
FROM comp_room r
LEFT JOIN comp_info i ON i.entity = r.entity
WHERE r.entity IN (SELECT id FROM entities WHERE stream_id = ?)
```

#### `packages/appserver/src/handlers/space.roomy.admin.materializeSpace.ts`
After Phase 1, materialization is inline — there's no async backfill to wait for. Simplify:

| Change | Detail |
|--------|--------|
| Remove import | `getOrCreateMaterializer` from `../materialization/registry.ts` |
| Remove import | `readBackfilledTo` from `../materialization/SpaceMaterializer.ts` |
| Replace body | Query `events.stream_state.latest_event` for cursor, query `comp_space.backfilled_to` for backfill status |
| Remove | `mat.drain()`, `mat.getStats()`, `mat.close()` calls |

New implementation: read cursor from `events.stream_state`, read stats from materialized tables directly.

#### `packages/appserver/src/index.ts`
The startup backfill currently:
1. Lists streams from Leaf via `serviceClient.listStreams()`
2. Creates a `SpaceMaterializer` for each (subscribes to Leaf for backfill)

After Phase 1, Leaf still exists for existing streams, but new streams are created locally. The backfill should:
- **During transition (Phase 1-2):** Keep the Leaf-based backfill for existing streams that have events only in Leaf. New streams (created after Phase 1 deploy) have events in `events.stream_events` and don't need backfill.
- **After migration (Phase 3+):** Remove the Leaf-based backfill entirely.

For Phase 1, the backfill logic stays but should skip streams that already have events in `events.stream_events` (check `events.stream_state.latest_event > 0`).

| Change | Detail |
|--------|--------|
| Add check in `startupBackfill` | Skip streams where `events.stream_state.latest_event > 0` |
| Keep Leaf-based backfill | For streams that still need it |

#### `packages/appserver/src/materialization/registry.ts`
The `getOrCreateMaterializer()` function creates a `SpaceMaterializer` that subscribes to Leaf. After Phase 1, new streams don't need this — their events are materialized inline. But existing streams still need the Leaf subscription for backfill.

For Phase 1, keep the registry as-is. It will be removed in Phase 4.

### Dependencies
- None — this is the first phase.

### Rationale
- **Separate events DB** means the materialization DB can be safely wiped and re-derived from the event log without data loss. This is the key architectural improvement over the current Leaf setup.
- Events must be stored somewhere before they can be materialized. The `events.stream_events` table is that store.
- Stream creation must be local because Leaf won't be available after decommissioning.
- Inline materialization eliminates the race between write and subscription.
- The `StreamManager` provides a single abstraction for all event writing, replacing both `sendEventsToStream()` and `getConnectedSpace().sendEvent()`.
### Known Gaps
- **Transaction atomicity**: `StreamManager.sendEvents()` writes to the events DB then calls `applyBatch()` on the main DB. These are separate transactions on different connections. If materialization fails after the event write, the event is persisted but not materialized. This is acceptable — the event is safe in the events DB, and re-materialization on next boot catches it. The alternative (two-phase commit across SQLite files) is not worth the complexity.
- **Backup priority**: Three DB files now. The events DB is the critical source of truth. The materialization DB is re-derivable from events. Backup strategy should prioritize `roomy-events.sqlite`.
- **Re-materialization performance**: On schema version bump, the appserver re-materializes every stream from the events DB. For large deployments this could take minutes. Consider batching with progress reporting, or making re-materialization async (server starts serving before it completes).

### Test Strategy

#### New Tests
1. **`packages/appserver/src/streams/StreamManager.test.ts`**
   - `sendEvents()` writes to `events.stream_events` table
   - `sendEvents()` materializes events (check `entities`, `comp_content`, etc.)
   - `sendEvents()` emits invalidation signals
   - `sendEvents()` assigns sequential idx values
   - `createStream()` generates a valid `StreamDid`
   - `createStream()` writes addAdmin event
   - `createStream()` returns a stream that can receive events

2. **`packages/appserver/src/streams/did.test.ts`**
   - `createStreamDid()` registers a new DID PLC
   - Generated DIDs are unique

#### Modified Tests
3. **`packages/appserver/src/e2e/endpoints.test.ts`**
   - `sendEvents` test: change to verify events appear in `events.stream_events` and materialized tables, not that they were sent to Leaf
   - `createSpace` test: change to verify local stream creation, not Leaf stream creation
   - `connectSpace` test: change to use direct SQL instead of `fetchRooms()`
   - `materializeSpace` test: change to read from `events.stream_state` instead of `SpaceMaterializer`

4. **`packages/appserver/src/handlers/space.roomy.space.sendEvents.test.ts`** (create if not exists)
   - Events are written to `events.stream_events`
   - Events are materialized
   - Invalidation signals are emitted
   - Auth checks still work

#### Running Tests
```bash
cd packages/appserver && bun test src/streams/  # new tests
cd packages/appserver && bun test src/e2e/endpoints.test.ts  # modified e2e
cd packages/appserver && bun test  # full suite (~240 tests)
```

---

## Phase 2: Replace ConnectedSpace Queries with Direct SQL

### Goal
Eliminate all Leaf query dependencies from the appserver. All data reads go directly to the materialized SQLite tables.

### Files to Modify

#### `packages/appserver/src/handlers/space.roomy.admin.connectSpace.ts`
Already modified in Phase 1 to use direct SQL. Verify the SQL query is correct.

#### `packages/appserver/src/handlers/space.roomy.admin.materializeSpace.ts`
Already modified in Phase 1. Verify.

#### `packages/appserver/src/materialization/SpaceMaterializer.ts`
This file currently depends on `ConnectedSpace.subscribe()` for backfill. After Phase 2, backfill from Leaf is still needed for existing streams, but the subscription mechanism should be abstracted.

For Phase 2, keep `SpaceMaterializer` as-is but add a note that it will be removed in Phase 4.

#### `packages/appserver/src/serviceClient.ts`
This file manages the Leaf service client singleton and the `ConnectedSpace` cache. After Phase 2:
- `getServiceClient()` — still needed for startup backfill (Phase 1-2 transition)
- `getConnectedSpace()` — still needed for startup backfill
- `sendEventsToStream()` — replaced by `StreamManager.sendEvents()` in Phase 1

Keep the file but mark `getConnectedSpace()` and `sendEventsToStream()` as deprecated. They'll be removed in Phase 4.

### Dependencies
- Phase 1 must be complete (events table + StreamManager exist).

### Rationale
- The appserver already reads from materialized tables for all XRPC query handlers (getSpaces, getMessages, getRoles, etc.). The only remaining Leaf queries are in `connectSpace.ts` (admin diagnostic) and `materializeSpace.ts` (admin diagnostic).
- Replacing these with direct SQL is straightforward and eliminates the last Leaf read dependency from the appserver.

### Test Strategy
- Run the full appserver test suite. All existing tests should pass because they already use direct SQL for queries.
- Verify `connectSpace` admin endpoint returns correct data.
- Verify `materializeSpace` admin endpoint returns correct data.

---

## Phase 3: Migration Script

### Goal
Copy all events from Leaf per-stream SQLite databases into the appserver's `events` database, then bump `SCHEMA_VERSION` to trigger full re-materialization from the local event log.

### Key Insight: Separate Events DB Simplifies Migration
Because events live in their own database (`data/roomy-events.sqlite`), the migration script writes directly to that file. The materialization DB (`data/roomy.sqlite`) is then wiped and re-derived on next boot via the schema version mismatch. No risk of accidentally corrupting the events DB.

### Files to Create

#### `packages/appserver/scripts/migrate-from-leaf.ts` (NEW)
One-time migration script:

```typescript
// Usage: bun run scripts/migrate-from-leaf.ts [--dry-run]
//
// 1. Iterates all Leaf stream DBs at data/streams/{did}/stream.db
// 2. Reads events table rows
// 3. Inserts into appserver's events DB (stream_events table)
// 4. Sets stream_state.latest_event
// 5. Updates comp_space.backfilled_to in the main DB
// 6. Bumps SCHEMA_VERSION in the main DB to trigger re-materialization on next boot

interface LeafEvent {
  idx: number;
  user: string;
  payload: Uint8Array;
  signature: Uint8Array;
}

async function migrateStream(
  eventsDb: Database,
  mainDb: Database,
  streamDid: string,
  leafDbPath: string,
  dryRun: boolean,
): Promise<{ eventsMigrated: number; latestIdx: number }> {
  // 1. Open Leaf stream DB
  const leafDb = new Database(leafDbPath);
  
  // 2. Read all events ordered by idx
  const events = leafDb.query(`
    SELECT idx, user, payload, signature 
    FROM events 
    ORDER BY idx
  `).all() as LeafEvent[];
  
  if (events.length === 0) {
    leafDb.close();
    return { eventsMigrated: 0, latestIdx: 0 };
  }
  
  const latestIdx = events[events.length - 1].idx;
  
  // 3. Insert into events DB (use INSERT OR IGNORE for idempotency)
  if (!dryRun) {
    const insert = eventsDb.prepare(`
      INSERT OR IGNORE INTO stream_events (stream_id, idx, user, payload, signature)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const tx = eventsDb.transaction(() => {
      for (const event of events) {
        insert.run(streamDid, event.idx, event.user, event.payload, event.signature);
      }
    });
    tx();
    
    // 4. Update stream_state in events DB
    eventsDb.run(`
      INSERT INTO stream_state (stream_id, latest_event)
      VALUES (?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET latest_event = excluded.latest_event
    `, [streamDid, latestIdx]);
    
    // 5. Update comp_space.backfilled_to in main DB
    mainDb.run(`
      UPDATE comp_space SET backfilled_to = ? WHERE entity = ?
    `, [latestIdx, streamDid]);
  }
  
  leafDb.close();
  return { eventsMigrated: events.length, latestIdx };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const leafDataDir = process.env.LEAF_DATA_DIR ?? 'data/streams';
  const eventsDbPath = process.env.EVENTS_DB_PATH ?? 'data/roomy-events.sqlite';
  const mainDbPath = process.env.APPSERVER_DB_PATH ?? 'data/roomy.sqlite';
  
  // 1. Open both appserver DBs
  const eventsDb = new Database(eventsDbPath);
  const mainDb = new Database(mainDbPath);
  
  // 2. Discover Leaf stream DBs
  const streamDirs = fs.readdirSync(leafDataDir);
  let totalEvents = 0;
  let totalStreams = 0;
  
  for (const dir of streamDirs) {
    const streamDbPath = join(leafDataDir, dir, 'stream.db');
    if (!fs.existsSync(streamDbPath)) continue;
    
    const result = await migrateStream(eventsDb, mainDb, dir, streamDbPath, dryRun);
    totalEvents += result.eventsMigrated;
    totalStreams++;
    
    console.log(`[${dryRun ? 'DRY-RUN' : 'MIGRATED'}] ${dir}: ${result.eventsMigrated} events (latest idx: ${result.latestIdx})`);
  }
  
  console.log(`\nTotal: ${totalStreams} streams, ${totalEvents} events`);
  
  if (!dryRun) {
    // 6. Bump SCHEMA_VERSION in the main DB so next boot re-materializes
    // Set to a version that won't match the code, triggering a wipe + re-derive
    mainDb.run(`
      INSERT INTO roomy_schema_version (id, version) 
      VALUES (1, 'MIGRATION_PENDING')
      ON CONFLICT(id) DO UPDATE SET version = 'MIGRATION_PENDING'
    `);
    console.log('Schema version set to MIGRATION_PENDING — re-materialization will happen on next boot');
  }
  
  eventsDb.close();
  mainDb.close();
}

main().catch(console.error);
```

### Files to Modify

#### `packages/appserver/src/db/db.ts`
Bump `SCHEMA_VERSION` from `"10-appserver.4"` to `"10-appserver.5"`:
```typescript
export const SCHEMA_VERSION = "10-appserver.5";
```

This bump triggers full re-materialization from `events.stream_events` on next boot. The migration script sets the DB version to `"MIGRATION_PENDING"` which won't match `"10-appserver.5"`, so the appserver wipes the materialization DB and re-derives.

**Migration sequence:**
1. Stop appserver
2. Run migration script (copies events to events DB, sets main DB version to `MIGRATION_PENDING`)
3. Start new appserver version (detects schema mismatch, wipes materialized views, re-materializes from events DB)

#### `packages/appserver/src/index.ts`
Add local re-materialization on boot after schema initialization:

```typescript
async function reMaterializeFromLocalEvents(appDb: AsyncDatabase): Promise<void> {
  // Get all streams that have events
  const streams = await appDb.query(`
    SELECT DISTINCT stream_id FROM events.stream_events ORDER BY stream_id
  `).all<{ stream_id: string }>();
  
  for (const { stream_id } of streams) {
    const events = await appDb.query(`
      SELECT idx, user, payload FROM events.stream_events 
      WHERE stream_id = ? ORDER BY idx
    `).all(stream_id);
    
    // Decode CBOR payloads
    const decodedEvents = events.map(e => ({
      idx: e.idx,
      event: parseEvent(decode(e.payload)),
      user: e.user,
    }));
    
    // Materialize in batches
    await applyBatch(appDb, stream_id, decodedEvents, { isBackfill: true });
  }
}
```

This runs after schema initialization but before the server starts accepting requests. It replaces the old Leaf-based startup backfill.

### Dependencies
- Phase 1 and 2 must be complete (events DB exists, StreamManager works).
- Leaf server must still be running (to read its DB files).

### Rationale
- The migration is a one-time data copy, not a live sync.
- After migration, the appserver's `events` database is the authoritative event store.
- The `SCHEMA_VERSION` bump ensures all materialized views are rebuilt from the local event log, catching any drift between the old Leaf-based materialization and the new local materialization.
- **Separate events DB means the migration script writes to a different file than the materialization DB** — no risk of corrupting the materialized views during the copy.

### Test Strategy

#### New Tests
1. **`packages/appserver/scripts/__tests__/migrate-from-leaf.test.ts`**
   - Create a mock Leaf stream DB with known events
   - Run migration script in dry-run mode (verify no writes)
   - Run migration script (verify events are copied to events DB)
   - Run migration script again (verify idempotency — INSERT OR IGNORE)
   - Verify `stream_state` is updated in events DB
   - Verify `comp_space.backfilled_to` is updated in main DB
   - Verify schema version is bumped in main DB

#### Manual Verification
1. On staging: stop appserver, run migration script, start appserver, verify all spaces are accessible
2. Compare event counts between Leaf and appserver events DB
3. Verify materialized data matches (spot-check rooms, messages, reactions)

---

## Phase 4: Strip Leaf Dependencies

### Goal
Remove all Leaf-related code from the SDK, appserver, and discord-bridge. The appserver is fully self-contained.

### SDK Changes

#### Files to Delete
- `packages/sdk/src/leaf/` — entire directory (Leaf client factory)
- `packages/sdk/src/modules/` — entire directory (WASM module definitions)
- `packages/sdk/src/connection/ConnectedSpace.ts` — entire file (Leaf-connected space)
- `packages/sdk/src/connection/types.ts` — can delete or gut to just `DecodedStreamEvent` and `EventCallback` types
- `packages/sdk/src/connection/sqlParsing.ts` — Leaf SQL row parsing

#### Files to Modify

##### `packages/sdk/src/connection/index.ts`
Remove `ConnectedSpace` export. Keep only types that are still needed:
```typescript
export type { DecodedStreamEvent, EventCallback, EventCallbackMeta, EncodedStreamEvent } from "./types";
```

##### `packages/sdk/src/client/RoomyClientBase.ts`
Remove `leaf: LeafClient` field and all methods that use it (`getSpaceInfo`, `setHandle`, `resolveHandleFromLeafDid`). The base class becomes a simple abstract class with just `plcDirectory`.

```typescript
export abstract class RoomyClientBase {
  readonly plcDirectory: string;
  
  protected constructor(config: { plcDirectory?: string }) {
    this.plcDirectory = config.plcDirectory ?? DEFAULT_PLC_DIRECTORY;
  }
}
```

##### `packages/sdk/src/client/RoomyServiceClient.ts`
Remove `ConnectedSpace` import and `connectSpace()`/`createSpace()` methods. Remove `LeafClient` import. The service client becomes a profile-fetching utility only.

```typescript
export class RoomyServiceClient {
  readonly serviceDid: string;
  
  // Only keep: getProfiles(), listStreams() → remove (no Leaf to list from)
  // Actually, listStreams() is only used by appserver startup backfill, which is removed in Phase 4
}
```

Actually, `RoomyServiceClient` is only used by the appserver. After Phase 4, the appserver doesn't need it at all. We can delete the entire class and replace it with a simple profile fetcher.

##### `packages/sdk/src/client/RoomyClient.ts`
Remove `ConnectedSpace` import and `connectPersonalSpace()`/`connectSpace()` methods. Remove `LeafClient` import. The client becomes an ATProto-only client.

##### `packages/sdk/src/client/RoomyClientBase.ts`
Remove `LeafClient` dependency entirely.

##### `packages/sdk/src/client/index.ts`
Update exports to remove deleted classes.

##### `packages/sdk/src/index.ts`
Remove `export * from "./leaf"`, `export * from "./modules"`, update `export * from "./connection"` to only export types.

##### `packages/sdk/src/operations/message.ts`
Remove `ConnectedSpace` parameter from `createMessage()`, `editMessage()`, `deleteMessage()`, `reorderMessage()`, `forwardMessages()`. These functions should take a `sendEvents` callback instead, or the caller should construct and send events directly.

Actually, looking at the operations more carefully:
- `createMessage()` builds events and calls `space.sendEvents(events)` at the end
- `editMessage()` same pattern
- `deleteMessage()` same pattern
- `reorderMessage()` same pattern
- `forwardMessages()` same pattern

These can be refactored to return `Event[]` instead of sending them, letting the caller handle sending. But that's a breaking change for the SDK.

**Alternative:** Keep the operations but change them to accept a `sendEvents: (events: Event[]) => Promise<void>` callback instead of `ConnectedSpace`. This is backward-compatible if we keep the old signature as a deprecated overload.

For the initial cut, the simplest approach:
- `createMessage()` returns `Event[]` (the events to send)
- Caller sends them via XRPC or StreamManager

But this is a significant API change. Let's keep the operations as-is for now and just remove the `ConnectedSpace` type dependency by making them accept a generic `{ sendEvents(events: Event[]): Promise<void> }` interface.

##### `packages/sdk/src/operations/reaction.ts`
Same pattern as message.ts.

##### `packages/sdk/package.json`
Remove `@muni-town/leaf-client` from dependencies.

### Appserver Changes

#### Files to Delete
- `packages/appserver/src/serviceClient.ts` — Leaf service client singleton
- `packages/appserver/src/materialization/SpaceMaterializer.ts` — Leaf subscription-based materializer
- `packages/appserver/src/materialization/registry.ts` — materializer cache (replaced by StreamManager)

#### Files to Modify

##### `packages/appserver/src/index.ts`
Remove startup backfill entirely. After migration, all events are in `stream_events` and materialization happens inline.

New startup flow:
1. Create appserver (DB, routes, WebSocket)
2. Log startup complete
3. No backfill needed

```typescript
// Remove: import { getServiceClient } from "./serviceClient.ts";
// Remove: import { getOrCreateMaterializer, removeMaterializer } from "./materialization/registry.ts";
// Remove: entire startupBackfill() function
// Remove: BACKFILL_MODE, BACKFILL_CONCURRENCY, etc. env vars
// Remove: if (BACKFILL_MODE === "lazy") { ... } else { startupBackfill(app)... }
```

##### `packages/appserver/src/appserver.ts`
Remove `backfillMode` from `AppserverOptions` and `BackfillStatus` from the handle. The `backfillStatus` field on `AppserverHandle` can be removed or simplified to always report "done".

##### `packages/appserver/src/materialization/profiles.ts`
Change the default `GetProfilesFn` to use direct bsky appview calls instead of `RoomyServiceClient.getProfiles()`:

```typescript
const defaultGetProfiles: GetProfilesFn = async (dids: UserDid[]) => {
  // Direct bsky appview call, no Leaf dependency
  const url = `https://api.bsky.app/app/bsky.actor/getProfiles?actors=${dids.join(',')}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return data.profiles;
};
```

##### `packages/appserver/src/materialization/applyBatch.ts`
No changes needed — this is the core materialization pipeline and doesn't depend on Leaf.

##### `packages/appserver/src/handlers/space.roomy.space.createSpace.ts`
Already updated in Phase 1 to use `StreamManager`. Verify no remaining Leaf dependencies.

##### `packages/appserver/src/handlers/space.roomy.space.joinSpace.ts`
Already updated in Phase 1.

##### `packages/appserver/src/handlers/space.roomy.space.leaveSpace.ts`
Already updated in Phase 1.

##### `packages/appserver/src/handlers/space.roomy.admin.connectSpace.ts`
Already updated in Phase 2.

##### `packages/appserver/src/handlers/space.roomy.admin.materializeSpace.ts`
Already updated in Phase 1.

##### `packages/appserver/src/e2e/helpers.ts`
Remove `instantSpace()`, `preWarmPersonalMaterializer()`, `preWarmSpaceMaterializer()` — these create fake `ConnectedSpaceLike` objects that are no longer needed.

Replace with direct DB seeding for tests.

##### `packages/appserver/package.json`
Remove `@muni-town/leaf-client` from dependencies.

### Discord-Bridge Changes

#### Files to Modify

##### `packages/discord-bridge/src/roomy/space-manager.ts`
Replace `ConnectedSpace.connect()` with XRPC-based communication:

```typescript
import { DirectXrpcClient, ServiceAuthClient } from "@roomy-space/sdk";
import type { RoomyClient } from "@roomy-space/sdk";

export class SpaceManager {
  #xrpc: DirectXrpcClient;
  #spaces = new Map<string, { streamDid: string }>();
  
  constructor(client: RoomyClient, appserverUrl: string, appserverDid: string) {
    const serviceAuth = new ServiceAuthClient(client.agent);
    this.#xrpc = new DirectXrpcClient(appserverUrl, appserverDid, serviceAuth);
  }
  
  async getOrConnect(spaceDid: string): Promise<{ streamDid: string }> {
    // No need to "connect" anymore — just validate the space exists
    // by querying the appserver
    const existing = this.#spaces.get(spaceDid);
    if (existing) return existing;
    
    // Verify space exists via XRPC
    await this.#xrpc.query("space.roomy.space.getMetadata", { space: spaceDid });
    
    const entry = { streamDid: spaceDid };
    this.#spaces.set(spaceDid, entry);
    return entry;
  }
}
```

##### `packages/discord-bridge/src/roomy/live-gateway.ts`
Replace `ConnectedSpace.sendEvents()` with XRPC `space.roomy.space.sendEvents`:

```typescript
async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
  await this.#xrpc.procedure("space.roomy.space.sendEvents", {
    spaceId: spaceDid,
    events: events.map(e => ({ ...e })), // serialize
  });
}
```

Replace `ConnectedSpace.subscribe()` with appserver WebSocket sync:

```typescript
async subscribe(spaceDid: string, callback: RoomyEventCallback): Promise<void> {
  // Use the SDK's SyncConnection to subscribe to appserver sync
  const connection = new SyncConnection({
    url: this.#appserverWsUrl,
    getTicket: async () => {
      const { ticket } = await this.#xrpc.query("space.roomy.auth.getConnectionTicket", {});
      return ticket;
    },
  });
  
  connection.subscribe({ kind: "space", id: spaceDid });
  connection.onFrame((frame) => {
    // Decode frame and invoke callback
    // ...
  });
}
```

##### `packages/discord-bridge/src/roomy/client.ts`
Remove `ConnectedSpace` and `modules` imports. The `RoomyClient` initialization no longer needs Leaf config.

##### `packages/discord-bridge/package.json`
Remove `@muni-town/leaf-client` from dependencies.

### Dependencies
- Phase 3 must be complete (migration done, Leaf decommissioned).
- All appserver handlers must work without Leaf.

### Rationale
- After migration, Leaf is no longer needed. All its functionality is replaced by the appserver's local event store and materialization pipeline.
- Removing Leaf dependencies simplifies the codebase, reduces maintenance burden, and eliminates a network dependency.
- The SDK breaking changes are managed by keeping backward-compatible type exports where possible.

### Test Strategy

#### SDK Tests
```bash
cd packages/sdk && bun test
```
Expected: some tests may fail if they depend on `ConnectedSpace` or `modules`. These tests need updating:
- `tests/operations/message.test.ts` — uses `ConnectedSpace`
- `tests/operations/reaction.test.ts` — uses `ConnectedSpace`
- `tests/operations/room.test.ts` — may use `ConnectedSpace`
- `tests/connection/backfill-timeout.test.ts` — tests `ConnectedSpace` backfill timeout

#### Appserver Tests
```bash
cd packages/appserver && bun test
```
Expected: all ~240 tests pass. The e2e tests use `startAppserver()` with `backfillMode: "disabled"` which already skips Leaf.

#### Discord-Bridge Tests
```bash
cd packages/discord-bridge && bun test
```
Expected: tests that use `MockRoomyGateway` should pass unchanged. Tests that use `LiveRoomyGateway` need updating.

---

## Migration Strategy

### Pre-Migration Checklist
1. [ ] Verify Leaf server is healthy and all streams are accessible
2. [ ] Verify appserver is healthy and all materialized views are current
3. [ ] Take a backup of the appserver SQLite DB
4. [ ] Take a backup of Leaf's data directory (`data/streams/`)
5. [ ] Note the current `SCHEMA_VERSION` in production

### Migration Steps

#### Step 1: Deploy Phase 1 + Phase 2 code
- Deploy new appserver version with `stream_events` table, `StreamManager`, and updated handlers
- The new `stream_events` table is additive — existing materialized views are unaffected
- Leaf is still running; existing streams still backfill from Leaf
- New streams are created locally (no Leaf dependency for writes)
- **Verification:** All XRPC endpoints work. New spaces can be created. Events can be sent.

#### Step 2: Run migration script
```bash
# Stop appserver
bun run scripts/migrate-from-leaf.ts --dry-run  # preview
bun run scripts/migrate-from-leaf.ts             # actual migration
```

The script:
1. Opens each Leaf stream DB
2. Reads all events ordered by idx
3. Inserts into appserver's `stream_events` (INSERT OR IGNORE for idempotency)
4. Updates `stream_state.latest_event`
5. Updates `comp_space.backfilled_to`
6. Bumps `SCHEMA_VERSION` in the DB to `"10-appserver.5"`

#### Step 3: Deploy Phase 3 appserver (with SCHEMA_VERSION bump)
- Start the new appserver version
- The appserver detects schema version mismatch (`"10-appserver.5"` in DB vs `"10-appserver.4"` in code... wait, the code also needs to be `"10-appserver.5"`)
- Actually, the migration script bumps the DB version, and the new code has `SCHEMA_VERSION = "10-appserver.5"` — so they match, and no wipe occurs
- But we WANT a wipe to re-materialize from the local event log!

**Correction:** The migration script should set the DB to a version that does NOT match the code, triggering a wipe. Or we can explicitly trigger re-materialization.

**Better approach:**
1. Migration script copies events to `stream_events`
2. Migration script sets `roomy_schema_version.version` to `"PRE_MIGRATION"` (or deletes the row)
3. New appserver code has `SCHEMA_VERSION = "10-appserver.5"`
4. On boot, the appserver sees a mismatch, wipes materialized views, and re-materializes from `stream_events`

But wait — the appserver doesn't have a "re-materialize from stream_events" mechanism. The current re-materialization goes through `SpaceMaterializer` which subscribes to Leaf. After migration, we need a new re-materialization path.

**Revised approach:**
1. Migration script copies events to `stream_events`
2. Migration script sets `stream_state.latest_event` for each stream
3. New appserver code has `SCHEMA_VERSION = "10-appserver.5"`
4. On boot, the appserver detects schema mismatch, wipes materialized views
5. The appserver then reads each stream's events from `stream_events` and runs them through `applyBatch()`

This requires a new "local backfill" mechanism in the appserver that reads from `stream_events` instead of Leaf.

#### Step 4: Local re-materialization on boot
Add to `packages/appserver/src/index.ts` (or a new module):

```typescript
async function reMaterializeFromLocalEvents(appDb: AsyncDatabase): Promise<void> {
  // Get all streams that have events
  const streams = await appDb.query(`
    SELECT DISTINCT stream_id FROM stream_events ORDER BY stream_id
  `).all<{ stream_id: string }>();
  
  for (const { stream_id } of streams) {
    const events = await appDb.query(`
      SELECT idx, user, payload FROM stream_events 
      WHERE stream_id = ? ORDER BY idx
    `).all(stream_id);
    
    // Decode CBOR payloads
    const decodedEvents = events.map(e => ({
      idx: e.idx,
      event: parseEvent(decode(e.payload)),
      user: e.user,
    }));
    
    // Materialize in batches
    await applyBatch(appDb, stream_id, decodedEvents, { isBackfill: true });
  }
}
```

This runs after schema initialization but before the server starts accepting requests.

#### Step 5: Decommission Leaf
1. Verify all data is accessible through the appserver
2. Stop Leaf server
3. Remove Leaf data directory (after backup verification)
4. Remove Leaf-related DNS entries / load balancer configs

### Rollback During Migration

#### If Phase 1 deploy fails:
- Roll back to previous appserver version
- Leaf is still running — no data loss
- Any spaces created during Phase 1 (with local DIDs) will be lost, but they have no real data yet

#### If migration script fails:
- The script uses `INSERT OR IGNORE` — it's safe to re-run
- If the script crashes partway, re-run it
- If the appserver DB is corrupted, restore from backup

#### If Phase 3 deploy fails (re-materialization fails):
- Restore appserver DB from pre-migration backup
- Restore previous appserver version
- Leaf is still running — resume normal operation

---

## Test Strategy Summary

| Phase | What to Test | How |
|-------|-------------|-----|
| 1 | StreamManager | Unit tests for sendEvents, createStream, DID generation |
| 1 | Updated handlers | E2E tests for sendEvents, createSpace, joinSpace, leaveSpace |
| 1 | Full regression | `bun test` in appserver (~240 tests) |
| 2 | Admin endpoints | E2E tests for connectSpace, materializeSpace |
| 2 | Full regression | `bun test` in appserver |
| 3 | Migration script | Unit tests with mock Leaf DBs |
| 3 | Re-materialization | Integration test: copy events, wipe DB, verify re-materialization |
| 4 | SDK removal | `bun test` in SDK (update tests that use ConnectedSpace) |
| 4 | Appserver cleanup | `bun test` in appserver |
| 4 | Discord-bridge | `bun test` in discord-bridge |
| 4 | E2E | Manual smoke test of full flow: create space, send messages, verify sync |

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | **Data loss during migration** | Low | Critical | Migration script uses INSERT OR IGNORE (idempotent). Backup both Leaf and appserver DBs before migration. Dry-run mode for verification. |
| 2 | **Re-materialization produces different results than Leaf** | Medium | High | Compare materialized data before/after migration on staging. The SDK's materializers are the same functions — they should produce identical results. |
| 3 | **Stream DID collision** | Low | Medium | Use ULID-based DIDs with a configurable prefix. ULIDs are unique per millisecond. Add a UNIQUE constraint or check on creation. |
| 4 | **Discord-bridge subscription breaks** | Medium | High | The bridge's subscription path (Roomy→Discord) currently uses `ConnectedSpace.subscribe()`. The replacement (appserver WebSocket sync) has a different API. Need thorough testing of the new `LiveRoomyGateway`. |
| 5 | **SDK breaking changes affect external consumers** | Medium | Medium | The SDK is published to npm. Removing `ConnectedSpace`, `modules`, and `leaf` exports is a breaking change. Use a major version bump. Keep type exports for backward compatibility where possible. |
| 6 | **Migration script performance** | Medium | Low | With thousands of streams and millions of events, the migration could take hours. Test on staging with production data volume. Consider batching and progress reporting. |
| 7 | **Personal stream events not migrated** | Medium | High | Personal streams are stored in Leaf too. The migration script must iterate ALL Leaf stream DBs, not just space streams. Personal streams use the `personal` module. |
| 8 | **Event idx gaps after migration** | Low | Medium | Leaf assigns sequential idx per stream. The migration script reads events ORDER BY idx, so gaps (if any) are preserved. The materialization pipeline handles gaps gracefully. |
| 9 | **Embed enrichment backlog after re-materialization** | Low | Low | Re-materialization re-creates all `comp_embed_link` rows. The embed sweeper will process them all, which could take time. The sweeper has backpressure and prioritization. |
| 10 | **In-memory state lost on appserver restart** | Low | Low | The appserver is stateless (all state is in SQLite). Restart is safe. The only in-memory state is the invalidation router's listener set, which is re-established on WebSocket connect. |

---

## Appendix: File Change Summary

### Phase 1
| Action | File |
|--------|------|
| CREATE | `packages/appserver/src/streams/StreamManager.ts` |
| CREATE | `packages/appserver/src/streams/did.ts` |
| CREATE | `packages/appserver/src/db/eventsSchema.sql` |
| MODIFY | `packages/appserver/src/db/types.ts` (add eventsDbPath to initOpts) |
| MODIFY | `packages/appserver/src/db/worker.ts` (add events DB init + ATTACH) |
| MODIFY | `packages/appserver/src/db/db.ts` (add eventsDbPath) |
| MODIFY | `packages/appserver/src/handlers/space.roomy.space.sendEvents.ts` |
| MODIFY | `packages/appserver/src/handlers/space.roomy.space.createSpace.ts` |
| MODIFY | `packages/appserver/src/handlers/space.roomy.space.joinSpace.ts` |
| MODIFY | `packages/appserver/src/handlers/space.roomy.space.leaveSpace.ts` |
| MODIFY | `packages/appserver/src/handlers/space.roomy.admin.connectSpace.ts` |
| MODIFY | `packages/appserver/src/handlers/space.roomy.admin.materializeSpace.ts` |
| MODIFY | `packages/appserver/src/index.ts` (skip backfill for streams with events) |

### Phase 2
| Action | File |
|--------|------|
| MODIFY | `packages/appserver/src/handlers/space.roomy.admin.connectSpace.ts` (verify) |
| MODIFY | `packages/appserver/src/handlers/space.roomy.admin.materializeSpace.ts` (verify) |

### Phase 3
| Action | File |
|--------|------|
| CREATE | `packages/appserver/scripts/migrate-from-leaf.ts` |
| MODIFY | `packages/appserver/src/db/db.ts` (bump SCHEMA_VERSION) |
| MODIFY | `packages/appserver/src/index.ts` (add local re-materialization) |

### Phase 4
| Action | File |
|--------|------|
| DELETE | `packages/sdk/src/leaf/` |
| DELETE | `packages/sdk/src/modules/` |
| DELETE | `packages/sdk/src/connection/ConnectedSpace.ts` |
| DELETE | `packages/sdk/src/connection/types.ts` (or gut) |
| DELETE | `packages/sdk/src/connection/sqlParsing.ts` |
| DELETE | `packages/appserver/src/serviceClient.ts` |
| DELETE | `packages/appserver/src/materialization/SpaceMaterializer.ts` |
| DELETE | `packages/appserver/src/materialization/registry.ts` |
| MODIFY | `packages/sdk/src/connection/index.ts` |
| MODIFY | `packages/sdk/src/client/RoomyClientBase.ts` |
| MODIFY | `packages/sdk/src/client/RoomyServiceClient.ts` |
| MODIFY | `packages/sdk/src/client/RoomyClient.ts` |
| MODIFY | `packages/sdk/src/client/index.ts` |
| MODIFY | `packages/sdk/src/index.ts` |
| MODIFY | `packages/sdk/src/operations/message.ts` |
| MODIFY | `packages/sdk/src/operations/reaction.ts` |
| MODIFY | `packages/sdk/package.json` |
| MODIFY | `packages/appserver/src/index.ts` |
| MODIFY | `packages/appserver/src/appserver.ts` |
| MODIFY | `packages/appserver/src/materialization/profiles.ts` |
| MODIFY | `packages/appserver/src/e2e/helpers.ts` |
| MODIFY | `packages/appserver/package.json` |
| MODIFY | `packages/discord-bridge/src/roomy/space-manager.ts` |
| MODIFY | `packages/discord-bridge/src/roomy/live-gateway.ts` |
| MODIFY | `packages/discord-bridge/src/roomy/client.ts` |
| MODIFY | `packages/discord-bridge/package.json` |
