# Push freshness gates

Push is a *live* signal: "this just happened". The only time the push path
carried was `decodeTime(event.id)` — the event **ULID**, i.e. when the event was
*ingested*, not when the message was written. `sendEvents` is not a live-only
path: the Discord bridge replays channel history through it
(`backfillChannel` → `ingestDiscordMessage`), so a replay produces messages with
fresh ULIDs and hours-or-months-old content, and every downstream gate treats
them as new.

Three gates close that. Each one is impossible to trip by construction on the
path it guards.

## 1. Freshness gate on every push job

`isPushFresh(job, now)` (`push/freshness.ts`) compares the message's **canonical**
timestamp against `PUSH_MAX_MESSAGE_AGE_MS` (5 minutes).

The canonical time is `canonicalMessageTimestamp` (`materialization/sortIdx.ts`),
which honours the `timestampOverride` extension for bridged messages, else falls
back to the ULID time. That is the only value that distinguishes "old message,
ingested now" from "new message".

Applied at the single enqueue site (`StreamManager`, step 6b): stale messages are
dropped from the poke entirely — no immediate push, **and** no
`notification_state` batch seeded for engaged recipients. A
`[push-freshness] suppressed N/M` line makes a replay visible in production.

Undecodable event ids are treated as **fresh**, deliberately: this is an age
check, and silently dropping a live notification because its age is unknown is
the opposite — and worse — failure.

The window only has to absorb clock skew and pipeline latency between a user
hitting send and the message reaching the process; it does not batch anything.
A replay is hours-plus old, so the exact constant is not load-bearing.

## 2. Serialized bridge replay

`runBackfill` (`discord-bridge/src/services/backfill.ts`) runs **one
`(channel, space)` task at a time** rather than through `Promise.allSettled`, so
replay is a single stream of writes that live traffic interleaves with instead
of a parallel replay that starves the live path.

## 3. Digest age ceiling

The sweep deletes `notification_state` rows whose `first_unseen_at` is older
than `PUSH_MAX_DIGEST_AGE_MS` (24h) instead of firing them
(`push/dispatcher.ts`). A digest answers "you missed something while you were
away" — a batch that began long ago is stale state, not a prompt, and firing it
greets the user with hours-old messages.

This is what makes the sweep safe to run on **every restart**. The 1h
`DIGEST_WINDOW_MS` still governs *when* a fresh batch fires; the ceiling only
decides when a batch is too old to be worth firing at all. `read_positions` (and
therefore the unread counter) is untouched, so nothing user-visible is lost.

## Tests

- `push/freshness.test.ts` — the gate's contract, including the boundary at
  exactly `PUSH_MAX_MESSAGE_AGE_MS`.
- `streams/pushFreshnessGate.test.ts` — the enqueue seam: a live message is
  poked; a historical message ingested now is **not**; a mixed batch pokes only
  the live ones; a bridged message keeps its override time.
- `push/digestSweepFreshness.test.ts` — the sweep drops a stale batch and leaves
  a fresh overdue one for delivery.

## Follow-ups (not implemented)

- A replay-marker the appserver can honour would let a bridge replay be
  throttled and de-prioritised rather than merely gated.
- `sendEvents` still has no backpressure: a bridge replay and live user traffic
  share one serialized write path per stream.
