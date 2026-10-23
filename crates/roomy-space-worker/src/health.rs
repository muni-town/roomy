//! `/health`: what this worker is doing, in one JSON object.
//!
//! The fields are the ones an operator needs to tell "working" from "stuck":
//! how far the projection has come, how far behind the feed it is, whether it
//! holds the lease, and what the last failure was. `lag` is in log entries —
//! the number of entries the feed holds past the applied cursor — because that
//! is the quantity a dashboard alerts on.

use serde::{Deserialize, Serialize};

/// One worker's state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Health {
    pub space: String,
    /// The `(idx, ord)` position the projection has reached.
    pub cursor: (i64, i64),
    /// Log entries the feed holds past `cursor`.
    pub lag: i64,
    pub lease_held: bool,
    pub holder: String,
    pub last_error: Option<String>,
}

impl Health {
    /// The HTTP body: the struct as JSON, with `lease_held` under the name an
    /// operator greps for.
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "space": self.space,
            "cursor": { "idx": self.cursor.0, "ord": self.cursor.1 },
            "lag": self.lag,
            "leaseHeld": self.lease_held,
            "holder": self.holder,
            "lastError": self.last_error,
        })
        .to_string()
    }

    /// Whether the worker is doing its job: leased, and not erroring.
    pub fn is_healthy(&self) -> bool {
        self.lease_held && self.last_error.is_none()
    }
}
