# Roomy Protocol Migration Plan: Records as Source of Truth

**Date:** 2026-10-09
**Status:** Draft for review. Companion to 'Near-Term Plan: Read-Path Throughput and Replicable Space Workers'. Once agreed, this succeeds the Phase 4 goal in appserver-architecture.md ('hand off to Rust appserver'), which will carry a one-line pointer here.

## 1. Purpose and status

Today the appserver is the origin of events: clients call `space.roomy.space.sendEvents`, the appserver validates, appends to `stream_events`, and materialises inline. The target is for the appserver to own approximately none of the source-of-truth data. Source of truth moves into ATProto permissioned-space repos, and the appserver becomes an indexer and read-serving layer downstream of them.

This document records the target, the decisions already made, what is out of scope, and a staged path. It commits to a design, not to dates. The one timing anchor is the intent to begin protocol-native ingestion of permissioned-space records in roughly two months. The full migration cannot finish until Bluesky finalises the spaces spec and it is deployed to users, with other PDS providers expected to follow.

## 2. Goals and non-goals

**Goals**

- Records in permissioned-space repos are the source of truth. The appserver derives, caches and serves.
- Interoperate with the Open Social groups standard by using its role and membership records, extending only where Roomy needs to.
- Keep the projection a pure function of its input, so a snapshot at N and a fold of commits 1..N agree (batch-invariance) in the happy path, where Roomy has constant access to the repos in a space.
- Never force the Rust worker to be written twice.

**Out of scope for this migration**

- Adversarial PDSes or hostile authors. Honest operation is assumed, and moderation decisions are deferred with this.
- A witness or timestamping connector, and labels.
- As-of authorization semantics, hash pointers on member records, authority-written ledgers, and grace windows for late writes.
- Durability guarantees for source-of-truth data. Once on protocol, durability serves availability only.

## 3. Principles

1. **The arbiter is write authority for the space repo.** Users are authority for their own repos. The appserver holds no write authority over source-of-truth data.
2. **Records are mutable.** There is no append-only log semantics. Any event log is a cache plus an ingest-time ordering record.
3. **The projection is a pure function of its input.** No derived value may come from an ambient clock or process-local state.
4. **Hide, do not drop.** Records that fail an authorization check are not served but stay materialised.
5. **Deletes are removals from a set.** Derived state must not depend on remembering a deletion, because a snapshot never sees one.
6. **Narrow interfaces.** One change-record input type and one ordering-stamp contract isolate the system from the source.

## 4. Target architecture

| Actor | Role |
| --- | --- |
| User PDS (repo host) | Holds each user's own records for a space: messages, reactions, edits, and eventually read-state. The user is authority. |
| Arbiter / space host | Holds collectively owned records in the space repo: membership, roles, channel configuration, policy, space profile. Evaluates the Rego policy on proxied writes. Write authority for the space repo. |
| HappyView | Receives write notifications. The change-feed source for Roomy ingest. |
| Gateway (the current appserver) | Sockets, auth, user-scoped reads, cross-space queries by fan-out and caching, lease negotiation, invalidation. |
| Space worker (Rust) | Materialises per-space state from change records and serves per-space read queries. Replicated under a lease per space. |

Collective records go through the arbiter to the space repo. Member content is written by the user to their own PDS. Both produce write notifications, which HappyView receives and Roomy consumes as a stream of change records.

## 5. Ingest

### 5.1 Change-record input type

The materialiser consumes one input type, produced today by the internal append path and later by the HappyView source:

```
RecordChange {
  repo: DID,
  collection: NSID,
  rkey: string,
  op: create | update | delete,
  cid?: CID,
  prev?: CID,
  rev?: TID,          // cursor and per-repo ordering only
  orderStamp: string, // opaque, sortable, assigned at ingest
  record?: object     // present for create and update
}
```

The internal path fills `orderStamp` from `received_at` plus log idx, as today. The protocol path fills it from the client TID plus repo DID. The materialiser treats it as opaque.

### 5.2 What the spec gives us

From the draft permissioned-spaces spec:

- `listRepoOps` returns a per-repo operation log since a `rev`: entries of `{rev, collection, rkey, cid, prev}`, with record values inlined by default. Ops from one atomic write share a rev.
- A response that includes the repo's last op must include the signed commit. Comparing its `hash` with a running LtHash over the local copy verifies the sync is exact.
- The oplog is a transport optimisation. Hosts may compact or drop it, keeping only a backfill window, and it resets on account migration. When `since` is not found, the fallback is full-state recovery via `getRepo`.
- Revs are TIDs. A write notification's rev must increase monotonically and must not be in the future beyond a short skew window. A snapshot carries one commit rev for the whole repo and no per-record revs.
- The space host sequences notifications with a space-level rev and supports gap detection through `listRepos` with a `since` cursor.

### 5.3 Consequences

- Revs serve as an ingest cursor and for last-write-wins on edits. They are not the message sort key, because a snapshot cannot reproduce them.
- Roomy keeps per-repo state: the last rev and a running LtHash (a 2048-byte buffer) per (repo, space).
- Full-state recovery is a first-class path, not an exception.

### 5.4 HappyView

HappyView is the chosen source, and the interface to design against. Whether Roomy pulls from it with a cursor or receives a subscription does not change the materialiser's input. The questions to ask HappyView are in section 12.

## 6. Record model

**Use as defined by the Open Social groups proposal** (the `group.opensocial` namespace): `membership`, `acceptance`, `role`, `permissions`, `space` (index) and `access` in the members space, plus `profile` and `rule` in the meta space. Authorization is flat RBAC. A member's permissions are the union of the actions granted by their roles, with no deny rules or precedence.

