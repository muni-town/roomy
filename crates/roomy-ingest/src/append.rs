//! The log append: one transaction per batch, and nothing half-written.
//!
//! The event log is the source of truth for a space. An entry is appended with
//! its record changes and the stream's latest index in the same transaction, so
//! a worker reading `record_changes` from a cursor can never see an entry
//! without its changes, and the index a reader observes is the index a writer
//! committed.
//!
//! `idx` is assigned inside the transaction as `max(idx) + 1`, which is what
//! makes concurrent appends to one stream serialise without a lock the caller
//! can hold: SQLite's write lock is the only ordering primitive involved.

use std::path::Path;

use rusqlite::Connection;

use crate::record_change::RecordChangeRow;

#[derive(Debug, thiserror::Error)]
pub enum AppendError {
    #[error("event log error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("event log error: {0}")]
    Cbor(String),
}

/// One log entry to append.
///
/// The record changes are a function of the entry's index rather than a list,
/// because every row's ordering stamp encodes the position the entry lands on —
/// and that position is assigned inside the transaction that writes it.
pub struct AppendDraft<'a> {
    pub stream_id: String,
    /// The sender's DID, as recorded on the entry.
    pub user: String,
    /// The CBOR encoding of the event, as the log stores it.
    pub payload: Vec<u8>,
    /// The event's `$type`, denormalised for the dashboard's statistics.
    pub event_type: String,
    /// The instant the server accepted the batch: the ordering key's time
    /// component, and the log's own account of when the entry arrived.
    pub created_at: i64,
    pub received_at: i64,
    /// The changes the entry produces at the given index, in emission order.
    pub rows: Box<dyn FnOnce(i64) -> Vec<RecordChangeRow> + 'a>,
}

/// The event log, opened for writing.
pub struct EventLog {
    conn: Connection,
}

impl EventLog {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppendError> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        // Write-ahead logging is what lets a worker read the log while the
        // ingress appends to it.
        let _: String = conn.query_row("pragma journal_mode = wal", [], |row| row.get(0))?;
        conn.execute_batch(EVENTS_SCHEMA)?;
        Ok(Self { conn })
    }

    /// An in-memory log with the schema applied, for tests.
    pub fn in_memory() -> Result<Self, AppendError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(EVENTS_SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Append a batch and return the index its first entry landed on.
    ///
    /// The whole batch is one transaction: a failure on the last entry leaves
    /// none of them in the log.
    pub fn append(&mut self, entries: Vec<AppendDraft<'_>>) -> Result<i64, AppendError> {
        let transaction = self.conn.transaction()?;
        let mut start = 0i64;
        for (position, entry) in entries.into_iter().enumerate() {
            if position == 0 {
                start = next_index(&transaction, &entry.stream_id)?;
            }
            // `next_index` reads `max(idx)` inside the transaction, so a batch
            // lands on consecutive indexes and two concurrent appends cannot
            // take the same one: SQLite's write lock orders them.
            let idx = next_index(&transaction, &entry.stream_id)?;
            transaction.execute(
                "insert into stream_events
                   (stream_id, idx, user, payload, signature, event_type, created_at, received_at)
                 values (?, ?, ?, ?, x'', ?, unixepoch() * 1000, ?)",
                rusqlite::params![
                    entry.stream_id,
                    idx,
                    entry.user,
                    entry.payload,
                    entry.event_type,
                    entry.received_at,
                ],
            )?;
            for row in (entry.rows)(idx) {
                transaction.execute(
                    "insert or replace into record_changes
                       (stream_id, idx, ord, kind, repo, collection, rkey, op,
                        order_stamp, actor, event_id, body)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![
                        row.stream_id,
                        row.idx,
                        row.ord,
                        row.kind,
                        row.repo,
                        row.collection,
                        row.rkey,
                        row.op,
                        row.order_stamp,
                        row.actor,
                        row.event_id,
                        row.body,
                    ],
                )?;
            }
            transaction.execute(
                "insert into stream_state (stream_id, latest_event)
                 select ?, coalesce(max(idx), -1) from stream_events where stream_id = ?
                 on conflict (stream_id) do update set latest_event = excluded.latest_event",
                rusqlite::params![entry.stream_id, entry.stream_id],
            )?;
        }
        transaction.commit()?;
        Ok(start)
    }
}

