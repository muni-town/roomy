//! `/health`: what this worker is doing, in one JSON object.
//!
//! The fields are the ones an operator needs to tell "working" from "stuck":
//! how far the projection has come, how far behind the feed it is, whether it
//! holds the lease, and what the last failure was. `lag` is in log entries —
//! the number of entries the feed holds past the applied cursor — because that
//! is the quantity a dashboard alerts on.
//!
//! A follower takes no lease, so it reports `leaseHeld: false` and
//! `following: true`. That pair is the honest answer for a read replica, and it
//! is what `is_healthy` accepts in place of a lease.

use serde::{Deserialize, Serialize};

/// One worker's state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Health {
    /// The space this actor materialises.
    pub space: String,
    /// The `(idx, ord)` position the projection has reached.
    pub cursor: (i64, i64),
    /// Log entries the feed holds past `cursor`.
    pub lag: i64,
    /// Whether this process holds the space's write lease. Always false for a
    /// follower, which never asks for one.
    pub lease_held: bool,
    /// Whether this process replays beside the owner rather than owning the
    /// space.
    pub following: bool,
    /// This process's identity on the lease row.
    pub holder: String,
    /// The last failure, cleared by the next batch that succeeds.
    pub last_error: Option<String>,
}

impl Health {
    /// The object the HTTP body carries, with `lease_held` under the name an
    /// operator greps for.
    #[must_use]
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "space": self.space,
            "cursor": { "idx": self.cursor.0, "ord": self.cursor.1 },
            "lag": self.lag,
            "leaseHeld": self.lease_held,
            "following": self.following,
            "holder": self.holder,
            "lastError": self.last_error,
        })
    }

    /// The same object, serialised.
    #[must_use]
    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// Whether the worker is doing its job: nothing failed, and either it holds
    /// the lease or it is a follower, which is not supposed to have one.
    #[must_use]
    pub fn is_healthy(&self) -> bool {
        self.last_error.is_none() && (self.lease_held || self.following)
    }
}

/// What the last discovery pass found.
///
/// A stream the feed names but holds no rows for is reported as `noEvents`
/// rather than left out: nothing is opened for it, and an empty stream is not a
/// missing space. An operator who cannot tell the two apart cannot tell a quiet
/// deployment from a broken one.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveryState {
    /// Every stream the feed held when it was asked.
    pub streams: Vec<String>,
    /// The streams this process started because the pass found them.
    pub started: Vec<String>,
    /// The streams with nothing to apply.
    pub no_events: Vec<String>,
    /// The last pass that failed, cleared by the next that succeeded.
    pub last_error: Option<String>,
}

impl DiscoveryState {
    /// The object the health body carries.
    #[must_use]
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "streams": self.streams,
            "started": self.started,
            "noEvents": self.no_events,
            "lastError": self.last_error,
        })
    }
}
