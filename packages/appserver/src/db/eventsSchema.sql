-- Raw event log. One row per event per stream.
-- NEVER delete or modify rows — this is the source of truth.
create table if not exists stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    event_type text,          -- denormalized $type for dashboard stats
    created_at integer,       -- epoch ms, set at insert time
    primary key (stream_id, idx)
) strict;

-- Supports "events in the last N hours/day" counts (admin dashboard). Without
-- it those are full table scans of the whole event log.
create index if not exists idx_stream_events_created_at on stream_events(created_at);

-- Per-stream metadata (latest event idx, etc.)
--
-- `latest_event` is the highest `idx` in the stream and doubles as a rollup:
-- `idx` is assigned as max(idx)+1 and never deleted, so the stream holds
-- exactly `latest_event + 1` events and the admin dashboard sums this column
-- instead of counting the whole log.
create table if not exists stream_state (
    stream_id text primary key,
    latest_event integer not null default 0
) strict;

-- Per-stream DID signing keys. Each stream gets its own k256 keypair for PLC
-- operations (rotation key + verification method).
create table if not exists dids (
    did text primary key
) strict;

create table if not exists did_keys (
    did text references dids(did),
    p256_key blob,
    k256_key blob,
    unique (did)
) strict;

create table if not exists did_owners (
    did text references dids(did),
    owner text not null,
    unique (did, owner)
) strict;
