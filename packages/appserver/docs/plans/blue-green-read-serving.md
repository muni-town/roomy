# Blue-Green Read Serving Before Materialisation

**Status:** Implemented; the rebuild is now the fallback path when an in-place
per-space migration cannot be applied (see §2 Q3).
**Owner:** appserver

## 1. Problem

When `SPACE_SCHEMA_VERSION` is bumped, a per-space DB on disk is now **stale**:
its schema is older than the code that will read it. The current worker handles
this by **wiping the canonical file and reopening a fresh, empty, new-schema DB**
(`openSpaceDb` in `src/db/worker.ts` catches `SchemaVersionMismatchError` →
`deleteSpaceDbFile` → reopen → re-initialise). That empty DB immediately starts
serving reads, so the space **appears to disappear**: every read returns nothing
until boot `reMaterializeFromLocalEvents` finishes replaying the stream — which,
for a large space, is seconds-to-minutes of emptiness, and any write during that
window either lands against a partially-replayed DB or is lost.

The fix is **blue-green read serving**: keep the old (stale-schema) DB serving
reads while a temp **new-schema** DB is rebuilt from the event log in the
background, then atomically swap. Readers never see the empty/partial rebuild.

### Where the current behavior lives

| Location | Behavior | Why it matters |
|---|---|---|
| `src/db/worker.ts` `openSpaceDb()` | On `SchemaVersionMismatchError`: wipes canonical file, returns fresh empty new-schema DB | This is exactly what makes the space "disappear" — reads hit the empty DB until replay catches up |
| `src/streams/StreamManager.ts` `sendEvents()` | The single choke point for all live writes: event-log insert → materialise inline into the per-space DB via `applyBatch` | All writes funnel here; `createSpace` is the only other writer |
| `src/index.ts` boot | Fire-and-forget `reMaterializeFromLocalEvents` | Only rematerialisation trigger in production; `e2e/startAppserver()` disables it, so **no existing test exercises a real rebuild** |

## 2. Design decisions (confirmed)

The two open questions from the design session, resolved:

**Q1 — Where is the write gate?** In `StreamManager.sendEvents()`, checked via
`isSpaceRebuilding(streamDid)` **before** the event-log insert — not at each
handler. Rationale: `sendEvents` is the single write choke point (every handler
that writes routes through it); gating at each handler would scatter the check
and risk missing a path. The gate throws a structured `SpaceRematerializing`
error that the XRPC layer maps to a retryable status (see §5.3). This single
check covers both P2 and P8.

**Q2 — Is `forSpace()` never-wipe the default?** Yes. The worker **no longer
wipes on schema mismatch at all**. A stale-schema space simply serves its old
data (P1) until an explicit rebuild path (`spaceRebuildBegin` → replay → commit)
replaces it. This is strictly safer than today's wipe, and it is the default for
both `forSpace()` reads and the incremental catch-up path.

**Q3 — Is the rebuild the only way a stale DB is brought forward?** No. A schema
bump first upgrades each space **in place** (`per-space-migration` machinery:
`db/spaceVersions.ts`, `db/spaceMigrations.ts`), and the rebuild here is the
fallback for a DB whose version this build cannot start from, or a migration
that declines or fails. The two paths share the same write gate and the same
"never wipe a DB you cannot upgrade" rule; see §6a of
`pure-materialisation.md` for the migration side.

## 3. Invariants we must prove

| # | Invariant | Where proven |
|---|---|---|
| P1 | During the window, reads serve the old DB (same data as pre-deploy), never empty/partial | L1, L2 |
| P2 | Writes to a rebuilding space are rejected with a clear, retryable error and the event does **not** land in the event log | L2, L3 |
| P3 | The swap is atomic — a read sees all-old or all-new, never torn/mixed | L1 |
| P4 | After swap, the new DB is a complete rematerialisation of the event log (no data loss) | L2 |
| P5 | After swap, the cursor is current; a second cold rematerialisation is a no-op (idempotent) | L1, L2 |
| P6 | If the rebuild fails, the old DB keeps serving; we never swap in a broken/empty DB | L1 |
| P7 | A read that touches a schema column/table that changed errors cleanly (not a 500 or wrong data) | L1 (edge) |
| P8 | No double-apply race at the swap boundary — the reject-before-log ordering holds | L3 |

## 4. Test seams — the API surface this forces

