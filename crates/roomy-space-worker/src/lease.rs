//! The lease: which process may write this space.
//!
//! One row of the global `worker_leases` table, taken with the conditional
//! upsert `workers/lease.ts` uses: whoever last wrote it and has not let
//! `expires_at` pass holds it, and the current holder always succeeds, which is
//! what renews the claim. Two workers racing produce one winner without a lock.
//!
//! The lease serialises *applying* changes, not ordering them: the stamp was
//! assigned at ingest, so a worker that loses and regains the lease resumes and
//! produces the same projection it would have produced without ever losing it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use space_core::ids::SpaceDid;

/// Whether this process may write `space`.
pub trait Lease {
    /// Take or renew the lease for `space`. Returns whether `holder` holds it
    /// afterwards; a failed write reports "not held", so a worker that cannot
    /// reach the global DB never acts as an owner.
    fn acquire(
        &mut self,
        space: &SpaceDid,
        holder: &str,
        ttl: Duration,
    ) -> Result<bool, LeaseError>;

    /// Give the lease up if `holder` still holds it.
    fn release(&mut self, space: &SpaceDid, holder: &str) -> Result<(), LeaseError>;
}

/// A lease operation that failed.
#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// The lease, kept in the global database.
pub struct SqliteLease {
    conn: Connection,
}

impl SqliteLease {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, LeaseError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             pragma busy_timeout = 5000;

             -- The row this crate takes, declared here as well as in the global
             -- schema so a worker can open the file before the appserver has.
             create table if not exists worker_leases (
               name       text primary key,
               holder     text not null,
               expires_at integer not null,
               updated_at integer not null default (unixepoch() * 1000)
             ) strict;",
        )?;
        Ok(Self { conn })
    }

    pub fn in_memory() -> Result<Self, LeaseError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "create table if not exists worker_leases (
               name       text primary key,
               holder     text not null,
               expires_at integer not null,
               updated_at integer not null default (unixepoch() * 1000)
             ) strict;",
        )?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// The lease row a space's worker owns.
pub fn lease_name(space: &SpaceDid) -> String {
    format!("space-worker:{}", space.as_str())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

impl Lease for SqliteLease {
    fn acquire(
        &mut self,
        space: &SpaceDid,
        holder: &str,
        ttl: Duration,
    ) -> Result<bool, LeaseError> {
        let now = now_ms();
        let expires_at = now + ttl.as_millis() as i64;
        let changed = self.conn.execute(
            "insert into worker_leases (name, holder, expires_at, updated_at)
             values (?, ?, ?, ?)
             on conflict (name) do update set
               holder = excluded.holder,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at
             where worker_leases.holder = excluded.holder
                or worker_leases.expires_at <= ?",
            rusqlite::params![lease_name(space), holder, expires_at, now, now],
        )?;
        Ok(changed > 0)
    }

    fn release(&mut self, space: &SpaceDid, holder: &str) -> Result<(), LeaseError> {
        self.conn.execute(
            "delete from worker_leases where name = ? and holder = ?",
            rusqlite::params![lease_name(space), holder],
        )?;
        Ok(())
    }
}
