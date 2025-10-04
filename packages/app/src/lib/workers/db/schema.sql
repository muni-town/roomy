pragma foreign_keys = on;

CREATE TABLE IF NOT EXISTS events (
  idx INTEGER NOT NULL,
  stream_hash_id BLOB NOT NULL,
  entity_ulid BLOB REFERENCES entities(ulid) ON DELETE CASCADE,
  payload BLOB,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  applied INTEGER DEFAULT 0,
  PRIMARY KEY (idx, stream_hash_id)
) STRICT;

create table if not exists entities (
  ulid blob primary key, 
  stream_hash_id blob not null,
  parent blob,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;
create index if not exists idx_entities_stream_hash_id on entities (stream_hash_id);
create index if not exists idx_entities_parent on entities (parent);

CREATE TABLE IF NOT EXISTS edges (
    head BLOB NOT NULL,
    tail BLOB NOT NULL,
    label TEXT NOT NULL, -- CHECK(label IN ('child', 'parent', 'subscribe', 'member', 'ban', 'hide', 'pin', 'last_read', 'embed', 'reply', 'link', 'author', 'reorder', 'source', 'avatar')),
    payload TEXT CHECK(json_valid(payload)),
    created_at integer not null default (unixepoch() * 1000),
    updated_at integer not null default (unixepoch() * 1000),
    PRIMARY KEY (head, tail, label),
    FOREIGN KEY (head) REFERENCES entities(ulid) ON DELETE CASCADE,
    FOREIGN KEY (tail) REFERENCES entities(ulid) ON DELETE CASCADE
) STRICT;

create table if not exists comp_space (
  entity blob primary key references entities(ulid) on delete cascade,
  leaf_space_hash_id blob,
  personal_stream_hash_id blob not null,
  hidden integer not null default 0 check(hidden in (0, 1)),
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_room (
  entity blob primary key references entities(ulid) on delete cascade,
  parent blob references entities(ulid) on delete set null, -- would be more normalised for this to be an edge
  label text, -- "channel", "category", "thread", "page" etc
  deleted integer check(deleted in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create index if not exists idx_comp_room_parent on comp_room(parent);
create index if not exists idx_comp_room_label on comp_room(label);

create table if not exists comp_user (
  entity blob primary key references entities(ulid),
  did text,
  handle text,
  isAdmin integer check(isAdmin in (0, 1)) default 0,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_content (
  entity blob primary key references entities(ulid) on delete cascade,
  mime_type text,
  data blob,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create virtual table if not exists comp_text_content_fts using fts5(
  text, format, content='comp_text_content', content_rowid='rowid'
);

create table if not exists comp_info (
  entity blob primary key references entities(ulid) on delete cascade,
  name text,
  avatar text,
  description text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_override_meta (
  entity blob primary key references entities(ulid) on delete cascade,
  author text,
  timestamp integer,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_reaction (
  entity blob primary key references entities(ulid) on delete cascade,
  reaction_to blob not null references entities(ulid),
  reaction text not null,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;

create table if not exists comp_media (
  entity blob primary key references entities(ulid) on delete cascade,
  uri text,
  created_at integer not null default (unixepoch() * 1000),
  updated_at integer not null default (unixepoch() * 1000)
) strict;