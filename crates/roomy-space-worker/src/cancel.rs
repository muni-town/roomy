//! Cancellation, per space.
//!
//! A process owns many spaces, and stopping one is not stopping the process.
//! Each actor holds its own token; the supervisor flips the ones it wants to
//! stop and joins them, which is what lets a space be unloaded while its
//! neighbours keep materialising.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// A one-way stop signal, cloneable across the supervisor and its actors.
#[derive(Debug, Clone, Default)]
pub struct Cancel {
    cancelled: Arc<AtomicBool>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask whatever holds this token to stop after the batch it is applying.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}
