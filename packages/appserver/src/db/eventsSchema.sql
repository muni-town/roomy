-- Raw event log. One row per event per stream.
-- NEVER delete or modify rows — this is the source of truth.
create table if not exists stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    primary key (stream_id, idx)
) strict;

-- Per-stream metadata (latest event idx, etc.)
create table if not exists stream_state (
    stream_id text primary key,
    latest_event integer not null default 0
) strict;

-- Per-stream DID signing keys, mirroring Leaf's did_keys/did_owners tables.
-- Each stream gets its own k256 keypair for PLC operations (rotation key +
-- verification method). Migrated from Leaf's leaf.db for existing streams.
create table if not exists dids (
    did text primary key
) strict;

create table if not exists did_keys (
    did text references dids(did),
    p256_key blob,
    k256_key blob
) strict;

create table if not exists did_owners (
    did text references dids(did),
    owner text not null,
    unique (did, owner)
) strict;
