//! The space worker, as a library.
//!
//! The worker materialises spaces from a change feed and serves nothing: reads
//! are a separate crate, the HTTP edge is the gateway's, and the process that
//! owns this crate composes them. What it owns is the loop and its seams:
//!
//!  * [`space_feed::ChangeFeed`] — the change records one space has, from a cursor.
//!  * [`lease::Lease`] — whether this process may write the space.
//!  * [`sink::GlobalSink`] — where a change's global statements go.
//!  * [`signal::SignalSink`] — the post-commit signal, advisory.
//!  * [`clock::Clock`] — the lease's instants, injected rather than read.
//!  * [`cancel::Cancel`] — the per-space stop signal.
//!
//! [`supervisor::Supervisor`] owns N of them in one process: one blocking actor
//! per space, a shared health snapshot, and a stop that releases every lease.
//!
//! The crate parses no environment and binds no socket. A deployment's binary
//! does that and hands the values in (a [`supervisor::SupervisorConfig`]),
//! which is what makes the same code run embedded in a gateway and in a worker
//! pool.

pub mod cancel;
pub mod clock;
pub mod health;
pub mod lease;
pub mod relay;
pub mod signal;
pub mod sink;
pub mod supervisor;
pub mod worker;

pub use cancel::Cancel;
pub use clock::{Clock, SystemClock};
pub use health::Health;
pub use lease::Lease;
pub use signal::{NoSignals, SignalSink, SpaceSignal};
pub use sink::GlobalSink;
pub use supervisor::{Supervisor, SupervisorConfig};
pub use worker::{Progress, Worker, WorkerError, WorkerParts};
