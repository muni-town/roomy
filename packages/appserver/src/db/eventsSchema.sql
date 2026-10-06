-- Raw event log. One row per event per stream.
-- NEVER delete or modify rows — this is the source of truth.
create table if not exists stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    event_type text,          -- denormalized $type for dashboard stats
    created_at integer,       -- epoch ms at insert time; the admin dashboard's window key
    received_at integer,      -- epoch ms the server accepted the event; see below
    primary key (stream_id, idx)
) strict;

-- `received_at` is the materialisation ordering key's time component
-- (`materialization/sortIdx.ts`). A `createMessage` id is a ULID minted on the
-- sender's device, so keying the timeline on it would let one skewed clock bury
-- a message durably; stamping the server clock at materialisation instead made
-- the key unreproducible from the log. Recording the instant here, once, at
-- append, makes the key a pure function of the log: a rebuild reads this column
-- rather than re-deciding. Nullable only for rows written before the column
-- existed, which fall back to the event's own ULID time.

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
