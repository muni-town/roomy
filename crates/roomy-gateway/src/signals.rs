//! Signals from workers, to the connections that care.
//!
//! A worker emits a coarse, advisory signal after each committed batch
//! (`roomy_space_worker::signal`). The gateway fans it out to the sessions
//! subscribed to that space. Dropping one is safe: the client refetches on
//! reconnect, and the signal only ever shortens the wait.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use roomy_space_worker::signal::{SignalSink, SpaceSignal};
use tokio::sync::broadcast;

/// A worker's signals, fanned out to the gateway's subscription loop.
#[derive(Debug, Clone)]
pub struct GatewaySignals {
    sender: broadcast::Sender<SpaceSignal>,
    received: Arc<AtomicU64>,
}

impl Default for GatewaySignals {
    fn default() -> Self {
        Self::new(1024)
    }
}

impl GatewaySignals {
    /// `capacity` is how far a slow subscriber may fall behind before signals
    /// are dropped for it — which is allowed, because they are advisory.
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self {
            sender,
            received: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SpaceSignal> {
        self.sender.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    /// How many signals the workers in this process have emitted.
    pub fn received(&self) -> u64 {
        self.received.load(Ordering::Relaxed)
    }

    /// Publish a signal, as a test or an in-process worker would.
    pub fn publish(&self, signal: SpaceSignal) {
        self.received.fetch_add(1, Ordering::Relaxed);
        let _ = self.sender.send(signal);
    }
}

impl SignalSink for GatewaySignals {
    fn signal(&mut self, signal: &SpaceSignal) {
        self.publish(signal.clone());
    }
}
