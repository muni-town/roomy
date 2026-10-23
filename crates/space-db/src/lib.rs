//! A per-space SQLite database and the executor for a change's effects.
//!
//! The schema is the TypeScript appserver's own file (`schema-space.sql`,
//! included at compile time), and the PRAGMAs are its opener's, so the two
//! implementations write the same file shape and a gateway can read either.
//!
//! What a database does is narrow: apply a space-targeted statement, run a
//! derived step against the rows that are there, and hand the global-targeted
//! statements back to the caller — the global DB is a separate file with its own
//! sink, and a per-space database has no business writing it.
//!
//! [`snapshot`] reproduces the TypeScript rebuild-equality oracle
//! (`streams/rebuildEquality.ts`) byte for byte: the same column order, the same
//! dropped clock columns, the same canonical row order and encoding. That is
//! what makes a digest from here comparable with a digest from there, which is
//! how the port is checked.

mod derived;
mod digest;
pub mod plan;

pub use digest::{
    diff_snapshots, digest_of, snapshot_db, worker_snapshot, TableDivergence, TableSnapshot,
};
pub use plan::{apply_plan, plan_batch, EntryChanges, PlannedEntry};
pub use to_sql as value_to_sql;

use rusqlite::Connection;
use space_core::effects::{DerivedStep, Effect, SqlEffect, Target, Value};
use space_core::ids::SpaceDid;

/// The per-space schema, shared with the TypeScript appserver.
pub const SPACE_SCHEMA: &str = include_str!("../../../packages/appserver/src/db/schema-space.sql");

/// A database error.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Derived(#[from] derived::DerivedError),
    #[error("step produced a result the database rejected: {0}")]
    Step(String),
    #[error("{0}")]
    Rule(#[from] space_core::RuleError),
}

/// A per-space database.
pub struct SpaceDb {
    conn: Connection,
    stream_id: SpaceDid,
}

impl SpaceDb {
    /// Open the database at `path`, applying the schema.
    pub fn open(path: impl AsRef<std::path::Path>, stream_id: SpaceDid) -> Result<Self, DbError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        Self::with_connection(conn, stream_id)
    }

    /// An in-memory database with the schema applied.
    pub fn open_in_memory(stream_id: SpaceDid) -> Result<Self, DbError> {
        Self::with_connection(Connection::open_in_memory()?, stream_id)
    }

    fn with_connection(conn: Connection, stream_id: SpaceDid) -> Result<Self, DbError> {
        conn.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             pragma foreign_keys = on;
             pragma busy_timeout = 5000;",
        )?;
        conn.execute_batch(SPACE_SCHEMA)?;
        Ok(Self { conn, stream_id })
    }

    pub fn stream_id(&self) -> &SpaceDid {
        &self.stream_id
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Apply one change's effects.
    ///
    /// The statements run in the order they were planned; the derived steps run
    /// after the caller's batch of statements, in the same order (the caller
    /// decides where the boundary is — see `apply_statements`). Global-targeted
    /// statements, and any a derived step produced, are returned rather than
    /// applied.
    pub fn apply_effects(&mut self, effects: &[Effect]) -> Result<Vec<SqlEffect>, DbError> {
        let (statements, steps) = split(effects);
        let mut globals = self.apply_statements(&statements)?;
        globals.extend(self.apply_steps(&steps)?);
        Ok(globals)
    }

    /// Apply the space-targeted statements and return the global ones.
    pub fn apply_statements(&mut self, effects: &[&SqlEffect]) -> Result<Vec<SqlEffect>, DbError> {
        let mut globals: Vec<SqlEffect> = Vec::new();
        for effect in effects {
            match effect.target {
                Target::Global => globals.push((*effect).clone()),
                Target::Space => {
                    let mut statement = self.conn.prepare(effect.sql)?;
                    let params: Vec<rusqlite::types::Value> =
                        effect.params.iter().map(to_sql).collect();
                    statement.execute(rusqlite::params_from_iter(params))?;
                }
            }
        }
        Ok(globals)
    }

    /// Apply the derived steps, returning any global statements they produced.
    pub fn apply_steps(&mut self, steps: &[&DerivedStep]) -> Result<Vec<SqlEffect>, DbError> {
        let mut globals: Vec<SqlEffect> = Vec::new();
        for step in steps {
            globals.extend(derived::apply_step(&self.conn, &self.stream_id, step)?);
        }
        Ok(globals)
    }

    /// Apply a planned batch and advance the worker's cursor in one transaction.
    ///
    /// The cursor is written inside the same transaction as the effects, so a
    /// crash either applied both or neither: the changes the cursor covers are
    /// exactly the changes the projection holds. Global-targeted statements are
    /// returned for the caller's sink — they live in another database, so they
    /// cannot join this transaction.
    pub fn apply_batch(
        &mut self,
        planned: &[plan::PlannedEntry],
        cursor: (i64, i64),
    ) -> Result<Vec<SqlEffect>, DbError> {
        let (statements, steps) = plan::flatten(planned);
        let transaction = self.conn.transaction()?;
        let mut globals: Vec<SqlEffect> = Vec::new();

        for statement in statements {
            match statement.target {
                Target::Global => globals.push(statement.clone()),
                Target::Space => {
                    let params: Vec<rusqlite::types::Value> =
                        statement.params.iter().map(to_sql).collect();
                    transaction
                        .prepare(statement.sql)?
                        .execute(rusqlite::params_from_iter(params))?;
                }
            }
        }
        for step in steps {
            globals.extend(derived::apply_step(&transaction, &self.stream_id, step)?);
        }

        transaction.execute(
            "insert into worker_cursor (id, idx, ord) values (1, ?, ?)
             on conflict (id) do update set idx = excluded.idx, ord = excluded.ord",
            rusqlite::params![cursor.0, cursor.1],
        )?;
        transaction.commit()?;
        Ok(globals)
    }

    /// The worker's cursor, or `None` before the first batch.
    pub fn cursor(&self) -> Result<Option<(i64, i64)>, DbError> {
        let row: Option<(i64, i64)> = self
            .conn
            .query_row(
                "select idx, ord from worker_cursor where id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        Ok(row)
    }

    /// Snapshot the derived tables, in the form the digest and the diff use.
    pub fn snapshot(&self) -> Result<Vec<TableSnapshot>, DbError> {
        snapshot_db(&self.conn).map_err(DbError::Sqlite)
    }

    /// SHA-256 over the snapshot, comparable with `digestOf` in TypeScript.
    pub fn digest(&self) -> Result<String, DbError> {
        Ok(digest_of(&self.snapshot()?))
    }
}

/// Split effects into statements and steps, keeping each list's order.
pub fn split(effects: &[Effect]) -> (Vec<&SqlEffect>, Vec<&DerivedStep>) {
    let mut statements: Vec<&SqlEffect> = Vec::new();
    let mut steps: Vec<&DerivedStep> = Vec::new();
    for effect in effects {
        match effect {
            Effect::Sql(statement) => statements.push(statement),
            Effect::Step(step) => steps.push(step),
        }
    }
    (statements, steps)
}

/// A typed parameter as SQLite takes it.
pub fn to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Integer(value) => Sql::Integer(*value),
        Value::Real(value) => Sql::Real(*value),
        Value::Text(value) => Sql::Text(value.clone()),
        Value::Blob(value) => Sql::Blob(value.clone()),
    }
}
