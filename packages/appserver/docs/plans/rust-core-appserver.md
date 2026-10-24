# Provisional Plan: Rust Core Appserver

**Status (2026-10-23):** Provisional, for review. Nothing in this plan is implemented
beyond the space worker's materialisation core (PR #530) and the per-space read
router (`crates/space-xrpc`, #531). The design questions in §7 are open.

**Scope.** The Rust rewrite of the appserver's core: the gateway (XRPC edge,
WebSocket connection plane, auth, user-scoped and cross-space reads, write
ingress) plus the space worker that materialises and serves per-space data. It
does not attempt to port search, push transports, billing, voice control, link
unfurling or the admin dashboard; §10 says what stays outside.

**Goal.** One set of crates that can run as:

1. a single binary with the gateway and its space workers in one process, and
2. the same gateway with workers as separate processes on separate machines,

without changing the projection rules, the read queries or the XRPC contract.
Horizontal scale is a deployment choice, not a second implementation.

**Summary of recommendations.**

- **The worker can be embedded.** The seams (`ChangeFeed`, `Lease`, `GlobalSink`)
  are the right boundary; what blocks embedding is packaging, not design:
  process-global config and stop flag, a concrete `SpaceDb` field, a single-space
  XRPC state, and no signal/notification seam. §5 lists the changes.
- **The same crates scale out without a bus.** The feed becomes an HTTP pull
  behind the existing trait; the lease gains a fencing epoch; signals stay
  advisory. Correctness never depends on signal delivery, only freshness does.
- **`space-core` is sans-io; the worker is not, and the gateway should not be
  wholly sans-io.** Worth extracting: the sync session core, invalidation
  mapping, cache policy, and access decisions. Not worth abstracting: the HTTP
  and WebSocket transports. §3 gives the rule.
- **Composable crates, one direction of dependency.** Roughly fifteen crates,
  of which five are pure (no `rusqlite`, `tokio`, `axum`, `reqwest`). §4.
- **Correctness has five planes and only one has an oracle today.** Projection
  parity is proven; read, write, connection and distributed parity are the
  work. §6 defines the planes, the ten evaluation layers and their gates.
- **Fix three things before building on the existing work:** the worker's
  commit ordering, replay/batch equivalence, and the fact that derivation time
  is still ambient. §1.3, §6.5, §7 Q12.

---

## 1. What the port inherits

### 1.1 The gateway today

The TypeScript appserver is ~42k non-test lines (estimate) and 71 routes: 44 queries, 26
procedures and one subscription (`appserver.ts:207-547`). By role:

| Class | Count | Examples |
| --- | --- | --- |
| Per-space materialised reads | 24 | `space.getMetadata`, `room.getMessages`, `message.getMessage`, `federation.get*` |
| Cross-space / fan-out / external | 5 | `space.getActivityFeed`, `search.messages`, `mention.getMentions`, `user.getProfile`, `embed.getLinkMetadata` |
| User-scoped | 6 | `space.getSpaces`, `push.getPreferences`, `auth.getLoginScope` |
| Writes and procedures | 19 non-admin | `space.sendEvents`, `createSpace`, `joinSpace`, `room.updateSeen`, `reorderSpaces` |
| Admin / ops | 16 | `admin.*`, `sync.getEvents` |
| Connection | 1 | `space.roomy.sync.subscribe` |

The properties that make a multi-process gateway hard are all process-local
state:

- WebSocket connection, topic and stream indexes, and the per-connection frame
  `seq`, live in `sync/handler.ts:196-215`.
- Connection tickets are a 60-second in-memory `Map` (`xrpc/auth.ts:102-125`),
  so a ticket minted on one machine cannot be consumed on another.
- Invalidation listeners and the derived signals are in-process
  (`invalidation/router.ts:37-160`); signal inference reads materialised rows
  from the space DB (`invalidation/router.ts:95-155`), so it runs wherever the
  write was applied.
- The response cache is a process-local LRU (`cache/queryCache.ts:1-60`).

Writes have one ingress: `space.roomy.space.sendEvents` appends CBOR events to
`stream_events` and then materialises, infers signals, pokes the embed sweeper
and the push dispatcher, all inline under a per-stream promise chain
(`streams/StreamManager.ts:164-420`). The gateway and the materialiser are
therefore not separable today without inventing a post-commit boundary.

State is four SQLite families (`db/paths.ts:8-14`): the event log and the
read-state DB are source-of-truth; global and per-space DBs are derived. Only
the three static DBs are replicated by Litestream; per-space DBs are excluded
and rebuilt from the log (`litestream.yml`).

### 1.2 The Rust space crates

