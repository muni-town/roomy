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
    diff_snapshots, digest_of, global_tables, snapshot_db, snapshot_tables, worker_snapshot,
    TableDivergence, TableSnapshot,
};
pub use plan::{
    apply_plan, plan_batch, EntryChange, EntryChanges, LabelledStatement, PlannedChange,
    PlannedEntry,
};
pub use to_sql as value_to_sql;

use std::path::Path;

use rusqlite::{Connection, Transaction};
use space_core::change::{ChangeOp, RecordKind};
use space_core::effects::{DerivedStep, SqlEffect, Target, Value};
use space_core::ids::SpaceDid;
use space_core::RuleError;

/// The per-space schema, shared with the TypeScript appserver.
pub const SPACE_SCHEMA: &str = include_str!("../../../packages/appserver/src/db/schema-space.sql");

/// A database error.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    /// A statement the database rejected, with the change that emitted it and
    /// the statement itself. Boxed: the context is display data, and every
    /// other variant stays small.
    #[error("{0}")]
    Statement(Box<StatementError>),
    #[error("{0}")]
    Derived(#[from] derived::DerivedError),
    #[error("step produced a result the database rejected: {0}")]
    Step(String),
    #[error("{0}")]
    Rule(#[from] RuleError),
    #[error("{0} is not an ordering stamp")]
    Stamp(String),
    /// A batch carried an epoch older than the one already written: another
    /// worker has taken the space since this one last held the lease, so this
    /// batch must not land.
    #[error("fenced out: epoch {granted} is older than the stored epoch {stored}")]
    Fenced { granted: i64, stored: i64 },
}

/// A per-space database.
pub struct SpaceDb {
    conn: Connection,
    stream_id: SpaceDid,
}

impl SpaceDb {
    /// Open the database at `path`, applying the schema.
    pub fn open(path: impl AsRef<Path>, stream_id: SpaceDid) -> Result<Self, DbError> {
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

    /// The space this database projects.
    pub fn stream_id(&self) -> &SpaceDid {
        &self.stream_id
    }

    /// The connection underneath, for a caller that has to read the rows.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// The connection underneath, for a caller that has to write outside a
    /// batch.
    pub fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// Apply the space-targeted statements and return the global ones.
    ///
    /// Each statement carries the change that emitted it, so one the database
    /// rejects names both the change and the statement.
    pub fn apply_statements(
        &mut self,
        statements: &[LabelledStatement<'_>],
    ) -> Result<Vec<SqlEffect>, DbError> {
        let mut globals: Vec<SqlEffect> = Vec::new();
        for labelled in statements {
            match labelled.statement.target {
                Target::Global => globals.push(labelled.statement.clone()),
                Target::Space => {
                    execute_statement(&self.conn, labelled.change, labelled.statement)?;
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

    /// Begin a planned batch: apply its space statements and derived steps, and
    /// hold the result in an open transaction until [`PendingBatch::commit`].
    ///
    /// The cursor is written by `commit`, in the same transaction as the
    /// effects, so a crash either applied both or neither: the changes the
    /// cursor covers are exactly the changes the projection holds.
    /// Global-targeted statements — including the ones a derived step produced
    /// — are collected on the batch and handed to the caller's sink *before*
    /// `commit`, because they live in another database and cannot join this
    /// transaction. Dropping the batch rolls it back, which is what a crash
    /// between the two writes looks like.
    pub fn begin_batch(
        &mut self,
        planned: &[plan::PlannedEntry],
        cursor: (i64, i64),
        epoch: i64,
    ) -> Result<PendingBatch<'_>, DbError> {
        let (statements, steps) = plan::flatten(planned);
        let stream_id = self.stream_id.clone();
        let transaction = self.conn.transaction()?;
        let mut globals: Vec<SqlEffect> = Vec::new();

        for labelled in statements {
            match labelled.statement.target {
                Target::Global => globals.push(labelled.statement.clone()),
                Target::Space => {
                    execute_statement(&transaction, labelled.change, labelled.statement)?;
                }
            }
        }
        for step in steps {
            globals.extend(derived::apply_step(&transaction, &stream_id, step)?);
        }

        Ok(PendingBatch {
            transaction,
            cursor,
            epoch,
            globals,
        })
    }

    /// The epoch of the last batch written to this space, or 0 before the
    /// first one. A worker compares it to its lease to learn whether it is
    /// stale before doing any work.
    pub fn fence(&self) -> Result<i64, DbError> {
        let epoch: Option<i64> = self
            .conn
            .query_row("select epoch from worker_fence where id = 1", [], |row| {
                row.get(0)
            })
            .ok();
        Ok(epoch.unwrap_or(0))
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

/// A planned batch applied to an open transaction, not yet committed.
///
/// The order the worker has to follow is: apply the global half through the
/// sink, then [`commit`](PendingBatch::commit). Global first, because the
/// global index may be ahead of a space batch that will be replayed — every
/// statement is idempotent, so replay rewrites the same rows — and must never
/// be behind a committed space projection. If the sink fails, or the process
/// dies before the commit, dropping this batch rolls the space transaction back
/// so the cursor stays where it was and the same changes are read again.
pub struct PendingBatch<'db> {
    transaction: Transaction<'db>,
    cursor: (i64, i64),
    /// The lease epoch this batch was planned under.
    epoch: i64,
    globals: Vec<SqlEffect>,
}

impl PendingBatch<'_> {
    /// The statements destined for the global database, in emission order.
    #[must_use]
    pub fn globals(&self) -> &[SqlEffect] {
        &self.globals
    }

    /// Advance the cursor and commit the space half.
    ///
    /// The fence is checked in the same transaction that writes it, so a worker
    /// whose lease expired during the batch cannot land it: the takeover's
    /// epoch is already stored, and this batch is older. Nothing of the batch
    /// survives the refusal — the transaction is dropped uncommitted.
    pub fn commit(self) -> Result<(), DbError> {
        let stored = self.fence_stored()?;
        if self.epoch < stored {
            return Err(DbError::Fenced {
                granted: self.epoch,
                stored,
            });
        }
        self.transaction.execute(
            "insert into worker_fence (id, epoch) values (1, ?)
             on conflict (id) do update set epoch = excluded.epoch",
            rusqlite::params![self.epoch],
        )?;
        self.transaction.execute(
            "insert into worker_cursor (id, idx, ord) values (1, ?, ?)
             on conflict (id) do update set idx = excluded.idx, ord = excluded.ord",
            rusqlite::params![self.cursor.0, self.cursor.1],
        )?;
        self.transaction.commit()?;
        Ok(())
    }

    fn fence_stored(&self) -> Result<i64, DbError> {
        let stored: Option<i64> = self
            .transaction
            .query_row("select epoch from worker_fence where id = 1", [], |row| {
                row.get(0)
            })
            .ok();
        Ok(stored.unwrap_or(0))
    }
}

/// Run one statement, naming the change and the statement if it fails.
///
/// SQLite's own text — `FOREIGN KEY constraint failed` — names neither the
/// change that produced the statement nor the values that were bound to it, so
/// a failure carries both: the change's position in the log, and the SQL with
/// its parameters rendered.
fn execute_statement(
    conn: &Connection,
    change: ChangeLabel<'_>,
    statement: &SqlEffect,
) -> Result<(), DbError> {
    let run = || -> rusqlite::Result<usize> {
        let params: Vec<rusqlite::types::Value> = statement.params.iter().map(to_sql).collect();
        conn.prepare(statement.sql)?
            .execute(rusqlite::params_from_iter(params))
    };
    run().map(|_| ()).map_err(|source| {
        DbError::Statement(Box::new(StatementError {
            context: StatementContext::new(change, statement),
            source,
        }))
    })
}

/// The longest run of a text parameter a failure renders. One of these values
/// can be a whole message body.
const MAX_RENDERED_CHARS: usize = 200;

/// The most parameters a failure renders.
const MAX_RENDERED_VALUES: usize = 5;

/// The change a statement came from, as a failure names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeRef {
    /// The log entry the change came from.
    pub idx: i64,
    /// Emission order within that entry.
    pub ord: i64,
    pub kind: RecordKind,
    pub op: ChangeOp,
    pub rkey: String,
}

impl std::fmt::Display for ChangeRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "change idx={} ord={} kind={} op={} rkey={}",
            self.idx,
            self.ord,
            self.kind.name(),
            self.op,
            self.rkey
        )
    }
}

/// The change a statement came from, borrowed from the plan it is part of.
#[derive(Debug, Clone, Copy)]
pub struct ChangeLabel<'a> {
    pub idx: i64,
    pub ord: i64,
    pub kind: RecordKind,
    pub op: ChangeOp,
    pub rkey: &'a str,
}

impl From<ChangeLabel<'_>> for ChangeRef {
    fn from(label: ChangeLabel<'_>) -> Self {
        Self {
            idx: label.idx,
            ord: label.ord,
            kind: label.kind,
            op: label.op,
            rkey: label.rkey.to_string(),
        }
    }
}

