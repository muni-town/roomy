//! The space worker's seams.
//!
//! Four narrow interfaces, each with one implementation, so the loop that ties
//! them together can be read as the loop it is:
//!
//!  * [`ChangeFeed`] — the change records one space has, from a cursor.
//!  * [`Lease`] — whether this process may write the space.
//!  * [`GlobalSink`] — where a change's global statements go.
//!  * [`Materialisation`] — the loop body, which is `Worker::step`.
//!
//! The worker serves no XRPC here: the router and the read queries are a
//! separate piece of work, and none of them changes what materialisation is.

pub mod config;
pub mod feed;
pub mod health;
pub mod lease;
pub mod sink;
pub mod worker;

pub use config::Config;
pub use feed::ChangeFeed;
pub use lease::Lease;
pub use sink::GlobalSink;
pub use worker::{Worker, WorkerParts};