/// The index the next entry into `stream_id` will take.
fn next_index(conn: &Connection, stream_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "select coalesce(max(idx), -1) + 1 from stream_events where stream_id = ?",
        [stream_id],
        |row| row.get::<_, i64>(0),
    )
}

/// The log's own tables, as `eventsSchema.sql` declares them. Only these are
/// written here; the rest of that schema belongs to services this crate does
/// not replace.
const EVENTS_SCHEMA: &str = "\
create table if not exists stream_events (
    stream_id text not null,
    idx integer not null,
    user text not null,
    payload blob not null,
    signature blob not null default x'',
    event_type text,
    created_at integer,
    received_at integer not null,
    primary key (stream_id, idx)
) strict;

create table if not exists stream_state (
    stream_id text primary key,
    latest_event integer not null default 0
) strict;

create table if not exists record_changes (
    stream_id text not null,
    idx integer not null,
    ord integer not null,
    kind text not null,
    repo text not null,
    collection text not null,
    rkey text not null,
    op text not null,
    order_stamp text not null,
    actor text not null,
    event_id text not null,
    body text,
    primary key (stream_id, idx, ord)
) strict;
";

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(stream: &str, event_id: &str, ord: i64) -> AppendDraft<'static> {
        let stream_id = stream.to_string();
        let rkey = event_id.to_string();
        AppendDraft {
            stream_id: stream.to_string(),
            user: "did:plc:author".to_string(),
            payload: vec![0xa0],
            event_type: "space.roomy.message.createMessage.v0".to_string(),
            created_at: 1_700_000_000_000,
            received_at: 1_700_000_000_000,
            rows: Box::new(move |idx| {
                vec![RecordChangeRow {
                    stream_id,
                    idx,
                    ord,
                    kind: "message".to_string(),
                    repo: "did:plc:author".to_string(),
                    collection: "space.roomy.message".to_string(),
                    rkey: rkey.clone(),
                    op: "create".to_string(),
                    order_stamp: "01JC0000000000000000000C0X".to_string(),
                    actor: "did:plc:author".to_string(),
                    event_id: rkey,
                    body: Some("{}".to_string()),
                }]
            }),
        }
    }

    #[test]
    fn appends_take_sequential_indexes() {
        let mut log = EventLog::in_memory().unwrap();
        let start = log
            .append(vec![
                entry("did:web:s", "e1", 0),
                entry("did:web:s", "e2", 0),
            ])
            .unwrap();
        assert_eq!(start, 0);
        let next = log.append(vec![entry("did:web:s", "e3", 0)]).unwrap();
        assert_eq!(next, 2);
    }

    #[test]
    fn the_stream_index_follows_the_log() {
        let mut log = EventLog::in_memory().unwrap();
        log.append(vec![
            entry("did:web:s", "e1", 0),
            entry("did:web:s", "e2", 0),
        ])
        .unwrap();
        let latest: i64 = log
            .connection()
            .query_row(
                "select latest_event from stream_state where stream_id = ?",
                ["did:web:s"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(latest, 1);
    }

    #[test]
    fn an_entry_carries_its_changes_at_its_own_index() {
        let mut log = EventLog::in_memory().unwrap();
        log.append(vec![
            entry("did:web:s", "e1", 0),
            entry("did:web:s", "e2", 0),
        ])
        .unwrap();
        let rows: Vec<(i64, String)> = log
            .connection()
            .prepare("select idx, event_id from record_changes order by idx")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows, vec![(0, "e1".to_string()), (1, "e2".to_string())]);
    }
}
