//! The cutover mechanisms: shadow reads, materialisation ownership, the write
//! flag, and divergence alerts.
//!
//! Four independent switches make the move from the TypeScript core to the
//! Rust one observable and reversible:
//!
//!  * [`Shadow`] mirrors a sample of reads to the Rust path while the
//!    TypeScript answer stays authoritative. It compares the two answers and
//!    records what differed; the mirrored answer is never returned.
//!  * [`MaterialisationOwners`] is the table that says which node materialises
//!    a space. A handover is one compare-and-swap, and a rollback puts the
//!    previous owner back only while the handover it undoes is still the latest
//!    one. [`MaterialisationAuthority`] is the shape a supervisor takes.
//!  * [`WriteCutover`] decides, per space, whether writes go to the Rust
//!    ingress or the retained TypeScript path. It starts on TypeScript and
//!    keeps an audit trail of every flip.
//!  * [`DivergenceLog`] keeps bounded per-NSID records and recent outcomes so
//!    [`DivergenceLog::should_alert`] has a rate to test.
//!
//! Everything that needs an instant takes one as an argument; nothing here
//! reads a clock, so a test decides exactly what happened when.

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use space_core::ids::SpaceDid;

/// How many times a handover retries a lost compare-and-swap before reporting
/// contention. Each retry re-reads the row and writes against its new revision.
const HANDOVER_ATTEMPTS: usize = 8;

// ---------------------------------------------------------------------------
// Shadow reads
// ---------------------------------------------------------------------------

/// One read request as the shadow sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowRequest {
    /// The XRPC method being called.
    pub nsid: String,
    /// The query parameters, in whatever order the caller supplied them.
    pub params: Vec<(String, String)>,
}

impl ShadowRequest {
    /// Build a request from its NSID and parameter pairs.
    pub fn new(
        nsid: impl Into<String>,
        params: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        Self {
            nsid: nsid.into(),
            params: params.into_iter().collect(),
        }
    }

    /// The parameters in canonical form: empty values dropped, pairs sorted.
    pub fn canonical_params(&self) -> String {
        let mut pairs: Vec<(&str, &str)> = self
            .params
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        pairs.sort_unstable();
        pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    /// A stable hexadecimal hash of the NSID and canonical parameters, as
    /// recorded on a divergence.
    pub fn params_hash(&self) -> String {
        format!("{:016x}", self.key())
    }

    /// The sampling key: a stable 64-bit hash of the NSID and canonical
    /// parameters. Two spellings of one request have the same key.
    pub fn key(&self) -> u64 {
        request_key(&self.nsid, &self.canonical_params())
    }
}

/// One response, as either path produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowResponse {
    /// The HTTP status.
    pub status: u16,
    /// The response body, unchanged.
    pub body: Vec<u8>,
}

impl ShadowResponse {
    /// A response from a status and raw body.
    pub fn new(status: u16, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            body: body.into(),
        }
    }

    /// A response from a status and a JSON value.
    pub fn json(status: u16, body: &serde_json::Value) -> Self {
        let body = serde_json::to_vec(body).expect("a JSON value serialises");
        Self { status, body }
    }
}

/// Whether two responses agree: same status and canonically equal JSON bodies.
///
/// Bodies that are not both JSON are compared byte for byte. JSON objects
/// compare with their keys sorted, so field order is not a divergence.
pub fn responses_equivalent(authoritative: &ShadowResponse, shadow: &ShadowResponse) -> bool {
    authoritative.status == shadow.status && bodies_equivalent(&authoritative.body, &shadow.body)
}

/// One recorded disagreement between the two read paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    /// The XRPC method whose answers differed.
    pub nsid: String,
    /// [`ShadowRequest::params_hash`] of the request that produced them.
    pub params_hash: String,
    /// The status the authoritative TypeScript path returned.
    pub authoritative_status: u16,
    /// The status the shadowed Rust path returned.
    pub shadow_status: u16,
    /// The TypeScript body, decoded lossily for recording.
    pub authoritative_body: String,
    /// The Rust body, decoded lossily for recording.
    pub shadow_body: String,
}

/// How a [`Shadow`] decides what to mirror.
#[derive(Debug, Clone)]
pub struct ShadowConfig {
    /// The percentage of eligible requests to mirror, from 0 to 100.
    pub sample_percent: u8,
    /// Mixed into the request key so two deployments can sample differently.
    /// The decision for one key is otherwise stable.
    pub seed: u64,
    /// The NSIDs eligible for shadowing. Empty means every NSID is eligible.
    pub eligible_nsids: Vec<String>,
    /// How many recent divergences to retain per NSID. Zero counts them
    /// without retaining a record.
    pub retained_divergences_per_nsid: usize,
    /// How many recent comparisons to retain per NSID for alert rates. Zero
    /// disables [`DivergenceLog::should_alert`].
    pub retained_samples_per_nsid: usize,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            sample_percent: 0,
            seed: 0,
            eligible_nsids: Vec::new(),
            retained_divergences_per_nsid: 256,
            retained_samples_per_nsid: 4096,
        }
    }
}

/// A read mirror: samples eligible requests, compares the answers, and hands
/// the caller the authoritative one.
pub struct Shadow {
    config: ShadowConfig,
    log: DivergenceLog,
}

impl Shadow {
    /// Build a shadow. A percentage above 100 is treated as 100.
    pub fn new(mut config: ShadowConfig) -> Self {
        config.sample_percent = config.sample_percent.min(100);
        let log = DivergenceLog::new(
            config.retained_divergences_per_nsid,
            config.retained_samples_per_nsid,
        );
        Self { config, log }
    }

    /// The configuration in force.
    pub fn config(&self) -> &ShadowConfig {
        &self.config
    }

    /// The divergences recorded so far.
    pub fn divergences(&self) -> &DivergenceLog {
        &self.log
    }