`crates/space-core` is genuinely sans-io: `serde`, `serde_json`, `thiserror`,
`base64`, `regex` and `roomy-events`, no database, runtime or network. Its entry
point is `plan(change: &RecordChange, ctx: &RuleContext) -> Vec<Effect>`
(`crates/space-core/src/rules/mod.rs:35-59`). Effects are SQL text plus bound
parameters (`SqlEffect`) and typed derived steps, each targeting either the
space DB or the global DB. Given a `RecordChange` and a `RuleContext`, output is
deterministic.

`crates/space-db` owns one per-space `rusqlite::Connection`, plans a batch by
reading the prior room/parent/call rows, applies all statements, then all
derived steps, then the cursor in one transaction (`space-db/src/lib.rs:139-171`),
and ports the rebuild-equality digest (`space-db/src/digest.rs`).

`crates/roomy-space-worker` supplies three IO seams — `ChangeFeed`, `Lease`,
`GlobalSink` (`roomy-space-worker/src/lib.rs:6-24`) — and the loop
(`worker.rs:95-240`). But it is packaged as a process: one space per process by
design (`config.rs:5-7`), env-only config, a global `STOP` flag
(`main.rs:18`), its own hand-written health listener, and a concrete
`SpaceDb` field (`worker.rs:81-89`). None of these are architectural; they are
the shape of a first binary.

`crates/space-xrpc` serves eight per-space read NSIDs through an axum router,
with a `CallerVerifier` trait, caller-supplied read positions on an internal
header, and byte-compatible DTOs. Its state is one fixed `Arc<SpaceDb>`
(`space-xrpc/src/state.rs:52-56`); `spaceId` is validated but never selects a
database, and the endpoint list is a compile-time slice
(`space-xrpc/src/lib.rs:50-59`). It deliberately leaves federation grants and
blocks to the gateway (`space-xrpc/src/access.rs:1-11`).

### 1.3 Defects to fix before the rewrite leans on them

- **Commit ordering is the reverse of its documentation.** `worker.rs` says the
  global half is written first and is idempotent (`worker.rs:205-208`), but the
  code commits the space batch and cursor first (`:209`) and applies the global
  sink second (`:210`). A crash between them leaves the space projection ahead
  of the global index. The plan's invariant (`replicable-space-workers.md:211`)
  is the opposite. This must be fixed, and the fix must be tested, before a
  crash-replay guarantee is claimed.
- **`is_backfill` is hard-coded to `false`** in `plan_batch`
  (`space-db/src/plan.rs:63-71`). Rebuilding a live space while serving it needs
  a decision: either replay writes read-path projections (wrong for live
  readers) or invalidate them as the TypeScript backfill path does.
- **Ambient clocks remain in materialisation.** Federation rules use
  `ctx.now_ms` (`space-core/src/rules/federation.rs:39,62,81`); derived steps use
  `unixepoch()` for `created_at`/`updated_at`. The digest drops those columns by
  name, so "byte-identical" is true only outside them. §6.5 treats this as a
  correctness gap to close, not a permanent exclusion.

---

## 2. Target shape

Two roles, one composition root:

```text
                        ┌─────────────────────────────────────────────┐
   client ── HTTP ─────▶│ gateway                                     │
   client ── WS ───────▶│  auth · session/topic registry · cache      │
                        │  user-scoped reads · cross-space fan-out    │
                        │  write ingress · routing to space owners    │
                        └───────────────┬─────────────────────────────┘
                                        │ in-process call (embedded)
                                        │ or ChangeFeed/Lease/Sink (split)
                        ┌───────────────▼─────────────────────────────┐
                        │ space worker (one per owned space)          │
                        │  feed → space-core::plan → space-db         │
                        │  per-space reads (space-xrpc)               │
                        │  post-commit signals                        │
                        └─────────────────────────────────────────────┘
```

**Gateway.** WebSockets, auth, user-scoped reads including read state, the
cross-space endpoints (fan-out + short TTL), the write path, and a routing table
mapping a space to the worker that owns it.

**Space worker.** Materialises one space from change records, serves the eight
per-space read NSIDs, computes unread from caller-supplied watermarks, and
emits a post-commit signal for the spaces it changed.

**Ownership.** A lease per space. Ordering is assigned at ingest, so a worker
that loses and regains a lease resumes from its cursor and lands on the same
projection. The lease serialises applying, not ordering.

### 2.1 Deployment modes

| Mode | Gateway | Workers | Coordination | When |
| --- | --- | --- | --- | --- |
| **Embedded** (default) | one process | N spaces per process, in-process | local SQLite + in-memory signals | until a second machine is needed |
| **Split** | one or more processes | worker pool, one or more spaces per process | `ChangeFeed` over internal HTTP + lease in a shared store + signal relay | when one machine cannot hold the write or read load |
| **Replicated reads** | as split | one writer per space, N read replicas following the owner | owner publishes its cursor; replicas tail it | when a hot space's read load exceeds one process |

