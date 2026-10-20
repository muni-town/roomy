# Near-Term Plan: Read-Path Throughput and Replicable Space Workers

*Draft for review. Companion to 'Roomy Protocol Migration Plan: Records as Source of Truth'. A one-line pointer to both documents goes into appserver-architecture.md, replacing its Phase 4 goal ('hand off to Rust appserver').*

## 1. Purpose and baseline

The goal of this work is horizontal scale-out of the read and connection plane. The measured pain is on the read path, not write throughput:

| Measure | At drafting (2026-10-09) | Now (7d, production) |
| --- | --- | --- |
| `space.getActivityFeed` | p95 3.1s | p50 24ms, p95 955ms |
| `space.getThreads` | p95 3.4s | p50 9ms, p95 786ms |
| `room.getMetadata` | p50 7ms, p95 349ms | p50 6ms, p95 69ms |
| Fan-out per live message, per client | 7 WebSocket frames, 5 of them invalidations, about 137 DB round-trips | 6 frames, 3 invalidations (`#roomActivityDiff` replaced the boards'; WS5b retired the feed's) |

The read-path work of the last two weeks is what moved the first three rows, and the
projections work is what will move them further. The fan-out column moved partway: the three
activity-ordered boards now receive a diff frame instead of an invalidation, and the activity
feed — a pulled view since WS5b — no longer receives one at all. What remains is the link-index
pair and the author-scoped space metadata.

**Not goals of this plan:** protocol-native ingestion (see the migration plan), durability and ops simplification (these fall out of moving the log off the volume), and a Rust rewrite as an end in itself.

**What this work does not fix on its own.** The p95s are read-path fan-out, and the projections work is what moves them. Replication and a Rust port do not. A Rust port also does not buy replicability, because purity does. Porting before purity would relocate impurity rather than remove it.

## 2. Decisions

| Decision | Status |
| --- | --- |
| Read-path scaling is the goal | Decided |
| Finish purity before the Rust port and before implementing anything else here | Decided |
| Rust worker materialises and serves per-space read queries. Gateway handles sockets, auth, user-scoped reads and cross-space queries by fan-out and caching, and consumes invalidation signals from workers | Decided |
| Lease per space, not hash. One owner per space, and replicate the read plane only | Decided |
| Rebuild-equality harness is the acceptance oracle, including between TS and Rust | Decided |
| The Rust rewrite happens while the total-ordering guarantee still holds | Decided |
| Events are remodelled as change records | Decided |
| Unread is recomputed from `last_read` by the worker, never incremented | Decided |
| Cross-space views are refreshed by pull, not push. The gateway serves them with a short TTL and the client decides when to refresh | Decided |
| Bus before log. No bus until a second process consumes it | Decided, mechanics pending research |
| Split ownership and causal broadcast to several replicas of one space | Deferred until measured need |

## 3. Constraints inherited from the migration

These keep the Rust worker from being written twice:

- The materialiser's input is a change record with an opaque, sortable ordering stamp. Today the stamp comes from `received_at` plus log idx.
- The log sits behind the narrow interface that already exists (`onEvents`, `getEventsFrom`, `append`).
- Projection rules are set-like: upserts keyed by entity id, reorder events that record the resulting key, and deletes treated as removal from a set.
- No derived value comes from an ambient clock or process-local state.

## 4. Target shape

**Gateway (the current appserver).** WebSockets, auth, user-scoped reads including read-state, and the cross-space endpoints (`getSpaces`, `getActivityFeed`), which fan out to workers and cache. It consumes invalidation signals from workers, routes per-space requests to the lease holder or a replica, and negotiates leases.

**Space worker (Rust).** Materialises per-space databases from change records, serves per-space XRPC reads, computes unread counts from `last_read`, and emits invalidation signals.

**Lease per space.** Use the conditional-upsert pattern already in the tree, the voice reconciler in `global.sqlite` (`schema-global.sql`, lines 228 to 236). A lease has failure semantics where a hash does not: when it expires another worker can take over. One owner per space preserves the single-writer total order through the whole Rust phase, since the owner assigns ordering stamps.

**Read replication.** Replicas follow the owner for the read plane only. Ownership is not split. Causal broadcast of events to several replicas of one space is deferred until a measured hot subset needs it.

**Invalidation.** Worker-to-gateway signals replace process-local invalidation, which is what blocks multi-process today. Signals exist for two consumers, and they need different transports: the gateway's response cache, which must be told when a space's data moved so it can evict, and the connections, which are told so a mounted query refetches. The signal should be coarse and coalescable, so that one live message no longer causes five separate invalidations per client.