    /// Whether `request` is of a kind the shadow mirrors at all.
    pub fn is_eligible(&self, request: &ShadowRequest) -> bool {
        self.config.eligible_nsids.is_empty()
            || self
                .config
                .eligible_nsids
                .iter()
                .any(|nsid| nsid == &request.nsid)
    }

    /// Whether this request is sampled. The answer is a pure function of the
    /// request key, the seed and the percentage, so repeating a request repeats
    /// the decision.
    pub fn should_sample(&self, request: &ShadowRequest) -> bool {
        if !self.is_eligible(request) {
            return false;
        }
        match self.config.sample_percent {
            0 => false,
            100 => true,
            percent => {
                let bucket = mix(request.key() ^ self.config.seed) % 100;
                bucket < u64::from(percent)
            }
        }
    }

    /// Mirror one read when it samples, record the comparison, and return the
    /// authoritative answer unchanged.
    ///
    /// `mirror` is called only for a sampled request, so an unsampled read pays
    /// nothing. Its answer is compared and dropped; the caller always receives
    /// `authoritative`.
    pub fn observe<M>(
        &self,
        request: &ShadowRequest,
        authoritative: ShadowResponse,
        mirror: M,
    ) -> ShadowResponse
    where
        M: FnOnce() -> ShadowResponse,
    {
        if self.should_sample(request) {
            let shadow = mirror();
            self.compare(request, &authoritative, &shadow);
        }
        authoritative
    }

    /// Compare one pair of answers and record the outcome. Returns whether they
    /// diverged.
    ///
    /// Callers that run the mirror themselves — because they cannot afford its
    /// latency on the request's thread — call [`Shadow::should_sample`] and then
    /// this method once both answers exist.
    pub fn compare(
        &self,
        request: &ShadowRequest,
        authoritative: &ShadowResponse,
        shadow: &ShadowResponse,
    ) -> bool {
        if responses_equivalent(authoritative, shadow) {
            self.log.record_match(&request.nsid);
            false
        } else {
            self.log.record_divergence(Divergence {
                nsid: request.nsid.clone(),
                params_hash: request.params_hash(),
                authoritative_status: authoritative.status,
                shadow_status: shadow.status,
                authoritative_body: String::from_utf8_lossy(&authoritative.body).into_owned(),
                shadow_body: String::from_utf8_lossy(&shadow.body).into_owned(),
            });
            true
        }
    }
}

// ---------------------------------------------------------------------------
// Divergence alerts
// ---------------------------------------------------------------------------

/// The rate over a window of recent comparisons at or above which an alert
/// fires.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AlertWindow {
    /// How many recent comparisons the rate is measured over. The window must
    /// fit within [`ShadowConfig::retained_samples_per_nsid`].
    pub samples: usize,
    /// The divergence rate, from 0 to 1, at or above which the alert fires. A
    /// non-positive threshold fires on any divergence in a full window.
    pub threshold: f64,
}

impl AlertWindow {
    /// An alert window of `samples` comparisons and a `threshold` rate.
    pub fn new(samples: usize, threshold: f64) -> Self {
        Self { samples, threshold }
    }
}

/// Bounded per-NSID divergence records plus the recent outcomes a rate is
/// computed from.
#[derive(Debug)]
pub struct DivergenceLog {
    per_nsid: Mutex<BTreeMap<String, NsidLog>>,
    retained_per_nsid: usize,
    samples_per_nsid: usize,
}

#[derive(Debug, Default)]
struct NsidLog {
    compared: u64,
    diverged: u64,
    retained: VecDeque<Divergence>,
    recent: VecDeque<bool>,
}

impl DivergenceLog {
    /// An empty log retaining at most `retained_per_nsid` divergences and
    /// `samples_per_nsid` comparison outcomes per NSID.
    pub fn new(retained_per_nsid: usize, samples_per_nsid: usize) -> Self {
        Self {
            per_nsid: Mutex::new(BTreeMap::new()),
            retained_per_nsid,
            samples_per_nsid,
        }
    }

    /// Record a comparison whose answers agreed.
    pub fn record_match(&self, nsid: &str) {
        self.logs().entry(nsid.to_string()).or_default().record(
            false,
            None,
            self.retained_per_nsid,
            self.samples_per_nsid,
        );
    }

    /// Record a divergence: count it, keep it if there is room, and remember it
    /// as a diverged sample.
    pub fn record_divergence(&self, divergence: Divergence) {
        self.logs()
            .entry(divergence.nsid.clone())
            .or_default()
            .record(
                true,
                Some(divergence),
                self.retained_per_nsid,
                self.samples_per_nsid,
            );
    }

    /// How many comparisons the shadow has made for `nsid`.
    pub fn compared(&self, nsid: &str) -> u64 {
        self.logs().get(nsid).map_or(0, |log| log.compared)
    }

    /// How many divergences the shadow has seen for `nsid`, retained or not.
    pub fn count(&self, nsid: &str) -> u64 {
        self.logs().get(nsid).map_or(0, |log| log.diverged)
    }

