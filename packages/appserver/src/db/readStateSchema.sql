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