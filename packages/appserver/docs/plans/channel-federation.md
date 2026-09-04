# Channel Federation — Plan

**Date:** 2026-08-19
**Commit (baseline):** `dc29633f`
**Status:** Phases 1-4 **shipped** (backend relationship lifecycle, origin + receiver grants, federated read/write, flag-gated frontend). Phase 5 hardening **shipped** (revoke cleanup, B-side removal, double-request guard, banned-member denial, invalidation on grant changes, deleted-channel sidebar skip). **Sidebar reorder fix shipped**: federated channels placed in a category via drag-and-drop reorder now stay there (see §0).
**Gated by:** frontend feature flag `channel-federation` (registered; no Phase-1 UI to gate yet).

## 0. Implementation status

- **Phase 1 backend shipped** (`4555cfb5` + follow-ups): SDK events `space.roomy.federation.{request,respond,remove}.v0`, global `space_federations` table (routed to the global DB via `statementRouting.ts`), write-auth for the three events (incl. the cross-space admin-of-B check for `request`), and queries `space.roomy.federation.getRequests` / `getIncoming` / `getOutgoing`. Unit tests: `src/auth/writeAuth.federation.test.ts`, `src/materialization/federation.test.ts`.
- **Phase 2 backend shipped:** SDK event `space.roomy.federation.setRoomPermission.v0` (origin grants) + `federation_room_permissions` table; `auth/federation.ts` `federatedRoomAccess` (channel-scoped, thread-inheriting via `resolveRoom`); `requireRoomRead` federation fallback (only consulted when native access denies); `getMetadata` sidebar injection of federated channels into the receiving space, decorated with `federated: { originSpaceId, permission }`. Tests: `src/auth/federation.test.ts`, plus materializer/writeAuth coverage.
- **Phase 3 backend shipped:** SDK event `space.roomy.federation.setReceiverPermission.v0` (receiver grants) + `federation_receiver_permissions` table; `federatedRoomAccess` now applies receiver grants (user + role kinds) capped by the origin grant, with a B-admin override (admins of the receiving space get origin-level access); federated **writes** via `requireRoomWrite` and `writeAuth.requireRoomWriteCheck` (both origin + receiver grants must allow write); `getMetadata` sidebar filters federated channels by the caller's effective access (B admins see all, B members only what they're granted). Tests: receiver-grant/ceiling/role/admin cases, federated-write auth, materializer.
- **Phase 4 frontend shipped (flag-gated):** federation RPCs added to the OAuth scope (`config.ts` + `build-prod.sh`); `channel-federation` flag gates a settings **Federations** page (`[space]/settings/federations`) with (1) pending-request approve/reject, (2) **origin-grant** toggles per own channel per accepted federation (`setRoomPermission`), and (3) **receiver-grant** toggles per federated channel per B role (`setReceiverPermission`); a pending-count badge on the settings icon; and federated-channel decoration (share icon + "shared" chip) in the sidebar. Added `space.roomy.federation.getGrants` query to feed the grant toggles. The plan's "list accepted federations alongside roles in the Permissions surface" is delivered as the dedicated Federations page instead (cleaner separation; same events/backing).
- **Phase 5 hardening shipped:** (a) `remove` now drops every origin + receiver grant for the federation (SDK materializer); (b) a **B admin can remove the federation** (B-side revocation) via `checkFederationRemove`, in addition to an A admin; (c) a **double-request guard** returns 409 when a federation already exists (active/rejected/removed) — re-request while pending stays an idempotent no-op; (d) **invalidation signals** for all five federation events (`getRequests`/`getIncoming`/`getOutgoing`/`getGrants` + both spaces' `getMetadata`/`getSpaces`), so both spaces' sync caches refresh on grant changes — new nsids wired into `inferSignals` + `topicsForSignal`; (e) a **B-banned member loses federated access** despite a stale receiver grant; (f) `getMetadata` skips origin channels that no longer exist (deleted). Tests: materializer (remove wipes grants), writeAuth (B-side remove, non-admin deny, double-request 409), inferSignals (federation events), federatedRoomAccess (banned member).
- **Roles → Permissions hard rename shipped**: settings route moved `settings/roles` → `settings/permissions`; `settings/roles` redirects (307) to `settings/permissions`.
- **Decisions confirmed:** mutual A↔B federation is in scope and trivial (independent relationships); transitive re-federation is out of scope. Storage is the **global-DB registry** (chosen over the virtual-role-in-`roles` alternative).
- **Global schema version is NOT bumped**: `initializeVersionedSchema` re-applies the DDL idempotently when the version matches, so adding `space_federations` heals existing DBs without wiping the global DB (which would also discard externally-fetched `profiles`).
- **Feature flag registered**: `channel-federation` added to `FEATURE_FLAGS` (`featureFlags.ts`); returned by `space.roomy.getFlags`. Server-side write gate for the events is deferred to a later phase (the backend events are functional; only frontend UI is gated).
- **Sidebar reorder fix shipped:** federated channels are injected into B's sidebar as orphans, so drag-and-drop reorder (which writes the channel ID into a category via `updateSidebar.v1`) was silently discarded — `getMetadata`'s category loop only resolved IDs from B's own DB, and the federated channel fell back to orphans in grant order. `getMetadata` now resolves federated channels *before* the category loop and falls back to the access-checked federated entry for any config child that isn't a native channel; unplaced federated channels still land in orphans. Regression test: `src/e2e/federation.test.ts` "a federated channel placed in a category by reorder stays there".
- **Receiver-grant UI regression + fix shipped (`844f68df` → restored):** the Aug-24 settings cleanup removed the "Federated channels" receiver-grant toggles, claiming role config moved to the edit-channel modal — but that modal wrote `role_rooms` via `setRoleRoomPermission.v0`, which `federatedRoomAccess` **never** reads (it only consults `federation_receiver_permissions` + B's `member_roles`). Net effect: non-admin B members could never receive federated access through any UI. Restored receiver-grant management in the edit-channel modal (edit sidebar → channel → save) for federated channels: `ChannelPermissions` renders a per-B-role toggle grid backed by `getGrants.receiverGrants`, clamped to the origin grant ceiling and written via `setReceiverPermission` (sent on B's stream, diffed against current grants). Rename/archive are disabled for federated channels (both would target the origin space A's stream and 403 as a B admin).

## 1. Goal

Allow a **channel in Space A** to be *federated* to **Space B**, so that:

- the channel appears in **Space B's sidebar** with a special decoration (indicating it is a federated / remote channel),
- **members of Space B** can read it (and, when granted, write to it),
- access is layered and configurable:
  1. **Space A admins** first set, per channel, whether Space B gets *none / read / readwrite* (the origin grant);
  2. once a channel is exposed to Space B, **Space B admins** (who see it in the sidebar first) can then configure which Space B members/roles can actually use it, up to the origin grant's ceiling (the receiver grant).

The relationship is established out-of-band:

1. An **admin of Space B** must also be a **member of Space A**.
2. That admin submits a **federation request** addressed to Space A.
3. The request surfaces as a **notification on Space A's settings icon** and in the settings menu (the Roles page — proposed rename to *Permissions*).
4. A **Space A admin approves or rejects** it.
5. Once accepted, Space B is represented in Space A as a **special kind of role** (membership is *not* configurable by Space A — Space B's membership is authoritative).

Ship in **phases**, gated behind a **frontend feature flag**.

---

## 2. Relevant current architecture (research findings)

### 2.1 Per-space materialised databases

- The appserver writes events to a shared append-only event-log DB (`data/roomy-events.sqlite`), then **materialises into per-space SQLite DBs** (`data/spaces/<spaceDid>.sqlite`), plus a shared **global DB** and a **read-state DB**. (`packages/appserver/src/db/db.ts`, `docs/plans/per-space-dbs.md`.)
- `openSpaceDb(spaceId)` returns the handle for one space. Events target a **single stream** (the space DID) and materialise only into that space's DB. `sendEvents` writes `events: [...], spaceId` to one stream. (`packages/appserver/src/handlers/space.roomy.space.sendEvents.ts`, `packages/appserver/src/streams/StreamManager.ts`.)
- The materializer supports **dual-write to the global DB** (`derived: "global"` steps) — see `applyBatch.ts` (§4). This is the existing precedent for cross-space data and the natural home for the federation registry.

### 2.2 Access control (`packages/appserver/src/auth/access.ts`)

- **Space-level**: `spaceAccess(db, spaceId, did)` → `{ isMember, isAdmin, isBanned }`, read from `edges` (`member`/`admin` labels) and `comp_bans` in that space's DB. Memoised per-request (`createAccessMemo`).
- **Room-level**: `roomAccess(db, roomId, did)` → `{ exists, canRead, canWrite, isAdmin, defaultAccess, spaceId, parentChannelId, isBanned }`.
  - admin override → full access;
  - banned → deny;
  - `roleGrant(db, spaceId, permRoom, did)` → looks up `member_roles ⋈ role_rooms ⋈ roles` for the caller;
  - union with `default_access` (`readwrite`/`read`/`none`), gated on space membership for write and (for invite-only) read;
  - threads inherit `default_access` from their canonical parent channel via `minAccess` (`access.ts` `resolveRoom`) — **an existing precedent for composing/max-capping two grants**, which the federation receiver-grant ceiling mirrors.
- **All access decisions are per-space and take only one space's DB handle.** This is the central thing federation must extend.

### 2.3 Write authorization (`packages/appserver/src/auth/writeAuth.ts`)

- `checkWriteAuth(db, spaceId, callerDid, event, access)` dispatches on `$type`:
  - `ROOM_WRITE_TYPES` → `requireRoomWriteCheck` (needs `canWrite` on `event.room`);
  - `MESSAGE_AUTHOR_TYPES` → plus author-or-admin;
  - `ROOM_MANAGE_TYPES` / `SPACE_MANAGE_TYPES` → space admin;
  - `SPACE_MEMBER_TYPES` → membership (not banned);
  - `BRIDGED_TYPES` → space admin;
  - `ALLOWED_TYPES` (must be registered) / `REJECTED_TYPES` (e.g. `space.roomy.state.markRead.v0`).
- **Federation introduces two new auth cases** the current model cannot express:
  1. a *request* event from an admin of Space B (who is not an admin of Space A);
  2. *room-write* events from a Space B member writing to a federated Space A channel (who is not a member of Space A).

### 2.4 Roles & channel permissions (`roles`, `role_rooms`, `member_roles`)

- `roles (id, stream_id, name, avatar, description, deleted)`
- `role_rooms (role_id, room_id, stream_id, permission ∈ {'read','readwrite'}, PK(role_id, room_id))`
- `member_roles (user_id, role_id, stream_id, PK(user_id, role_id))`
- `getRoles` (`space.roomy.space.getRoles`) returns `{ roles: [{ id, name?, avatar?, description?, rooms: [{roomId, permission}], memberDids }] }`, filtered to admins + the caller's own roles. SDK event `space.roomy.role.setRoleRoomPermission.v0` mutates `role_rooms`.
- Lexicon JSONs live in `packages/sdk/src/schemas/lexicons/`; typed query wrappers in `packages/sdk/src/schemas/queries/`; SDK event schemas in `packages/sdk/src/schema/events/roles.ts`.

### 2.5 Sidebar construction (`space.roomy.space.getMetadata`)

- `getMetadata` reads only the caller's space DB, builds `sidebar: { categories, orphans }` from `comp_space.sidebar_config`, and **omits any channel the caller cannot read** (`roomAccess(...).canRead`).
- **Federated channels must be injected into Space B's sidebar** from Space A's DB — a new cross-space read.

### 2.6 Feature flags

- `space.roomy.getFlags` returns the enabled flag keys for the caller (`packages/appserver/src/handlers/space.roomy.getFlags.ts`, `queries/featureFlags.ts`). Frontend gates UI on these. There is no hard-coded frontend flag store today; the flag check is done via the getFlags query result.

### 2.7 Frontend touchpoints

- Settings sidebar state: `packages/app-lite/src/lib/components/layout/settings-bar.svelte.ts` (`settingsBar.expanded`); icon buttons in `SpaceSidebarButtons.svelte` (`IconBell`, `IconSettings`, `IconUserPlus`). Notifications page at `settings/notifications`.
- Settings layout: `packages/app-lite/src/routes/[space]/settings/+layout.svelte`; Roles page: `.../settings/roles/+page.svelte` (channel-permission rows per role); role edit modal: `packages/design/src/components/modals/RoleEditForm.svelte`; mutations `packages/app-lite/src/lib/mutations/role.ts`; queries `packages/app-lite/src/lib/queries/roles.ts` (all call `sendEvents`).
- Space sidebar: `SpaceSidebarButtons.svelte` + the sidebar components that render `getMetadata.sidebar`.

---

## 3. Concept & terminology

| Term | Meaning |
|---|---|
| **Origin space (A)** | Owns the channel; grants federation access to B. |
| **Receiving/federated space (B)** | Gets a read/write view of A's channel in its sidebar. |
| **Federation relationship** | `SpaceB → SpaceA`, accepted by an A admin. Represented in A as a special role-like entity. |
| **Origin grant** | A-admin-set per-channel access for the *whole space B*: `none \| read \| readwrite`. |
| **Receiver grant** | B-admin-set per-channel access for specific B members/roles, capped by the origin grant. |
| **Effective access** | `min(originGrant, receiverGrant)` for a B member on a federated channel — same `minAccess` semantics threads already use. |

---

## 4. Data model

### 4.1 Recommended storage: global DB registry + per-space grants

Federation is cross-space by nature, so **the relationship and per-channel grants live in the shared global DB** (consistent with the existing "global DB holds cross-space data" mandate and the materializer's `derived: "global"` dual-write support). Per-space DBs stay the source of truth for their own space data; federation adds a small cross-space layer.

New tables in `packages/appserver/src/db/schema-global.sql` (added idempotently — see §0, the global schema version is NOT bumped):

```sql
-- One row per accepted (or pending) federation SpaceB -> SpaceA.
-- PK(space_id, federating_space_did); space_id = the accepting/origin space A.
create table if not exists space_federations (
  space_id              text not null,   -- origin space A
  federating_space_did  text not null,   -- receiving space B
  status                text not null check(status in ('pending','active','rejected','removed')),
  requested_by_did      text not null,   -- admin of B who asked
  requested_at          integer not null default (unixepoch()*1000),
  decided_by_did        text,            -- admin of A who decided
  decided_at            integer,
  primary key (space_id, federating_space_did)
) strict;

-- Origin grant: A-admin-set access for space B on a channel of A.
-- Mirrors role_rooms. permission null == removed / not exposed.
create table if not exists federation_room_permissions (
  space_id             text not null,   -- origin space A
  federating_space_did text not null,   -- space B
  room_id              text not null,   -- channel id in A
  permission           text check(permission in ('read','readwrite')),
  primary key (space_id, federating_space_did, room_id)
) strict;
create index if not exists idx_frp_recv on federation_room_permissions(federating_space_did, permission);

-- Receiver grant: B-admin-set access for a B role or user on a federated channel.
-- Ceiling is the origin grant. `kind` = 'role' | 'user'; `grantee` = role_id | user_did.
create table if not exists federation_receiver_permissions (
  space_id            text not null,   -- origin space A
  federating_space_did text not null,  -- space B
  room_id             text not null,   -- channel id in A
  grantee             text not null,   -- B role_id or B user_did
  kind                text not null check(kind in ('role','user')),
  permission          text not null check(permission in ('read','readwrite')),
  primary key (space_id, federating_space_did, room_id, grantee, kind)
) strict;
```

**Alternative (rejected for now, documented for a later refactor):** model each accepted federation as a **virtual row in `roles`** (`roles.is_federation=1`, `roles.federated_space_did=B`) and reuse `role_rooms`/`member_roles`. This maximally reuses the existing channel-permission UI and `getRoles`. It is attractive but conflates user roles with space federations and complicates the `member_roles` semantics (Space B membership is dynamic, not stored). **Recommended path: dedicated federation tables first; expose federations *as role-like objects* in the `getRoles` response / a new `getFederations` query so the UI stays uniform.** If the team prefers the virtual-role implementation, the schema work collapses to adding two columns + reusing `role_rooms`; the access/auth design below still applies.

### 4.2 New SDK events (`packages/sdk/src/schema/events/federation.ts`)

| Event | Stream targets | Fields | Materializer writes |
|---|---|---|---|
| `space.roomy.federation.request.v0` | Space A | `spaceId`(=A), `federatingSpaceDid`(=B), `message?` | `space_federations` status `pending` (global) |
| `space.roomy.federation.respond.v0` | Space A | `federatingSpaceDid`, `approve: bool`, `message?` | status → `active` / `rejected` (global) |
| `space.roomy.federation.remove.v0` | Space A | `federatingSpaceDid` | status → `removed` + delete grants (global) |
| `space.roomy.federation.setRoomPermission.v0` | Space A | `federatingSpaceDid`, `roomId`, `permission: 'read'\|'readwrite'\|null` | upsert/delete `federation_room_permissions` (origin grant, global) |
| `space.roomy.federation.setReceiverPermission.v0` | Space B | `originSpaceId`(=A), `roomId`, `grantee`, `kind`('role'\|'user'), `permission` | upsert/delete `federation_receiver_permissions` (receiver grant, global) |

Each is registered with `defineEvent` following `roles.ts`; add to the SDK event registry and to `writeAuth.ALLOWED_TYPES`.

### 4.3 New XRPC lexicons + SDK wrappers

Add to `packages/sdk/src/schemas/lexicons/` (+ `queries/` wrappers), and register handlers in `appserver.ts`:

| NSID | Type | Purpose |
|---|---|---|
| `space.roomy.federation.getRequests` | query | For A admins: list `pending` federations (with requester profile + message). |
| `space.roomy.federation.getIncoming` | query | For B (admins): list channels federated *to* B from any origin + current origin grants. |
| `space.roomy.federation.getOutgoing` | query | For A admins: list active federations + per-channel origin grants. |
| `space.roomy.federation.getFederatedChannels` | query | For B: the federated-channel sidebar/access payload (or fold into `getMetadata`). |

`getRoles` may additionally expose accepted federations as role-like objects (`kind: "federation"`) so the existing channel-permission UI can render "Space B" next to roles.

### 4.4 Schema/version bumps

- `schema-global.sql` adds the `space_federations` table. No `GLOBAL_SCHEMA_VERSION` bump: `initializeVersionedSchema` re-applies the DDL idempotently on a matching version, so the new table heals existing DBs without wiping the global DB (a wipe would also drop externally-fetched `profiles`). `statementRouting.ts` routes `space_federations` statements to the global DB.
- No per-space schema change required if federation lives entirely in the global DB.

---

## 5. Access-control design (the crux)

### 5.1 Principle: federation as a "virtual space-level grant"

A B-member's access to a federated A-channel is a **composition**:

```
federatedRoomAccess(A_channel, did, homeSpace=B):
  if caller is A member/admin -> normal roomAccess (unchanged, takes precedence)
  if channel not federated       -> deny
  origin = federation_room_permissions[A, B, channel]      // A-admin ceiling
  if origin is null/none        -> deny
  receiver = federation_receiver_permissions[A, B, channel, grantee]  // B-admin grant
            where grantee is did, or a B-role the did holds
  effective = minAccess(origin, receiver)                  // reuse minAccess
  return { canRead, canWrite } from effective (read/readwrite)
```

`homeSpace B` is found by: for each space the caller is a member of (`global.edges`), check whether `federation_room_permissions` has a non-null grant for `(A, B, channel)` and a matching receiver grant. In practice the appserver can resolve the caller's membership spaces cheaply from the global membership edges (`global.edges` `joinedSpace`), then probe the small federation tables.

### 5.2 Where to extend

- Add `federatedRoomAccess(dbSpaceA, dbGlobal, roomId, did, memo)` in a new `packages/appserver/src/auth/federation.ts`, reusing `minAccess`, `spaceAccess` (for the A member fast-path), and the global registry tables.
- **Reads** (`room.getMetadata`, `getMessages`, `getThreads`, `getReactions`, activity feed): authorize via `federatedRoomAccess` when the caller is not an A member.
- **Writes** (`writeAuth`):
  - `ROOM_WRITE_TYPES` already call `requireRoomWriteCheck` → extend it (or the federation path) to consult `federatedRoomAccess` and require `canWrite` **and** that the caller is a member of the federating space B (not banned in B).
  - The **federation-manage events** (`request/respond/remove/setRoomPermission/setReceiverPermission`) need new auth categories:
    - `request` → caller must be **admin of B** and **member of A** (precondition). Cross-space: `spaceAccess(openSpaceDb(B), B, did).isAdmin` AND `spaceAccess(openSpaceDb(A), A, did).isMember`.
    - `respond`, `remove`, `setRoomPermission` → caller must be **admin of A** (existing `requireSpaceAdminCheck`).
    - `setReceiverPermission` → caller must be **admin of B**.
  - All new event types must be added to `ALLOWED_TYPES` and new dispatch sets (`FEDERATION_MANAGE_TYPES`, `FEDERATION_REQUEST_TYPES`, etc.).

### 5.3 Sidebar injection (`getMetadata` for Space B)

- When rendering Space B's sidebar, query the global registry for `federation_room_permissions` where `federating_space_did = B` and `permission` is non-null, group by `space_id` (origin), open each origin's per-space DB to fetch channel name/`default_access`, and append them as `SidebarChannel[]` entries tagged `federated: { originSpaceId, permission }` (drives the decoration). Gate: **B admins see them by default; B members see them only if `federatedRoomAccess` grants read** (or per-phase policy below).

### 5.4 Access memoisation

`createAccessMemo` should gain federation caches (per `(roomId, did)` federated decisions) so the sidebar/thread loops don't fan out cross-space queries. This is a natural extension of the existing memo.

### 5.5 Threads inherit federation from their parent channel (explicit)

In Roomy, a thread's permissions are derived from its parent channel, not set on the thread itself. `access.ts` already does this in two ways:

- **Effective `default_access`**: `resolveRoom` follows the canonical `link` edge and sets a thread's `defaultAccess = minAccess(parent.defaultAccess, own)` — a thread can never grant more than its parent.
- **Grants attach to the channel**: `computeRoomAccess` uses `permRoom = parentChannelId ?? roomId` when resolving role grants, so a role's permission on a channel applies to all of that channel's threads.

Federation must mirror this exactly — **it does so with no extra per-thread state**, provided the federated access path follows the same rule:

- **Federation grants are channel-scoped.** The origin grant (`federation_room_permissions[A, B, channel]`) and the receiver grant (`federation_receiver_permissions[A, B, channel, grantee]`) are both keyed on the **parent channel**, never the thread. This matches the plan's UI (Space A admins pick channels, not threads).
- **`federatedRoomAccess` resolves grants against the parent channel.** For any room, first call the existing `resolveRoom` to get `parentChannelId`; then look up origin/receiver grants using `parentChannelId` (mirroring `permRoom = parentChannelId ?? roomId`). The thread's own `default_access` only ever *restricts* via `minAccess`, never grants.
- **Consequence:** federating a channel automatically federates its threads — reads (room/getMetadata, getMessages, threads) and writes (message create/edit/delete) for a B member resolve grants on the parent channel, exactly as role grants do today. No per-thread federation flags, no per-thread grants.
- **Sidebar:** federated channels are injected into B's sidebar; their threads already flow through the existing active-threads logic (threads are distributed into their parent channel's `activeThreads`), so they appear under the federated channel for B. The access check for each such thread routes through the federation-aware `roomAccess`/`federatedRoomAccess`.

**Concrete change for Phase 2/3:** `federatedRoomAccess` must (a) resolve the canonical parent channel for threads, (b) check origin+receiver grants against that channel, and (c) apply the thread's own `defaultAccess` only as a downward `minAccess` cap. A regression test should cover: origin grant on a channel ⇒ a B member can read/write that channel's threads; removing the channel's origin grant removes thread access.

---

## 6. Phasing

All frontend work gated on the `channel-federation` feature flag (returned by `space.roomy.getFlags`); backend event processing additionally guarded by the same flag so nothing can be triggered via the API while disabled.

### Phase 0 — Research & scaffolding (this document; no code)
- Confirm the storage choice (global registry vs virtual role) with the team.
- Decide `Roles → Permissions` rename (recommended: rename the nav item, keep the route `settings/roles` with a redirect, to limit churn).

### Phase 1 — Relationship lifecycle (backend, flag off by default)
- SDK events: `request`, `respond`, `remove`; global `space_federations` table.
- Lexicons/queries: `getRequests`, `getIncoming`, `getOutgoing`.
- writeAuth categories for the 3 events (cross-space admin-of-B check for `request`).
- Handler: request → notification for A admins (reuse/parallel the `activity_item` / settings-notification surface).
- **Acceptance:** A admin sees request in settings, approves/rejects; B admin sees status.

### Phase 2 — Origin grants + read federation (backend, flag off)
- `setRoomPermission` (origin grant) + `federation_room_permissions`.
- `federatedRoomAccess` read path; `getMetadata` sidebar injection for B (B admins see federated channels with decoration; origin grant `read` → B admins/members can read).
- **Acceptance:** A admin grants a channel to B; channel appears in B sidebar decorated; B members can read it.

### Phase 3 — Receiver grants + write federation (backend, flag off) ✅ shipped
- `setReceiverPermission` (receiver grant) + `federation_receiver_permissions`.
- Extend `requireRoomWriteCheck`/`writeAuth` for federated writes; B admins configure which B members/roles can use the channel (capped by origin grant).
- **Acceptance:** B members can write to federated channels when both grants allow; ceilings enforced.

### Phase 4 — Frontend (flag ON) ✅ shipped
- Add `channel-federation` to the flags the app checks; gate all UI below.
- **Settings badge + notification:** federation requests appear as a badge on the settings icon (`SpaceSidebarButtons`) and a section in `settings/notifications` / a new `settings/federations` page; approve/reject actions call `respond`.
- **Roles → Permissions rename** in settings nav (+ route redirect).
- **Channel-permission UI:** in the Permissions/RoleEdit surface, list accepted federations alongside roles with read/readwrite toggles (origin grants) → calls `setRoomPermission`.
- **Space B sidebar:** federated channels rendered with a special decoration (origin-space chip/icon); visible to B admins by default, to B members per receiver grants.
- **Space B receiver config:** admins see a "federated channels" section to set receiver grants (`setReceiverPermission`) for B roles/users.

### Phase 5 — Hardening ✅ shipped
- Revoke (A removes federation → clean up grants + remove from B sidebar).
- B-side rejection/removal; banning a federated B member; edge cases (origin channel deleted/renamed, origin space deleted, B member leaves B). **Mutual federation A↔B is explicitly supported and trivially modeled** — the two directions are independent `space_federations` rows and grant lookups are anchored by the channel's owning space, so they cannot cycle. Guard only against accidental double-request (one pending request per `(A,B)` pair).
- Invalidation signals so both spaces' sync caches update on grant changes.
- E2E tests (app-password auth mode, local appserver) covering the full request→approve→grant→read/write chain. **Shipped**: `src/e2e/federation.test.ts` drives the whole chain over real XRPC (B-admin request → A-admin approve → origin grant → receiver grant → federated read/write, plus no-grant denial and A-side revoke). This surfaced a real gap — `sendEvents`' hard space-membership gate blocked B members before writeAuth ever ran — fixed by relaxing the gate (banned callers still rejected; writeAuth remains the sole per-event authority).

---

## 7. Risks & open questions

1. **Cross-space auth in the hot path.** `roomAccess` currently touches one DB; federation adds global-DB lookups and, for receiver grants, possibly Space B's DB. Must be memoised and benchmarked; keep the A-member fast path intact so non-federated spaces are unaffected.
2. **Write path correctness.** A federated write lands in **Space A's stream/DB** but originates from a B member. Ensure the event's `spaceId` stays A (it lives in A's DB), writeAuth authorizes against the federation, and materialization is identical to a native A write. Notification/activity/mention/push side-effects must fire as if an A member wrote it.
3. **Feature flag safety.** Keep the flag enforced server-side (reject events while off) so frontend-only gating isn't a security hole.
4. **Storage choice** (global registry vs virtual role in `roles`). Global registry is cleaner but adds a new access layer; virtual role reuses UI at the cost of semantic conflation. Decide before Phase 2.
5. **Sidebar/sync visibility** — federated channels cross a DB boundary; unread counts / active threads currently key on `(user, room)` in the read-state DB and work regardless of origin, but `getMetadata`'s thread injection is A-only and must learn to include federated channels for B.
6. **Naming** — `Roles` → `Permissions` touches URLs, tests, and docs; keep a redirect to avoid breaking existing links.
7. **Transitive re-federation is out of scope (a structural non-feature, not a hard constraint).** v1 grants are authored only by a channel's *owning* space, so a federated channel is never re-hosted or re-forwarded by the receiving space. Consequently the grant graph is strictly a star per channel (owner → receivers) and cannot form cycles. **Mutual (bidirectional) federation A↔B is fully supported** — it is just two independent relationships whose grant lookups are anchored by each channel's owning space, so they never interfere. If a later phase adds transitive re-federation (B re-exposing A's channel to C), a cycle-guard and bounded access-resolution depth become required; note this explicitly before that work.

---

## 8. Testing

- **Unit (appserver, `bun test`)**: `access.ts`/`federation.ts` pure decisions (origin/receiver ceiling via `minAccess`); `writeAuth` dispatch for the 3 manage events + federated room writes; materializer for the 5 new events (mocked global DB).
- **HTTP E2E** (`appserver.test.ts`, test-mode auth): boot two spaces A and B with a shared user; exercise request→approve→origin grant→read→receiver grant→write chain; assert denials (non-admin, no grant, ceiling exceeded).
- **Frontend**: gate off = no federation UI; gate on = badge, request approval, Permissions page, sidebar decoration, receiver config.
- **Regression**: run existing `access.ts`/`writeAuth.ts` tests to prove non-federated paths are unchanged (A-member fast path untouched).
