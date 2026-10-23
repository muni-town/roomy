# Roomy ↔ Matrix Bridge — Plan

**Date:** 2026-10-22
**Status:** Draft — implementation in the same PR that adds this document.
**Scope:** one PR: plan, Rust crates, homeserver-side appservice, app-lite
Integrations UI, deployment image, E2E.

## 1. Goal

A bidirectional bridge between one or more Matrix rooms and a Roomy space:

- **Room mode** — N individual Matrix rooms each mapped to a Roomy channel
  (or thread) in one or more spaces.
- **Space mode** — one Matrix space (`m.space`) with all or an allowlisted
  subset of its child rooms bridged, each child becoming a channel, deeper
  hierarchy becoming threads.
- **End-to-bridge encryption** (E2BE): the bridge joins encrypted rooms as a
  single Matrix device, decrypts on receipt and re-encrypts on send.
- Messages, edits, redactions (deletes), reactions, replies, attachments and
  profiles are bridged in both directions.
- Matrix→Roomy history backfill, two-phase, matching the Discord bridge.
- An operator can run one process for any number of spaces and portals.
- The deployable artifact is a single image that contains the homeserver and
  the bridge, self-registering on first boot.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | Mapping/config lives in the **bridge's SQLite**, not in Roomy events. The space admin making the bridge DID a space admin is the authorization; the bridge acts on that grant and no new Roomy schema is added. |
| 2 | Admin operations are exposed over the bridge's **HTTP admin API, authenticated with ATProto service-auth JWTs** whose audience is the bridge DID; the bridge then checks the caller is an admin of the target space via `space.roomy.space.getMembers`. |
| 3 | **Ghosts** (`m.room.member` per bridged Roomy user), not a relay bot. Ghosts give real attribution, mentions, DMs and member lists on the Matrix side. |
| 4 | **One bridge device** for E2EE. Ghost messages are sent with the bridge's device under identity assertion — the same model mautrix uses; per-ghost devices (MSC4190/MSC4326) are out of scope. |
| 5 | No Roomy→Matrix backfill. Matrix→Roomy: capped recent window on portal creation, deep history in the background, unencrypted rooms only. |
| 6 | Each side is authoritative for its own access control. Memberships are not mirrored; bridging a room makes it readable by everyone who can read it on the other side, and the UI must say so. |
| 7 | Matrix hierarchy: depth 1 → channel, depth 2 → thread, depth ≥3 flattened into the nearest thread with a prefixed name and a warning. Multi-parent rooms use the first canonical parent; cycles are refused. |
| 8 | Matrix in-room threads (`m.thread` relations) → Roomy threads when the root message is bridged; otherwise flattened into the channel as a reply. |
| 9 | Rust lives in `crates/` at the workspace root; `packages/` stays JS/TS. License MPL-2.0. |
| 10 | Homeserver: **continuwuity** is the target for the bundled image, gated on a runtime capability probe. Synapse (with Postgres) is the fallback and the E2E target, because it is the only homeserver whose appservice E2EE support is documented and tested. |
| 11 | **Type design is an acceptance criterion.** Newtypes over primitives, typestate for ordered lifecycles, invalid states unrepresentable, interfaces kept small. See §4.1. |

## 3. Why these decisions (evidence)

**Config in SQLite, not events.** The Discord bridge already works this way
(`packages/discord-bridge/src/db/schema.ts` — `bridge_config`, `id_mappings`,
`channel_cursors`, `backfill_progress`, `failed_sends`). Adding Roomy events
for bridge config would mean new SDK events, lexicons, materialisers and a
space schema bump for data no Roomy client needs to render. The bridge is a
long-lived service that re-reads its SQLite on start; config changes must not
require either a restart of the world or a protocol change.

**Admin API auth.** The Discord bridge's REST API has no authentication at
all, so `/get-guild-id?spaceId=…` discloses another space's configuration to
anyone who can reach the port. That is not a pattern to copy. The bridge
already holds an ATProto identity (it must, to call `sendEvents`), so the
cheapest correct gate is: caller presents a service-auth JWT with `aud` =
bridge DID and `lxm` = the admin method, the bridge verifies it against the
caller's DID document, then asks the appserver whether that DID is an admin of
the space. The SDK client side already mints these tokens
(`packages/sdk/src/transport/service-auth.ts`).

