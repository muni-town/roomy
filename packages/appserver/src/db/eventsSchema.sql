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
    received_at integer not null,  -- epoch ms the server accepted the event; see below
    primary key (stream_id, idx)
) strict;

-- `received_at` is the materialisation ordering key's time component
-- (`materialization/sortIdx.ts`). A `createMessage` id is a ULID minted on the
-- sender's device, so keying the timeline on it would let one skewed clock bury
-- a message durably; stamping the server clock at materialisation instead made
-- the key unreproducible from the log. Recording the instant here, once, at
-- append, makes the key a pure function of the log: a rebuild reads this column
-- rather than re-deciding.
--
-- NOT NULL in the declared shape. Existing DBs gain the column through
-- `handleInit`'s ALTER, which cannot add a NOT NULL constraint to a populated
-- table, so the guarantee is on writers rather than on the file: the ALTER
-- backfills `created_at`, and `StreamManager.sendEvents` — the only production
-- writer — always stamps both. A row carrying neither predates both columns
-- and orders by the sender-minted ULID time (`materialization/sortIdx.ts`).

-- Supports "events in the last N hours/day" counts (admin dashboard). Without
-- it those are full table scans of the whole event log.
create index if not exists idx_stream_events_created_at on stream_events(created_at);

-- The interim change feed: the record adapter's output, one row per change a
-- log entry emits (`streams/recordChanges.ts`). Written by the write path in
-- the same call as the log append, so a worker that applies change records
-- reads them here instead of re-running the adapter over events.
--
-- `ord` is the emission order within an entry: one entry can emit several
-- changes (`createRoomLink` emits a room update and a message create;
-- `federation.remove` deletes two kinds), and `(stream_id, idx, ord)` is the
-- total order the worker applies them in. `order_stamp` is the log's ordering
-- key — the same value the materialiser writes to `entities.sort_idx` — so a
-- consumer sorts by it without reading the log.
--
-- `actor` and `event_id` are the entry's own facts rather than the record's:
-- the membership announcement is keyed by the join event's id,
-- `comp_invite.event_ulid` by the invite event's, and a call fact's
-- `joined_at` decodes the event id. `body` is the record (`create`) or patch
-- (`update`) as JSON with bytes carried as `{"$bytes": "<base64>"}`, and null
-- for a delete.
--
-- `insert or replace` makes a write idempotent, which is what lets the
-- backfill script re-run over a stream's log. The table is derived from
-- `stream_events` and can be rebuilt from it at any time.
create table if not exists record_changes (
    stream_id text not null,
    idx integer not null,
    ord integer not null,      -- emission order within one log entry
    kind text not null,
    repo text not null,
    collection text not null,
    rkey text not null,
    op text not null,          -- 'create' | 'update' | 'delete'
    order_stamp text not null,
    actor text not null,
    event_id text not null,
    body text,                 -- JSON full body (create), patch (update), null (delete)
    primary key (stream_id, idx, ord)
) strict;

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
