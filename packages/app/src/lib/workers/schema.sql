pragma foreign_keys = on;

CREATE TABLE IF NOT EXISTS events (
  idx INTEGER NOT NULL,
  stream_id BLOB NOT NULL,
  entity_ulid BLOB REFERENCES entities(ulid) ON DELETE CASCADE,
  payload BLOB,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  applied INTEGER DEFAULT 0,
  PRIMARY KEY (idx, stream_id)
) STRICT;

create table if not exists entities (
  id blob primary key, 
  stream_id blob not null,
  parent blob,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;
create index if not exists idx_entities_stream_id on entities (stream_id);

-- This is an important index because it allows us to query for entities in a thread
-- with a reverse sort order to get only the latest entities.
create index if not exists idx_entities_parent on entities (parent, id desc);

CREATE TABLE IF NOT EXISTS edges (
    edge_id integer primary key autoincrement,
    head BLOB NOT NULL,
    tail BLOB NOT NULL,
    label TEXT NOT NULL, -- CHECK(label IN ('child', 'parent', 'subscribe', 'member', 'ban', 'hide', 'pin', 'last_read', 'embed', 'reply', 'link', 'author', 'reorder', 'source', 'avatar')),
    payload TEXT,
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    FOREIGN KEY (head) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (tail) REFERENCES entities(id) ON DELETE CASCADE
) STRICT;
create index if not exists idx_edges_label on edges(label);
create index if not exists idx_edges_label_head on edges(label, head);
create index if not exists idx_edges_label_tail on edges(label, tail);

create table if not exists comp_space (
  entity blob primary key references entities(id) on delete cascade,
  hidden integer not null default 0 check(hidden in (0, 1)),
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_room (
  entity blob primary key references entities(id) on delete cascade,
  label text, -- "channel", "category", "thread", "page" etc
  deleted integer check(deleted in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create index if not exists idx_comp_room_label on comp_room(label);

create table if not exists comp_user (
  -- The DID is the entity ID for users, but it is encoded into the our ID encoding, not just a
  -- normal string.
  did blob primary key references entities(id),
  handle text,
  isAdmin integer check(isAdmin in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_content (
  entity blob primary key references entities(id) on delete cascade,
  mime_type text,
  data blob,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create virtual table if not exists comp_text_content_fts using fts5(
  text, format, content='comp_text_content', content_rowid='rowid'
);

create table if not exists comp_info (
  entity blob primary key references entities(id) on delete cascade,
  name text,
  avatar text,
  description text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_override_meta (
  entity blob primary key references entities(id) on delete cascade,
  author blob references entities(id),
  timestamp integer,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_media (
  entity blob primary key references entities(ulid) on delete cascade,
  uri text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

-- Aggregation table containing the number of entities created in a room in a
-- 48 hour time slot. This can be used to build an activity histogram.
create table if not exists agg_room_activity (
  room_entity blob references entities(id) on delete cascade,
  time_slot integer,
  count integer,
  primary key (room_entity, time_slot)
) strict;

create trigger if not exists agg_room_activity_update_entity
after insert on entities
for each row when new.parent is not null and is_ulid(new.id)
begin
  insert into agg_room_activity (room_entity, time_slot, count)
  values (
      new.parent,
      ulid_timestamp(new.id) / 1000 / 86400,
      1
  )
  on conflict(room_entity, time_slot) do update set count = count + 1;
end;

create trigger if not exists agg_room_activity_update_override
after insert on comp_override_meta
for each row when exists
  (select 1 from entities e where e.id = new.entity and e.parent is not null)
begin
  update agg_room_activity set count = count - 1
  where
    room_entity in (
      select parent from entities where id = new.entity
    )
      and
    time_slot = ulid_timestamp(new.entity) / 1000 / 86400;
  insert into agg_room_activity (room_entity, time_slot, count)
  values (
      (select parent from entities where id = new.entity),
      new.timestamp / 1000 / 86400,
      1
  )
  on conflict(room_entity, time_slot) do update set count = count + 1;
end;