The embedded mode is not a toy: the per-space worker loop and the gateway share
a process, but they still communicate through the same seams (`ChangeFeed`,
`GlobalSink`, signals) as the split mode. The in-process implementations are
just the shortest path through those traits. If the embedded path bypasses a
seam, that is a defect: it makes the split mode a second implementation.

**No bus is required for correctness.** Signals are advisory: a dropped signal
causes staleness until the next refetch or reconnect, never an incorrect answer.
Cross-space views are pulled, with a short TTL, per the existing decision
(`replicable-space-workers.md:69-73`). A bus becomes worthwhile only when the
signal fan-out or the feed transport itself becomes the bottleneck (§7 Q11).

### 2.2 Per-space ownership, not one process per space

The current "one space per process" (`config.rs:5-7`) is a testing convenience,
not a scale model: production has thousands of space DBs (~2,700 are referenced in
`replicable-space-workers.md` §10). A process should own a
configurable number of spaces, with:

- one **actor** per space: a dedicated blocking task owning the write connection,
  a command queue, and the loop;
- a bounded **read pool** per space (or a shared read-only connection guarded by
  a mutex, as `space-xrpc` does now) so reads do not queue behind writes;
- an **LRU registry** of open space DBs with idle unload, mirroring the
  TypeScript pool's hash-pinned workers (`db/pool.ts:41-60`). The hash is a
  deployment detail; ownership is the lease.

A supervisor owns the set: it starts and stops actors, renews leases, reports
health, and drains on shutdown. `main.rs`'s global `STOP` is replaced by a
cancellation token per space.

---

## 3. Sans-io: what is, what is not, and what is worth making so

| Component | Pure? | Status | Recommendation |
| --- | --- | --- | --- |
| `space-core` | **Yes** | No IO, no runtime, no ambient clock except `RuleContext.now_ms` | Keep. It is the model. |
| `space-db` | No | Blocking `rusqlite`; deterministic planning plus SQL execution | Keep as an executor; inject connections, do not run DDL on read replicas. |
| `roomy-space-worker` | No | Seams are right, packaging is process-shaped | Make a library: inject clock, cancellation, notifier, and DB handles. |
| `space-xrpc` | No | Blocking queries in async handlers | Make the space registry dynamic; move blocking reads to the DB actor/pool. |
| Gateway session/router | **Candidate** | Today entangled with sockets, DB and access checks | Extract a sans-io session core: subscriptions, seq, frame derivation, backfill cursor. |
| Invalidation inference | **Candidate** | Reads materialised rows inline | Make it a pure function of `(event, message snapshot, signal context)`; the adapter fetches snapshots. |
| Cache policy | **Candidate** | LRU + signal-driven eviction | Pure key/eviction decisions; the store is an adapter. |
| Auth decision | **Partly** | JWT crypto + DID resolution are IO | Pure decision given verified credentials and access facts; keep the verifier trait. |
| HTTP/WS transport | No | axum/tower | Do not sans-io the HTTP stack. |

**Decision rule.** Make a component sans-io when doing so buys determinism that
a test can exploit: the projection rules (already), sync frame derivation,
invalidation mapping, cache eviction, and access decisions. Do not make a
component sans-io merely to hide a socket; a pure core that needs an IO-filled
context for every call is an extra layer, not a testability win.

**`space-core` caveat.** It is sans-io but not storage-agnostic: it emits SQL
text and parameter values against `schema-space.sql`. That is the price of
byte-level parity with the TypeScript rules. Keep it, name the coupling in the
crate docs, and add a typed command layer only if a second store becomes a real
requirement (§7 Q9).

### 3.1 The gateway's sans-io core

The one piece worth extracting is the connection plane. A session core would
hold:

- the topic → connection and stream → connection indexes,
- per-connection subscription state and `seq`,
- the access decisions already made (as inputs),
- the backfill cursor per stream.

Its input is an event or signal plus the access facts; its output is a list of
commands (`SendFrame`, `ReadBackfill`, `Close`) and updated state. A
deterministic simulation can then drive thousands of connections, reorder
signals, expire tickets and drop sockets without a network. That is the test
that today's `sync/handler.test.ts` cannot provide.

---

## 4. Crate decomposition

Small crates with one direction of dependency. Adapters depend inward; only the
binary depends on everything.

