-- Read-state schema (data/roomy-readstate.sqlite).
--
-- This database stores appserver-owned state that cannot be reconstructed
-- from the Leaf event log. Unlike the materialisation DB, this data
-- survives schema changes to the materialisation tables.
--
-- Bump the version constant in readStateDb.ts whenever this file changes.

pragma foreign_keys = on;

create table if not exists readstate_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

create table if not exists read_positions (
  user_did    text not null,
  room_id     text not null,
  seen_up_to  text not null,   -- sort_idx of the last-read message entity
  unread_count integer not null default 0,
  updated_at  integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;

create table if not exists user_thread_activity (
  user_did      text not null,
  thread_id     text not null,
  last_active_at integer not null,   -- unix epoch milliseconds
  updated_at    integer not null default (unixepoch() * 1000),
  primary key (user_did, thread_id)
) strict;

create index if not exists idx_user_thread_activity_user
  on user_thread_activity(user_did, last_active_at desc);

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
-- Engaged digest to restrict prompts to rooms you've spoken in. (Phase 2
-- populates this; the table exists from schema v3 so it's ready.)
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
-- opened the room. Reset (deleted) by the updateSeen handler. (Phase 2
-- drives this; the table exists from schema v3 so it's ready.)
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