**Ghosts.** Attribution is the whole point of a bridge. A relay bot with a
`**Alice** (via Roomy)` prefix is a rendering hack: Matrix users cannot reply
to a ghost, mention it, invite it, or see it in the member list. Ghosts cost
one `m.room.member` join per participant in the room, paid once.

**E2EE single device.** `matrix-sdk-crypto`'s `OlmMachine` is per
`(user_id, device_id)`. Mautrix runs one machine for the bridge bot and
encrypts ghost messages with it — its own documentation states that "messages
sent by ghost users are encrypted by the bridge bot". Per-ghost devices need
MSC4190 (device creation) and MSC4326 (device masquerading); those are spec
features, not implementation features, and they change nothing about *who can
read* the plaintext — the bridge still can. So per-ghost crypto buys no
confidentiality and costs a device + key upload per puppet.

**WASM is out of scope.** An appservice is an HTTP server the homeserver
calls; it cannot run in a browser. The only useful WASM story is a
client-side bridge where each user holds their own keys, which is the
"per-ghost" model above with the crypto moved to the client — speculative and
not needed by anything in this plan. The `bridge-core` crate stays
sans-io/`no_std`-friendly so that path is not precluded: no tokio, no
`std::time`, no filesystem, injected clock, storage behind a trait. That
constraint is imposed anyway for testability.

## 4. Architecture

```
crates/
  roomy-events/          typed Roomy event construction + CBOR. No I/O.
  roomy-client/          XRPC client, service-auth JWT minting, sync socket.
  bridge-core/           sans-io state machine. No tokio, no clock, no fs.
  matrix-adapter/        ruma + matrix-sdk-crypto + appservice transport.
  roomy-matrix-bridge/   binary: config, AS web server, admin API, supervisor.
```

Data flow, Matrix → Roomy:

```
homeserver ──PUT /_matrix/app/v1/transactions/{txn}──► matrix-adapter
                                                         │ decrypted PDU
                                                         ▼
                                              bridge-core: map + dedupe
                                                         │ Vec<Command>
                                                         ▼
                                              roomy-client: sendEvents
```

Roomy → Matrix is the mirror image: the sync socket delivers
`#streamEvents` frames, `bridge-core` filters out events the bridge itself
produced (origin extension + ID map), and `matrix-adapter` sends them as the
right ghost.

`bridge-core` vocabulary is platform-neutral: `Portal`, `Ghost`, and the op
set `Send | Edit | Redact | React | Unreact | CreateRoom | Link | Backfill`.
It is deliberately shared with a future Rust Discord bridge — the state
machine (echo suppression, ID maps, cursors, retry/park, ordering) is
identical. What stays in each adapter: hierarchy derivation, permission
translation, media fetch, and platform-specific relations.

### 4.1 Type design

Applied to the public surface of every crate, not as an afterthought:

- **Newtypes, parsed at the boundary.** `MatrixRoomId`, `MatrixEventId`,
  `RoomyRoomId`, `RoomyEventId`, `GhostMxid`, `GhostDid`, `SpaceDid`, `PortalId`,
  `TxnId`, `BackfillCursor`, `SortIdx`, `MatrixDeviceId`, `AsToken` and `HsToken`
  are distinct types with private fields and a fallible `TryFrom<&str>` that
  validates. A bare `String` at a function boundary means the caller can pass a
  value of the wrong kind; a Roomy room id, a Roomy event id and a space DID are
  all strings and must not be interchangeable. IDs that cross a protocol
  boundary keep their validated form; only the storage and transport layers
  render a value back to a bare string.
- **Typestate where an ordering exists.**
  - Appservice startup: `Appservice<Unregistered>` → `Appservice<Registered>` →
    `Appservice<Running>`. `start` takes `self` and only exists on `Registered`,
    and the transaction endpoint takes `Running`, so starting before the tokens
    exist does not typecheck.
  - Portal encryption: `PortalEncryption::Plain` /
    `Encrypted { device: Ready(MatrixDeviceId) }` /
    `Encrypted { device: Unusable { missing } }`. `device()` is the only route to
    a device id, and a portal with no device is refused at send time rather than
    downgraded to plaintext; `EncryptingSender` also fails closed when the room's
    encryption state cannot be read.
  - Inbound op application: `bridge_core::step` returns
    `Step::Accepted(Vec<Op>)` or `Step::Rejected(Echo | Duplicate | Superseded |
    NotBridged)`, so a caller cannot silently ignore a rejection.