    /// The retained divergences for `nsid`, oldest first.
    pub fn divergences(&self, nsid: &str) -> Vec<Divergence> {
        self.logs()
            .get(nsid)
            .map(|log| log.retained.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Every retained divergence, ordered by NSID and then oldest first.
    pub fn all(&self) -> Vec<Divergence> {
        self.logs()
            .values()
            .flat_map(|log| log.retained.iter().cloned())
            .collect()
    }

    /// How many divergences are currently retained across all NSIDs.
    pub fn len(&self) -> usize {
        self.logs().values().map(|log| log.retained.len()).sum()
    }

    /// Whether no divergence is currently retained.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether `nsid`'s divergence rate over the last `window.samples`
    /// comparisons is at or above the threshold.
    ///
    /// False until a full window has been recorded, so one early divergence
    /// cannot alert on a sample of one.
    pub fn should_alert(&self, nsid: &str, window: AlertWindow) -> bool {
        let Ok(logs) = self.per_nsid.lock() else {
            return false;
        };
        logs.get(nsid)
            .map(|log| window_fires(log, window))
            .unwrap_or(false)
    }

    /// The NSIDs whose divergence rate currently crosses `window`, in name
    /// order.
    pub fn should_alert_any(&self, window: AlertWindow) -> Vec<String> {
        let Ok(logs) = self.per_nsid.lock() else {
            return Vec::new();
        };
        logs.iter()
            .filter(|(_, log)| window_fires(log, window))
            .map(|(nsid, _)| nsid.clone())
            .collect()
    }

    fn logs(&self) -> MutexGuard<'_, BTreeMap<String, NsidLog>> {
        self.per_nsid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl NsidLog {
    fn record(
        &mut self,
        diverged: bool,
        divergence: Option<Divergence>,
        retained_per_nsid: usize,
        samples_per_nsid: usize,
    ) {
        self.compared += 1;
        if diverged {
            self.diverged += 1;
        }
        if let Some(divergence) = divergence {
            if retained_per_nsid > 0 {
                if self.retained.len() == retained_per_nsid {
                    self.retained.pop_front();
                }
                self.retained.push_back(divergence);
            }
        }
        if samples_per_nsid > 0 {
            if self.recent.len() == samples_per_nsid {
                self.recent.pop_front();
            }
            self.recent.push_back(diverged);
        }
    }
}

fn window_fires(log: &NsidLog, window: AlertWindow) -> bool {
    if window.samples == 0 || log.recent.len() < window.samples {
        return false;
    }
    let diverged = log
        .recent
        .iter()
        .rev()
        .take(window.samples)
        .filter(|diverged| **diverged)
        .count();
    if window.threshold > 0.0 {
        diverged as f64 / window.samples as f64 >= window.threshold
    } else {
        diverged > 0
    }
}

// ---------------------------------------------------------------------------
// Materialisation ownership
// ---------------------------------------------------------------------------

/// One row of the materialisation-ownership table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    /// The node that owns the space's materialisation.
    pub node: String,
    /// The operator or process that flipped ownership to `node`.
    pub changed_by: String,
    /// When the flip happened, in epoch milliseconds.
    pub changed_at_ms: i64,
    /// The fencing epoch: it increases by one on every flip, and a conditional
    /// write compares it.
    pub revision: u64,
}

/// A completed handover: the owner it replaced and the owner it installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handover {
    /// The space whose ownership changed.
    pub space: String,
    /// The owner before the flip; `None` when the space was unowned.
    pub from: Option<Owner>,
    /// The owner the flip installed.
    pub to: Owner,
}

/// A persistence failure behind an ownership store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The SQLite statement failed.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Another backend failed.
    #[error("{0}")]
    Backend(String),
}

/// A handover or rollback that could not be completed.
#[derive(Debug, thiserror::Error)]
pub enum OwnerError {
    /// Reading or writing the ownership row failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// A compare-and-swap kept losing to other writers.
    #[error("materialisation ownership of {space} moved during {operation}")]
    Contended {
        /// The space being flipped.
        space: String,
        /// The operation that lost the race.
        operation: &'static str,
    },
    /// The handover being rolled back is no longer the latest one.
    #[error("rollback of {space} refused: ownership moved after the handover being rolled back")]
    RollbackConflict {
        /// The space whose rollback was refused.
        space: String,
    },
}

/// The persistence under [`MaterialisationOwners`]: one ownership row per
/// space, written conditionally so a flip is a single atomic step.
pub trait OwnerStore: Send + Sync {
    /// The current row for `space`, or `None` when it is unowned.
    fn load(&self, space: &str) -> Result<Option<Owner>, StoreError>;

    /// Write `next` only if the row is still at `expected_revision`; `None`
    /// means the row must not exist. Returns whether the write happened.
    fn compare_and_swap(
        &self,
        space: &str,
        expected_revision: Option<u64>,
        next: &Owner,
    ) -> Result<bool, StoreError>;

    /// Delete the row only if it is still at `expected_revision`. Returns
    /// whether the delete happened.
    fn clear(&self, space: &str, expected_revision: u64) -> Result<bool, StoreError>;
}

impl OwnerStore for Box<dyn OwnerStore> {
    fn load(&self, space: &str) -> Result<Option<Owner>, StoreError> {
        (**self).load(space)
    }

    fn compare_and_swap(
        &self,
        space: &str,
        expected_revision: Option<u64>,
        next: &Owner,
    ) -> Result<bool, StoreError> {
        (**self).compare_and_swap(space, expected_revision, next)
    }

    fn clear(&self, space: &str, expected_revision: u64) -> Result<bool, StoreError> {
        (**self).clear(space, expected_revision)
    }
}

/// The in-process ownership table.
#[derive(Debug, Default)]
pub struct InMemoryOwnerStore {
    rows: Mutex<BTreeMap<String, Owner>>,
}

impl InMemoryOwnerStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    fn rows(&self) -> MutexGuard<'_, BTreeMap<String, Owner>> {
        self.rows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl OwnerStore for InMemoryOwnerStore {
    fn load(&self, space: &str) -> Result<Option<Owner>, StoreError> {
        Ok(self.rows().get(space).cloned())
    }

    fn compare_and_swap(
        &self,
        space: &str,
        expected_revision: Option<u64>,
        next: &Owner,
    ) -> Result<bool, StoreError> {
        let mut rows = self.rows();
        let matches = match expected_revision {
            Some(revision) => rows.get(space).is_some_and(|row| row.revision == revision),
            None => !rows.contains_key(space),
        };
        if matches {
            rows.insert(space.to_string(), next.clone());
        }
        Ok(matches)
    }

    fn clear(&self, space: &str, expected_revision: u64) -> Result<bool, StoreError> {
        let mut rows = self.rows();
        let matches = rows
            .get(space)
            .is_some_and(|row| row.revision == expected_revision);
        if matches {
            rows.remove(space);
        }
        Ok(matches)
    }
}

