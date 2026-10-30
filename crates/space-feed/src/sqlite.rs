//! The SQLite feed: the log's own database, read from a cursor.
//!
//! The rows live in `record_changes`, which the write path appends to. The
//! worker reads them read-only: the log is another process's file, and a worker
//! that could write it would be a second writer.

use std::path::Path;

use rusqlite::Connection;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;

use crate::{ChangeFeed, Cursor, FeedError};

/// One space's changes, read out of the event-log database.
pub struct SqliteChangeFeed {
    conn: Connection,
}

impl SqliteChangeFeed {
    /// Open the log's database read-only.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, FeedError> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        conn.execute_batch("pragma busy_timeout = 5000;")?;
        Ok(Self { conn })
    }

    /// An in-memory feed with the schema applied, for tests and fixtures.
    pub fn in_memory() -> Result<Self, FeedError> {
        let conn = Connection::open_in_memory()?;
        Self::create_schema(&conn)?;
        Ok(Self { conn })
    }

    /// A feed over a connection the caller already has.
    pub fn from_connection(conn: Connection) -> Result<Self, FeedError> {
        Self::create_schema(&conn)?;
        Ok(Self { conn })
    }

    fn create_schema(conn: &Connection) -> Result<(), FeedError> {
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
        Ok(())
    }

    /// The connection underneath.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

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
        let rows = statement.query_map(rusqlite::params![space.as_str(), idx, ord], row_of)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedRow> {
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
}

impl ChangeFeed for SqliteChangeFeed {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
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
            rusqlite::params![
                space.as_str(),
                cursor.idx,
                cursor.idx,
                cursor.ord,
                limit as i64
            ],
            row_of,
        )?;
        let mut rows: Vec<FeedRow> = rows.collect::<Result<_, _>>()?;

        if let Some(last) = rows.last() {
            rows.extend(self.trailing_of_entry(space, last.idx, last.ord)?);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_with(rows: &[(i64, i64)]) -> (SqliteChangeFeed, SpaceDid) {
        let feed = SqliteChangeFeed::in_memory().expect("feed");
        let space = SpaceDid::parse("did:web:feed.example").expect("space");
        for (idx, ord) in rows {
            feed.connection()
                .execute(
                    "insert into record_changes (
                       stream_id, idx, ord, kind, repo, collection, rkey, op,
                       order_stamp, actor, event_id, body
                     ) values (?, ?, ?, 'ban', ?, 'space.roomy.space.ban', ?, 'delete', ?, ?, ?, null)",
                    rusqlite::params![
                        space.as_str(),
                        idx,
                        ord,
                        space.as_str(),
                        format!("did:plc:user{idx}"),
                        "01HF7YAT000000000000000001",
                        space.as_str(),
                        "01HF7YAT00000000000000000A",
                    ],
                )
                .expect("insert");
        }
        (feed, space)
    }

    #[test]
    fn a_batch_starts_after_the_cursor() {
        let (feed, space) = feed_with(&[(1, 0), (2, 0), (3, 0)]);
        let rows = feed
            .batch(&space, Cursor::from((1, 0)), 10)
            .expect("a batch");
        assert_eq!(
            rows.iter().map(|row| row.idx).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn a_batch_never_splits_an_entry() {
        let (feed, space) = feed_with(&[(1, 0), (2, 0), (2, 1), (2, 2), (3, 0)]);
        let rows = feed
            .batch(&space, Cursor::from((0, 0)), 2)
            .expect("a batch");
        assert_eq!(
            rows.iter()
                .map(|row| (row.idx, row.ord))
                .collect::<Vec<_>>(),
            vec![(1, 0), (2, 0), (2, 1), (2, 2)]
        );
    }

    #[test]
    fn the_cursor_defaults_before_the_first_change() {
        let (feed, space) = feed_with(&[(0, 0)]);
        assert_eq!(
            feed.batch(&space, Cursor::START, 10)
                .expect("a batch")
                .len(),
            1
        );
        assert_eq!(feed.latest_idx(&space).expect("latest"), 0);
    }
}