- **Small interfaces.** `bridge-core` exposes one entry point,
  `step(state, input) -> Step`, over `BridgeState`; concrete enums over trait
  objects except at the two boundaries that genuinely need them (`Storage`,
  `MatrixSender`).

Where a `ruma`/`matrix-sdk` type cannot be wrapped without friction, the adapter
keeps the upstream type and says so in a doc comment; forcing a newtype around
a foreign type buys nothing. Two string fields stay strings because their domain
depends on a sibling enum rather than being fixed: `Mapping::matrix_id` and
`Mapping::roomy_id` (an id of the kind `Mapping::kind` names) and the
`mxc://`/`atblob://` URI fields, which are validated by the media layer that
consumes them.

Where a `ruma`/`matrix-sdk` type cannot be wrapped without friction, the adapter
keeps the upstream type and says so in a doc comment; forcing a newtype around
a foreign type buys nothing.

## 5. Data model (bridge SQLite)

Mirrors the Discord bridge, keyed by Matrix identifiers.

```sql
-- one row per (space, matrix room|space) bridge
create table bridge_config (
  id                text primary key,          -- ulid
  space_did         text not null,
  matrix_id         text not null,             -- !room:server or !space:server
  kind              text not null check (kind in ('room','space')),
  mode              text not null check (mode in ('full','subset')),
  auto_bridge       integer not null default 0,
  target_room_id    text,                      -- for kind='room'
  created_at        integer not null,
  updated_at        integer not null,
  unique (space_did, matrix_id)
);

-- matrix room <-> roomy room, one row per portal
create table portals (
  space_did         text not null,
  matrix_room_id    text not null,
  roomy_room_id     text not null,
  bridge_id         text not null references bridge_config(id) on delete cascade,
  encrypted         integer not null default 0,
  created_at        integer not null,
  primary key (space_did, matrix_room_id)
);

-- matrix event id <-> roomy ulid, for echo suppression and edits/redactions
create table id_mappings (
  space_did         text not null,
  kind              text not null,             -- message|reaction|room
  matrix_id         text not null,
  roomy_id          text not null,
  created_at        integer not null,
  primary key (space_did, kind, matrix_id)
);

-- mxid <-> did
create table ghosts (
  mxid              text primary key,
  did               text not null,
  profile_hash      text,
  updated_at        integer not null
);

create table cursors (
  space_did         text not null,
  roomy_room_id     text not null,
  matrix_stream_pos text,
  roomy_cursor      integer,
  primary key (space_did, roomy_room_id)
);

create table backfill_progress ( ... );   -- as Discord bridge
create table failed_sends      ( ... );   -- as Discord bridge
create table schema_version    (version integer primary key);
```

Migrations follow `packages/discord-bridge/src/db/schema.ts`: an ordered
`MIGRATIONS` array, applied in a transaction, version row written last.

## 6. Identity mapping

- **Matrix → Roomy ghost DID:** `did:matrix:` + percent-encoded MXID.
  `@alice:example.org` → `did:matrix:%40alice%3Aexample.org`. A bare MXID is
  not a valid DID (`@` and `:` are outside `idchar`), and the SDK validates
  DIDs with the same rule the ATProto libraries use. Percent-encoding is
  reversible; the UI decodes for display.
- **Roomy → Matrix ghost MXID:** `@_roomy_<short-hash>:<bridge host>` under
  the registration's user namespace. Display name and avatar come from the
  Roomy profile and are pushed with `updateProfile`-equivalent events.
- **Authorship on the Roomy side:** `space.roomy.extension.authorOverride.v0`
  set to the ghost DID, plus `timestampOverride` with the Matrix
  `origin_server_ts`. The bridge account must be a space admin for both.
- **Profiles:** `space.roomy.user.updateProfile.v0` with a
  `matrixUserOrigin.v0` extension carrying the MXID and a profile hash, so
  changes are idempotent.

## 7. Upstream Roomy changes (the only schema work in this PR)

`space.roomy.extension.matrixOrigin.v0` (room) and
`matrixMessageOrigin.v0` (message), each `{ roomId, eventId?, originServerTs? }`:

1. `packages/sdk/src/schema/extensions/room.ts` and `.../message.ts` — arktype
   definitions added to the strict `unionToMap` unions.
2. `packages/sdk/src/schema/events/room.ts` (`CreateRoom` materialiser) and
   `message.ts` — write `comp_matrix_origin` alongside the existing
   `comp_discord_origin` write.
3. `packages/appserver/src/db/schema-space.sql` — `comp_matrix_origin`,
   bumping `SPACE_SCHEMA_VERSION`; the table is additive and the version bump
   re-materialises forward via the existing mechanism.
4. `packages/appserver/lexicons/` — regenerate.

Why this is worth the upstream surface (unlike config): it is what makes echo
suppression and idempotency survive a bridge DB loss, and it is what a future
Matrix client/bridge needs to link back to the origin room. Without it a
re-materialisation silently drops the mapping and the bridge starts echoing.

**Out of scope, filed separately:** `authorOverride` and `timestampOverride`
are currently accepted from any member with room write access
(`packages/appserver/src/auth/writeAuth.ts` never inspects `extensions`, and
`materialization/toAppliedEvent.ts` applies the override unconditionally), so
any member can post as any DID. That is an appserver auth fix with its own
test matrix and its own PR.

## 8. Structure mapping

Matrix spaces are a DAG: `m.space.child` state events, arbitrary depth, a
room may hang under several parents. Roomy is two levels: a channel with
threads under it, plus flat sidebar categories. The mapping is therefore
lossy by construction and the plan states the loss rather than hiding it:

| Matrix | Roomy |
|---|---|
| space (depth 1) | channel, or a sidebar category when `as_category = true` |
| room inside a space (depth 2) | channel |
| space at depth ≥ 3 | thread under the nearest depth-2 channel, name prefixed |
| room at depth ≥ 3 | thread under the nearest depth-2 channel |
| room under two parents | bridged once, under its first canonical parent |
| `m.thread` inside a bridged room | Roomy thread, if the root event is bridged |
| `m.thread` whose root is not bridged | flattened into the channel as a reply |
| encrypted room + key not available | portal created, sync paused, state `blocked` |

`as_category` and depth are recorded per portal so the mapping is stable
across restarts and visible in the admin API.

Cycle detection: walk `m.space.child` edges with a visited set at
configuration time; a cycle is a configuration error, refused with the cycle
named.

## 9. Sync semantics

- **Matrix → Roomy:** appservice `/transactions` PDUs, in order, per txn.
  Reaction relations (`m.annotation`) become `addBridgedReaction` /
  `removeBridgedReaction` — already space-admin-gated by the appserver.
  `m.replace` becomes `editMessage` with the **latest** content (Matrix keeps
  the whole edit chain; Roomy keeps the last, so history is dropped — stated
  in the UI). `m.room.redaction` becomes `deleteMessage`. Replies
  (`m.in_reply_to`) become `attachment.reply.v0`. Media: download → encrypt →
  upload to the bridge account's PDS → `atblob://<bridge did>/<cid>` refs.
- **Roomy → Matrix:** subscribe to `stream:<spaceDid>` over the sync socket
  (members and admins are allowed; the bridge is an admin). Filter events
  authored by the bridge, and events whose origin extension points at Matrix.
  Send as the ghost for the author's DID when one exists, otherwise as the
  bridge's own user with a note in the body.
- **A portal starts at its own creation.** Only Roomy events written after the
  portal row was created are relayed; the event id is a ULID, so its timestamp
  is the cut-off. That is how "no Roomy→Matrix backfill" is enforced rather than
  assumed: replaying a space's history into a room the bridge has just joined
  would post old messages as new, and a replayed reply names an event the room
  has never seen.
- **Echo suppression** is by ID map + origin extension, never by comparing
  content. A message is "ours" if its Matrix event ID is in `id_mappings` or
  its Roomy event carries `matrixMessageOrigin`.
- **Ordering:** backfilled Roomy messages carry `timestampOverride`, which
  the appserver already folds into `sort_idx`
  (`packages/appserver/src/materialization/sortIdx.ts`), so history lands
  chronologically instead of at the tip.
- **Retry:** every send goes through a durable outbox (`failed_sends`) with
  attempt count and `next_retry_at`, re-offered on a timer and on restart.

