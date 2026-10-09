# Near-Term Plan: Read-Path Throughput and Replicable Space Workers

*Draft for review. Companion to 'Roomy Protocol Migration Plan: Records as Source of Truth'. A one-line pointer to both documents goes into appserver-architecture.md, replacing its Phase 4 goal ('hand off to Rust appserver').*

## 1. Purpose and baseline

The goal of this work is horizontal scale-out of the read and connection plane. The measured pain is on the read path, not write throughput:

| Measure | Baseline |
| --- | --- |
| `space.getActivityFeed` | p95 3.1s |
| `space.getThreads` | p95 3.4s |
| `room.getMetadata` | p50 7ms, p95 349ms |
| Fan-out per live message, per client | 7 WebSocket frames, 5 of them invalidations, about 137 DB round-trips |

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

**Invalidation.** Worker-to-gateway signals replace process-local invalidation, which is what blocks multi-process today. The signal should be coarse and coalescable so that one live message no longer causes five separate invalidations per client.

## 5. Workstreams

### WS1. Finish pure materialisation

Remaining impurities, from the earlier scaling analysis:

- `setHandle` still writes `comp_space.handle` with no event.
- Unread counters are still incremented and decremented. Step 3 makes them a recomputation from `last_read`.
- `comp_embed_link_data` has no log provenance and is read on the message and activity-feed hot paths.
- Profile hydration still runs on the live write path.
- Search, embed and push are still process-local queues.

The mapping of these items to steps 2 to 5 follows pure-materialisation.md. **Acceptance:** the rebuild-equality harness passes, meaning the same log prefix and the same schema version give a byte-identical projection.

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
| WS6 Bus | A second consumer from WS5 |  |

WS1 to WS3 are the near-term commitments. WS4 to WS6 are staged without dates.

## 7. Verification

- **Rebuild-equality harness** at the end of WS1, WS3 and WS4, including TS against Rust.
- **Performance:** p95 per endpoint and DB round-trips per message, before and after WS2 and again after WS5.
- **Replication:** a test that unread counts do not inflate across replicas.
- **Failover:** a lease expiry test with an in-flight write, confirming a single writer is preserved.

## 8. Risks

- **Impurity relocated by an early port.** Mitigation: purity first, with the harness gating the port.
- **Protocol ingestion landing mid-rewrite.** Mitigation: the change-record interface in WS3 before WS4 begins.
- **A re-sort at the source swap** invalidates the golden files. This is expected and planned in the migration plan.
- **Cross-space endpoints as scatter-gather** may be too slow, in which case a gateway-side rollup projection is needed.
- **Lease edge cases:** split brain, and lease expiry during a write.
- **Replication cost:** N times the storage and materialisation volume, and per-space databases are deliberately outside Litestream.
- **Cache invalidation correctness** in the gateway.

## 9. Open questions

1. Do `getSpaces` and `getActivityFeed` need a gateway-side rollup projection, or is fan-out with caching fast enough?
2. What are the p95 targets for each endpoint?
3. What is the invalidation signal contract and transport before a bus exists?
4. How does `last_read` reach the worker, as a query parameter or by ingestion?
5. Which purity items belong to which of steps 2 to 5?
6. What do the pending research jobs on JetStream, Rust building blocks and deployment reality change?

## 10. Housekeeping

- Add a one-line pointer in appserver-architecture.md to this document and the migration plan, and mark its Phase 4 goal as superseded.
- Keep pure-materialisation.md as the detailed plan for WS1.
