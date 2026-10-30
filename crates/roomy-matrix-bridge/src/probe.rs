//! The capability probe's shared result.
//!
//! The probe runs at startup and again on a timer, and its result is read by
//! `GET /capabilities`, the `/health` healthcheck, and the encryption decision.
//! One cell holding the last measurement means those three cannot disagree.

use std::sync::Arc;

use matrix_adapter::HomeserverCapabilities;
use parking_lot::RwLock;

/// The last probe result.
#[derive(Debug, Clone, Default)]
pub struct ProbeState {
    inner: Arc<RwLock<Option<HomeserverCapabilities>>>,
}

impl ProbeState {
    /// A state that has measured nothing yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a fresh measurement.
    pub fn set(&self, capabilities: HomeserverCapabilities) {
        *self.inner.write() = Some(capabilities);
    }

    /// The last measurement, if the probe has run.
    pub fn capabilities(&self) -> Option<HomeserverCapabilities> {
        self.inner.read().clone()
    }
}
