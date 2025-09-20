pragma foreign_keys = on;

create table if not exists entities (
  ulid blob primary key, 
  stream blob not null,
  parent blob,
  created_at integer
  -- not sure if we need labels or not
  -- label text check(label in ('notification', 'media', 'device', 'user', 'timeline', 'message', 'task', 'space')),
) strict;

create index if not exists idx_entities_stream on entities (stream);

create table if not exists spaces (
  id blob primary key,
  stream blob not null,
  name text,
  avatar text,
  description text,
  hidden integer not null default 0 check(hidden in (0, 1))
) strict;

create table if not exists space_admins (
  space_id blob primary key references spaces(id),
  admin_id text not null,
  unique (space_id, admin_id)
) strict;

create table if not exists space_members (
  space_id blob primary key,
  member blob not null,
  -- 0 means read, 1 means write
  access integer not null
) strict;

create table if not exists comp_room (
  entity blob primary key references entities(ulid) on delete cascade,
  parent blob references entities(ulid) on delete set null
) strict;

create table if not exists comp_room_members (
  room blob not null references comp_room(entity),
  -- this is an encoded groupmember
  member blob not null,
  -- 0 means read, 1 means write, an encoded readorwrite
  access integer not null check(access in (0, 1))
) strict;

create table if not exists comp_reply (
  entity blob primary key references entities(ulid),
  reply_to blob not null references entities(ulid)
) strict;

create table if not exists profiles (
  did text primary key,
  handle text,
  display_name text,
  avatar text
) strict;

create table if not exists comp_user_access_times (
  entity blob primary key references entities(ulid) on delete cascade,
  created_at integer not null,
  updated_at integer not null,
  user_created_at integer not null,
  user_updated_at integer not null
) strict;

create index if not exists idx_user_access_times on comp_user_access_times (created_at);

create index if not exists idx_user_access_times_updated on comp_user_access_times (updated_at);

create table if not exists comp_content (
  entity blob primary key references entities(ulid) on delete cascade,
  mime_type text,
  data blob
) strict;

create virtual table if not exists comp_text_content_fts using fts5(
  text, format, content='comp_text_content', content_rowid='rowid'
);

create table if not exists comp_info (
  entity blob primary key references entities(ulid) on delete cascade,
  name text,
  avatar text,
  description text
) strict;

create table if not exists comp_override_meta (
  entity blob primary key references entities(ulid) on delete cascade,
  source text,
  author text,
  timestamp integer
) strict;

create table if not exists comp_reaction (
  entity blob primary key references entities(ulid) on delete cascade,
  reaction_to blob not null references entities(ulid),
  reaction text not null
) strict;

create table if not exists comp_media (
  entity blob primary key references entities(ulid) on delete cascade,
  uri text
) strict;