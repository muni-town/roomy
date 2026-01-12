-- Remember to update lib/config.ts schema version if you change this <3

pragma foreign_keys = on;

create table if not exists roomy_schema_version (
  id integer primary key check (id = 1),
  version text not null
) strict;

CREATE TABLE IF NOT EXISTS events (
  idx integer not null,
  stream_id text not null,
  user text not null,
  entity_ulid text references entities(ulid) on delete cascade,
  depends_on text,
  payload text,  -- json
  created_at integer not null default (unixepoch() * 1000),
  applied integer default 0,
  primary key (idx, stream_id)
) STRICT;
-- Index for efficiently finding stashed events when a dependency is satisfied
CREATE INDEX IF NOT EXISTS idx_events_depends_on 
  ON events(depends_on) WHERE applied = 0;

-- Index for checking if a dependency exists and is applied
CREATE INDEX IF NOT EXISTS idx_events_entity_applied 
  ON events(entity_ulid, applied);

create table if not exists entities (
  id text primary key, -- did or ulid
  stream_id text not null, -- did
  room text, -- ulid, references room id
  sort_idx text, -- mutable timeline ordering index based on ULID with jittered fractional indexing
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;
create index if not exists idx_entities_stream_id on entities (stream_id);
create index if not exists idx_entities_after on entities(after);
create index if not exists idx_entities_sort_idx on entities(sort_idx);

-- This is an important index because it allows us to query for entities in a thread
-- with a reverse sort order to get only the latest entities.
create index if not exists idx_entities_room on entities (room, id desc);

CREATE TABLE IF NOT EXISTS edges (
    head text NOT NULL, -- did or ulid
    tail text NOT NULL, -- did or ulid
    label TEXT NOT NULL, -- CHECK(label IN ('child', 'parent', 'subscribe', 'member', 'ban', 'hide', 'pin', 'embed', 'reply', 'link', 'author', 'reorder', 'source', 'avatar')),
    payload TEXT,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    FOREIGN KEY (head) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (tail) REFERENCES entities(id) ON DELETE CASCADE,
    primary key (head, tail, label)
) STRICT;
create index if not exists idx_edges_label on edges(label);
create index if not exists idx_edges_label_head on edges(label, head);
create index if not exists idx_edges_label_tail on edges(label, tail);

create table if not exists comp_space (
  entity text primary key references entities(id) on delete cascade,
  hidden integer not null default 0 check(hidden in (0, 1)),
  handle_account text, -- did
  backfilled_to integer references events(idx) default 0,
  sidebar_config text not null default '{ categories: [] }', -- JSON sidebar config
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_room (
  entity text primary key references entities(id) on delete cascade,
  label text, -- "space.roomy.channel", "space.roomy.category", "space.roomy.thread", "space.roomy.page" etc
  deleted integer check(deleted in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create index if not exists idx_comp_room_label on comp_room(label);

create table if not exists comp_user (
  -- The DID is the entity ID for users, but it is encoded into the our ID encoding, not just a
  -- normal string.
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
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create virtual table if not exists comp_text_content_fts using fts5(
  text, format, content='comp_text_content', content_rowid='rowid'
);

create table if not exists comp_info (
  entity text primary key references entities(id) on delete cascade,
  name text,
  avatar text,
  description text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_override_meta (
  entity text primary key references entities(id) on delete cascade,
  author text references entities(id), -- did
  timestamp integer,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- This is a component, attached to a page room entity,
-- but because it has multiple values ( a page can have multiple edits )
-- it has it's own primary key, the ID of the edit, and a separate column
-- that references the entity ID, so that multiple edits can be tied
-- to the same entity.
create table if not exists comp_page_edits( 
  -- This is the ID of the edit event
  edit_id text primary key, -- ulid
  -- The page entity that is being edited
  entity text references entities(ulid) on delete cascade,
  mime_type text not null,
  data blob not null,
  user_id text not null -- did -- author of each edit
  -- We don't need a created_at date because that is in the ULID
  -- and we don't need an updated_at date because the diff will
  -- never, itself, be edited.
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
  timestamp integer not null,
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

create index if not exists idx_comp_last_read_timestamp on comp_last_read(timestamp);
  