//! What a rule needs that the record does not carry.
//!
//! A record names its own rows; three things around it do not travel with it:
//! the space it belongs to, the acting user and event id (two rules key rows by
//! them — the membership announcement by the join event's id,
//! `comp_invite.event_ulid` by the invite event's, and a call fact's
//! `joined_at` decodes the event id), and the prior room or parent the planner
//! read. The planner reads the prior state because a move names only its
//! destination and a delete names no room at all.
//!
//! The prior fields are plain options on one struct rather than a type that
//! varies by kind: the planner does not know which change a read is for, and a
//! rule that reads one of them where its kind has none is a planner bug the
//! parity fixtures catch, not a shape the compiler can enforce without making
//! every caller say which kind it plans for.

use roomy_events::Did;

use crate::ids::SpaceDid;

/// The context of one change.
#[derive(Debug, Clone)]
pub struct RuleContext {
    pub stream_id: SpaceDid,
    /// True for a replay: the read-path projections are invalidated rather than
    /// written, matching the TypeScript materialiser's backfill mode.
    pub is_backfill: bool,
    /// The user who sent the entry the change was derived from.
    pub actor: Did,
    /// The entry's id, for the rows the record model does not identify.
    pub event_id: String,
    /// The room a message or call was in before this change.
    pub prior_room: Option<String>,
    /// The room a link's `parent` pointed at before this change.
    pub prior_parent: Option<String>,
    /// The derivation instant, in epoch milliseconds.
    ///
    /// Only the federation rules record it (`requested_at`, `decided_at`), and
    /// neither value is determined by the log — the same exception the
    /// TypeScript rules make with `Date.now()`, which is why both are excluded
    /// from a cross-implementation digest.
    pub now_ms: i64,
}

impl RuleContext {
    pub fn new(stream_id: SpaceDid, actor: Did, event_id: impl Into<String>, now_ms: i64) -> Self {
        Self {
            stream_id,
            is_backfill: false,
            actor,
            event_id: event_id.into(),
            prior_room: None,
            prior_parent: None,
            now_ms,
        }
    }
}
