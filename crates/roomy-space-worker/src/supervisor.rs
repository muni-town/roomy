//! The supervisor: N spaces in one process.
//!
//! A process owns a set of spaces and gives each one a blocking actor: a
//! dedicated thread with its own write connection, its own lease, and its own
//! cancellation token. Nothing is shared between actors but the configuration and
//! the health snapshot, which is why one space's slowdown cannot stall another's
//! materialisation.
//!
//! Three things the supervisor does that a bare loop cannot:
//!
//!  * **Ownership is explicit.** Actors start from the spaces the caller names;
//!    a space nobody named is not materialised, whatever the log holds.
//!  * **Stopping is per space.** `stop_space` cancels one actor, waits for it,
//!    and lets it release its lease and flush its signals. `stop` does that for
//!    every actor, in parallel.
//!  * **An idle space is unloaded.** With `idle_unload` set, an actor that has
//!    applied nothing for that long exits and drops its database handle, so the
//!    open-set is bounded by what is actually busy. `rearm` starts it again.
//!  * **A failing space waits, and says what failed.** A step that returns an
//!    error retries under an exponential backoff, so one space that cannot make
//!    progress costs neither a core nor a log flood; the warning names the
//!    space, the cursor it is stuck at, and the error.
//!
//! The supervisor binds no socket and reads no environment; the binary that
//! hosts it does both.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use space_core::ids::SpaceDid;
use space_core::PlanMode;
use space_db::SpaceDb;
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::{ChangeFeed, FeedError};

use crate::cancel::Cancel;
use crate::clock::{Clock, SystemClock};
use crate::health::Health;
use crate::lease::{FollowOnly, Lease, SqliteLease};
use crate::signal::{NoSignals, SignalSink};
use crate::sink::{GlobalSink, SqliteGlobalSink};
use crate::worker::{Progress, Worker, WorkerError, WorkerParts};

/// What this process is to the spaces it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Ownership {
    /// This process is the writer: it takes each space's lease and applies both
    /// halves of every change.
    #[default]
    Owner,
    /// This process replays beside the owner to serve reads: it takes no lease.
    /// Its global database must be its own copy, because the owner writes the
    /// shared one.
    Follower,
}

/// What a process needs to materialise spaces.
#[derive(Debug, Clone)]
pub struct SupervisorConfig {
    /// The event-log database the feed reads.
    pub events_db: PathBuf,
    /// The global database: leases and the global half of a change.
    pub global_db: PathBuf,
    /// Where per-space databases live (`<dir>/<space>.sqlite`).
    pub spaces_dir: PathBuf,
    /// This process's identity on a lease row.
    pub holder: String,
    /// How long a claim stays valid without renewal.
    pub lease_ttl: Duration,
    /// How long to wait between drains when the feed came back empty.
    pub idle_poll: Duration,
    /// The most changes one batch may hold.
    pub batch_limit: usize,
    /// Exit an actor after this long with nothing to apply. `None` keeps every
    /// space resident.
    pub idle_unload: Option<Duration>,
    /// Whether this process owns its spaces or follows them.
    pub ownership: Ownership,
}

impl SupervisorConfig {
    /// The file a space's projection lives in.
    pub fn space_path(&self, space: &SpaceDid) -> PathBuf {
        self.spaces_dir.join(format!("{space}.sqlite"))
    }
}

/// The actors one process is running.
pub struct Supervisor {
    config: SupervisorConfig,
    clock: Arc<dyn Clock>,
    /// How each actor gets its signal sink. A process serving sockets and the
    /// workers that feed it share one sink, so a committed batch reaches the
    /// connections without crossing a seam the split deployment does not have.
    signals: SignalFactory,
    /// How each actor gets its feed. A worker on the log's machine reads SQLite;
    /// a worker elsewhere asks the owner over HTTP. The loop cannot tell.
    feed: FeedFactory,
    cancel: Cancel,
    health: Arc<Mutex<BTreeMap<String, Health>>>,
    actors: Mutex<BTreeMap<String, Actor>>,
}

/// How long a failing actor waits before the next attempt. A space that cannot
/// make progress must not hold a core while it waits: the process shares the
/// machine with everything else the deployment runs.
const ERROR_BACKOFF_INITIAL: Duration = Duration::from_millis(250);

/// The longest a failing actor waits between attempts. Long enough that a space
/// broken for hours costs nothing, short enough that a fixed dependency is
/// picked up without a restart.
const ERROR_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// How often a space repeats a failure it has already reported. The first
/// occurrence of a distinct error is always logged; this bounds the rest.
const ERROR_REPORT_INTERVAL: Duration = Duration::from_secs(60);