**Roomy modality records**: messages, reactions, edits, threads, channel structure, embeds and so on, in Roomy's own modality space or spaces. The proposal leaves modality write authorization to each modality's lexicon, so Roomy defines it, using group roles where it wants.

**Event-to-record mapping principles**

- Create, edit and delete events become create, update and delete ops on keyed records.
- Reorder events record the resulting key rather than relying on a midpoint recomputed from neighbours.
- Anything currently written without an event (for example a space handle) becomes a record.
- Record schemas come from a lexicon workstream running alongside this plan. The proposal's lexicons are still draft, and its identity-and-authz and records-and-actions branches have not yet been reviewed.

## 7. Ordering

- **Sort key:** `(client TID, repo DID)`, carried in the ordering stamp. The TID is either the rkey or a `createdAt` field (open question). It lives in the record, so fold and snapshot compute the same value.
- **Why not revs:** they exist only in the oplog, which has no guaranteed retention, and one rev covers a whole commit. Using them would make the change log irreplaceable.
- **Accepted trade-off:** a client with a wrong clock can misplace a message in history. This is the failure Step 1 of pure materialisation removed by using the server's accept time. With adversaries out of scope, only honest clock error applies. Roomy's own client can check its clock against the PDS response Date header before minting a TID.
- **Existing history:** when spaces migrate to records, each message's time value (or minted TID) is written from its Step 1 sort time, so migrated history keeps its corrected order.
- **At the swap:** positions change only where the two orders disagree. Expect one re-sort (a schema version bump) and new golden files for the equality harness.

## 8. Authorization semantics

The scoped-down stance keeps this simple.

- **Collective records** (membership, roles, permissions, channel config, pins) are written by the group DID through the arbiter. The arbiter accepted them when they were written, so they are not re-judged downstream. They live in one repo, where a single writer and monotonic revs make last-write-wins well defined.
- **Member content** is valid if its author is currently a member with the permission the action needs. Validity is a function of final state, so fold and snapshot agree with no ordering of authorization history.
- **Derived, not decided at ingest.** A message can arrive before its author's membership record, because they live in different repos. Validity is therefore recomputed when membership or roles change, either as a read-time join or as a materialised column updated on join, leave and role change.
- **Leaving a space:** the member's content is hidden, not purged. It returns if they rejoin and still hold the records.
- **Known consequence:** revocation, ejection and demotion apply retroactively to old content. Role-gated writes are assumed to be judged the same way, which is open (section 12).

## 9. Read-state

Read-state ends up on the user's PDS as mutable records. Because records are mutable, the bloat that justified a separate store disappears.

- For now only `last_read` is stored. Unread counts are computed by the space worker from `last_read` plus the space's records, and are never incremented. This removes the N-times unread inflation that replication would otherwise cause.
- Until the PDS move, `last_read` stays in `roomy-readstate.sqlite` behind the gateway. The PDS move is then a storage swap, because the interface (supply `last_read`, receive counts) does not change.
- How `last_read` reaches the worker, as a query parameter or by ingesting the user's read-state records, is settled when the PDS move is planned.

## 10. Staged path

The near-term plan covers stage 0.

| Stage | Content | Gate |
| --- | --- | --- |
| 0 | Finish purity, read-path fixes, change-record interface, Rust worker and gateway shape | Near-term plan |
| 1 | Shadow ingest: consume HappyView's feed in staging alongside the internal path and compare derived state | HappyView ingest available for permissioned spaces |
| 2 | New spaces use the Open Social membership and role records. Collective writes go through the arbiter | Arbiter ready, lexicons settled |
| 3 | Member content written to users' own repos. Re-sort and new golden files at the swap | Spec finalised and deployed to enough users |
| 4 | Read-state on the PDS | Storage swap behind a stable interface |
| 5 | Internal append path retired. The log is a cache | Confidence from shadow comparison |

Timing for stages 2 to 5 depends on Bluesky and other PDS providers and is deliberately not dated.

## 11. Verification

- **Rebuild-equality:** the same input and schema version give byte-identical projection, and identical output between TS and Rust. This covers the port, not the source swap.
- **Batch-invariance harness (new):** for a set of repos, ingest all ops in order, ingest a single snapshot, and compare. This covers the source swap. Message position is the one place equality is relaxed, because it depends on stored stamps.
- **Shadow comparison in stage 1:** run the internal path and the HappyView path side by side and diff projections.

## 12. Open questions

1. Does HappyView expose a subscription, or only pull with a cursor? What retention and ordering guarantees does it offer, and does it keep per-record revs?
2. Do message records carry a client-minted TID as the rkey, or a separate `createdAt`?
3. Are role-gated writes judged against current state (assumed), or do they need as-of semantics?
4. Is validity a read-time join or a materialised column?
5. Do the Open Social lexicons tolerate extra fields, and what do the identity-and-authz branch and the access-sync discussion add?
6. Do revs stay monotonic across account migration, and is there a minimum oplog retention?
7. Should a history or sequence field be proposed upstream? Nothing in the working-group threads read so far discusses authorization history.

## 13. Decisions recorded

| Decision | Status |
| --- | --- |
| HappyView is the change-feed source, receiving write notifications | Decided |
| Arbiter is write authority for the space repo, users for their own repos | Decided |
| Use Open Social role and membership records | Decided |
| No hash pointer, witness, labels, grace window or as-of semantics | Decided |
| Ordering key is client TID plus repo DID, and history keeps its Step 1 time | Decided |
| Read-state moves to the PDS, with only `last_read` for now | Decided |
| Events are remodelled as change records | Decided |
| Role-gated writes judged against current state | Assumed |
