//! The relay: a worker's signal, delivered to a gateway in another process.
//!
//! Signals are advisory (`rust-core-appserver.md` §2.1, §7 Q5). A relay that
//! cannot deliver one costs freshness until the listener's next refetch or
//! reconnect, never correctness — so the relay logs a failure and carries on
//! rather than failing the batch that produced the signal. That is exactly why
//! the transport is allowed to be this simple: a POST per committed batch, no
//! queue, no retry, no ordering guarantee.

use std::time::Duration;

use crate::signal::{SignalSink, SpaceSignal, WireSignal};

/// The header a worker presents to a gateway's internal signal endpoint. Same
/// secret as the internal feed: it authenticates a process, not a user.
pub const INTERNAL_HEADER: &str = "x-roomy-internal";

/// Sends each committed batch's signal to a gateway over HTTP.
pub struct RelaySignals {
    /// The gateway's base URL, without a trailing slash.
    url: String,
    secret: Option<String>,
    agent: ureq::Agent,
    delivered: u64,
    dropped: u64,
}

impl RelaySignals {
    pub fn new(base_url: impl Into<String>, secret: Option<String>) -> Self {
        Self {
            url: base_url.into().trim_end_matches('/').to_string(),
            secret,
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(2))
                .timeout_read(Duration::from_secs(5))
                .build(),
            delivered: 0,
            dropped: 0,
        }
    }

    /// Signals this relay handed over, and ones it gave up on.
    pub fn counts(&self) -> (u64, u64) {
        (self.delivered, self.dropped)
    }

    fn deliver(&mut self, signal: &SpaceSignal) -> Result<(), String> {
        let body =
            serde_json::to_string(&WireSignal::from(signal)).map_err(|error| error.to_string())?;
        let mut request = self
            .agent
            .post(&format!("{}/internal/signal", self.url))
            .set("content-type", "application/json");
        if let Some(secret) = &self.secret {
            request = request.set(INTERNAL_HEADER, secret);
        }
        request
            .send_string(&body)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

impl SignalSink for RelaySignals {
    fn signal(&mut self, signal: &SpaceSignal) {
        match self.deliver(signal) {
            Ok(()) => self.delivered += 1,
            Err(error) => {
                self.dropped += 1;
                tracing::debug!(
                    space = signal.space.as_str(),
                    %error,
                    "a signal did not reach the gateway"
                );
            }
        }
    }
}
