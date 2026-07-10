# Appserver TODO

Post-merge improvements and known issues for `packages/appserver/`.

## Materialization

- **Cursor advances past apply errors (M1):** `applyBatch.ts:188-221` — when a chunk transaction fails, `materialization_cursor` is still advanced to `chunkMaxIdx`. Events in that chunk are never retried. Distinguish transient vs permanent errors; only advance past permanent errors.
- **Stats double-count on chunk failure (M2):** `applyBatch.ts:193-202` — `stats.applyErrors += chunk.length` double-counts events that already had materializer errors. `stats.applied` can underflow.
- **Savepoint isolation (B3):** `applyBatch.ts:107-155` — per-event savepoint isolation doesn't work because `handleTransaction` in `worker.ts` runs all steps synchronously with no per-step error handling. One bad event rolls back the entire chunk. Fix: add per-step try/catch in `handleTransaction` that rolls back to the most recent savepoint on failure.
- **Per-stream materialization ordering (H1):** Concurrent `sendEvents` to the same stream can materialize out of idx order because `applyBatch` runs after an async yield in `ensureProfilesForBatch`. Add per-stream serialization.

## Sync

- **No backpressure on WS send (M4):** `sync/handler.ts:532-553` — `#onStreamEvents` calls `state.send(frame)` for every subscribed connection with no backpressure check. A stalled WebSocket client causes unbounded memory buffering.
- **E2E WS stream subscription untested:** No E2E test exercises a real stream-topic subscription over WebSocket (sub → backfill → live event delivery). Only unit-tested with mocks.
- **Multi-batch backfill untested:** `BACKFILL_BATCH=100` but no test seeds >100 events. The `hasMore=true` intermediate frame logic is never exercised.

## StreamManager

- **getLatestEventIdx returns 0 for no events (L5):** `StreamManager.ts:209-216` — returns `row?.latest_event ?? 0`, same value as a stream with exactly one event at idx 0. Return -1 or null instead.
- **getEventsFrom/onEvents/getLatestEventIdx untested:** No direct unit tests. Sync handler tests use a mock (`FakeStreamSource`).

## Handlers

- **joinSpace existence check matches any entity (L4):** `joinSpace.ts:79-86` — `SELECT 1 FROM entities WHERE id = ?` matches rooms, users, messages, not just spaces. Check for a `comp_space` row instead.
- **Per-event write-auth untested:** `sendEvents.test.ts` — no test for a member sending an admin-only event (e.g. createRoom without admin edge). Only space-access (403) is tested.

## Queries

- **getEvents handler uses unqualified table (M3):** `getEvents.ts:45-49` — `FROM stream_events` instead of `FROM events.stream_events`. Works today via SQLite attach-order fallback, but fragile.

## Boot / Config

- **disableEmbedSweeper option silently ignored (M5):** `appserver.ts:281` — `disableEmbedSweeper` declared in `AppserverOptions`, tests pass `true`, but `createAppserver` never reads it. `startEmbedSweeper` is called unconditionally.
- **Stale comments reference removed backfill (L1):** `appserver.ts:9-14` and `e2e/helpers.ts:50` — comments still reference `backfillMode` option that was removed.
- **reMaterialize N+1 queries (L2):** `reMaterialize.ts:80-97` — per-stream `max(idx)` lookup inside the loop. Collapse into one `GROUP BY` query.
- **Full replay on first boot (L3):** `materialization_cursor` is empty on existing DBs → first post-deploy boot does a full re-materialization of every stream. Consider seeding from `comp_space.backfilled_to`.
- **reMaterialize per-stream catch untested:** No test for one stream throwing (e.g. decode failure) while others succeed.
- **Unhandled "Database closed" rejections:** `StreamManager.test.ts` and `did.test.ts` — `closeDb()` in `afterEach` rejects pending async-worker requests, producing unhandled promise rejections. Drain/await pending ops before close.