Today the code cannot express P1/P3/P5/P6/P8 because the worker **conflates
"open for read" with "wipe + rebuild."** The rebuild must be driven by an
explicit handle so tests can hold the window open and interleave reads/writes.
The minimal seam is:

### 4.1 Routing modes

- **`forSpace(spaceDid)`** — canonical, read-serving handle. **Never wipes.**
  If the on-disk schema is stale, it returns the old DB unchanged (reads serve
  pre-deploy data, P1). This is today's public routing method; its semantics
  change from "wipe-on-mismatch" to "never-wipe".
- **`forSpaceRebuild(spaceDid)`** — a handle pinned to the temp rebuild DB at
  `data/spaces/<spaceDid>.sqlite.new` (a fresh, new-schema DB). `applyBatch`
  during replay targets this handle. This is the seam behind P1/P3/P5/P6.

### 4.2 Worker lifecycle ops

- **`spaceRebuildBegin(spaceDid)`** — creates the temp `.sqlite.new` file with
  the **new** schema, marks the space as rebuilding, returns the rebuild handle.
  Idempotent: if already rebuilding, returns the existing handle.
- **`spaceRebuildCommit(spaceDid)`** — atomically renames `.sqlite.new` over the
  canonical file, drops the old file (plus `-wal`/`-shm`), clears the rebuilding
  flag, and flips routing. Idempotent: a second commit is a no-op (P5).
- **`spaceRebuildAbort(spaceDid)`** — deletes the temp file and clears the
  rebuilding flag. The old DB keeps serving (P6). Never swaps.
- **`isSpaceRebuilding(spaceDid)`** — boolean, checked at the top of
  `StreamManager.sendEvents()` before the log insert (P2/P8).
- **`checkSpaceSchema(spaceDid)`** → `{ current: boolean }` — whether the
  canonical file's schema version matches the expected `SPACE_SCHEMA_VERSION`.
  Used by `reMaterializeFromLocalEvents` to decide begin→replay→commit vs
  incremental catch-up. A missing file ⇒ `current: true` (fresh space).

### 4.3 Where these land in the code

| File | Change |
|---|---|
| `src/db/types.ts` `WorkerRequest.type` | add `"spaceRebuildBegin" \| "spaceRebuildCommit" \| "spaceRebuildAbort" \| "isSpaceRebuilding" \| "checkSpaceSchema"`; add `route?: "canonical" \| "rebuild"` to the `space` target so `forSpace` vs `forSpaceRebuild` dispatch to different worker DBs |
| `src/db/worker.ts` | replace the wipe-on-mismatch branch in `openSpaceDb()` with: on mismatch, return the old DB as-is (never wipe); add `openSpaceDbRebuild()`, `commitSpaceRebuild()`, `abortSpaceRebuild()`, `isSpaceRebuilding()`, `checkSpaceSchema()`. Maintain a `Map<spaceDid, { rebuild: Database; canonical: Database }>` plus a `Set<spaceDid>` rebuilding flag per worker (rebuild is per-space so it lands on the owning worker) |
| `src/db/pool.ts` `DatabasePool` | add `forSpaceRebuild(spaceDid)` (pins to same worker as `forSpace` via `hashSpace`, `route: "rebuild"`), `isSpaceRebuilding()`, `checkSpaceSchema()`, `spaceRebuildCommit()`, `spaceRebuildAbort()` |
| `src/db/pool.ts` `PooledDatabase` | expose the same five methods on the router (`DbLike`) |
| `src/db/asyncDatabase.ts` | propagate the new request types and the `route` field through `postMessage` (routing already exists; just extend the type union) |
| `src/streams/StreamManager.ts` `sendEvents()` | at the very top, before encoding/log-insert: `if (await this.#db.isSpaceRebuilding?.(streamDid)) throw new SpaceRematerializing(streamDid)` |
| `src/streams/reMaterialize.ts` | per-stream branch (§5.2) |

> **Atomic swap detail (P3).** Both the canonical and `.sqlite.new` files live
> in `data/spaces/`. `rename()` over the canonical path is atomic on the same
> filesystem. A reader holding the old inode keeps reading it; a new open gets
> the renamed file. No reader ever opens a torn file.

## 5. Implementation detail

### 5.1 `openSpaceDb()` becomes never-wipe

