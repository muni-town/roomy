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
//!
//! Expiry alone would not be enough. A worker paused past its expiry — a long
//! GC pause, a stopped container, a stalled disk — wakes believing it still
//! owns the space and commits over a projection another worker has since
//! advanced. So every acquisition carries a **fencing epoch**: the row's epoch
//! increases when a *different* holder takes the lease, the batch writes it into
//! the space database, and a commit whose epoch is older than the one already
//! written there is refused. A stale writer cannot land a batch, however long
//! it was asleep.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use space_core::ids::SpaceDid;

/// What an acquisition produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseGrant {
    /// Whether `holder` holds the lease after the call.
    pub held: bool,
    /// The fencing epoch in force. Meaningful only when `held`: it is the value
    /// the batch must carry, and a batch carrying less is refused.
    pub epoch: i64,
}

impl LeaseGrant {
    /// Not held: a worker that cannot reach the global database never acts as
    /// an owner.
    pub fn refused() -> Self {
        Self {
            held: false,
            epoch: 0,
        }
    }
}

/// Whether this process may write `space`.
pub trait Lease: Send {
    /// Take or renew the lease for `space`, as of `now_ms`.
    fn acquire(
        &mut self,
        space: &SpaceDid,
        holder: &str,
        now_ms: i64,
        ttl: Duration,
    ) -> Result<LeaseGrant, LeaseError>;

    /// Give the lease up if `holder` still holds it.
    fn release(&mut self, space: &SpaceDid, holder: &str) -> Result<(), LeaseError>;
}

/// A follower's stand-in for the lease: it claims nothing.
///
/// A read replica replays the log beside the owner to answer reads from its own
/// projection (`rust-core-appserver.md` §2.1, replicated reads). It must not take
/// the lease — that would stop the owner materialising — and it cannot be fenced
/// by it, because the fence lives in the space file it alone writes. The epoch it
/// carries is the one that file already holds, so a follower's commits are never
/// refused and never regress a fence.
#[derive(Debug, Clone, Copy)]
pub struct FollowOnly {
    epoch: i64,
}

impl FollowOnly {
    /// Follow the projection that carries `epoch`.
    pub fn new(epoch: i64) -> Self {
        Self { epoch }
    }
}

impl Lease for FollowOnly {
    fn acquire(
        &mut self,
        _space: &SpaceDid,
        _holder: &str,
        _now_ms: i64,
        _ttl: Duration,
    ) -> Result<LeaseGrant, LeaseError> {
        Ok(LeaseGrant {
            held: true,
            epoch: self.epoch,
        })
    }

    fn release(&mut self, _space: &SpaceDid, _holder: &str) -> Result<(), LeaseError> {
        Ok(())
    }
}

impl Lease for Box<dyn Lease> {
    fn acquire(
        &mut self,
        space: &SpaceDid,
        holder: &str,
        now_ms: i64,
        ttl: Duration,
    ) -> Result<LeaseGrant, LeaseError> {
        (**self).acquire(space, holder, now_ms, ttl)
    }

    fn release(&mut self, space: &SpaceDid, holder: &str) -> Result<(), LeaseError> {
        (**self).release(space, holder)
    }
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
    /// Open the global database at `path`, creating it and the lease table.
    ///
    /// A database written before the fencing epoch existed gains the column
    /// here.
    ///
    /// # Errors
    ///
    /// Returns [`LeaseError::Sqlite`] when the file cannot be opened or the
    /// table cannot be brought up to date.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, LeaseError> {
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
               epoch      integer not null default 1,
               updated_at integer not null default (unixepoch() * 1000)
             ) strict;",
        )?;
        // A database created before the fencing epoch existed has the table
        // without the column: `create table if not exists` is a no-op there, so
        // the column is added explicitly. Existing rows start at epoch 1, which
        // is the value a first acquisition writes.
        let has_epoch: bool = conn.query_row(
            "select count(*) from pragma_table_info('worker_leases') where name = 'epoch'",
            [],
            |row| row.get::<_, i64>(0).map(|count| count > 0),
        )?;
        if !has_epoch {
            conn.execute_batch(
                "alter table worker_leases add column epoch integer not null default 1;",
            )?;
        }
        Ok(Self { conn })
    }

    /// The lease table in a database that dies with the process.
    ///
    /// # Errors
    ///
    /// Returns [`LeaseError::Sqlite`] when the table cannot be created.
    pub fn in_memory() -> Result<Self, LeaseError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "create table if not exists worker_leases (
               name       text primary key,
               holder     text not null,
               expires_at integer not null,
               epoch      integer not null default 1,
               updated_at integer not null default (unixepoch() * 1000)
             ) strict;",
        )?;
        Ok(Self { conn })
    }

    /// The underlying connection, for a caller that needs to read.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// The lease row a space's worker owns.
#[must_use]
pub fn lease_name(space: &SpaceDid) -> String {
    format!("space-worker:{}", space.as_str())
}

impl Lease for SqliteLease {
    fn acquire(
        &mut self,
        space: &SpaceDid,
        holder: &str,
        now: i64,
        ttl: Duration,
    ) -> Result<LeaseGrant, LeaseError> {
        let expires_at = now + ttl.as_millis() as i64;
        // The epoch advances only when the holder changes: a worker renewing
        // its own lease keeps the epoch its batch already carries, and a
        // takeover by another worker invalidates every batch the previous
        // holder had in flight.
        let changed = self.conn.execute(
            "insert into worker_leases (name, holder, expires_at, epoch, updated_at)
             values (?, ?, ?, 1, ?)
             on conflict (name) do update set
               epoch = case
                 when worker_leases.holder = excluded.holder then worker_leases.epoch
                 else worker_leases.epoch + 1
               end,
               holder = excluded.holder,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at
             where worker_leases.holder = excluded.holder
                or worker_leases.expires_at <= ?",
            rusqlite::params![lease_name(space), holder, expires_at, now, now],
        )?;
        if changed == 0 {
            return Ok(LeaseGrant::refused());
        }
        let epoch: i64 = self.conn.query_row(
            "select epoch from worker_leases where name = ?",
            [lease_name(space)],
            |row| row.get(0),
        )?;
        Ok(LeaseGrant { held: true, epoch })
    }

    fn release(&mut self, space: &SpaceDid, holder: &str) -> Result<(), LeaseError> {
        self.conn.execute(
            "delete from worker_leases where name = ? and holder = ?",
            rusqlite::params![lease_name(space), holder],
        )?;
        Ok(())
    }
}