**Freshness of cross-space views is pulled, not pushed.** `getActivityFeed` and `getSpaces` answer for one caller by merging what several spaces hold, and those spaces may be leased to different workers. Pushing their freshness would mean a fan-out no worker can serve alone: a gateway-side aggregation point, cross-process dedupe, frame ordering that today is a single connection counter, and the delivery-time access check moved into whichever process holds the socket. None of that is needed if the reader asks instead. The gateway answers these two on demand, caches the response for a short TTL, and refetches when the client remounts or the user refreshes — so the only thing crossing a worker boundary is the answer to a request someone made. Space-scoped views keep their push path: they are answered by one worker, which already knows which of its connections are watching.

This is what retires §9 Q1. A gateway-side rollup projection exists to keep a pushed cross-space view fresh across leases; with the view pulled on demand, fan-out over workers plus a short-TTL cache is the whole mechanism. The same TTL covers the case the invalidation channel would otherwise have to reach: a reader whose page includes a space they cannot see changing still gets a fresh answer on their next mount.

What push remains is `getSpaces`' and the feed's per-user cases — joining or leaving a space, and marking a room read — which change one caller's own view rather than the shape of a shared one. They stay signals and become rarer, since the client no longer needs them to stay current while a page sits open.

## 5. Workstreams

### WS1. Finish pure materialisation

Remaining impurities, from the earlier scaling analysis:

- ~~`setHandle` still writes `comp_space.handle` with no event.~~ Moved to the global `space_handles` store (Step 2).
- ~~Unread counters are still incremented and decremented.~~ Step 3 made them a recomputation from `last_read`.
- ~~`comp_embed_link_data` has no log provenance and is read on the message and activity-feed hot paths.~~ Moved to the global `link_embeds` store (Step 4).
- ~~Profile hydration still runs on the live write path.~~ Step 5 moved it to read time; materialisation makes no outbound call.
- ~~Search, embed and push are still process-local queues.~~ Step 5 gave each loop a lease, so one replica owns it across the fleet. The search and push work queues stay in-memory per replica and wait for whichever process holds their lease.

The mapping of these items to steps 2 to 5 follows pure-materialisation.md. **Acceptance:** the rebuild-equality harness (`src/streams/rebuildEquality.ts`) passes, meaning the same log prefix and the same schema version give a byte-identical projection.

### WS2. Read-path p95 fixes

The projections work already planned targets `getActivityFeed`, `getThreads`, `room.getMetadata` and the WebSocket amplification. It does not need to wait for Rust and can overlap WS1. **Acceptance:** targets for each endpoint and for round-trips per message, set against the baseline in section 1, and measured before and after.

### WS3. Change-record interface

- Define the `RecordChange` type from the migration plan.
- Make the internal append path produce it, with the ordering stamp built from `received_at` plus log idx.
- Map each current event type to create, update or delete changes on keyed records.

**Acceptance:** the equality harness still passes byte-for-byte, and the materialiser has no remaining dependency on log position other than through the stamp.

### WS4. Rust worker

- **Scope:** materialisation plus per-space read serving, behind a narrow interface, with the TS gateway in front.
- **Oracle:** the rebuild-equality harness, run across both implementations, so the port is checked against TS output.
- **Cutover, space by space:** shadow-materialise in Rust and diff against TS, then query both from the gateway and compare responses, then shift traffic, keeping a rollback path to TS.
- Research on Rust building blocks is still pending.

### WS5. Gateway, leases and replicas

- Lease table and conditional upsert, routing, failover.
- Invalidation channel from workers to the gateway.
- Cross-space fan-out and caching in the gateway.
- Read replicas following the lease owner.

### WS5b. Pull freshness for the cross-space views

**Shipped.** Split out of WS5 because it is client- and gateway-local, needs no
lease, and was the one piece here that could land before Rust exists. Both halves
are in: `cacheEvictionOnly` on the appserver, and `staleTime: 0` on the two
queries plus a refresh control on the feed, on the client.

- The client fetches `getActivityFeed` and `getSpaces` on mount and on an
  explicit refresh — `staleTime: 0` on both queries, plus a refresh control on
  the feed — rather than waiting for a frame, and shows its last answer while a
  refetch is in flight. `staleTime` and not `refetchOnMount`, so a mount refetch
  cannot restart the feed's in-flight fetch through `cancelRefetch`.
- The response cache holds both against the signal channel it already has, so a
  mount is served from cache unless the space it covers moved. Today that cache
  is the appserver's own (`CACHEABLE_NSIDS`); it moves to the gateway, unchanged,
  when the gateway exists.
- The push signals for the message-driven cases become cache evictions with no
  client frame (`cacheEvictionOnly`). The per-user cases (join, leave, mark-read,
  a reorder) keep their frames.