```ts
// BEFORE (today) — wipes on SchemaVersionMismatchError
try { initializeVersionedSchema(db, ...) }
catch (err) {
  deleteSpaceDbFile(spaceDid, db);          // <-- makes the space disappear
  if (err instanceof SchemaVersionMismatchError) {
    db = openSpaceDbFile(spaceDid);         // <-- fresh empty new-schema DB
    initializeVersionedSchema(db, ...);
  } else throw err;
}

// AFTER — never wipes. A stale DB serves reads as-is.
try { initializeVersionedSchema(db, ...) }
catch (err) {
  if (err instanceof SchemaVersionMismatchError) {
    // Serve the OLD DB as-is (P1). It is safe to read; its schema is a strict
    // superset-read of older columns and its data is complete. A rebuild is
    // triggered later by reMaterializeFromLocalEvents, not by a read.
    // Do NOT delete the file. Do NOT return a fresh DB.
    return db;
  }
  throw err;
}
```

`SchemaVersionMismatchError` stays as the *signal* that a rebuild is needed; it
is no longer the trigger for a wipe.

### 5.2 `reMaterializeFromLocalEvents()` per-stream branch

```ts
for (const { stream_id } of streams) {
  const { current } = await db.checkSpaceSchema(stream_id);

  if (!current) {
    // BLUE-GREEN REBUILD (new path):
    //   begin → replay into the .sqlite.new handle → commit (P3/P6)
    // On any failure → abort; old DB keeps serving (P6).
    await db.spaceRebuildBegin(stream_id);
    try {
      replayFromCursor(db.forSpaceRebuild(stream_id), stream_id, -1, getProfiles, happyView);
      // write materialization_cursor to the new DB so P5 holds
      await db.spaceRebuildCommit(stream_id);
    } catch (err) {
      await db.spaceRebuildAbort(stream_id);   // old DB keeps serving
      throw err;                                // or log-and-continue (see §8)
    }
    continue;
  }

  // CURRENT schema — existing incremental catch-up path, unchanged:
  //   read cursor from forSpace(stream_id), skip if caught up, else replay
  //   from cursor + 1 into forSpace(stream_id).
  ...
}
```

Replay logic is shared with the existing incremental path — the only difference
is which handle `applyBatch` targets (`forSpaceRebuild` vs `forSpace`) and the
start index (fresh rebuild always from `-1`; incremental from `cursor + 1`).

### 5.3 `SpaceRematerializing` error

A structured error with a stable code (`errorCode: "SpaceRematerializing"`,
HTTP `409 Conflict` or `503` — the handler test pins the exact mapping). The XRPC
`sendEvents` handler maps it to a response the client can retry. It is thrown
only by the `isSpaceRebuilding` gate.

### 5.4 The P8 race (write landing exactly at commit)

The gate (`isSpaceRebuilding`) and the log-insert are **not** one atomic unit
across the two DBs (space worker vs system/events worker). That is fine — we
only need *exactly-once or rejected*, never double-applied:

- Write checks `isSpaceRebuilding` → **false**, proceeds, inserts log → commit
  lands in between → the write materialises into the *new* DB exactly once
  (normal post-commit path). ✓ applied once.
- Write checks `isSpaceRebuilding` → **true** → rejected, nothing in the log.
  ✓ rejected.
- There is no window where a write passes the check, lands in the log, and is
  then replayed a second time by the rebuild: rebuild replays events with
  `idx` strictly increasing and skips to cursor; a log-insert that happened
  before commit but materialised after is an ordinary incremental event on the
  new DB (exactly once). This is the property L3 pins.

## 6. Test plan

### L1 — Worker DB-management unit tests (`src/db/blueGreen.test.ts`)

Foundation layer. Uses the **isolated pool** with a real temp `spacesDir`
(not `:memory:` — the swap needs real files to rename), like `pool.test.ts`.
Each case maps to its invariant.

