//! The materialisation loop.
//!
//! One iteration is: hold the lease, read a batch of changes from the cursor,
//! plan it against the rows the space DB holds, hand the global half to the
//! sink, then commit the space half and the cursor in one transaction. The
//! global index may be one batch ahead of the space projection after a crash —
//! every global statement is idempotent, so the replay rewrites it — and is
//! never behind it.
//!
//! Three things it deliberately does not do:
//!
//!  * **Unread.** A reader's unread count is their read position against the
//!    room's message set, both of which are read-time facts. Nothing here
//!    accumulates it.
//!  * **Re-materialisation from the log.** The feed is the input; a worker with
//!    a stale DB resumes from its cursor and a worker with a corrupt one is
//!    rebuilt by replaying the feed from zero. A rebuild plans in
//!    [`PlanMode::Backfill`], which invalidates the read-path projections
//!    instead of maintaining them, so a database being rebuilt never answers a
//!    read from a half-replayed projection.
//!  * **Serving reads.** The router is a separate crate; this one materialises.

use std::sync::Arc;
use std::time::Duration;

use space_core::change::DecodeError;
use space_core::ids::SpaceDid;
use space_core::{PlanMode, RuleError};
use space_db::plan;
use space_db::{DbError, SpaceDb};
use space_feed::{ChangeFeed, Cursor, FeedError};

use crate::cancel::Cancel;
use crate::clock::Clock;
use crate::health::Health;
use crate::lease::{Lease, LeaseError, LeaseGrant};
use crate::signal::{SignalSink, SpaceSignal};
use crate::sink::{GlobalSink, SinkError};

/// What one iteration did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    /// The lease is not ours; another process owns the space.
    NotLeased,
    /// Nothing to apply, or everything available was applied and the feed is
    /// now empty.
    Idle { cursor: (i64, i64) },
    /// A batch was applied.
    Applied {
        cursor: (i64, i64),
        entries: usize,
        changes: usize,
    },
}

