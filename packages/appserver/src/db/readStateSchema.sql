-- Read-state schema (data/roomy-readstate.sqlite).
--
-- This database stores appserver-owned state that cannot be reconstructed
-- from the event log. Unlike the materialisation DB, this data
-- survives schema changes to the materialisation tables.
--
-- Bump by adding a version to READSTATE_MIGRATIONS in readStateVersions.ts;
-- that manifest drives the version constant, the worker's upgrade loop, and
-- the async-task key type.

pragma foreign_keys = on;

create table if not exists readstate_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

-- Resumable asynchronous/data migrations. Only versions declared
-- `kind: "data"` in READSTATE_MIGRATIONS get a row here (the worker inserts it
-- at upgrade time); startup runs the registered task and stamps completed_at
-- only after it succeeds, so interrupted migrations retry safely. Structural
-- versions never appear here.
create table if not exists readstate_schema_migrations (
  version text primary key,
  completed_at integer
) strict;

-- Durable user-owned intent to participate in a space. This is appserver
-- source-of-truth state during the transition to ATProto permission records;
-- actual space access remains derived from the space's member/admin/ban state.
create table if not exists user_space_membership (
  user_did       text not null,
  space_did      text not null,
  state          text not null check(state in ('joined', 'left')),
  source         text not null,
  source_event_id text not null,
  updated_at     integer not null default (unixepoch() * 1000),
  primary key (user_did, space_did)
) strict;
create index if not exists idx_user_space_membership_user_state
  on user_space_membership(user_did, state, updated_at desc);

-- Per-user space ordering (schema v8). One row per (user, space); `position`
-- is the 0-based index in the user's space list. Absent row → fall back to
-- the default ordering (updated_at desc). Written by the reorderSpaces
-- procedure; read by getSpaces.
create table if not exists space_order (
  user_did   text not null,
  space_did  text not null,
  position   integer not null,
  updated_at integer not null default (unixepoch() * 1000),
  primary key (user_did, space_did)
) strict;
create index if not exists idx_space_order_user_position
  on space_order(user_did, position);