/// The ownership table in the global database: the production store.
pub struct SqliteOwnerStore {
    conn: Mutex<rusqlite::Connection>,
}

impl SqliteOwnerStore {
    /// Open (and create) the ownership table at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = rusqlite::Connection::open(path)?;
        conn.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             pragma busy_timeout = 5000;",
        )?;
        Self::from_connection(conn)
    }

    /// An in-memory ownership table, for a test or a throwaway process.
    pub fn in_memory() -> Result<Self, StoreError> {
        Self::from_connection(rusqlite::Connection::open_in_memory()?)
    }

    fn from_connection(conn: rusqlite::Connection) -> Result<Self, StoreError> {
        conn.execute_batch(
            "create table if not exists materialisation_owners (
               space      text primary key,
               node       text not null,
               revision   integer not null,
               changed_at integer not null,
               changed_by text not null
             ) strict;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl OwnerStore for SqliteOwnerStore {
    fn load(&self, space: &str) -> Result<Option<Owner>, StoreError> {
        use rusqlite::OptionalExtension;

        let conn = self.conn();
        let owner = conn
            .query_row(
                "select node, changed_by, changed_at, revision
                 from materialisation_owners where space = ?1",
                [space],
                |row| {
                    Ok(Owner {
                        node: row.get(0)?,
                        changed_by: row.get(1)?,
                        changed_at_ms: row.get(2)?,
                        // The revision is a counter, not a quantity; the column is
                        // an integer because that is what SQLite has.
                        revision: row.get::<_, i64>(3)? as u64,
                    })
                },
            )
            .optional()?;
        Ok(owner)
    }

    fn compare_and_swap(
        &self,
        space: &str,
        expected_revision: Option<u64>,
        next: &Owner,
    ) -> Result<bool, StoreError> {
        let conn = self.conn();
        let changed = match expected_revision {
            Some(revision) => conn.execute(
                "update materialisation_owners
                 set node = ?2, changed_by = ?3, changed_at = ?4, revision = ?5
                 where space = ?1 and revision = ?6",
                rusqlite::params![
                    space,
                    next.node,
                    next.changed_by,
                    next.changed_at_ms,
                    next.revision as i64,
                    revision as i64
                ],
            )?,
            None => conn.execute(
                "insert into materialisation_owners (space, node, changed_by, changed_at, revision)
                 values (?1, ?2, ?3, ?4, ?5)
                 on conflict (space) do nothing",
                rusqlite::params![
                    space,
                    next.node,
                    next.changed_by,
                    next.changed_at_ms,
                    next.revision as i64
                ],
            )?,
        };
        Ok(changed > 0)
    }

    fn clear(&self, space: &str, expected_revision: u64) -> Result<bool, StoreError> {
        let conn = self.conn();
        let changed = conn.execute(
            "delete from materialisation_owners where space = ?1 and revision = ?2",
            rusqlite::params![space, expected_revision as i64],
        )?;
        Ok(changed > 0)
    }
}

/// The authority a worker supervisor consults before applying a batch: which
/// node owns a space's materialisation.
pub trait MaterialisationAuthority: Send + Sync {
    /// The node that owns `space`'s materialisation, or `None` when it is
    /// unowned.
    fn owner(&self, space: &SpaceDid) -> Result<Option<Owner>, OwnerError>;

    /// Whether `node` may materialise `space` right now. This is the check a
    /// supervisor makes before it commits a batch.
    fn owns(&self, space: &SpaceDid, node: &str) -> Result<bool, OwnerError> {
        Ok(self.owner(space)?.is_some_and(|owner| owner.node == node))
    }

    /// Flip ownership to `to` in one compare-and-swap and return what it
    /// replaced. A lost race is retried against the new revision a bounded
    /// number of times.
    fn handover(
        &self,
        space: &SpaceDid,
        to: &str,
        by: &str,
        at_ms: i64,
    ) -> Result<Handover, OwnerError>;

    /// Restore the owner that `handover` replaced, provided no later flip has
    /// happened. `Some` is the restored owner; `None` leaves the space unowned,
    /// as it was before the handover.
    fn rollback(
        &self,
        space: &SpaceDid,
        handover: &Handover,
        by: &str,
        at_ms: i64,
    ) -> Result<Option<Owner>, OwnerError>;
}

/// The materialisation-ownership table over a pluggable store.
pub struct MaterialisationOwners<S: OwnerStore> {
    store: S,
}

impl MaterialisationOwners<InMemoryOwnerStore> {
    /// An ownership table in this process's memory.
    pub fn in_memory() -> Self {
        Self::new(InMemoryOwnerStore::new())
    }
}

impl<S: OwnerStore> MaterialisationOwners<S> {
    /// An ownership table over `store`.
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The node that owns `space`, or `None` when it is unowned.
    pub fn owner(&self, space: &SpaceDid) -> Result<Option<Owner>, OwnerError> {
        Ok(self.store.load(space.as_str())?)
    }

    /// Whether `node` may materialise `space` right now.
    pub fn owns(&self, space: &SpaceDid, node: &str) -> Result<bool, OwnerError> {
        Ok(self.owner(space)?.is_some_and(|owner| owner.node == node))
    }

    /// Flip ownership to `to` in one compare-and-swap. The returned handover
    /// records the previous owner and the revision the flip installed.
    pub fn handover(
        &self,
        space: &SpaceDid,
        to: &str,
        by: &str,
        at_ms: i64,
    ) -> Result<Handover, OwnerError> {
        for _ in 0..HANDOVER_ATTEMPTS {
            let current = self.store.load(space.as_str())?;
            let next = Owner {
                node: to.to_string(),
                changed_by: by.to_string(),
                changed_at_ms: at_ms,
                revision: current
                    .as_ref()
                    .map_or(1, |owner| owner.revision.saturating_add(1)),
            };
            let expected = current.as_ref().map(|owner| owner.revision);
            if self
                .store
                .compare_and_swap(space.as_str(), expected, &next)?
            {
                return Ok(Handover {
                    space: space.as_str().to_string(),
                    from: current,
                    to: next,
                });
            }
        }
        Err(OwnerError::Contended {
            space: space.as_str().to_string(),
            operation: "handover",
        })
    }

    /// Restore the owner recorded in `handover`, atomically.
    ///
    /// Refuses with [`OwnerError::RollbackConflict`] if ownership has moved
    /// since that handover, so an old rollback cannot undo a newer flip.
    pub fn rollback(
        &self,
        space: &SpaceDid,
        handover: &Handover,
        by: &str,
        at_ms: i64,
    ) -> Result<Option<Owner>, OwnerError> {
        let current = self.store.load(space.as_str())?;
        let Some(current) = current else {
            return Err(OwnerError::RollbackConflict {
                space: space.as_str().to_string(),
            });
        };
        if current.revision != handover.to.revision || current.node != handover.to.node {
            return Err(OwnerError::RollbackConflict {
                space: space.as_str().to_string(),
            });
        }
        match &handover.from {
            Some(previous) => {
                let restored = Owner {
                    node: previous.node.clone(),
                    changed_by: by.to_string(),
                    changed_at_ms: at_ms,
                    revision: current.revision.saturating_add(1),
                };
                if self
                    .store
                    .compare_and_swap(space.as_str(), Some(current.revision), &restored)?
                {
                    Ok(Some(restored))
                } else {
                    Err(OwnerError::RollbackConflict {
                        space: space.as_str().to_string(),
                    })
                }
            }
            None => {
                if self.store.clear(space.as_str(), current.revision)? {
                    Ok(None)
                } else {
                    Err(OwnerError::RollbackConflict {
                        space: space.as_str().to_string(),
                    })
                }
            }
        }
    }
}

impl<S: OwnerStore> MaterialisationAuthority for MaterialisationOwners<S> {
    fn owner(&self, space: &SpaceDid) -> Result<Option<Owner>, OwnerError> {
        MaterialisationOwners::owner(self, space)
    }

    fn handover(
        &self,
        space: &SpaceDid,
        to: &str,
        by: &str,
        at_ms: i64,
    ) -> Result<Handover, OwnerError> {
        MaterialisationOwners::handover(self, space, to, by, at_ms)
    }

    fn rollback(
        &self,
        space: &SpaceDid,
        handover: &Handover,
        by: &str,
        at_ms: i64,
    ) -> Result<Option<Owner>, OwnerError> {
        MaterialisationOwners::rollback(self, space, handover, by, at_ms)
    }
}

// ---------------------------------------------------------------------------
// The per-space write flag
// ---------------------------------------------------------------------------

/// Which path accepts writes for a space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WritePath {
    /// The retained TypeScript core. This is the default for every space.
    #[default]
    TypeScript,
    /// The Rust write ingress.
    Rust,
}