/// A loop failure.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("{0}")]
    Feed(#[from] FeedError),
    #[error("{0}")]
    Lease(#[from] LeaseError),
    #[error("{0}")]
    Sink(#[from] SinkError),
    #[error("{0}")]
    Db(#[from] DbError),
    #[error("change at idx {idx} does not decode: {source}")]
    Decode { idx: i64, source: DecodeError },
    #[error("planning batch at idx {idx}: {source}")]
    Plan { idx: i64, source: RuleError },
    #[error("starting an actor: {0}")]
    Spawn(String),
    /// The lease moved to another worker while this batch was in flight, so the
    /// batch was refused rather than written over the new owner's projection.
    #[error("fenced out at epoch {granted} (stored {stored})")]
    Fenced { granted: i64, stored: i64 },
}

/// What a worker is built from: the four seams, the space it owns, and the
/// policy of the loop itself.
pub struct WorkerParts<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> {
    /// The space this worker owns.
    pub space: SpaceDid,
    /// This process's identity on the lease row.
    pub holder: String,
    /// How long a claim stays valid without renewal.
    pub lease_ttl: Duration,
    /// The most changes one batch may hold.
    pub batch_limit: usize,
    /// Whether this worker is the live write path or a rebuild. A rebuild
    /// invalidates the read-path projections rather than writing them.
    pub mode: PlanMode,
    /// The change records to apply.
    pub feed: F,
    /// Whether this process may write the space.
    pub lease: L,
    /// Where each change's global statements go.
    pub sink: S,
    /// Where the post-commit signals go.
    pub signals: N,
    /// The lease's instants.
    pub clock: Arc<dyn Clock>,
    /// The supervisor's stop signal for this space.
    pub cancel: Cancel,
    /// Whether this worker replays beside the owner instead of owning the
    /// space. Its lease claims nothing, so its health reports no lease rather
    /// than the answer `acquire` gives.
    pub following: bool,
    /// The space's projection.
    pub db: SpaceDb,
}

/// The materialisation loop for one space.
pub struct Worker<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> {
    space: SpaceDid,
    holder: String,
    lease_ttl: Duration,
    batch_limit: usize,
    mode: PlanMode,
    feed: F,
    lease: L,
    sink: S,
    signals: N,
    clock: Arc<dyn Clock>,
    cancel: Cancel,
    following: bool,
    db: SpaceDb,
    /// The last failure, for `/health`. A failed batch leaves the cursor where
    /// it was, so the next iteration retries it.
    last_error: Option<String>,
}

impl<F: ChangeFeed, L: Lease, S: GlobalSink, N: SignalSink> Worker<F, L, S, N> {
    /// A worker over `parts`.
    #[must_use]
    pub fn new(parts: WorkerParts<F, L, S, N>) -> Self {
        Self {
            space: parts.space,
            holder: parts.holder,
            lease_ttl: parts.lease_ttl,
            batch_limit: parts.batch_limit,
            mode: parts.mode,
            feed: parts.feed,
            lease: parts.lease,
            sink: parts.sink,
            signals: parts.signals,
            clock: parts.clock,
            cancel: parts.cancel,
            db: parts.db,
            following: parts.following,
            last_error: None,
        }
    }

    /// The space's projection, as this worker sees it.
    pub fn space_db(&self) -> &SpaceDb {
        &self.db
    }

    /// The last batch failure, until a batch succeeds.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// What this worker plans in: the live path, or a rebuild's backfill.
    #[must_use]
    pub fn mode(&self) -> PlanMode {
        self.mode
    }

    /// Switch between the live path and a rebuild. A supervisor sets this while
    /// a space is being replayed from zero and clears it once the replay has
    /// caught up to the feed.
    pub fn set_mode(&mut self, mode: PlanMode) {
        self.mode = mode;
    }

    /// Whether this process holds the lease right now, and under which epoch.
    pub fn holds_lease(&mut self) -> Result<LeaseGrant, WorkerError> {
        Ok(self.lease.acquire(
            &self.space,
            &self.holder,
            self.clock.now_ms(),
            self.lease_ttl,
        )?)
    }

    /// The supervisor's stop signal for this space.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The cursor the projection has been advanced to.
    pub fn cursor(&self) -> Result<(i64, i64), WorkerError> {
        Ok(self.db.cursor()?.unwrap_or((-1, -1)))
    }

    /// How many log entries the space has beyond the applied cursor.
    pub fn lag(&mut self) -> Result<i64, WorkerError> {
        let latest = self.feed.latest_idx(&self.space)?;
        let (idx, _) = self.cursor()?;
        Ok((latest - idx).max(0))
    }

    /// One iteration of the loop.
    pub fn step(&mut self) -> Result<Progress, WorkerError> {
        match self.run_step() {
            Ok(progress) => {
                self.last_error = None;
                Ok(progress)
            }
            Err(error) => {
                self.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    fn run_step(&mut self) -> Result<Progress, WorkerError> {
        if self.cancel.is_cancelled() {
            return Ok(Progress::Idle {
                cursor: self.db.cursor()?.unwrap_or((-1, -1)),
            });
        }
        let grant = self.lease.acquire(
            &self.space,
            &self.holder,
            self.clock.now_ms(),
            self.lease_ttl,
        )?;
        if !grant.held {
            return Ok(Progress::NotLeased);
        }

        let cursor = self.db.cursor()?.unwrap_or((-1, -1));
        let rows = self
            .feed
            .batch(&self.space, Cursor::from(cursor), self.batch_limit)?;
        if rows.is_empty() {
            return Ok(Progress::Idle { cursor });
        }

        let entries = plan::group_entries(&rows).map_err(|error| WorkerError::Decode {
            idx: error.idx,
            source: error.source,
        })?;
        let changes = rows.len();

        let planned = plan::plan_batch(self.db.connection(), &self.space, &entries, self.mode)
            .map_err(|source| match source {
                DbError::Rule(source) => WorkerError::Plan {
                    idx: entries.first().map(|entry| entry.idx).unwrap_or(-1),
                    source,
                },
                other => WorkerError::Db(other),
            })?;

        let last = rows.last().expect("a non-empty batch has a last row");
        let next_cursor = (last.idx, last.ord);

        // The global half goes first: it is idempotent, so a crash between the
        // two databases replays harmlessly, and writing it first is what keeps
        // the index from ever being behind a committed space projection. The
        // space half stays uncommitted until the sink has accepted, so a sink
        // failure leaves the cursor where it was and the same changes are read
        // again.
        let batch = self
            .db
            .begin_batch(&planned, next_cursor, grant.epoch)
            .map_err(|error| match error {
                DbError::Fenced { granted, stored } => WorkerError::Fenced { granted, stored },
                other => WorkerError::Db(other),
            })?;
        self.sink.apply(batch.globals())?;
        batch.commit()?;
        // After the commit: a listener that reacts to this signal reads the
        // rows it is about.
        self.signals.signal(&SpaceSignal {
            space: self.space.clone(),
            cursor: next_cursor,
            entries: entries.len(),
        });

        Ok(Progress::Applied {
            cursor: next_cursor,
            entries: entries.len(),
            changes,
        })
    }

    /// Give the lease back, if this process still holds it, and flush anything
    /// the signal sink is holding.
    pub fn release(&mut self) {
        if let Err(error) = self.lease.release(&self.space, &self.holder) {
            tracing::warn!(%error, "releasing the lease");
        }
        self.signals.flush();
    }

    /// What `/health` reports.
    pub fn health(&mut self) -> Health {
        let cursor = self.cursor().unwrap_or((-1, -1));
        let lag = self.lag().unwrap_or(-1);
        // A follower holds no lease, and asking for one is a write to a table it
        // does not own. Report what is true instead of acquiring it.
        let lease_held = if self.following {
            false
        } else {
            self.holds_lease().map(|grant| grant.held).unwrap_or(false)
        };
        Health {
            space: self.space.as_str().to_string(),
            cursor,
            lag,
            lease_held,
            following: self.following,
            holder: self.holder.clone(),
            last_error: self.last_error.clone(),
        }
    }
}