## 10. Encryption (E2BE)

- Build feature `e2ee` (default on). Without it, no `matrix-sdk-crypto`
  dependency and encrypted rooms are refused at config time.
- One bridge device, created on first boot and persisted in the registration's
  volume. `OlmMachine` with a SQLite crypto store.
- Decrypt on receipt; re-encrypt outbound with `share_room_key` on
  `ErrSessionNotShared`, exactly as mautrix does.
- No key backup import in v1: history before join is unreadable. Config
  documents this; the UI states it per portal.
- **Capability probe.** `roomy-matrix-bridge --check-homeserver` queries
  `/versions` and runs a self-test, reporting one verdict per field:
  `msc4190-devices`, `msc2409-ephemeral`, `msc4203-to-device`,
  `msc3202-device-lists`, `msc3202-otk-counts`, `msc3202-fallback-keys`. E2EE
  is enabled only if the device call and the key-bearing streams pass; the
  ephemeral stream is relayed by the bridge but carries no key material, and
  fallback keys only matter once the one-time-key pool is exhausted. With
  `e2ee = "required"` the process refuses to start and names what is missing.
  This is what turns "can we run on continuwuity" into a measurement.

Verified state of the ecosystem at time of writing:

| Homeserver | E2EE appservice support | Verdict |
|---|---|---|
| Synapse | MSC4203 to-device, MSC2409 ephemeral and the MSC3202 device-list, one-time-key and fallback-key fields in `/transactions`; enabled per registration | E2E target, guaranteed |
| Dendrite | maintenance mode, security fixes only; no MSC4186 | excluded |
| Conduit / conduwuit | archived | excluded |
| continuwuity | MSC4190 devices fully supported, MSC2409 ephemeral delivered (`receive_ephemeral` honoured); transactions carry no to-device stream and no MSC3202 fields | **bundled-image target, gated on the probe** |

The probe result is a first-class test output, not an assumption: a
`continuwuity` compose profile runs the probe and the E2E, and PR acceptance
requires the result to be recorded.

## 11. Configuration

TOML is deployment only — values true for the whole process, never per-bridge:

```toml
[homeserver]
url = "http://synapse:8008"
domain = "matrix.roomy.local"
# for the bundled image these are generated on first boot
as_token = "…"
hs_token = "…"
sender_localpart = "_roomy_bridge"

[bridge]
listen = "0.0.0.0:29331"
db_path = "/data/bridge.sqlite"
bridge_did = "did:web:bridge.roomy.space"
hostname = "matrix.roomy.local"      # ghost MXID domain

[appserver]
url = "https://api.roomy.space"
did = "did:web:api.roomy.space"

[atproto]
identifier = "…"
app_password = "…"

[bridge.e2ee]
mode = "required"      # off | preferred | required
```

Per-bridge configuration (which space, which rooms, auto-bridge) is rows in
`bridge_config`, created through the admin API.

## 12. Admin API

All under `/_roomy/admin/v1`, JSON, authenticated as in §3.

| Method | Purpose |
|---|---|
| `GET /health` | unauth; `{ ok, portalCount, e2ee, homeserver }` |
| `GET /capabilities` | unauth; the homeserver probe result |
| `GET /bridges?spaceId=` | list this space's bridges and portals |
| `POST /bridges` | `{ spaceId, matrixId, kind, mode, targetRoomId?, autoBridge? }` |
| `PATCH /bridges/:id` | change mode / allowlist / autoBridge |
| `DELETE /bridges/:id` | stop syncing; leaves both rooms intact |
| `GET /bridges/:id/backfill` | progress, honest about unknowns |
| `GET /bridges/:id/rooms` | discovered hierarchy, with depth and decisions |

Every write re-checks space admin. Every response is scoped to a `spaceId` the
caller administers — no cross-space enumeration.

## 13. app-lite UI

Move to **Settings → Integrations**, with separate collapsible sections:

```
Integrations
  ▸ Bluesky            (existing content, unchanged)
  ▸ Discord            (the existing Discord Bridge page, moved here)
  ▸ Matrix             (new)
```

- `routes/[space]/settings/integrations/+page.svelte` becomes a host for
  collapsible sections; the Discord page's body is extracted into a component
  (no behavioural change) and the `discord-bridge` route redirects there.