impl WritePath {
    /// Whether this is the Rust path.
    pub fn is_rust(self) -> bool {
        matches!(self, WritePath::Rust)
    }

    /// The path's name, for logs and audit records.
    pub fn as_str(self) -> &'static str {
        match self {
            WritePath::TypeScript => "typescript",
            WritePath::Rust => "rust",
        }
    }
}

/// One recorded change of a space's write path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFlip {
    /// The space whose flag changed.
    pub space: String,
    /// The path the flag was set to.
    pub to: WritePath,
    /// Who set it.
    pub by: String,
    /// When they set it, in epoch milliseconds.
    pub at_ms: i64,
}

/// A space's current write path and the last flip that set it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFlag {
    /// The path writes currently take.
    pub path: WritePath,
    /// Who last flipped the flag; `None` while it is at its default.
    pub flipped_by: Option<String>,
    /// When the flag was last flipped; `None` while it is at its default.
    pub flipped_at_ms: Option<i64>,
}

/// The per-space write flag, reversible per space.
#[derive(Debug, Default)]
pub struct WriteCutover {
    spaces: Mutex<BTreeMap<String, SpaceWrite>>,
}

#[derive(Debug)]
struct SpaceWrite {
    path: WritePath,
    flipped_by: Option<String>,
    flipped_at_ms: Option<i64>,
    history: Vec<WriteFlip>,
}

impl WriteCutover {
    /// A table in which every space writes through TypeScript.
    pub fn new() -> Self {
        Self::default()
    }

    /// The path writes for `space` take. A space nobody has flipped uses the
    /// retained TypeScript path.
    pub fn path(&self, space: &str) -> WritePath {
        self.lock()
            .get(space)
            .map_or(WritePath::TypeScript, |state| state.path)
    }

    /// Whether writes for `space` go to the Rust ingress.
    pub fn goes_to_rust(&self, space: &str) -> bool {
        self.path(space).is_rust()
    }

    /// The current flag for `space`.
    pub fn flag(&self, space: &str) -> WriteFlag {
        let spaces = self.lock();
        let state = spaces.get(space);
        WriteFlag {
            path: state.map_or(WritePath::TypeScript, |state| state.path),
            flipped_by: state.and_then(|state| state.flipped_by.clone()),
            flipped_at_ms: state.and_then(|state| state.flipped_at_ms),
        }
    }