| Case | Setup | Assert | Invariant |
|---|---|---|---|
| stale-schema DB serves reads before rebuild | seed old-schema DB, bump `SPACE_SCHEMA_VERSION`, `forSpace` read | returns pre-deploy rows, **not** empty, file **not** wiped | P1 |
| `forSpaceRebuild` returns fresh new-schema DB | stale canonical, begin | rebuild handle has new schema, canonical untouched | P1, seam |
| replay → commit makes reads see new data + old file gone | begin → write new data to rebuild handle → commit | `forSpace` returns new data; `data/spaces/<did>.sqlite.new` gone | P3, P4 |
| commit is idempotent | commit twice | second commit no-op, no error, data intact | P5 |
| abort keeps old serving | begin → write to rebuild → abort | old data still served; temp file gone | P6 |
| cursor current after swap | seed full event log, rebuild | new DB `materialization_cursor.materialized_to == latest idx`; second rebuild is a no-op | P5 |
| changed-column read during window errors cleanly | new schema drops/retypes a column; begin; read that column on canonical | clean structured error (not 500, not wrong data) | P7 |
| swap-boundary race | begin, then commit racing a write | write either rejected or applied exactly once | P8 |

### L2 — Rematerialisation integration test (`src/streams/reMaterialize.test.ts`)

Seeds + materialises at the **old** schema, simulates a schema bump, runs
`reMaterializeFromLocalEvents` with a **slow `getProfiles` hook** to hold the
window open, then interleaves:

1. assert a `forSpace()` read **during** the window returns old data → **P1**
2. assert a write is rejected **and** `stream_events` is untouched → **P2**
3. await completion; assert full new data present → **P4**
4. assert cursor is current; run `reMaterializeFromLocalEvents` again → no-op → **P5**

### L3 — XRPC handler-level test (`src/handlers/space.roomy.space.sendEvents.test.ts`)

1. mark a space rebuilding (`spaceRebuildBegin` via the pool)
2. POST a write
3. assert the specific `SpaceRematerializing` status/error
4. assert `stream_events` is **untouched** (no row) → **P2/P8 at the protocol boundary**

## 7. Rollout order

All four steps are **shipped** in the `blue-green-read-serving` PR:

1. **L1** — `src/db/blueGreen.test.ts` (worker seam: `forSpaceRebuild` + the five
   worker ops). Proves P1/P3/P5/P6/P7/P8 at the DB layer. The never-wipe
   semantic is strictly safer than the old wipe.
2. **L2** — `src/streams/reMaterialize.blueGreen.test.ts` (end-to-end window
   through the real `reMaterializeFromLocalEvents` branch). Proves P1/P2/P4/P5
   and P6 (failed rebuild aborts, old DB keeps serving).
3. **L3** — `src/handlers/space.roomy.space.sendEvents.test.ts` (protocol
   boundary). Proves P2/P8: a write to a rebuilding space returns a retryable
   `409` / `SpaceRematerializing` and does not land in the event log.
4. **Live switch** — `reMaterializeFromLocalEvents` now takes the begin/replay/
   commit path for stale-schema streams (see §5.2). Because L1/L2/L3 pass
   against the same code, the boot path is tested blue-green.

**Verification on real data:** a schema bump (added a `comp_room.pinned` column,
`SPACE_SCHEMA_VERSION` 1→2) was replayed against a copy of the local appserver
`data/` (4,153 streams, 435,986 events). All stale spaces rebuilt into temp
`.sqlite.new` DBs and atomically swapped with no data loss (rebuilt
`comp_content` counts matched originals), no `.new` files left behind, and the
write gate rejected writes during the window. Full rematerialisation took
~655 s at concurrency 4; the largest single space (~126k events) dominated at
~185 s. See §6 for the invariant mapping.

## 8. Risks / open questions

- **Rebuild failure policy:** abort-and-keep-serving (P6) leaves the space stale
  forever if the rebuild keeps failing. Decide whether `reMaterializeFromLocalEvents`
  retries a failed rebuild on the next boot (it already re-runs per stream) or
  logs-and-continues. Default in §5.2: abort + rethrow so the space stays old
  and the next boot retries.
- **`createSpace` (the other writer):** out of scope — a brand-new space has no
  canonical DB to swap, so it never races a rebuild. Confirm `createSpace` still
  doesn't go through `sendEvents` in a way the gate could miss.
- **Reads that legitimately need the new schema:** P7 says they error cleanly
  rather than corrupt. Decide the exact error shape (a structured
  `SpaceSchemaMismatch` read error) so clients can distinguish "space is
  rebuilding, retry" from "your query is invalid."
- **Memory pressure:** a rebuild holds two per-space DBs in the worker LRU
  (canonical + temp) simultaneously. `maxSpaceDbs` LRU must not evict the
  canonical handle mid-rebuild; the rebuild state should pin both.