/// The statement a database rejected, and the change it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct StatementContext {
    /// The change whose effects included the statement.
    pub change: ChangeRef,
    /// The database the statement targets.
    pub target: Target,
    /// The SQL, whitespace collapsed so the failure stays one log line.
    pub sql: String,
    /// The bound parameters, rendered: the first few values, each text value
    /// cut short, a blob as its size alone.
    pub params: String,
}

impl StatementContext {
    fn new(change: ChangeLabel<'_>, statement: &SqlEffect) -> Self {
        Self {
            change: ChangeRef::from(change),
            target: statement.target,
            sql: statement
                .sql
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            params: render_params(&statement.params),
        }
    }
}

impl std::fmt::Display for StatementContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {} statement failed: {} params {}",
            self.change, self.target, self.sql, self.params
        )
    }
}

/// A statement the database rejected.
#[derive(Debug, thiserror::Error)]
#[error("{context}: {source}")]
pub struct StatementError {
    pub context: StatementContext,
    #[source]
    pub source: rusqlite::Error,
}

/// Render bound parameters for a failure line, bounded in length.
///
/// A blob renders as its size alone: the bytes are never the thing a reader
/// needs, and one of them can be megabytes.
fn render_params(params: &[Value]) -> String {
    let mut rendered: Vec<String> = params
        .iter()
        .take(MAX_RENDERED_VALUES)
        .map(render_param)
        .collect();
    if params.len() > MAX_RENDERED_VALUES {
        rendered.push(format!("+{} more", params.len() - MAX_RENDERED_VALUES));
    }
    format!("[{}]", rendered.join(", "))
}

fn render_param(param: &Value) -> String {
    match param {
        Value::Null => "null".to_string(),
        Value::Integer(value) => value.to_string(),
        Value::Real(value) => value.to_string(),
        Value::Text(text) => {
            let mut chars = text.chars();
            let head: String = chars.by_ref().take(MAX_RENDERED_CHARS).collect();
            let truncated = chars.next().is_some();
            format!(
                "text({}B) \"{}{}\"",
                text.len(),
                head.escape_debug(),
                if truncated { "…" } else { "" }
            )
        }
        Value::Blob(bytes) => format!("blob({}B)", bytes.len()),
    }
}

/// A typed parameter as SQLite takes it.
#[must_use]
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