    /// Set `space`'s write path and record who did it and when.
    pub fn flip(&self, space: &str, to: WritePath, by: &str, at_ms: i64) -> WriteFlag {
        let flip = WriteFlip {
            space: space.to_string(),
            to,
            by: by.to_string(),
            at_ms,
        };
        let mut spaces = self.lock();
        let state = spaces
            .entry(space.to_string())
            .or_insert_with(|| SpaceWrite {
                path: WritePath::TypeScript,
                flipped_by: None,
                flipped_at_ms: None,
                history: Vec::new(),
            });
        state.path = to;
        state.flipped_by = Some(by.to_string());
        state.flipped_at_ms = Some(at_ms);
        state.history.push(flip);
        WriteFlag {
            path: state.path,
            flipped_by: state.flipped_by.clone(),
            flipped_at_ms: state.flipped_at_ms,
        }
    }

    /// Return `space` to the retained TypeScript path, recording the flip.
    pub fn rollback(&self, space: &str, by: &str, at_ms: i64) -> WriteFlag {
        self.flip(space, WritePath::TypeScript, by, at_ms)
    }

    /// Every flip recorded for `space`, oldest first. An untouched space has
    /// no history.
    pub fn history(&self, space: &str) -> Vec<WriteFlip> {
        self.lock()
            .get(space)
            .map(|state| state.history.clone())
            .unwrap_or_default()
    }