create table if not exists read_positions (
  user_did    text not null,
  room_id     text not null,
  space_did   text not null default '',  -- space stream DID (per-space split §1f)
  seen_up_to  text not null,   -- sort_idx of the last-read message entity
  unread_count integer not null default 0,
  updated_at  integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;

-- Room-scoped read-state lookups. The primary key is (user_did, room_id), so
-- every query that filters by `room_id` alone — the createMessage unread bump
-- (`update ... where room_id = ?`), its `getRoomReadPositionUsers` read, and
-- the delete/move unwind (`select ... where room_id = ? and unread_count > 0`)
-- — had no usable index and scanned the WHOLE table. `read_positions` is
-- global across every space, so that scan cost grows with total readership,
-- not with the room being written to: on a production-sized table (~10M rows,
-- 50k rooms x 200 readers) a single scan measured ~1.1s, which a 50-delete
-- sendEvents batch multiplies into ~55s of worker time. Purely additive and
-- idempotent, so it is safe to declare here for every version.
create index if not exists idx_read_positions_room on read_positions(room_id);

create table if not exists user_thread_activity (
  user_did      text not null,
  thread_id     text not null,
  space_did     text not null default '',  -- space stream DID (per-space split §1f)
  last_active_at integer not null,   -- unix epoch milliseconds
  updated_at    integer not null default (unixepoch() * 1000),
  primary key (user_did, thread_id)
) strict;

create index if not exists idx_user_thread_activity_user
  on user_thread_activity(user_did, last_active_at desc);

-- NOTE: the per-space index idx_user_thread_activity_user_space
-- (user_did, space_did, last_active_at desc) is intentionally NOT declared
-- here. It references the `space_did` column, which does not exist on
-- pre-v7 databases; declaring it in this schema file would make
-- `db.exec(schema)` throw "no such column: space_did" on an existing v6 DB
-- before the v7 migration can add the column. It is created by the v7
-- migration (existing DBs) and by the fresh-DB path in
-- initializeReadStateSchema (worker.ts).

-- ── Web push (schema v3) ────────────────────────────────────────────────
-- A device/browser subscription for a user. A user may have many (one per
-- browser). Idempotent on endpoint — re-registering updates keys/expiry.
create table if not exists push_subscriptions (
  user_did        text not null,
  endpoint        text not null,          -- push service URL; unique per subscription
  p256dh          text not null,
  auth            text not null,
  expiration_time integer,                -- epoch ms, nullable
  created_at      integer not null default (unixepoch() * 1000),
  updated_at      integer not null default (unixepoch() * 1000),
  primary key (user_did, endpoint)
) strict;
create index if not exists idx_push_subs_user on push_subscriptions(user_did);

-- User-wide default notification level. Absent row → appserver default
-- ('engaged', matching the copy's highlighted option).
create table if not exists push_user_default (
  user_did text primary key,
  level    text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged',
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- Per-space override. Absent row → fall back to push_user_default.
create table if not exists push_preferences (
  user_did  text not null,
  space_id  text not null,
  level     text not null check(level in ('silent','quiet','engaged','busy')),
  updated_at integer not null default (unixepoch() * 1000),
  primary key (user_did, space_id)
) strict;

-- "User sent a message / participated in this room" signal. Used by the
-- Engaged digest to restrict prompts to rooms you've spoken in.
create table if not exists user_room_participation (
  user_did         text not null,
  room_id          text not null,
  last_message_at  integer not null,     -- epoch ms of the user's latest message in the room
  updated_at       integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;
create index if not exists idx_user_room_participation_user
  on user_room_participation(user_did, last_message_at desc);

-- Per (user, room) digest state for the Engaged "occasional prompts". One
-- row = one pending/fulfilled batch of unseen messages since the user last
-- opened the room. Reset (deleted) by the updateSeen handler.
create table if not exists notification_state (
  user_did            text not null,
  room_id             text not null,
  first_unseen_at     integer,           -- epoch ms of the first unseen message in this batch
  first_unseen_msg_id text,              -- anchor message ULID
  unseen_count        integer not null default 0,
  notified            integer not null default 0 check(notified in (0,1)),
  pushed_at           integer,
  updated_at          integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;
-- Sweep index: find due digests (notified=0, first_unseen_at + 1h <= now).
create index if not exists idx_notification_state_due
  on notification_state(notified, first_unseen_at);

-- ── Feature flags (schema v4) ─────────────────────────────────────────────
-- A flag registered in code. One row per flag key. global_enabled=1 means
-- the flag is on for ALL users (no per-user assignment needed).
create table if not exists feature_flags (
  key             text primary key,
  global_enabled  integer not null default 0 check(global_enabled in (0, 1)),
  updated_at      integer not null default (unixepoch() * 1000)
) strict;

-- Per-user flag assignments. A user's flag is enabled if:
--   global_enabled = 1  OR  a row exists in feature_flag_assignments
create table if not exists feature_flag_assignments (
  flag_key   text not null,
  user_did   text not null,
  updated_at integer not null default (unixepoch() * 1000),
  primary key (flag_key, user_did)
) strict;
create index if not exists idx_ff_assignments_flag
  on feature_flag_assignments(flag_key);

-- ── Roomy Pro bridge tokens (schema v9) ─────────────────────────────────
-- A Roomy Pro subscriber (or negotiated custom-membership grant) may grant
-- one bridge token to a space; the grant powers a guild-space bridge up to
-- the granted capacity. One active grant per user (primary key = grantor
-- DID). `spent_at` is set when the bridged guild's member count exceeds 100
-- and is PERMANENT — a spent grant can neither be revoked nor re-granted.
-- `capacity_snapshot` is the grant-time capacity (for display; live
-- capacity is re-resolved from Polar at read time). The grant row persists
-- across subscription lapses/cancellations — read-time validity is decided
-- by the caller against Polar, and a resubscribed grantor revalidates
-- automatically.
create table if not exists bridge_token_grants (
  grantor_did        text primary key,
  space_did          text not null,
  granted_at         integer not null default (unixepoch() * 1000),
  spent_at           integer,             -- epoch ms; NULL = not spent
  capacity_snapshot  integer not null
) strict;
create index if not exists idx_bridge_token_grants_space
  on bridge_token_grants(space_did);

-- ── Roomy Pro members-area role grants (schema v10) ─────────────────────
-- Tracks the DIDs the Roomy Pro members-role reconcile sweep has granted
-- the 'Members' role in the Roomy Space. This is the sweep's ownership
-- record so it can remove a lapsed subscriber WITHOUT clobbering a
-- manually-assigned member who is not a subscriber. Removal only applies
-- to a tracked DID whose subscription has lapsed.
create table if not exists pro_role_grants (
  did         text primary key,
  granted_at  integer not null default (unixepoch() * 1000)
) strict;

-- ── OAuth scope grants (schema v11) ─────────────────────────────────────
-- The raw OAuth scope string each user last consented to, as returned by
-- the PDS's `getTokenInfo().scope`. Written by the recordScopeGrant
-- procedure (the client calls it after every login/expansion) and read by
-- the unauthenticated getLoginScope query, so a returning user gets the
-- scope they already approved back in one round-trip, with no re-prompt.
--
-- LAST-GRANTED, not a high-water mark: a user who narrows consent on the
-- PDS consent screen must not be silently re-granted the removed scopes on
-- next login. Tiers (`semble`, `withDms`) are a client-side UX abstraction —
-- the server stores the opaque string from `getTokenInfo()` verbatim.
create table if not exists user_oauth_grants (
  user_did       text primary key,
  granted_scope  text not null,
  updated_at     integer not null default (unixepoch() * 1000)
) strict;