| Crate | Holds | Depends on | IO |
| --- | --- | --- | --- |
| `roomy-ids` | `Did`, `Ulid`, `SpaceDid`, `Nsid`, ordering stamps — one type per concept | — | no |
| `roomy-events` | Event and record wire types, CBOR/JSON encoding | `roomy-ids` | no |
| `space-core` | Projection rules: change + context → effects | `roomy-events` | no |
| `space-db` | Effects → per-space SQLite, derived steps, digest/snapshot | `space-core` | SQLite |
| `space-feed` | `ChangeFeed` trait, SQLite impl, HTTP-pull impl, cursor types | `space-core`, `space-db` (types only) | SQLite/HTTP |
| `roomy-space-worker` | Embeddable loop, supervisor, per-space actor, health | `space-core`, `space-db`, `space-feed` | SQLite |
| `space-xrpc` | Per-space read router over a dynamic space registry | `space-db`, `roomy-ids` | SQLite/axum |
| `roomy-global` | Global store, entity→space index, leases, fencing epochs | `roomy-ids` | SQLite |
| `roomy-auth` | JWT verification, service auth, DID cache, access decisions | `roomy-ids` | HTTP/SQLite |
| `roomy-readstate` | `ReadStateStore` trait + SQLite impl: read positions, per-user state, ticket/scope state | `roomy-ids` | trait; SQLite now, network later |
| `roomy-sync` | Sans-io session core + WebSocket adapter | `roomy-events`, `roomy-auth` | WS |
| `roomy-cache` | Response cache policy and store | `roomy-ids` | no (store trait) |
| `roomy-ingest` | `sendEvents` validation, append, record adapter | `roomy-events`, `space-feed` | SQLite |
| `roomy-gateway` | Routing, fan-out, composition, HTTP middleware, health | all of the above | axum/HTTP |
| `roomy-appserver` | Binary; `--role all\|gateway\|worker` | `roomy-gateway` | — |
| `roomy-testkit` | Fixtures, fake stores, virtual clock, deterministic runtime | test crates | no |

Rules:

- A pure crate never depends on `rusqlite`, `tokio`, `axum` or `reqwest`.
- `roomy-ids` replaces the three `SpaceDid` types and the duplicated ULID-time
  and DID validators currently in `space-core`, `space-xrpc` and `bridge-core`.
- `space-db` keeps one `SpaceDb` name; the read-only wrapper in `space-xrpc`
  becomes a `SpaceReadDb` or a method on the same type. Two opposite types with
  one name is a bug waiting for an import.
- `roomy-testkit` is a first-class crate, not `#[cfg(test)]` helpers: the
  differential and simulation harnesses are shared by every crate.

---

## 5. Embedding the worker

The seams already exist; the changes are packaging and lifetimes.

1. **Fix commit ordering.** Apply the global statements first (they are
   idempotent), then the space batch and cursor in one transaction. If the sink
   fails, the cursor does not advance. Add a test that crashes between the two
   and proves replay converges. Alternatively, write a durable outbox marker in
   the space batch and let a relay drain it; the first is simpler and matches
   the documented invariant.
2. **Inject the database handle.** `SpaceDb::open` takes a path and owns the
   connection, and `apply_batch` needs `&mut self`. Add a constructor from an
   existing `Connection` (or a small `SpaceStore` trait) so the supervisor can
   own the handle and hand it to the actor. Do not run schema DDL on a read
   replica.
3. **Inject the clock.** `now_ms()` is private (`worker.rs:242`); put a `Clock`
   in `WorkerParts`. This is also what makes federation timestamps replayable
   (§7 Q12).
4. **Inject cancellation.** Replace the process-global `STOP` with a
   `CancellationToken` per space; release the lease and flush the sink on stop.
5. **Add a notifier seam.** `WorkerParts` has feed, lease, sink and db only.
   Add `SignalSink` so a post-commit signal is an effect of the loop, not
   something the gateway reconstructs by watching rows.
6. **Make `space-xrpc` multi-space.** Replace `XrpcState { db: Arc<SpaceDb> }`
   with a `SpaceRegistry` that resolves `spaceId` (or the entity id) to a
   handle, and resolve federation/blocks before dispatch, as the gateway does
   today. Keep the eight endpoint handlers unchanged.
7. **Supervise, do not `main`.** Move `main.rs` into `roomy-appserver`; the
   worker crate exposes `Worker` + `Supervisor` and owns no listener. Health
   becomes a snapshot the gateway serves.
8. **Share handles across the process.** Feed, lease and sink each open their
   own connection today (`feed.rs:40-44`, `lease.rs:46`, `sink.rs:39`). That is
   fine under WAL, but an embedded gateway should pass shared read handles and
   one writer handle to avoid descriptor growth across thousands of spaces.
9. **Decide the read path's snapshot.** `space-xrpc` opens a second read-only
   connection per space, which is a different WAL snapshot from the writer's.
   That is correct for reads; document it, and make sure a read that follows a
   write the caller just acknowledged is served by a connection that has
   observed the commit (same connection or a barrier).