- The `getSpaces` broadcast on every message is the same question asked of a
  different view and is decided with it.

### WS6. Bus

Deploy JetStream as a bus only when a second process needs to consume it, which in practice means when replicas or the worker-to-gateway signals need a shared transport. Log-as-authority is not planned, because under the protocol model any log is a cache. Research on JetStream as a durable log is pending.

## 6. Sequencing

| Workstream | Depends on | Can overlap with |
| --- | --- | --- |
| WS1 Purity | Nothing | WS2 |
| WS2 Read-path fixes | Nothing, though unread benefits from WS1 | WS1, WS3 |
| WS3 Change records | WS1 started | WS2 |
| WS4 Rust worker | WS1 and WS3 complete | WS2 |
| WS5 Gateway, leases, replicas | WS4 per-space serving | WS6 design |
| WS5b Pull freshness | Nothing | WS1, WS2, WS5's routing |
| WS6 Bus | A second consumer from WS5 |  |

WS1 to WS3 are the near-term commitments, and WS5b is the one part of the gateway work that does
not wait for Rust: it needs a short-lived response cache and a client that refetches on mount,
neither of which involves a lease. It ships ahead of the rest because the push path it replaces
is what makes WS5 expensive to build.

## 7. Verification

- **Rebuild-equality harness** at the end of WS1, WS3 and WS4, including TS against Rust. It lives in `packages/appserver/src/streams/rebuildEquality.ts`: `snapshotSpaceDb` reads every derived per-space table, `diffSnapshots` names the tables two readings disagree on, `digestOf` hashes one reading, and `materialiseAndDiff` composes the TS-only case (derive, rebuild through the blue-green path, diff). The WS4 runner uses the first three — snapshot the Rust worker's per-space DB, snapshot the TS one, compare — and needs no TS materialisation to do it.
- **Performance:** p95 per endpoint and DB round-trips per message, before and after WS2 and again after WS5.
- **Pull freshness (WS5b, verified):** the feed and the space list answer correctly with the frames suppressed — a
  remount after a write returns the new row, and a mount inside the TTL that covers no change is served
  from cache. The counter-check the same test holds is that suppressing the frames without the client
  change leaves a mounted feed frozen, which is what makes the two halves one change. Held by
  `packages/app-lite/e2e/pull-freshness.spec.ts` (mounted-feed-does-not-update, remount and refresh
  both do, and a held-open refetch keeps the last answer on screen) and, on the server side, by
  `src/e2e/deleteInvalidationStorm.test.ts` (zero frames, one eviction per batch).
- **Replication:** a test that unread counts do not inflate across replicas.
- **Failover:** a lease expiry test with an in-flight write, confirming a single writer is preserved.

## 8. Risks

- **Impurity relocated by an early port.** Mitigation: purity first, with the harness gating the port.
- **Protocol ingestion landing mid-rewrite.** Mitigation: the change-record interface in WS3 before WS4 begins.
- **A re-sort at the source swap** invalidates the golden files. This is expected and planned in the migration plan.
- **Pull freshness shows a stale feed for as long as the TTL.** Accepted: a feed is a view a
  reader opens, not a stream they sit in. The mitigation is the TTL being short and the mount
  and refresh paths both refetching — not a push frame. With the client half shipped, the
  residual window is a reader who leaves the feed open: they see what was true when it mounted
  until they press Refresh. That is the deliberate trade, and the refresh control is the answer
  to it.
- **Cache invalidation correctness** in the gateway, for the two pushed per-user cases and for
  the space-scoped views, which are unaffected.
- **Lease edge cases:** split brain, and lease expiry during a write.
- **Replication cost:** N times the storage and materialisation volume, and per-space databases are deliberately outside Litestream.
- **Cache invalidation correctness** in the gateway.

## 9. Open questions

1. ~~Do `getSpaces` and `getActivityFeed` need a gateway-side rollup projection, or is fan-out with caching fast enough?~~ Answered: neither needs one, because both are pulled rather than pushed (§4). Fan-out over workers with a short-TTL cache is the whole mechanism, and `getSpaces`' remaining question is only whether its unread badge needs a push frame while a page sits open.
2. What are the p95 targets for each endpoint?
3. What is the invalidation signal contract and transport before a bus exists?
4. How does `last_read` reach the worker, as a query parameter or by ingestion?
5. Which purity items belong to which of steps 2 to 5?
6. What do the pending research jobs on JetStream, Rust building blocks and deployment reality change?

## 10. Housekeeping

- Add a one-line pointer in appserver-architecture.md to this document and the migration plan, and mark its Phase 4 goal as superseded.
- Keep pure-materialisation.md as the detailed plan for WS1.