- Matrix section: connect a room or a space (paste `#alias:server` or `!id`),
  choose target channel/thread, an explicit **"also bridge rooms created
  later"** checkbox (unchecked by default), per-portal status (syncing /
  backfilling / paused / blocked + why), and the encryption notice.
- The tab is admin-only; the Pro gate stays only on the Discord section, which
  is what it actually prices.
- Bridge DIDs come from `PUBLIC_MATRIX_BRIDGE_DIDS` (comma-separated) so one
  deployment can address more than one bridge instance.

## 14. Deployment image

`Dockerfile.matrix-bridge` + `compose.matrix.yaml`:

- **Default profile: continuwuity + bridge.** Embedded DB, no Postgres, one
  container each plus a shared volume.
- **Fallback profile: Synapse + Postgres + bridge** (`--profile synapse`),
  used when the probe fails or the operator wants the reference
  implementation. Postgres is accepted here.
- First boot: generate `as_token`, `hs_token` and the ghost namespace, write
  the homeserver config and the registration, start both, persist tokens in
  `/data`. Idempotent — a second boot reuses the volume and does not
  re-register.
- Healthcheck runs the capability probe; the container reports unhealthy with
  the missing feature named.

## 15. Testing

- **`bridge-core`:** pure state-machine tests — echo suppression, edit and
  redaction ordering, cursor resume, retry/park, hierarchy flattening (DAG,
  multi-parent, cycle), thread mapping. No network, no clock.
- **`roomy-events`:** encode/decode round-trip against golden CBOR produced by
  the TypeScript SDK.
- **`matrix-adapter`:** transaction handler unit tests with fixture PDUs,
  including an encrypted event decrypted via a fixed OlmMachine state.
- **`roomy-matrix-bridge`:** admin API auth (valid JWT, wrong audience,
  expired, non-admin caller), config CRUD, startup recovery.
- **E2E (`docker compose`):** Synapse (MSC flags on) + appserver in
  `APPSERVER_TEST_MODE` + bridge. Round trip: message, edit, redaction,
  reaction, reply, attachment, thread; backfill of 50 messages; one encrypted
  room; admin API denies a non-admin.
- **CI:** new `test-rust` job — `cargo fmt --check`, `clippy -D warnings`,
  `cargo test --workspace` — plus `test-matrix-bridge-e2e` running the compose
  stack. Turbo stays JS-only; the Rust job runs alongside it.

## 16. Milestones (single branch, single PR)

1. `crates/` workspace, `roomy-events`, `roomy-client` — compiles, unit tests.
2. `bridge-core` state machine + tests.
3. `matrix-adapter`: appservice transactions (unencrypted), ghost creation.
4. `roomy-matrix-bridge` binary, SQLite schema, admin API + auth, config.
5. Roomy side: origin extensions, materialiser, lexicons, schema bump.
6. E2EE: crypto store, encrypt/decrypt, capability probe.
7. Backfill, two-phase.
8. app-lite Integrations restructure + Matrix section.
9. Deployment image, compose, first-boot self-registration.
10. E2E green, docs (`docs/plans/` → operator README), CI jobs.

## 17. Risks

| Risk | Mitigation |
|---|---|
| continuwuity lacks to-device delivery and the MSC3202 fields | probe gates E2EE; Synapse profile ships as the guaranteed path; the probe result is recorded in the PR |
| Matrix DAG → two-level Roomy is lossy | mapping table is explicit; prefixed names; per-portal state in admin API |
| Ghost joins cost on large rooms | lazy join on first message, plus an explicit cap with a warning |
| Ghost DID scheme is unusual | percent-encoding is reversible and validated by the same DID rule as ATProto; display layer decodes |
| One PR is large | milestones are sequential commits on one branch; the PR opens when E2E is green |
| `authorOverride` is currently unguarded | the bridge requires space admin; the upstream fix is a separate task |

## 18. Out of scope

- Roomy→Matrix backfill.
- Per-ghost encryption devices (MSC4190/MSC4326) and key-backup import.
- Bridging Roomy voice rooms to Matrix calls.
- Running the appservice in WASM (see §3); `bridge-core` stays portable.
- Fixing the Discord bridge's unauthenticated admin API or the
  `authorOverride` authorization hole — both filed as separate tasks.