None of these change the rules or the schema. That is the test of whether the
decomposition is right.

---

## 6. Correctness: what it means and how it is evaluated

### 6.1 Five planes

| Plane | Correctness statement | Primary oracle |
| --- | --- | --- |
| **Projection** | Replaying the same change log produces the same per-space and global projections, regardless of batching, process or restart. | Snapshot digest (`rebuildEquality.ts`, `space-db/src/digest.rs`) |
| **Read response** | For the same state, caller and params, the Rust response is equivalent to the TypeScript response — status, error taxonomy and body. | Differential fixture + live TS oracle |
| **Write/auth** | The same request is accepted or rejected for the same reason, and an accepted request produces the same log entry and derived state. | Request corpus replayed through both |
| **Connection** | For the same subscriptions and the same signal sequence, each connection sees the same frames in the same order; reconnect and backfill recover the same view. | Scripted session diff + deterministic simulation |
| **Distributed** | One writer per space; no cursor skip; a crash replays to the same projection; a dropped signal only delays freshness. | Fault-injection simulation + invariant monitors |

The first plane is the only one with an existing cross-implementation oracle.
The other four are the work.

### 6.2 The oracle today, and its blind spots

The reusable oracle is `snapshotSpaceDb` → `diffSnapshots` → `digestOf`, with
`workerSnapshot` for cross-implementation comparison
(`src/streams/rebuildEquality.ts`; Rust port `space-db/src/digest.rs`). It reads
tables and rows, not APIs, so it is implementation-agnostic. The fixture
exporter turns a deterministic corpus into a change feed plus the TypeScript
digests, and `space-db/tests/parity.rs` replays it through the Rust rules.

Known blind spots, each of which needs a deliberate answer:

1. **Clock columns are dropped by name** — `created_at`, `updated_at`,
   `fetched_at`, `synced_at`, `retry_after`. Any log-determined value in one of
   them is unverified, and any derivation-time value elsewhere cannot be
   compared.
2. **No schema in the digest.** Table and column names are hashed; DDL, types,
   constraints, indexes and the schema version are not.
3. **Three hard-coded exclusion lists** — TypeScript, Rust and the exporter —
   must agree by hand.
4. **Cursors are outside the digest.** `workerSnapshot` drops the cursor tables;
   the worker test asserts only `cursor.0 > 0` and `lag == 0`.
5. **Global coverage is seven hand-picked tables.** Read state, profiles, link
   embeds, mentions, handles, search cursors and leases are outside it.
6. **The corpus is a happy path.** 45–48 events, 16 record kinds, no duplicate
   delivery, no out-of-order stamp, no malformed record, no replay from a
   mid-batch cursor.
7. **The XRPC parity fixture is hand-seeded and not reproducible.** It builds
   `space.sqlite` directly rather than materialising a log, and mints ULIDs with
   `Math.random()`.
8. **Response parity covers 8 of 71 NSIDs; writes and WebSockets have none.**
9. **Both E2E harnesses import TypeScript internals.** `appserver.test.ts` boots
   `createAppserver`; the Playwright launcher seeds `bun:sqlite` directly. The
   specs themselves are portable; the launcher is not.
10. **No failure or multi-process test exists.** No lease expiry, crash between
    commits, duplicate/reordered delivery, slow consumer, cross-process cache,
    or graceful shutdown (`fatal.ts:22-27`).

### 6.3 Evaluation programme

| Layer | What it does | Runs | Gate |
| --- | --- | --- | --- |
| **L1 Pure properties** | `space-core`: determinism, totality over kind × op, independence of unrelated changes, no ambient input. Property tests over generated changes. | `cargo test` | every PR |
| **L2 Projection differential** | Expanded corpus + generated logs through TS and Rust; compare digests and semantic diffs of excluded columns. | CI | before any worker cutover |
| **L3 Batch/replay equivalence** | Same log applied with different batch boundaries, with a crash at every commit point, resuming from the stored cursor. Compare final projection and cursor. | CI | before embedding |
| **L4 Read differential** | Every registered read NSID, params matrix (pagination edges, unknown ids, malformed), caller matrix (admin, member, outsider, banned, anonymous, federated). TS is the oracle. | CI | per endpoint group |
| **L5 Write differential** | `sendEvents` corpus (valid, invalid, unauthorized, oversized, duplicate), compare log rows modulo defined ids and the error response. Read-state procedures similarly. | CI | before write cutover |
| **L6 Connection conformance** | Scripted client sessions against both: subscribe, access denial, signal bursts, reconnect, backfill, slow consumer, ticket expiry. Compare per-connection frame streams. | CI + staging | before serving sockets |
| **L7 Deterministic simulation** | Multi-node in one process: virtual clock, simulated network/store, N gateways and workers, fault schedule (crash before/after each commit, duplicate, reorder, lease expiry, partition). Assert §6.4 invariants. | CI | before multi-node |
| **L8 Shadow** | Mirror production reads to Rust, compare responses and latency, alert on divergence. No writes. | staging/prod | before traffic shift |
| **L9 Chaos/soak** | `kill -9` under load, lease expiry mid-write, disk full, corrupt space DB rebuild, slow consumer, node loss. | staging | before cutover |
| **L10 Perf** | p95 per endpoint and DB round-trips per message, before/after; memory per open space and per connection; rebuild time. | staging | before cutover |

