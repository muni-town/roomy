//! The clock, injected.
//!
//! Materialisation itself reads no clock: every instant it writes comes from the
//! change's ordering stamp. Two things still need one — the lease's expiry, and a
//! test that wants to advance time — so the clock is a value the supervisor
//! passes in rather than a call to `SystemTime::now()` inside the loop.

use std::time::{SystemTime, UNIX_EPOCH};

/// The current instant, in epoch milliseconds.
pub trait Clock: Send + Sync {
    /// Now, as epoch milliseconds.
    #[must_use]
    fn now_ms(&self) -> i64;
}

/// Wall-clock time.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or(0)
    }
}
