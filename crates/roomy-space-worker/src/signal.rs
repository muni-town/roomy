//! The post-commit signal: what a worker tells the gateway it changed.
//!
//! A signal is advisory (`rust-core-appserver.md` §2.1). It says "this space
//! moved"; it never carries the rows, and dropping one only delays freshness
//! until the next refetch or reconnect. That is why it is coarse enough to
//! coalesce and cheap enough to send after every committed batch.

use space_core::ids::{KeyError, SpaceDid};

/// One space's committed progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceSignal {
    /// The space that moved.
    pub space: SpaceDid,
    /// The cursor the projection has reached.
    pub cursor: (i64, i64),
    /// Log entries applied by the batch that produced this signal.
    pub entries: usize,
}

/// A signal as it crosses a process boundary.
///
/// The space travels as its DID string: the wire format is the deployment's, and
/// a worker and a gateway that upgrade on different days still agree on it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WireSignal {
    /// The space that moved, as its DID string.
    pub space: String,
    /// The cursor the projection has reached.
    pub cursor: (i64, i64),
    /// Log entries applied by the batch that produced this signal.
    pub entries: usize,
}

impl From<&SpaceSignal> for WireSignal {
    fn from(signal: &SpaceSignal) -> Self {
        Self {
            space: signal.space.as_str().to_string(),
            cursor: signal.cursor,
            entries: signal.entries,
        }
    }
}

impl WireSignal {
    /// The signal it names.
    ///
    /// # Errors
    ///
    /// Returns the parse error when the wire's `space` is not a DID.
    pub fn into_signal(self) -> Result<SpaceSignal, KeyError> {
        Ok(SpaceSignal {
            space: SpaceDid::parse(self.space)?,
            cursor: self.cursor,
            entries: self.entries,
        })
    }
}

/// Where a worker's signals go.
pub trait SignalSink: Send {
    /// A batch committed. Called after the commit, so a listener that reads the
    /// space sees the rows the signal is about.
    fn signal(&mut self, signal: &SpaceSignal);

    /// The worker is stopping: deliver anything still held.
    fn flush(&mut self) {}
}

/// A sink that drops every signal, for a worker whose gateway polls instead.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSignals;

impl SignalSink for NoSignals {
    fn signal(&mut self, _signal: &SpaceSignal) {}
}

impl SignalSink for Box<dyn SignalSink> {
    fn signal(&mut self, signal: &SpaceSignal) {
        (**self).signal(signal);
    }

    fn flush(&mut self) {
        (**self).flush();
    }
}