### 6.4 Distributed invariants to assert

1. **Single writer.** At most one worker holds a lease for a space; a stale
   writer cannot commit after losing it. This needs a fencing epoch written with
   every batch, not just an expiry timestamp (§7 Q4).
2. **No cursor skip.** A batch either commits its statements and cursor or
   neither; a replayed batch is idempotent.
3. **Convergence.** Any worker that takes over a space and replays from the
   last committed cursor reaches the same digest as one that never lost it.
4. **Global at worst ahead.** After a crash, the global index may be ahead of a
   space batch that will be replayed; it must never be behind a committed space
   projection.
5. **Signals are advisory.** Dropping any subset of signals leaves every read
   answer correct once a refetch happens; it may only delay freshness.
6. **One connection, one order.** Per-connection `seq` is monotonic; a gap
   triggers the client's resubscribe/refetch path; reconnect never reuses a
   cursor from a different connection.
7. **Access is checked at delivery.** A subscription granted while a user had
   access must stop receiving content after access is revoked, within the
   documented TTL.

### 6.5 Closing the oracle's blind spots

- **Make derivation time log-derived.** Either carry the decision instant on the
  change record (the honest fix) or derive it from `orderStamp`. Then remove
  most clock columns from the exclusion list and keep the exclusion list in one
  generated manifest, not three.
- **Hash the schema.** Add a canonical DDL digest to the fixture, and fail the
  parity test when DDL changes without re-recording.
- **Assert the cursor exactly.** Test the cursor equals the last applied
  `(idx, ord)`, and replay from every entry boundary.
- **Cover the global half.** Assert the sink's statements and order in the
  worker loop test; add read-state, profiles, link embeds, mentions, handles and
  leases to the fixture.
- **Cover the write path.** Add a request corpus for `sendEvents` and the
  read-state procedures; compare log rows and error taxonomy, not just the
  final projection.
- **Make fixtures reproducible.** Fixed id source, fixed receipt time, no
  `Math.random()`, and a generator that materialises a log rather than seeding
  tables.
- **Replace the E2E seeding seam.** Either expose an internal fixture/admin
  write surface or pre-build databases; direct `bun:sqlite` seeding cannot
  target a Rust process.
- **Add the failure tests that do not exist.** Lease expiry, both commit-order
  crash points, duplicate delivery, reorder, slow consumer, graceful drain.

---

## 7. Design questions

Each question gives a recommendation and the evidence that would change it.

**Q1. Is the deployment unit one binary or two?**
Recommendation: one binary with `--role all|gateway|worker`; `all` is the
default. The role flag wires the same crates; a deployment that needs workers
elsewhere starts the same binary with `--role gateway` or `--role worker`. This
keeps the embedded path honest (it uses the same seams) and avoids a second
build. Change if the gateway and worker need different release cadences or
different machine shapes; then split the binary, not the crates.

**Q2. How many spaces per process, and how are they scheduled?**
Recommendation: a configurable number per process, one actor per space, a
bounded read pool, and an LRU registry of open DBs. Start with the same order of
magnitude as the TypeScript pool (`APPSERVER_DB_POOL_SIZE`,
`APPSERVER_MAX_SPACE_DBS`). Change if a single space's write rate saturates an
actor; then pin hot spaces to dedicated processes.

**Q3. What is the feed across machines?**
Recommendation: keep `ChangeFeed` as the only contract and add a pull
implementation over an internal HTTP endpoint served by the log owner. A worker
asks for changes after a cursor; the owner answers from `record_changes`. This
is at-least-once with a monotonic cursor, needs no bus, and survives a worker
restart. Do not read a network filesystem SQLite. A durable bus/JetStream is a
later implementation of the same trait (§7 Q11).

**Q4. How is single-writer enforced?**
Recommendation: lease per space with a fencing epoch. The lease row carries an
epoch; every batch writes the epoch into the space DB; a commit that finds a
newer epoch fails. Expiry alone is not enough: a paused writer can wake after
its lease expired and still write. This is the one distributed invariant that
must be designed before multi-node, not retrofitted.

