//! Roomy space projection, without I/O.
//!
//! The crate answers one question: given a change record and the state around
//! it, which statements and steps apply it? That is the whole of what a space
//! worker computes, split out so it can be tested without a database and
//! executed by whatever does have one.
//!
//! Ported from `packages/appserver/src/materialization/records/` — the same
//! rules, the same statements, the same order. `plan` is the entry point.
//!
//! Two properties the port keeps rather than documents:
//!
//!  * **No ambient state.** A rule reads the change, the context and the
//!    record's own bytes. The only clock it sees is one the caller passed, and
//!    only the federation rules record it — the same exception the TypeScript
//!    rules make with `Date.now()`, and the reason those columns are out of a
//!    cross-implementation digest.
//!  * **A key cannot be invented.** An ordering stamp comes from
//!    deserialisation, and the one key derived from rows (a reorder between
//!    neighbours) is a [`effects::DerivedStep`], not a statement.

pub mod change;
pub mod context;
pub mod effects;
pub mod ids;
pub mod links;
pub mod rules;
pub mod time;

pub use change::{decode_row, ChangeBase, DecodeError, FeedRow, RecordChange, RecordKind};
pub use context::RuleContext;
pub use effects::{DerivedStep, Effect, SqlEffect, Target, Value};
pub use ids::{Collection, OrderStamp, Rkey, SpaceDid};
pub use rules::{plan, RuleError};
