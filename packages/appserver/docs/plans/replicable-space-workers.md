# Near-Term Plan: Read-Path Throughput and Replicable Space Workers

**Status (2026-10-22):** WS1 complete — purity Steps 1–5 are merged (#338, #405, #403, #422, #436), and the acceptance oracle `src/streams/rebuildEquality.ts` is reusable (#424). WS2 mostly merged: R1/R2/R3/R6/R7 of `denormalised-read-projections.md` are in `next`; R4 was measured and deferred as below value. WS5b is written and in review (#454). WS3's record kind, op and `repo` mapping is settled (§5 WS3) and its implementation has not started; WS4 waits on WS3 plus the Rust building-blocks research, which has not been done.

**Next:** WS3 (the change-record interface) is the one gate before a Rust worker, and it is now unblocked. The companion plan is *Roomy Protocol Migration Plan: Records as Source of Truth* — muni-town/roomy#683, `docs/plans/atproto-spaces-migration-plan.md` on that branch — whose §5.1 fixes the `RecordChange` type. WS3 builds the adaptor for that model; it does not migrate the storage. See §5 WS3.

The storage migration itself is deliberately not scheduled. It waits for ATProto permissioned spaces to be deployed to users, because until then records cannot be the source of truth. `RecordChange` is defined now so the Rust worker is written once, against the input type the migration will hand it.

**Ownership of the ordering stamp.** The stamp is assigned at ingest — on the internal path in `StreamManager.sendEvents` (`stream_events.received_at` plus log idx), and on the protocol path from the client TID plus repo DID. The space worker never assigns one; it treats the stamp as opaque and sorts by it. That is what lets a worker be restarted, replaced or replicated without changing any ordering, and it is why the lease below is about write serialisation rather than about ordering authority.

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

- The materialiser's input is a change record with an opaque, sortable ordering stamp. Today the stamp comes from `received_at` plus log idx, assigned once at append; the worker reads it and never re-derives it.
- The log sits behind the narrow interface that already exists (`onEvents`, `getEventsFrom`, `append`).
- Projection rules are set-like: upserts keyed by entity id, reorder events that record the resulting key, and deletes treated as removal from a set.
- No derived value comes from an ambient clock or process-local state.

## 4. Target shape

**Gateway (the current appserver).** WebSockets, auth, user-scoped reads including read-state, and the cross-space endpoints (`getSpaces`, `getActivityFeed`), which fan out to workers and cache. It consumes invalidation signals from workers, routes per-space requests to the lease holder or a replica, and negotiates leases.

**Space worker (Rust).** Materialises per-space databases from change records, serves per-space XRPC reads, computes unread counts from `last_read`, and emits invalidation signals.

**Lease per space.** Use the conditional-upsert pattern already in the tree, `workers/lease.ts` over `worker_leases` (`schema-global.sql`). A lease has failure semantics where a hash does not: when it expires another worker can take over. The lease is over **applying change records to the per-space DB**, so that one space has one writer and one total order of projection. It is not over the ordering stamp — that is assigned at ingest, upstream of any worker, and is carried in the record (§ above). A worker that loses and regains a lease resumes from the ingest stream and produces the same projection it would have produced without ever losing it; that is the property the lease's simplicity depends on.

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

**This is an adaptor, not the migration.** `RecordChange` (migration plan §5.1) becomes the materialiser's only input type while `stream_events` remains the source of truth. The storage migration is Stage 3 of that plan and waits on ATProto permissioned spaces reaching users; the adaptor is what lets the Rust worker be written against the final input shape now, and nothing about it is discarded at the swap — the internal producer is replaced by the HappyView producer, and the materialiser is unchanged.

The type, from the migration plan §5.1:

```
RecordChange {
  repo: DID
  collection: NSID
  rkey: string
  op: create | update | delete
  cid?: CID
  prev?: CID
  rev?: TID           // cursor and per-repo ordering only, never the sort key
  orderStamp: string  // opaque, sortable, assigned at ingest
  record?: object     // present for create and update
}
```

Work, in order. The unit is the **record object**, not the event type: 47 event types collapse to 16 record kinds (`message`, `reaction`, `room`, `spaceInfo`, `spaceSidebar`, `membership`, `ban`, `invite`, `role`, `roleGrant`, `roomPermission`, `federationRequest`, `federationGrant`, `profile`, `calendarLink`, `voiceCall`), and each kind gets one create, one update and one delete rule rather than one materialiser per event.

1. **Define the record kinds and their keys.** For each kind: its collection NSID, what `rkey` is (the message id, the role id, `<user>/<role>` for a grant), and the record body's fields. This is the lexicon workstream the migration plan §6 calls for, and it is what the adapter maps onto. Four shapes do not survive the move unchanged and are decided here:

   - **`deleteRoom` is a soft delete, and the record must say so.** Today `deleteRoom` sets `comp_room.deleted = 1` and `restoreRoom` sets it back to `0` (`sdk/src/schema/events/room.ts`); the room entity and its messages stay. Restoring is a product feature the client already supports — `getMetadata` returns a `deletedRooms` list (`space.roomy.space.getMetadata.ts:340-353`) that `RestoreRoomModal.svelte` renders. So the room record carries a `deleted` boolean and both events are **`update`**, never `delete`; `op: delete` is not used for rooms at all. The migration plan's "deletes are removals from a set" does not conflict — a soft-deleted room is still in the set, and its removal would be a hard delete that nobody performs today.
   - **`roomLink` is a `parent` field on the room record, not its own kind.** `createRoomLink`/`removeRoomLink` become **updates to the linked room's record**. Two consequences the mapping must not lose. First, the link edge is a real access input: `roomAccess` resolves a thread's effective access through its canonical parent (`auth/access.ts:300-310`), and a thread may not grant more than its parent — so `parent` is load-bearing for authorization, not presentation. Second, **today's materialiser also writes a system message** (`link.ts`: an `entities` row plus `comp_content` saying "created [name]" or "linked to [name]"), and that message is real content with an author edge. Collapsing the events to a room update alone would delete that message from every room's history; the adapter must emit the room update *and* keep the system message as a `message` create. The alternative — dropping the system message — is a product change, not an adaptor one.
   - **Multi-parent is expressible today and a single `parent` is not.** The edge table holds one `link` row per `(head, tail)` pair, so a room can be linked from several parents; `canonical_parent` marks whichever link was written first, and every reader filters on it (`activityItem.ts:97`, `search.rooms.ts:159`, `access.ts:302`, `roomAccessProjection.ts:120`). No producer emits a second link today — `createRoomLink` has exactly one caller (`app-lite/src/lib/mutations/thread.ts:42`, always `isCreationLink: true`) and `removeRoomLink` has none — so a single `parent` field is correct *now*. If linking an existing room under a second parent ever ships, the field becomes a list and the canonical rule has to be re-stated; the adapter should assert single-parent rather than silently last-write-wins.
   - **`moveMessages` is one event per message, so N updates plus N deletes is what already happens.** The schema caps `messageIds` at one entry (`.atMostLength(1)`, pending LibSQL TVFs) and the client emits one event per message (`app-lite/src/lib/mutations/message.ts:291-310`). Nothing about the record model makes a batch harder, so no special expressiveness is needed.

   **Two changes from one event is the seam's designed cardinality, not a special case.** The producer is `LoggedEvent → RecordChange[]`, so `createRoomLink` returning a `room` update plus a `message` create is the same shape as `federation.remove` deleting two kinds and `setRoleRoomPermission` emitting a delete (below). Nothing downstream assumes one record per event. The two changes also target different rooms — the `room` update its `linkToRoom`, the `message` create the linking room — so a rule must key each change by its own record, never by the event's `room`.

   The system message's author is the **space**, not the acting user: `link.ts` writes the `author` edge as `select ${event.id}, ${streamId}, 'author'` while the body text names the user as a markdown mention. Under the derived-`repo` rule that makes its `repo` the space's. The record body therefore has to carry the acting DID as a field — recovering it by parsing the mention out of the markdown is not acceptable, and the space DID cannot stand in for it. This is the one place where the current projection already loses information the record model needs, so flag it in the adapter rather than reconstructing it.

   The full event-to-record mapping. Several event types collapse onto one record kind; the columns say which op the adapter emits. `space.roomy.state.markRead.v0` and the two synthetic types are absent deliberately (step 5).

   | Record kind | Created by | Updated by | Deleted by |
   | --- | --- | --- | --- |
   | `message` | `createMessage`, `forwardMessages` (forward attachment), `createRoomLink` (system message) | `editMessage`, `moveMessages` (room) | `deleteMessage` |
   | `reaction` | `addReaction`, `addBridgedReaction` | — | `removeReaction`, `removeBridgedReaction` |
   | `room` | `createRoom` | `updateRoom`, `deleteRoom` (soft), `restoreRoom` (soft), `createRoomLink`/`removeRoomLink` (`parent`) | — (no hard delete) |
   | `spaceInfo` | `updateSpaceInfo` | `updateSpaceInfo` | — |
   | `spaceSidebar` | `updateSidebar.v1` | `updateSidebar.v1` | — |
   | `membership` | `joinSpace`, `addAdmin` | `addAdmin`, `removeAdmin` | `leaveSpace` |
   | `ban` | `banAccount` | — | `unbanAccount` |
   | `invite` | `createInvite` | — | `revokeInvite` |
   | `role` | `createRole` | `updateRole` | `deleteRole` |
   | `roleGrant` | `addMemberRole` | — | `removeMemberRole` |
   | `roomPermission` | `setRoleRoomPermission` (non-null) | `setRoleRoomPermission` (non-null) | `setRoleRoomPermission` (null) |
   | `federationRequest` | `federation.request` | `federation.respond` | `federation.remove` |
   | `federationGrant` | `federation.setRoomPermission`, `setReceiverPermission` | same | `federation.remove` |
   | `profile` | `updateProfile` | `updateProfile` | — |
   | `calendarLink` | `openmeet.configure` | `openmeet.configure` | — |
   | `voiceCall` | `callStarted` | `callJoined`, `callLeft` | `callEnded` |
   | *(no record)* | `setHandleProvider`, `editPage` — retired; `reorderMessage` — see below | — | — |

   Three observations from building it. `updateSidebar.v0` and `.v1` are the same record kind with a schema change, so the adapter maps both and the `v0` form is a legacy producer only. `setRoleRoomPermission` with a null permission is a **delete**, which is what makes the current materialiser's "delete then maybe insert" (`roles.ts`) two different ops on the same record. And `federation.remove` deletes two record kinds at once, which is fine — one event, several changes.

   Three event types are deliberately not carried into the record model, by decision rather than omission: **`handleProvider`** (space handles are DID- and DNS-derived; the user-leases-their-handle-to-a-space feature is retired, and `setHandleProvider` writes a `comp_space.handle_provider` column with no readers), **`pageEdit`** (the client has not supported pages for some time and the appserver has no `comp_page_edits` reader at all), and **`reorderMessage`** (below). All three remain accepted at the write path and keep their current materialisers; the adapter maps them to **no record**. `updateSidebar.v0` stays mapped only because v1 has the same kind and the v0 form is a legacy producer.

   **`reorderMessage` is out of the record model; `moveMessages` stays.** Neither has a producer beyond the SDK operation — the client and the Discord bridge emit no reorder, and `moveMessages` is reachable only from an admin UI action — so nothing is lost by narrowing the mapping.

   `reorderMessage` is dropped for a reason specific to this work: it is the only event whose key is *derived from its neighbours*. The current materialiser reads the `after` entity's `sort_idx` and the key that sorts next, and takes a midpoint (`sortIdx.ts:236-297`). §6 of the migration plan requires the record to carry the resulting key, because a worker that recomputes from neighbours produces a different answer once the neighbours arrive in a different order — and the replay guard already refuses to reconstruct such a key in place (`spaceMigrations.ts:206-210` forces a full rebuild for any space with one reorder in its log). Keeping it in the mapping would mean either a worker rule that cannot be expressed as "the record carries the key" or an ingest-side computation that duplicates the materialiser. Drop it: `reorderMessage` maps to **no record**, stays in `ALLOWED_TYPES` and is materialised today exactly as now, and becomes a curator record on the space repo if the feature is ever exposed.

   It was also gated too widely, and that part is fixed: `space.roomy.message.reorderMessage.v0` used to sit in `ROOM_WRITE_TYPES`, so any member who could post could reposition any other author's message — the same class of act `moveMessages` reserves for space admins (`checkMoveMessages`). It now dispatches to `requireSpaceAdminCheck` like a move does, in `writeAuth.ts`. That is the whole change to the write path; the event is still accepted and materialised as before.

   `moveMessages` stays in the mapping, with the interim shape recorded at Q9: an action by an admin over another author's content cannot live in that author's repo, so the adapter writes the updated `message` record with the **space** as `repo` until Stage 3 settles where curator actions live.
2. **Define the type and its producer seam.** One `RecordChange` type; one function `LoggedEvent → RecordChange[]`. `orderStamp` is `received_at` plus log idx, encoded so it sorts as a string — the value `sortIdx.ts` already derives, lifted into the record rather than read back out of `stream_events`.

   Two things the adapter must get right, because they are the differences between the internal and the protocol path:

   - **`repo` has to be derived, not copied.** The internal log is per-*space*: `sendEvents` asserts `streamDid = spaceId` and appends every event to that one stream (`space.roomy.space.sendEvents.ts:198-207`). The protocol log is per-*repo*, and the migration plan splits member content (user repos) from collective records (the space repo, §8). So the adapter derives `repo` from the event — the author DID for member content, the space DID for collective records — rather than passing the stream DID through.
   - **The stamp is opaque and the two formats disagree.** Internal: server-observed `received_at` plus log idx. Protocol: client TID plus repo DID (migration plan §7). They order the same log differently where a sender's clock is off, which is why that plan expects one re-sort and new golden files at the source swap. A materialiser may sort *by* the stamp but never parse it or re-derive a key from it.
3. **Write the projection rules per record kind.** Create/update/delete for each kind, computed from the record body plus the state the worker already holds. **This is not a rehosting of the current SQL, and three cases prove it:**

   - **`deleteMessage` cannot be a delete.** Today it is two `delete from entities` statements plus an appserver-side rebuild of two projections (`deleteMessage.ts:22-46`, `rebuildActivityWindow` then `rebuildRoomActivity`). Rules 5 and 4 of the migration plan (deletes are removals from a set; derived state must not remember a deletion, because a snapshot never sees one) mean the rule must recompute the affected room's window from what remains — a query, not a delete.
   - **`editMessage` is a read-modify-write that needs a SQL function that does not exist.** The materialiser calls `apply_dmp_patch(...)` (`message.ts:218`, `page.ts:47,50`); **nothing in the repository defines it** — not in the appserver, not as a SQLite extension, and Bun's SQLite rejects it (`no such function: apply_dmp_patch`). No client sends `text/x-dmp-patch`. The rule must be restated as "replace the content with the record's body", which is what actually happens.
   - **Three projection steps live outside the materialisers entirely** — `setMessageSortIdxByReorder` (`applyBundle.ts:155`), the delete/move activity-window rebuilds (`deleteMessage.ts`, `moveMessages.ts:119`), and the `sort_idx` update in `applyBatch.ts:218`. A worker implementing only the record rules would miss them. They must move into the rules, or the Rust worker reproduces the TS worker only by accident.
4. **Delete the log-position dependency.** A rule may read `orderStamp`; nothing else. `applyBatch.ts:218` and `StreamManager`'s `received_at` stamping both collapse into the stamp carried on the record.
5. **Decide what produces no record.** `space.roomy.state.markRead.v0` is rejected at the write path (`writeAuth.ts:44-46`; `updateSeen` is the real receipt write) and read receipts stay gateway-side. The two synthetic types have no live producer (§9 Q7). None of the three becomes a record, and the adapter should say so rather than invent a representation.
6. **Retire the SDK's event materialisers from the worker path.** `getMaterializer` has exactly one importer in the repository (`materialization/materializer.ts:33`) and no client-side user, so the worker can stop calling it. That is **not** the same as deleting it: it is exported from `@roomy-space/sdk` (`schema/index.ts:51`) and appears in the published `dist`, so removing it is a breaking change to a public package. The plan is to leave it exported, stop calling it, and decide its removal when the SDK next takes a breaking release — the migration's Stage 3 is where the event shape stops being a thing the SDK owns at all.

**Acceptance:** the rebuild-equality harness passes byte-for-byte with records as the only input, **and** the worker no longer imports `getMaterializer`. The projection output is unchanged, so the golden files are unchanged — the input type and the rule's shape change, not what they produce. That last property is what makes this safe to do before the Rust port.

**Explicitly out of scope:** replacing `stream_events` with HappyView ingest (migration Stage 1), the Open Social record model (Stage 2), moving member content to user PDSes (Stage 3). The adaptor is validated by the fact that Stages 1–3 replace its producer and leave its consumer alone.

**Staging.** This is delivered as a sequence of PRs that are individually safe, not one cutover:

| Slice | Content | Gate |
| --- | --- | --- |
| S1 | `RecordChange` type, the adapter, and the record-kind definitions. Producer wired but not consumed. | Adapter round-trip test: replaying today's corpus through the adapter and back reproduces today's projection byte-for-byte. |
| S2 | Projection rules for one record kind at a time, largest first (`message` — 6 event types, 31 statements, both non-trivial cases above). The worker switches that kind over and drops its event materialiser. | Harness byte-identical + that kind's tests. |
| S3 | Remaining kinds; the worker stops calling `getMaterializer` (left exported, see step 6). | `grep` shows no worker-side importer; harness byte-identical. |

Each slice leaves one input type per code path — the adapter sits upstream of every rule — so there is no runtime dual mode and no flag. A kind that has not been converted still reads events; a kind that has been converted reads records; the same request never sees both.

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
4. ~~How does `last_read` reach the worker, as a query parameter or by ingestion?~~ Answered: as a **query parameter**, and the code already has that shape. Read receipts stay in the gateway (`roomy-readstate.sqlite`; the user's PDS after migration Stage 4), and only the watermark crosses: `deriveUnreadCounts(spaceDb, queries)` (`queries/readPositions.ts:83`) takes `[{roomId, seenUpTo}]` and counts `entities where room = ? and sort_idx > ?` against the per-space DB. Unread is therefore a pure function of worker-local data plus a caller-supplied integer — it never needs the receipt as state, and it must not be cached in the worker, because the same space is read by many users with different watermarks.
5. Which purity items belong to which of steps 2 to 5?
6. What do the pending research jobs on JetStream, Rust building blocks and deployment reality change?
7. **Are synthetic events (`space.roomy.query.spaceMeta.v0`, `space.roomy.query.profile.v0`) still reachable at all?** They are a leftover of the client-side materialisation architecture: `synthetic.ts` is 439 lines, `getSyntheticMaterializer`/`syntheticEventRegistry` have **zero** consumers outside their own module, and neither type is in `eventRegistry`, so `getMaterializer` never returns one. Four references survive in the appserver — one `MEMBERSHIP_EVENT_TYPES` entry (`applyBatch.ts:78`), one `roomAccessProjection` table (`:87`), one signal-suppression prefix (`inferSignals.ts:68`), and the comment at `applyBatch.ts:68`. They should be deleted rather than carried into the record model, where an event that is neither a record nor a log entry has no place. Not deleted as part of this plan because the `space_stats` member-count gate explicitly preserves their historical absence (`spaceStats.ts:30-40`); removing them is a separate, verifiable change.
8. **Where does the gateway's `space_stats` member count come from once the worker owns the edges?** Today `space.roomy.admin.listSpaces` reads a global aggregate maintained by `applyBatch` at write time. Under the target shape that aggregate is a per-space worker query that the gateway would have to fan out for a dashboard page. Not urgent, but it is the same fan-out shape §4 decided against for `getSpaces`, so it should be decided with it rather than after.
9. **Where do curator actions live once records are the source of truth?** `moveMessages` rewrites another author's content and is authorized as space admin. The migration plan's model has member content in the author's own repo, which cannot express authority over a record its owner did not write. Options: the space repo carries the action (a "moderation" record naming the target), the author's repo carries it and the space's policy is consulted at read time, or the action stays an appserver-side overlay. Flagged, not resolved — the interim adapter writes the updated `message` record with the space as `repo`, which is correct today and will need revisiting at migration Stage 3. `reorderMessage` was the second case here and is out of WS3 (§5 WS3): its key comes from its neighbours, so it cannot be carried as a record until the feature is designed, at which point it becomes a curator record on the space repo like the above.
10. **Does `spaceSidebar` belong to the space repo, and `parent` too?** Both are collective configuration (sidebar ordering, thread parent), so presumably the space repo — but `createRoomLink` is authorized as room write, which suggests the linked room's authors can set it. Worth settling when the record lexicons are written.

## 10. Housekeeping

- Add a one-line pointer in appserver-architecture.md to this document and the migration plan, and mark its Phase 4 goal as superseded. (Done, with the pointer to `atproto-spaces-migration-plan.md` pending that plan's merge.)
- Keep pure-materialisation.md as the detailed plan for WS1.
- Delete the synthetic-event module (`sdk/src/schema/events/synthetic.ts`) once the `space_stats` member-count gate is re-derived without it; see §9 Q7. Its only live effect is preserving the absence of a `comp_space` row for ~2,700 spaces.
