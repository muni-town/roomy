//! The change feed: a space's changes, from a cursor.
//!
//! The feed lives in the event-log database the appserver writes
//! (`record_changes`), and the cursor is the `(idx, ord)` position the worker
//! last applied. Rows come back in that order, which is the order the appserver
//! wrote them in and the order the projection depends on.

use rusqlite::Connection;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;

/// One space's change records.
pub trait ChangeFeed {
    /// The next changes after `cursor`, oldest first. An empty batch means the
    /// feed has nothing new.
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: (i64, i64),
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError>;

    /// The highest entry index the feed holds for `space`, for lag reporting.
    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError>;
}

/// A feed read that failed.
#[derive(Debug, thiserror::Error)]
pub enum FeedError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// The feed, read from the event-log database.
pub struct SqliteChangeFeed {
    conn: Connection,
}

impl SqliteChangeFeed {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, FeedError> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        conn.execute_batch("pragma busy_timeout = 5000;")?;
        Ok(Self { conn })
    }

    /// An in-memory feed, for tests and for a worker pointed at a fixture.
    pub fn in_memory() -> Result<Self, FeedError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "create table if not exists record_changes (
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
             ) strict;",
        )?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

impl SqliteChangeFeed {
    /// The remaining rows of one entry, past `ord`.
    fn trailing_of_entry(
        &self,
        space: &SpaceDid,
        idx: i64,
        ord: i64,
    ) -> Result<Vec<FeedRow>, FeedError> {
        let mut statement = self.conn.prepare(
            "select stream_id, idx, ord, kind, repo, collection, rkey, op,
                    order_stamp, actor, event_id, body
               from record_changes
              where stream_id = ? and idx = ? and ord > ?
              order by ord",
        )?;
        let rows = statement.query_map(rusqlite::params![space.as_str(), idx, ord], |row| {
            Ok(FeedRow {
                stream_id: row.get(0)?,
                idx: row.get(1)?,
                ord: row.get(2)?,
                kind: row.get(3)?,
                repo: row.get(4)?,
                collection: row.get(5)?,
                rkey: row.get(6)?,
                op: row.get(7)?,
                order_stamp: row.get(8)?,
                actor: row.get(9)?,
                event_id: row.get(10)?,
                body: row.get(11)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

impl ChangeFeed for SqliteChangeFeed {
    /// The next changes after `cursor`.
    ///
    /// A batch never splits a log entry: the rows sharing the last `idx` of the
    /// batch are pulled in past `limit`, because the planner reads state once
    /// per entry and an entry's changes are planned together. The TypeScript
    /// materialiser applies a chunk's statements before its derived steps, so a
    /// batch is also the unit the derived steps see — the same contract.
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: (i64, i64),
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        let mut statement = self.conn.prepare(
            "select stream_id, idx, ord, kind, repo, collection, rkey, op,
                    order_stamp, actor, event_id, body
               from record_changes
              where stream_id = ?
                and (idx > ? or (idx = ? and ord > ?))
              order by idx, ord
              limit ?",
        )?;
        let rows = statement.query_map(
            rusqlite::params![space.as_str(), cursor.0, cursor.0, cursor.1, limit as i64],
            |row| {
                Ok(FeedRow {
                    stream_id: row.get(0)?,
                    idx: row.get(1)?,
                    ord: row.get(2)?,
                    kind: row.get(3)?,
                    repo: row.get(4)?,
                    collection: row.get(5)?,
                    rkey: row.get(6)?,
                    op: row.get(7)?,
                    order_stamp: row.get(8)?,
                    actor: row.get(9)?,
                    event_id: row.get(10)?,
                    body: row.get(11)?,
                })
            },
        )?;
        let mut rows: Vec<FeedRow> = rows.collect::<Result<_, _>>()?;

        // Pull in the rest of the last entry rather than splitting it.
        if let Some(last) = rows.last() {
            let trailing = self.trailing_of_entry(space, last.idx, last.ord)?;
            rows.extend(trailing);
        }
        Ok(rows)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        let latest: Option<i64> = self
            .conn
            .query_row(
                "select max(idx) from record_changes where stream_id = ?",
                rusqlite::params![space.as_str()],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        Ok(latest.unwrap_or(-1))
    }
}