**Q5. What is the worker→gateway signal contract without a bus?**
Recommendation: coarse, coalescable, space-scoped, ephemeral. Signals carry
`(space, kind, room?, nsids, affected users?)` and are delivered best-effort.
Embedded: in-process channel. Split: worker pushes to gateways that have
registered interest in that space (the gateway sends its subscription set when
it opens a connection), or the gateway polls a per-space `changed_at` counter on
a short interval. Define the contract so that dropping a signal is always safe.
Change if fan-out cost grows; then a bus is the transport, not a new contract.

**Q6. Which state is shared and which is node-local?**
Recommendation:
- Read-state: a `ReadStateStore` trait with a SQLite implementation now —
  embedded, one writer per node or partition — and a networked implementation
  later if write rate or multi-node contention demands it. The gateway depends
  on the trait, never on `rusqlite`. Partition by user when one writer stops
  being enough.
- Tickets: signed and self-contained (short expiry, audience, one-shot nonce),
  so any gateway can verify them. The current process-local map is a
  single-node assumption.
- Connection, topic and stream registries: node-local.
- Cache: node-local, per-caller, TTL-bounded.
- Global DB: single writer per table partition, or one owner for the whole
  global store until it becomes a bottleneck.

**Q7. Where is authorization decided?**
Recommendation: gateway verifies the user's JWT and decides whether the request
may route to a space (including federation and blocks); worker verifies a
gateway-minted service JWT and performs per-space row-level checks for the eight
read NSIDs (already implemented in `space-xrpc::verify`). Never forward a bare
`X-Test-Did`-style header outside test mode. Write authorization stays on the
gateway/ingest path, where the event is validated.

**Q8. How do WebSocket connections scale?**
Recommendation: connections are node-local. A gateway subscribes to signals for
the spaces its connections care about; the worker (or signal relay) fans out to
the interested gateways. With one gateway this is trivial; with N, the interest
registry is the shared state. An alternative — every gateway receives every
signal — is simpler and acceptable at small N, but budget it: it is O(spaces ×
gateways) frames. Do not route a connection to a space's owner; route signals to
the connection.

**Q9. Keep SQL effects or move to typed commands?**
Recommendation: keep SQL effects. They are what makes byte-level parity
possible, and the schema is already the shared contract (`include_str!`). Add a
typed command layer only if a second store is required; then the command layer
is new code below `space-core`, not a rewrite of the rules. Change if the
project commits to a non-SQLite store for per-space data.

**Q10. Which services stay outside the Rust core?**
Recommendation: search (Qdrant), push transports, billing (Polar), voice
control (LiveKit), the admin dashboard, and arbiters remain separate services.
Link unfurling stays a separate fetcher; its *result* write is a global-store
operation the gateway owns, because it already updates `pending_links` and the
per-space link rows on the write path. The core owns: event log + append, change
feed, materialisation, per-space reads, gateway reads/writes/read-state, the
connection plane, auth, cache and routing. Port a side service only when it
shares the per-space DB or the write path; otherwise put it behind XRPC/internal
HTTP and leave it alone.

**Q11. When is a bus justified?**
Recommendation: add JetStream/NATS only when one of these is measured: signal
fan-out exceeds a frame budget, the feed pull cannot keep a worker within its
lag target, or a second durable consumer needs the event stream. The trait
boundaries (`ChangeFeed`, `SignalSink`) exist so the bus is a transport swap.
Log-as-authority is not planned; under the protocol model any log is a cache.

**Q12. What happens to ambient clocks?**
Recommendation: remove them from materialisation. The `orderStamp` is assigned
at ingest and travels with the change; use it (or a `decided_at` field on the
record) for federation timestamps and `created_at`. This makes replay
byte-identical, shrinks the digest exclusion list, and makes the TS and Rust
paths comparable without masking. If a product decision genuinely needs the
server's decision time, persist it in the record at ingest.

**Q13. Byte-exact response parity or semantic parity?**
Recommendation: semantic (canonical JSON) for all responses, with byte-exact
checks only where a client has been observed to depend on ordering or encoding.
Byte-exactness forces hand-written DTOs and makes codegen hard; canonical
comparison catches the bugs that matter (wrong field, wrong null, wrong number
type). Keep the existing byte-exact fixture as an additional guard for the eight
ported endpoints until semantic comparison is in place.

**Q14. How is the cutover performed?**
Recommendation: never dual-write a space. Stages:
1. Rust materialises in shadow from the same feed; compare digests continuously.
2. Rust serves shadow reads; compare responses offline; then mirror a
   percentage of reads and alert on divergence.
3. Move materialisation ownership per space (lease handover); TS stops
   materialising that space and reads Rust.
