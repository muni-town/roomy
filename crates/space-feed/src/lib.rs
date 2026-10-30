//! The change feed: one space's changes, from a cursor.
//!
//! A space worker materialises a projection from the records the write path
//! appended, in the order it appended them. This crate is that input and
//! nothing else: a [`Cursor`], the [`ChangeFeed`] contract over it, a SQLite
//! implementation for a worker that shares the log's machine, and an HTTP
//! implementation for one that does not.
//!
//! Two properties the contract fixes:
//!
//!  * **A batch never splits a log entry.** Rows sharing an `idx` came from one
//!    entry, share its actor and ordering stamp, and are planned together; the
//!    feed returns them all.
//!  * **At-least-once, monotonic.** A feed returns rows strictly after the
//!    cursor it was given, and a cursor that has been committed is never
//!    re-delivered *before* one that has not. Re-delivery after a crash is
//!    expected: the projection is idempotent by construction.

pub mod http;
pub mod sqlite;

pub use http::{HttpChangeFeed, PullError};
pub use sqlite::SqliteChangeFeed;

use space_core::change::FeedRow;
use space_core::ids::SpaceDid;

/// A position in one space's log: the entry index and the change's order within
/// it. The cursor a worker commits is the last row it applied.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
pub struct Cursor {
    pub idx: i64,
    pub ord: i64,
}

impl Cursor {
    /// The position before the first change.
    pub const START: Cursor = Cursor { idx: -1, ord: -1 };

    /// The position of one change: entry `idx`, order `ord` within it.
    pub fn new(idx: i64, ord: i64) -> Self {
        Self { idx, ord }
    }

    /// The same position as the `(idx, ord)` pair the worker's cursor row
    /// stores.
    #[must_use]
    pub fn as_pair(self) -> (i64, i64) {
        (self.idx, self.ord)
    }
}

impl From<(i64, i64)> for Cursor {
    fn from((idx, ord): (i64, i64)) -> Self {
        Self { idx, ord }
    }
}

impl From<Cursor> for (i64, i64) {
    fn from(cursor: Cursor) -> Self {
        cursor.as_pair()
    }
}

/// One space's change records.
pub trait ChangeFeed: Send {
    /// The next changes after `cursor`, oldest first. An empty batch means the
    /// feed has nothing new; it is not an error and not an end.
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
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
    #[error("{0}")]
    Transport(#[from] PullError),
    #[error("the feed answered with an unreadable body: {0}")]
    Decode(String),
    #[error("the feed is behind its own cursor: asked for {cursor:?}, answered {answered:?}")]
    Rewound { cursor: Cursor, answered: Cursor },
}

impl ChangeFeed for Box<dyn ChangeFeed> {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        (**self).batch(space, cursor, limit)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        (**self).latest_idx(space)
    }
}
