//! The global sink: where a change's global statements go.
//!
//! A change's global half — membership edges, the entity→space index, the
//! federation tables, the call index — lives in the global database, a different
//! file from the space's own. The worker hands these statements here while the
//! space half is applied but uncommitted, so the two databases never have to be
//! opened by one connection and the space projection stays the unit of
//! atomicity.
//!
//! The statements are idempotent (upserts and deletes by key), which is what
//! makes a crash between the two writes harmless: the batch is replayed and the
//! same rows are written again. The sink is written first, so the index may be
//! ahead of a space batch that is about to be replayed, and is never behind a
//! committed space projection.

use std::path::Path;

use rusqlite::types::Value;
use rusqlite::Connection;
use space_core::effects::SqlEffect;

/// Applies the statements a change aimed at the global database.
pub trait GlobalSink: Send {
    /// Apply `statements` in one transaction.
    ///
    /// # Errors
    ///
    /// Returns [`SinkError::Sqlite`] when a statement fails, leaving none of
    /// them applied.
    fn apply(&mut self, statements: &[SqlEffect]) -> Result<(), SinkError>;
}

/// A sink write that failed.
#[derive(Debug, thiserror::Error)]
pub enum SinkError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// The global database.
pub struct SqliteGlobalSink {
    conn: Connection,
}

impl SqliteGlobalSink {
    /// The global schema, shared with the TypeScript appserver.
    pub const SCHEMA: &'static str =
        include_str!("../../../packages/appserver/src/db/schema-global.sql");

    /// Open the global database at `path`, creating it and its schema.
    ///
    /// # Errors
    ///
    /// Returns [`SinkError::Sqlite`] when the file cannot be opened or the
    /// schema cannot be applied.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, SinkError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             pragma foreign_keys = on;
             pragma busy_timeout = 5000;",
        )?;
        conn.execute_batch(Self::SCHEMA)?;
        Ok(Self { conn })
    }

    /// The global schema in a database that dies with the process.
    ///
    /// # Errors
    ///
    /// Returns [`SinkError::Sqlite`] when the schema cannot be applied.
    pub fn in_memory() -> Result<Self, SinkError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(Self::SCHEMA)?;
        Ok(Self { conn })
    }

    /// The underlying connection, for a caller that needs to read.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

impl GlobalSink for SqliteGlobalSink {
    fn apply(&mut self, statements: &[SqlEffect]) -> Result<(), SinkError> {
        if statements.is_empty() {
            return Ok(());
        }
        let transaction = self.conn.transaction()?;
        for statement in statements {
            let params: Vec<Value> = statement.params.iter().map(space_db::to_sql).collect();
            transaction
                .prepare(statement.sql)?
                .execute(rusqlite::params_from_iter(params))?;
        }
        transaction.commit()?;
        Ok(())
    }
}