/// A sink per actor, made afresh because a worker owns its sink.
pub type SignalFactory = Arc<dyn Fn() -> Box<dyn SignalSink> + Send + Sync>;

/// A feed per actor, made afresh because a feed may hold its own connection.
pub type FeedFactory = Arc<dyn Fn() -> Result<Box<dyn ChangeFeed>, FeedError> + Send + Sync>;

struct Actor {
    cancel: Cancel,
    handle: JoinHandle<()>,
}

impl Supervisor {
    /// Start an actor for every space in `spaces`.
    pub fn start(
        config: SupervisorConfig,
        spaces: impl IntoIterator<Item = SpaceDid>,
    ) -> Result<Self, WorkerError> {
        let supervisor = Self::new(config);
        supervisor.start_all(spaces)?;
        Ok(supervisor)
    }

    /// Start an actor for every space in `spaces`, on a supervisor already
    /// configured with its clock and signal sink.
    pub fn start_all(&self, spaces: impl IntoIterator<Item = SpaceDid>) -> Result<(), WorkerError> {
        for space in spaces {
            self.rearm(space)?;
        }
        Ok(())
    }

    /// A supervisor for `config` that has started no actors yet, reading the
    /// log through this machine's SQLite file and sending no signals.
    #[must_use]
    pub fn new(config: SupervisorConfig) -> Self {
        let events_db = config.events_db.clone();
        Self {
            config,
            clock: Arc::new(SystemClock),
            signals: Arc::new(|| Box::new(NoSignals) as Box<dyn SignalSink>),
            feed: Arc::new(move || {
                Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn ChangeFeed>)
            }),
            cancel: Cancel::new(),
            health: Arc::new(Mutex::new(BTreeMap::new())),
            actors: Mutex::new(BTreeMap::new()),
        }
    }

    /// Read the log through `factory` instead of this machine's SQLite file.
    #[must_use]
    pub fn with_feed(mut self, factory: FeedFactory) -> Self {
        self.feed = factory;
        self
    }

    /// Send this process's post-commit signals to `factory`'s sink.
    #[must_use]
    pub fn with_signals(mut self, factory: SignalFactory) -> Self {
        self.signals = factory;
        self
    }

    /// Use a different clock (a test's, or a monotonic one).
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// The configuration these actors run under.
    pub fn config(&self) -> &SupervisorConfig {
        &self.config
    }

    /// Start (or restart) the actor for `space`. Idempotent while it runs.
    pub fn rearm(&self, space: SpaceDid) -> Result<(), WorkerError> {
        let mut actors = self.actors.lock().expect("the actor table is not poisoned");
        if actors.contains_key(space.as_str()) {
            return Ok(());
        }
        let cancel = Cancel::new();
        let config = self.config.clone();
        let health = Arc::clone(&self.health);
        let clock = Arc::clone(&self.clock);
        let actor_cancel = cancel.clone();
        let key = space.as_str().to_string();

        // Open before spawning so a missing feed or an unopenable space is
        // reported to the caller rather than logged from a thread nobody joins.
        let db = SpaceDb::open(config.space_path(&space), space.clone())?;
        let feed = (self.feed)()?;
        let lease: Box<dyn Lease> = match config.ownership {
            Ownership::Owner => Box::new(SqliteLease::open(&config.global_db)?),
            Ownership::Follower => Box::new(FollowOnly::new(db.fence()?)),
        };
        // Both roles write the global half; a follower writes it to its own copy,
        // which is what makes its entity index usable for reads it serves alone.
        let sink = SqliteGlobalSink::open(&config.global_db)?;
        let holder = config.holder.clone();
        let idle_poll = config.idle_poll;
        let idle_unload = config.idle_unload;
        let batch_limit = config.batch_limit;
        let lease_ttl = config.lease_ttl;
        let actor_space = space.clone();
        let health_key = key.clone();
        let signals = Arc::clone(&self.signals);

        let handle = std::thread::Builder::new()
            .name(format!("space-{key}"))
            .spawn(move || {
                let mut worker = Worker::new(WorkerParts {
                    following: config.ownership == Ownership::Follower,
                    space: actor_space,
                    holder,
                    lease_ttl,
                    batch_limit,
                    mode: PlanMode::Live,
                    feed,
                    lease,
                    sink,
                    signals: signals(),
                    clock,
                    cancel: actor_cancel,
                    db,
                });
                run_actor(&mut worker, &health, &health_key, idle_poll, idle_unload);
                // Hand the space back: another process may take it, and a
                // restart of this one begins from the committed cursor.
                worker.release();
                if let Ok(mut health) = health.lock() {
                    health.remove(&health_key);
                }
            })
            .map_err(|error| WorkerError::Spawn(error.to_string()))?;

        actors.insert(key, Actor { cancel, handle });
        Ok(())
    }

    /// Stop one space's actor and wait for it.
    pub fn stop_space(&self, space: &SpaceDid) {
        let actor = {
            let mut actors = self.actors.lock().expect("the actor table is not poisoned");
            actors.remove(space.as_str())
        };
        if let Some(actor) = actor {
            actor.cancel.cancel();
            let _ = actor.handle.join();
        }
    }

    /// Stop every actor and wait for them.
    pub fn stop(&self) {
        self.cancel.cancel();
        let actors = {
            let mut table = self.actors.lock().expect("the actor table is not poisoned");
            std::mem::take(&mut *table)
        };
        for actor in actors.values() {
            actor.cancel.cancel();
        }
        for actor in actors.into_values() {
            let _ = actor.handle.join();
        }
    }

    /// What each running actor is doing.
    #[must_use]
    pub fn health(&self) -> Vec<Health> {
        self.health
            .lock()
            .map(|health| health.values().cloned().collect())
            .unwrap_or_default()
    }

    /// The spaces with a running actor.
    #[must_use]
    pub fn spaces(&self) -> Vec<String> {
        self.actors
            .lock()
            .map(|actors| actors.keys().cloned().collect())
            .unwrap_or_default()
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The loop one actor runs. Extracted so a test can drive it with its own seams.
fn run_actor<F, L, S, N>(
    worker: &mut Worker<F, L, S, N>,
    health: &Arc<Mutex<BTreeMap<String, Health>>>,
    key: &str,
    idle_poll: Duration,
    idle_unload: Option<Duration>,
) where
    F: ChangeFeed,
    L: Lease,
    S: GlobalSink,
    N: SignalSink,
{
    let mut last_progress = Instant::now();
    let mut cursor = worker.cursor().unwrap_or((-1, -1));
    let mut backoff = ERROR_BACKOFF_INITIAL;
    // The last failure this actor reported, and when. `None` after a batch that
    // applied, so the next failure is always logged.
    let mut reported: Option<(String, Instant)> = None;

    loop {
        if worker.is_cancelled() {
            return;
        }
        let progress = worker.step();
        let wait = match &progress {
            Ok(Progress::Applied {
                cursor: applied,
                entries,
                changes,
            }) => {
                tracing::info!(
                    idx = applied.0,
                    ord = applied.1,
                    entries,
                    changes,
                    "applied"
                );
                cursor = *applied;
                last_progress = Instant::now();
                backoff = ERROR_BACKOFF_INITIAL;
                reported = None;
                Some(idle_poll)
            }
            Ok(Progress::NotLeased) => {
                tracing::debug!(space = key, "another process holds the lease");
                Some(idle_poll)
            }
            Ok(Progress::Idle { .. }) => Some(idle_poll),
            Err(error) => {
                let text = error.to_string();
                let quiet = reported.as_ref().is_some_and(|(seen, at)| {
                    *seen == text && at.elapsed() < ERROR_REPORT_INTERVAL
                });
                if !quiet {
                    tracing::warn!(
                        space = key,
                        idx = cursor.0,
                        ord = cursor.1,
                        %error,
                        "batch failed; retrying"
                    );
                    reported = Some((text, Instant::now()));
                }
                let wait = backoff;
                backoff = (backoff * 2).min(ERROR_BACKOFF_MAX);
                Some(wait)
            }
        };

        if let Ok(mut snapshot) = health.lock() {
            snapshot.insert(key.to_string(), worker.health());
        }

        let idle = matches!(
            progress,
            Ok(Progress::Idle { .. }) | Ok(Progress::NotLeased)
        );
        if idle {
            if let Some(idle_unload) = idle_unload {
                if last_progress.elapsed() >= idle_unload {
                    tracing::info!("unloading an idle space");
                    return;
                }
            }
        }
        if let Some(wait) = wait {
            wait_unless_cancelled(worker, wait, idle_poll);
        }
    }
}

/// Wait `duration`, in slices no longer than `slice`, returning early once the
/// actor is cancelled.
///
/// `stop` joins this thread, so a backoff must not become a shutdown: without the
/// slices, stopping a space in a 30-second retry would block for 30 seconds, and
/// the container's interrupt path — which drains the log sink — would be cut short
/// by its own watchdog.
fn wait_unless_cancelled<F, L, S, N>(
    worker: &Worker<F, L, S, N>,
    duration: Duration,
    slice: Duration,
) where
    F: ChangeFeed,
    L: Lease,
    S: GlobalSink,
    N: SignalSink,
{
    let slice = slice.max(Duration::from_millis(1));
    let deadline = Instant::now() + duration;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep((deadline - now).min(slice));
        if worker.is_cancelled() {
            return;
        }
    }
}