4. Move writes last, behind a per-space flag, with the TS path retained as a
   rollback for a bounded window.
Each step is reversible per space.

**Q15. How do we keep the XRPC surface honest?**
Recommendation: generate the NSID table, params and response types from the
lexicons, and add a test that every registered route has a lexicon and a
handler and that every lexicon has a route. Hand-written DTOs where canonical
output needs explicit ordering. This is the cheapest defence against a Rust
gateway slowly diverging from the published interface.

**Q16. What is the performance contract?**
Recommendation: per-endpoint p95 budgets and a DB-round-trips-per-message
budget, measured by the same harness before and after, with the existing
baseline as the starting point (`replicable-space-workers.md:16-20`,
`packages/appserver/perf/measure.ts`). Add memory per open space and per
connection, and rebuild time per space. A rewrite that is correct but slower is
not done.

---

## 8. Sequencing

| Milestone | Content | Gate |
| --- | --- | --- |
| **M0** | Merge #530; fix commit ordering; make the corpus/fixture generator deterministic; land the oracle in `next` | Projection parity green; crash-between-commits test green |
| **M1** | Extract `space-feed`, make `roomy-space-worker` a library with injected clock/cancel/notifier, add the supervisor and dynamic `space-xrpc` registry | One process materialises N spaces and serves the eight reads from a log-derived DB |
| **M2** | Gateway skeleton: axum HTTP/WS, auth, signed tickets, session core, routing table, health/metrics | Connection conformance for subscribe/deny/reconnect/backfill |
| **M3** | Per-space reads through the gateway + cross-space fan-out with TTL + cache | Read differential across all read NSIDs |
| **M4** | Write path (`sendEvents`, read-state procedures) + record adapter + append | Write differential; log-row equality |
| **M5** | Multi-node: HTTP feed, lease + fencing, signal relay, replicated reads | Simulation invariants + chaos green |
| **M6** | Shadow reads, then per-space materialisation cutover, then writes | No divergence alerts; rollback exercised |
| **M7** | Decommission the TypeScript core | Perf budgets met; ops runbooks moved |

M1 and M2 can overlap: the gateway's session core and the worker supervisor do
not share state. M4 must precede any write cutover, but not M2/M3.

---

## 9. Risks

- **The oracle is narrower than the word "correct".** Projection parity is the
  only thing proven today. Treat read, write, connection and distributed parity
  as separate deliverables with separate gates.
- **A shared oracle drifts.** Three copies of the exclusion list already exist.
  Generate one manifest and consume it everywhere.
- **Embedded mode hides seam defects.** If the gateway calls the worker directly
  instead of through the feed/signal traits, split mode becomes a second
  implementation. Enforce the seam in review and test both modes in CI.
- **Fencing is easy to defer and expensive to retrofit.** Design the epoch with
  the lease, before multi-node.
- **The read path can be correct and slow.** Fan-out and caching need the same
  measurement discipline as materialisation.
- **Schema ownership.** `include_str!` from the TypeScript tree ties the Rust
  build to the TS package layout. That is fine while both exist; the migration
  must copy the schema (or generate it) before the TS package is deleted.
- **Clock removal changes golden files.** Expected, and better done before the
  corpus grows.

---

## 10. Non-goals

- A line-for-line port of `StreamManager`, `applyBatch` or the SDK event
  materialisers. The record path replaces them; the old materialisers stay
  exported until a breaking SDK release.
- Replacing the storage model in the same rewrite. Per-space SQLite stays;
  protocol-native ingestion is a separate migration.
- A Rust admin UI, search engine, push transport stack, billing integration or
  voice media server.
- A bus before a measured need.
- Multi-writer causal broadcast for one space. Ownership is not split; replicas
  follow the owner for reads.

---

## 11. Open research

1. **Deterministic simulation in Rust.** `turmoil` for tokio tasks, or a custom
   synchronous executor over the sans-io cores plus in-memory SQLite. The
   blocking `rusqlite` calls need a strategy (in-memory DBs and synchronous
   steps are the obvious one).
2. **HTTP feed semantics.** Cursor encoding, batch size, backpressure, and how
   a worker reports lag. Decide whether the feed endpoint is gateway-public or
   an internal service.
3. **Shared read-state store.** Partitioned SQLite with ownership, or move to a
   networked store. Measure the write rate before choosing.
4. **Lexicon codegen for Rust.** Which generator, and whether canonical JSON
   comparison is sufficient to drop the hand-written DTO ordering.
5. **Replica freshness.** How a replica learns the owner's cursor, and whether a
   stale replica may serve a read (and with what header/TTL) or must proxy to
   the owner.
6. **Ticket format.** Signed one-shot ticket versus a short-lived JWT; replay
   protection without a shared nonce store.
