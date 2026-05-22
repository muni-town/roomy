-- Roomy appserver SQLite schema.
--
-- Ported from packages/app/src/lib/workers/sqlite/schema.sql. Materialiser
-- functions in the SDK target this exact shape, so column names and types
-- must stay in sync with the frontend schema.
--
-- IMPORTANT: bump the version constant in db.ts whenever this file changes.

pragma foreign_keys = on;

create table if not exists roomy_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

-- NOTE: the frontend schema includes an `events` table used for stash/unstash
-- of out-of-order events. The appserver materialises strictly in increasing
-- `idx` order from a single Leaf subscription, so dependencies are always
-- already applied — no stash machinery is needed and the table is omitted.
-- The backfill cursor lives on `comp_space.backfilled_to`.

create table if not exists entities (
  id text primary key, -- did or ulid
  stream_id text not null, -- did
  room text, -- ulid, references room id
  sort_idx text, -- mutable timeline ordering index based on ULID with jittered fractional indexing
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;
create index if not exists idx_entities_stream_id on entities (stream_id);
create index if not exists idx_entities_sort_idx on entities(sort_idx);

-- This is an important index because it allows us to query for entities in a thread
-- with a reverse sort order to get only the latest entities.
create index if not exists idx_entities_room on entities (room, id desc);

create table if not exists edges (
    head text not null, -- did or ulid
    tail text not null, -- did or ulid
    label text not null,
    payload text,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    foreign key (head) references entities(id) on delete cascade,
    foreign key (tail) references entities(id) on delete cascade,
    primary key (head, tail, label)
) strict;
create index if not exists idx_edges_label on edges(label);
create index if not exists idx_edges_label_head on edges(label, head);
create index if not exists idx_edges_label_tail on edges(label, tail);

-- Space-global config + the backfill cursor. One row per space.
--
-- NOTE: `hidden` is per-user join intent and so does NOT belong on this
-- global row — with multiple members one user leaving would hide the space
-- for everyone. The appserver reads membership from `edges` rows labelled
-- 'joinedSpace' instead (see queries/joinedSpaces.ts). `hidden` is still
-- written by the shared SDK materialiser (the main app's local DB reads it)
-- but the appserver ignores it. Drop it once the main app also migrates.
create table if not exists comp_space (
  entity text primary key references entities(id) on delete cascade,
  hidden integer not null default 0 check(hidden in (0, 1)),
  handle text, -- domain
  handle_provider text,
  backfilled_to integer default 0,
  sidebar_config text not null default '{"categories": []}', -- JSON sidebar config
  allow_public_join integer check(allow_public_join in (0, 1)), -- null = unset (defaults to open)
  allow_member_invites integer check(allow_member_invites in (0, 1)), -- null = unset (defaults to yes)
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_room (
  entity text primary key references entities(id) on delete cascade,
  label text, -- "space.roomy.channel", "space.roomy.category", "space.roomy.thread", "space.roomy.page" etc
  default_access text check(default_access in ('readwrite', 'read', 'none')) default 'readwrite',
  deleted integer check(deleted in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create index if not exists idx_comp_room_label on comp_room(label);

create table if not exists comp_discord_origin (
  entity text primary key references entities(id) on delete cascade,
  snowflake text not null,
  guild_id text not null
) strict;
create index if not exists idx_comp_discord_origin on comp_discord_origin(snowflake, guild_id);

create table if not exists comp_user (
  -- The DID is the entity ID for users, but it is encoded into our ID encoding,
  -- not just a normal string.
  did text primary key references entities(id),
  handle text, -- atproto handle
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_content (
  entity text primary key references entities(id) on delete cascade,
  mime_type text,
  data blob,
  last_edit text not null, -- ID of most recent edit event
  timestamp integer, -- Canonical message timestamp (milliseconds since epoch), resolves override if present
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- NOTE: the frontend schema declares a comp_text_content_fts virtual table
-- referencing a (nonexistent) comp_text_content content table. The browser
-- worker swallows the resulting error; we drop the table here until full-text
-- search is actually implemented. Re-add when the backing content table exists.

create table if not exists comp_info (
  entity text primary key references entities(id) on delete cascade,
  name text,
  avatar text,
  description text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- This is a component, attached to a page room entity, but because it has
-- multiple values (a page can have multiple edits) it has its own primary key,
-- the ID of the edit, and a separate column that references the entity ID, so
-- that multiple edits can be tied to the same entity.
create table if not exists comp_page_edits (
  -- This is the ID of the edit event
  edit_id text primary key, -- ulid
  -- The page entity that is being edited
  entity text references entities(ulid) on delete cascade,
  mime_type text not null,
  data blob not null,
  user_id text not null -- did -- author of each edit
) strict;

create table if not exists comp_comment (
  entity text primary key references entities(ulid) on delete cascade,
  version text references comp_page_edits(edit_id) on delete cascade,
  snippet text not null,
  idx_from integer not null,
  idx_to integer not null,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_embed_image (
  entity text primary key references entities(ulid) on delete cascade, -- URI
  mime_type text not null,
  size integer,
  width integer,
  height integer,
  blurhash text,
  alt text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_embed_video (
  entity text primary key references entities(ulid) on delete cascade, -- URI
  mime_type text not null,
  size integer,
  width integer,
  height integer,
  length integer,
  blurhash text,
  alt text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_embed_file (
  entity text primary key references entities(ulid) on delete cascade, -- URI
  mime_type text not null,
  size integer,
  name text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_embed_link (
  entity text primary key references entities(ulid) on delete cascade, -- URI
  show_preview integer check(show_preview in (0, 1)) default 1,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_last_read (
  entity text primary key references entities(id) on delete cascade,
  last_read integer not null,
  unread_count integer,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_reaction (
  entity text references entities(id) on delete cascade, -- id of the message
  user text references entities(id) on delete cascade, -- did
  reaction_id text not null, -- event id that added the reaction
  reaction text not null, -- generally emoji
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000),
  primary key (entity, user, reaction)
) strict;

create index if not exists idx_comp_last_read_last_read on comp_last_read(last_read);

-- OpenMeet calendar integration
create table if not exists comp_calendar_link (
  entity text primary key,
  group_slug text not null,
  tenant_id text not null,
  api_url text not null
) strict;

create table if not exists comp_calendar_event (
  entity text primary key,
  slug text not null,
  name text not null,
  start_date text not null,
  end_date text,
  location text,
  location_online text,
  status text not null default 'Published',
  synced_at integer not null
) strict;

create index if not exists idx_calendar_event_start
  on comp_calendar_event(start_date);

create table if not exists roles (
  id text primary key, -- ulid of the createRole event
  stream_id text not null, -- space stream did
  name text,
  avatar text,
  description text,
  deleted integer not null default 0 check(deleted in (0, 1))
) strict;
create index if not exists idx_roles_stream_id on roles(stream_id);

create table if not exists member_roles (
  user_id text not null, -- did
  role_id text not null, -- references roles(id)
  stream_id text not null,
  primary key (user_id, role_id)
) strict;
create index if not exists idx_member_roles_role_id on member_roles(role_id);

create table if not exists role_rooms (
  role_id text not null, -- references roles(id)
  room_id text not null, -- references entities(id)
  stream_id text not null,
  permission text not null check(permission in ('read', 'readwrite')),
  primary key (role_id, room_id)
) strict;
create index if not exists idx_role_rooms_room_id on role_rooms(room_id);

-- Banned users per space. Written by the SDK's BanAccount materializer
-- (`insert into comp_bans (entity, user_did)`). Notably the frontend schema
-- never declared this table — banAccount events silently no-op there because
-- the worker swallows per-statement errors. The appserver applies events
-- transactionally so we need a real table.
create table if not exists comp_bans (
  entity text not null references entities(id) on delete cascade,
  user_did text not null,
  created_at integer not null default (unixepoch() * 1000),
  primary key (entity, user_did)
) strict;
create index if not exists idx_comp_bans_user_did on comp_bans(user_did);

-- Active invite tokens per space. Written by the SDK's CreateInvite/RevokeInvite
-- materializers. Frontend has no equivalent table today; the worker swallows
-- per-statement errors there, so this is appserver-only.
create table if not exists comp_invite (
  entity text not null references entities(id) on delete cascade,
  token text not null,
  created_by_did text not null,
  event_ulid text not null,
  created_at integer not null default (unixepoch() * 1000),
  primary key (entity, token)
) strict;
create index if not exists idx_comp_invite_creator on comp_invite(entity, created_by_did);

-- Cache of user DID → personal stream DID, resolved from the user's PDS via
-- com.atproto.repo.getRecord. The record on the PDS is meant to be stable per
-- user so we don't TTL these. Appserver-only; no frontend equivalent.
create table if not exists comp_user_personal_stream (
  user_did text primary key,
  personal_stream_did text not null,
  resolved_at integer not null default (unixepoch() * 1000)
) strict;
