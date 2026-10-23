# Push freshness gates

Push is a *live* signal: "this just happened". The only time the push path
carried was `decodeTime(event.id)` — the event **ULID**, i.e. when the event was
*ingested*, not when the message was written. `sendEvents` is not a live-only
path: the Discord bridge replays channel history through it
(`backfillChannel` → `ingestDiscordMessage`), so a replay produces messages with
fresh ULIDs and hours-or-months-old content, and every downstream gate treats
them as new.

Three gates close that; a fourth keeps a failed delivery from being lost
afterwards. Each one is impossible to trip by construction on the path it
guards.

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

## 4. Delivery retry

A transport answers with one of four outcomes (`PushOutcome`,
`push/transports/types.ts`), and the dispatcher treats only `retry` as worth
another attempt:

| Outcome | Meaning | Dispatcher |
|---|---|---|
| `delivered` | the push service accepted it | settle the row |
| `gone` | the destination is dead (404/410, a rejected device token) | prune the row |
| `skipped` | nothing was attempted (unconfigured transport, unreachable device) | count it, settle any park |
| `retry` | 429/5xx/a dropped connection | park the row, re-attempt after a backoff |

Before retry existed, `retry` was dropped on the floor with the same log line
as a permanent failure: one APNs device produced 31 identical
"HTTP null" failures over 30 days, was never delivered to, and was never
pruned, because nothing was holding it back and nothing was counting it.

The retry state is on the subscription row
(`push_subscriptions.attempts` / `retry_after` / `last_error` / `retry_payload`),
not in the dispatcher's queue, so a pending re-attempt survives a restart and is
readable from `/health/push` and `space.roomy.admin.push.getStats`. Each cycle
runs `_runPushRetrySweep` (`push/dispatcher.ts`) before its queued work, and the
idle wait is clamped by the earliest parked backoff, so a 30s park is not left
until the next 60s poll.

`retryBackoffMs` (`push/retry.ts`) escalates — 30s, 5m, 30m, 2h, then capped at
6h — so a push-service outage does not burn every device's attempts in one
minute. After `maxRetryAttempts` (6) consecutive transient failures the row is
pruned with a `GONE (pruned, after=N)` line, identical in shape to a `gone`
prune: a device that has not accepted a push in ~9 hours is not coming back, and
leaving it in place makes every later push pay for it forever.

A delivery that lands clears the retry state, and so does re-registering the
device — a registration is a fresh claim that the device is reachable.

## Tests

- `push/freshness.test.ts` — the gate's contract, including the boundary at
  exactly `PUSH_MAX_MESSAGE_AGE_MS`.
- `streams/pushFreshnessGate.test.ts` — the enqueue seam: a live message is
  poked; a historical message ingested now is **not**; a mixed batch pokes only
  the live ones; a bridged message keeps its override time.
- `push/digestSweepFreshness.test.ts` — the sweep drops a stale batch and leaves
  a fresh overdue one for delivery.
- `push/retry.test.ts` — a transient failure parks the row instead of dropping
  it, the parked row is re-attempted when its backoff elapses, a delivery that
  lands settles it, the repeat offender is pruned at the ceiling, and a
  re-registration clears the state.
- `push/transports/transport.test.ts` — the outcome vocabulary reaches the
  dispatcher from every transport, including a `retry` leaving the row parked.

## Follow-ups (not implemented)

- A replay-marker the appserver can honour would let a bridge replay be
  throttled and de-prioritised rather than merely gated.
- `sendEvents` still has no backpressure: a bridge replay and live user traffic
  share one serialized write path per stream.
- A re-attempt replays the payload that first failed, not a re-evaluation of
  what the user is owed now: messages that arrive while a device is parked
  replace the parked payload rather than queueing, so what is redelivered is
  the latest payload for that device, not one per message.