    /// The spaces that have been flipped at least once, in name order.
    pub fn spaces(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, SpaceWrite>> {
        self.spaces
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a(hash: u64, bytes: &[u8]) -> u64 {
    let mut hash = hash;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// A stable key for `(nsid, params)`. A separator byte after each part keeps
/// `("a", "bc")` and `("ab", "c")` distinct.
fn request_key(nsid: &str, params: &str) -> u64 {
    let hash = fnv1a(FNV_OFFSET, nsid.as_bytes());
    let hash = hash ^ 0xff;
    let hash = fnv1a(hash.wrapping_mul(FNV_PRIME), params.as_bytes());
    hash ^ 0xff
}

/// A 64-bit avalanche so neighbouring keys land in unrelated sample buckets.
fn mix(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn bodies_equivalent(authoritative: &[u8], shadow: &[u8]) -> bool {
    if authoritative == shadow {
        return true;
    }
    match (canonical_json(authoritative), canonical_json(shadow)) {
        (Some(authoritative), Some(shadow)) => authoritative == shadow,
        _ => false,
    }
}

/// The canonical form of a JSON body: object keys sorted, no insignificant
/// whitespace. `None` when the body is not JSON.
fn canonical_json(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let mut rendered = String::new();
    render_canonical(&value, &mut rendered);
    Some(rendered)
}

fn render_canonical(value: &serde_json::Value, out: &mut String) {
    use serde_json::Value;

    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => out.push_str(&value.to_string()),
        Value::String(value) => {
            out.push_str(&serde_json::to_string(value).expect("a string serialises"))
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                render_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            let mut keys: Vec<&str> = entries.keys().map(String::as_str).collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("a string serialises"));
                out.push(':');
                render_canonical(&entries[key], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(params: &[(&str, &str)]) -> ShadowRequest {
        ShadowRequest::new(
            "space.roomy.room.getMessages",
            params
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string())),
        )
    }

    fn shadow(sample_percent: u8) -> Shadow {
        Shadow::new(ShadowConfig {
            sample_percent,
            ..ShadowConfig::default()
        })
    }

    fn divergence(nsid: &str, hash: &str) -> Divergence {
        Divergence {
            nsid: nsid.to_string(),
            params_hash: hash.to_string(),
            authoritative_status: 200,
            shadow_status: 200,
            authoritative_body: "{}".into(),
            shadow_body: "{\"different\":true}".into(),
        }
    }

    fn space() -> SpaceDid {
        SpaceDid::parse("did:web:alpha.example").expect("a space DID")
    }

    // -- shadow -------------------------------------------------------------

    #[test]
    fn the_shadow_never_serves_its_own_answer() {
        let shadow = shadow(100);
        let request = request(&[("roomId", "01ROOM")]);
        let authoritative = ShadowResponse::json(200, &serde_json::json!({"messages": []}));
        let shadowed = ShadowResponse::json(500, &serde_json::json!({"error": "boom"}));

        let answer = shadow.observe(&request, authoritative.clone(), || shadowed.clone());

        assert_eq!(answer, authoritative);
        assert_eq!(answer.status, 200);
        assert_eq!(shadow.divergences().count(&request.nsid), 1);
    }

    #[test]
    fn an_unsampled_request_does_not_run_the_mirror() {
        let shadow = shadow(0);
        let request = request(&[("roomId", "01ROOM")]);
        let authoritative = ShadowResponse::new(200, "typescript");
        let mut mirrored = false;

        let answer = shadow.observe(&request, authoritative.clone(), || {
            mirrored = true;
            ShadowResponse::new(200, "rust")
        });

        assert_eq!(answer, authoritative);
        assert!(!mirrored);
        assert_eq!(shadow.divergences().compared(&request.nsid), 0);
    }

    #[test]
    fn a_divergence_is_recorded_once_and_counted() {
        let shadow = shadow(100);
        let request = request(&[("roomId", "01ROOM")]);
        let authoritative = ShadowResponse::json(200, &serde_json::json!({"a": 1}));
        let shadowed = ShadowResponse::json(200, &serde_json::json!({"a": 2}));

        assert!(shadow.compare(&request, &authoritative, &shadowed));
        assert_eq!(shadow.divergences().count(&request.nsid), 1);
        assert_eq!(shadow.divergences().compared(&request.nsid), 1);

        let recorded = shadow.divergences().divergences(&request.nsid);
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].nsid, request.nsid);
        assert_eq!(recorded[0].params_hash, request.params_hash());
        assert_eq!(recorded[0].authoritative_status, 200);
        assert_eq!(recorded[0].authoritative_body, "{\"a\":1}");
        assert_eq!(recorded[0].shadow_body, "{\"a\":2}");
    }

    #[test]
    fn an_agreeing_comparison_is_counted_but_records_no_divergence() {
        let shadow = shadow(100);
        let request = request(&[("roomId", "01ROOM")]);
        let response = ShadowResponse::json(200, &serde_json::json!({"a": 1, "b": [true, null]}));

        assert!(!shadow.compare(&request, &response, &response));
        assert_eq!(shadow.divergences().count(&request.nsid), 0);
        assert_eq!(shadow.divergences().compared(&request.nsid), 1);
        assert!(shadow.divergences().is_empty());
    }

    #[test]
    fn canonical_json_ignores_key_order_but_not_values() {
        let sorted = ShadowResponse::new(200, "{\"a\":1,\"b\":[1,2]}");
        let reordered = ShadowResponse::new(200, "{ \"b\" : [1, 2], \"a\" : 1 }");
        assert!(responses_equivalent(&sorted, &reordered));

        let different = ShadowResponse::new(200, "{\"a\":1,\"b\":[1,3]}");
        assert!(!responses_equivalent(&sorted, &different));

        let other_status = ShadowResponse::new(404, "{\"a\":1,\"b\":[1,2]}");
        assert!(!responses_equivalent(&sorted, &other_status));

        let not_json = ShadowResponse::new(200, "not json");
        let same_not_json = ShadowResponse::new(200, "not json");
        assert!(responses_equivalent(&not_json, &same_not_json));
        assert!(!responses_equivalent(&not_json, &different));
    }

    #[test]
    fn sampling_is_stable_for_a_repeated_key() {
        let shadow = Shadow::new(ShadowConfig {
            sample_percent: 50,
            seed: 7,
            ..ShadowConfig::default()
        });
        let original = request(&[("roomId", "01ROOM"), ("limit", "50")]);

        let sampled = shadow.should_sample(&original);
        for _ in 0..64 {
            assert_eq!(shadow.should_sample(&original), sampled);
        }

        // Parameter order and empty values are part of neither the key nor the
        // decision.
        let reordered = request(&[("limit", "50"), ("roomId", "01ROOM"), ("cursor", "")]);
        assert_eq!(reordered.key(), original.key());
        assert_eq!(reordered.params_hash(), original.params_hash());
        assert_eq!(shadow.should_sample(&reordered), sampled);
    }

    #[test]
    fn sampling_honours_the_percentage_and_the_eligibility_list() {
        let request = request(&[("roomId", "01ROOM")]);
        assert!(!shadow(0).should_sample(&request));
        assert!(shadow(100).should_sample(&request));

        let restricted = Shadow::new(ShadowConfig {
            sample_percent: 100,
            eligible_nsids: vec!["space.roomy.other.method".into()],
            ..ShadowConfig::default()
        });
        assert!(!restricted.should_sample(&request));

        let allowed = Shadow::new(ShadowConfig {
            sample_percent: 100,
            eligible_nsids: vec![request.nsid.clone()],
            ..ShadowConfig::default()
        });
        assert!(allowed.should_sample(&request));
    }

    #[test]
    fn the_divergence_ring_is_bounded_but_the_count_is_not() {
        let log = DivergenceLog::new(2, 8);
        for index in 0..5 {
            log.record_divergence(divergence("space.roomy.a.b", &format!("{index:016x}")));
        }

        assert_eq!(log.count("space.roomy.a.b"), 5);
        let retained = log.divergences("space.roomy.a.b");
        assert_eq!(retained.len(), 2);
        assert_eq!(retained[0].params_hash, format!("{:016x}", 3));
        assert_eq!(retained[1].params_hash, format!("{:016x}", 4));
        assert_eq!(log.len(), 2);
    }

    // -- alerts -------------------------------------------------------------

    #[test]
    fn the_alert_predicate_fires_above_the_rate_and_not_below_it() {
        let log = DivergenceLog::new(16, 16);
        let nsid = "space.roomy.room.getMessages";
        let window = AlertWindow::new(4, 0.5);

        // Three agreements and one divergence: below the rate, and the window
        // is full.
        log.record_match(nsid);
        log.record_match(nsid);
        log.record_match(nsid);
        log.record_divergence(divergence(nsid, "0000000000000001"));
        assert!(!log.should_alert(nsid, window));
        assert!(log.should_alert_any(window).is_empty());

        // Three of the last four diverged: above the rate.
        log.record_divergence(divergence(nsid, "0000000000000002"));
        log.record_divergence(divergence(nsid, "0000000000000003"));
        assert!(log.should_alert(nsid, window));
        assert_eq!(log.should_alert_any(window), vec![nsid.to_string()]);

        // The rate is computed over the window, not over all history: three
        // agreements push the early divergences out.
        log.record_match(nsid);
        log.record_match(nsid);
        log.record_match(nsid);
        assert!(!log.should_alert(nsid, window));
    }

    #[test]
    fn an_incomplete_window_does_not_alert() {
        let log = DivergenceLog::new(16, 16);
        let nsid = "space.roomy.room.getMessages";
        log.record_divergence(divergence(nsid, "0000000000000001"));
        assert!(!log.should_alert(nsid, AlertWindow::new(2, 0.5)));
        assert!(!log.should_alert("space.roomy.unknown.method", AlertWindow::new(1, 0.5)));
    }

    // -- materialisation ownership -----------------------------------------

    #[test]
    fn a_handover_flips_atomically_and_a_rollback_restores_the_owner() {
        let owners = MaterialisationOwners::in_memory();
        let space = space();

        let first = owners
            .handover(&space, "ts-node", "ops", 1_000)
            .expect("the first handover");
        assert_eq!(first.from, None);
        assert_eq!(first.to.node, "ts-node");
        assert_eq!(first.to.revision, 1);
        assert!(owners.owns(&space, "ts-node").expect("read ownership"));

        let flip = owners
            .handover(&space, "rust-node", "ops", 2_000)
            .expect("the handover");
        assert_eq!(
            flip.from.as_ref().map(|owner| owner.node.as_str()),
            Some("ts-node")
        );
        assert_eq!(flip.from.as_ref().map(|owner| owner.revision), Some(1));
        assert_eq!(flip.to.revision, 2);
        assert!(owners.owns(&space, "rust-node").expect("read ownership"));
        assert!(!owners.owns(&space, "ts-node").expect("read ownership"));

        let restored = owners
            .rollback(&space, &flip, "ops", 3_000)
            .expect("the rollback")
            .expect("the previous owner is restored");
        assert_eq!(restored.node, "ts-node");
        assert_eq!(restored.changed_by, "ops");
        assert_eq!(restored.changed_at_ms, 3_000);
        assert_eq!(restored.revision, 3);
        assert!(owners.owns(&space, "ts-node").expect("read ownership"));
        assert!(!owners.owns(&space, "rust-node").expect("read ownership"));
    }

    #[test]
    fn a_store_compare_and_swap_is_one_atomic_step() {
        let store = InMemoryOwnerStore::new();
        let row = |revision| Owner {
            node: "node".into(),
            changed_by: "ops".into(),
            changed_at_ms: 0,
            revision,
        };

        assert!(store
            .compare_and_swap("did:web:alpha.example", None, &row(1))
            .expect("the first write"));
        assert!(!store
            .compare_and_swap("did:web:alpha.example", None, &row(2))
            .expect("the stale write"));
        assert_eq!(
            store
                .load("did:web:alpha.example")
                .expect("the read")
                .expect("a row")
                .revision,
            1
        );
    }

    #[test]
    fn a_stale_rollback_is_refused_after_another_flip() {
        let owners = MaterialisationOwners::in_memory();
        let space = space();
        let stale = owners
            .handover(&space, "rust-a", "ops", 10)
            .expect("the first handover");
        let latest = owners
            .handover(&space, "rust-b", "ops", 20)
            .expect("the second handover");

        assert!(matches!(
            owners.rollback(&space, &stale, "ops", 30),
            Err(OwnerError::RollbackConflict { .. })
        ));
        assert!(owners.owns(&space, "rust-b").expect("read ownership"));
        assert_eq!(latest.to.revision, 2);
    }

    #[test]
    fn a_handover_without_a_predecessor_rolls_back_to_unowned() {
        let owners = MaterialisationOwners::in_memory();
        let space = space();
        let flip = owners
            .handover(&space, "rust-node", "ops", 10)
            .expect("the handover");

        assert_eq!(
            owners
                .rollback(&space, &flip, "ops", 20)
                .expect("the rollback"),
            None
        );
        assert_eq!(owners.owner(&space).expect("read ownership"), None);
    }

    #[test]
    fn the_sqlite_store_round_trips_a_handover_and_a_rollback() {
        let owners = MaterialisationOwners::new(
            SqliteOwnerStore::in_memory().expect("an in-memory ownership table"),
        );
        let space = space();

        let flip = owners
            .handover(&space, "rust-node", "ops", 10)
            .expect("the handover");
        assert_eq!(flip.to.revision, 1);
        assert!(owners.owns(&space, "rust-node").expect("read ownership"));

        let restored = owners
            .rollback(&space, &flip, "ops", 20)
            .expect("the rollback");
        assert_eq!(restored, None);
        assert!(!owners.owns(&space, "rust-node").expect("read ownership"));
    }

    // -- write cutover ------------------------------------------------------

    #[test]
    fn a_write_flip_is_per_space_and_starts_on_typescript() {
        let cutover = WriteCutover::new();
        let alpha = "did:web:alpha.example";
        let beta = "did:web:beta.example";

        assert_eq!(cutover.path(alpha), WritePath::TypeScript);
        assert_eq!(cutover.path(beta), WritePath::TypeScript);
        assert_eq!(cutover.flag(alpha).flipped_by, None);

        let flag = cutover.flip(alpha, WritePath::Rust, "alice", 111);
        assert_eq!(flag.path, WritePath::Rust);
        assert_eq!(flag.flipped_by.as_deref(), Some("alice"));
        assert_eq!(flag.flipped_at_ms, Some(111));
        assert!(cutover.goes_to_rust(alpha));
        assert!(!cutover.goes_to_rust(beta));
        assert_eq!(cutover.path(beta), WritePath::TypeScript);

        let rolled_back = cutover.rollback(alpha, "bob", 222);
        assert_eq!(rolled_back.path, WritePath::TypeScript);
        assert_eq!(rolled_back.flipped_by.as_deref(), Some("bob"));
        assert!(!cutover.goes_to_rust(alpha));
        assert!(!cutover.goes_to_rust(beta));

        let history = cutover.history(alpha);
        assert_eq!(history.len(), 2);
        assert_eq!(
            history[0],
            WriteFlip {
                space: alpha.into(),
                to: WritePath::Rust,
                by: "alice".into(),
                at_ms: 111,
            }
        );
        assert_eq!(history[1].to, WritePath::TypeScript);
        assert!(cutover.history(beta).is_empty());
        assert_eq!(cutover.spaces(), vec![alpha.to_string()]);
    }

    #[test]
    fn flipping_one_space_leaves_another_spaces_writes_alone() {
        let cutover = WriteCutover::new();
        cutover.flip("did:web:alpha.example", WritePath::Rust, "alice", 1);
        cutover.flip("did:web:beta.example", WritePath::Rust, "alice", 2);

        assert!(cutover.goes_to_rust("did:web:alpha.example"));
        assert!(cutover.goes_to_rust("did:web:beta.example"));

        cutover.rollback("did:web:alpha.example", "bob", 3);
        assert!(!cutover.goes_to_rust("did:web:alpha.example"));
        assert!(cutover.goes_to_rust("did:web:beta.example"));
    }
}
