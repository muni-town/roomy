# Discord Bridge TODO

Post-merge improvements and known issues for `packages/discord-bridge/`.

## Subscription / Connection

- **Retry failed subscriptions (H3):** `services/roomy-event-router.ts:100-116` — `start()` uses `Promise.allSettled`. A transient network error during `subscribe()` logs the error but the space remains permanently unmonitored. A code TODO exists at line 117; implement retry with backoff.
- **disconnectAll doesn't await in-flight (M7):** `roomy/live-gateway.ts:247-255` — `disconnectAll()` clears `#processing` map without awaiting in-flight promises. Callbacks may fire after disconnect returns.
- **Stale-cursor reconnect duplicate window (M):** `roomy/live-gateway.ts:102,115-124` — on reconnect, the SDK replays the tracked topic before firing `onOpen`, causing a brief window of duplicate event delivery. Currently harmless (router dedup via `getDiscordId`), but should be documented or fixed.

## Database

- **event_errors table grows without bound (M6):** `db/repository.ts:496-544`, `db/schema.ts:141-157` — `logEventError()` inserts rows unboundedly. No unique constraint on `(space_did, event_idx)`, no retention/cleanup. Add a prune method or periodic cleanup.

## Robustness

- **Missing frame validation (L):** `roomy/live-gateway.ts:180,227,231` — `#processFrame` casts body as `StreamEventsBody` without validating `cursor` and `hasMore` fields. If `cursor` is undefined, `setSpaceCursor` throws. If `hasMore` is undefined, `!data.hasMore` evaluates to `true`, incorrectly setting `backfillState.value = false`.
- **APPSERVER_URL path handling (L):** `env.ts:24-27` — if `APPSERVER_URL` contains a path (e.g. `http://example.com/appserver`), the path is preserved when deriving the WebSocket URL. Document that it should be a bare origin, or strip any path.

## Cleanup

- **Shallow copy in sendEvents (L):** `roomy/live-gateway.ts:62-67` — `sendEvents` maps events with `{ ...e }` (shallow copy). Serves no purpose; pass events directly.
- **getEventErrors docstring (L):** `db/repository.ts:511` — "most recent ... oldest first" is contradictory. Fix to "Get event errors for a space, ordered oldest-first within the filter window."
- **flush() microtask loop (L):** `roomy/live-gateway.test.ts:155-157` — uses a fixed 30-iteration loop to drain microtasks. Fragile if the processing chain grows deeper.
