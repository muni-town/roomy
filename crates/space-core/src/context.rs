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

/// Whether a batch is the live write path or a replay.
///
/// A rebuild runs the same rules over the same log, but it must not write the
/// rows reads populate: a live space is being read while it is rebuilt, and a
/// projection written from the middle of a replay would answer a read with a
/// partial view. [`PlanMode::Backfill`] invalidates them instead, and the next
/// read rebuilds them from the rows that are there — the same choice the
/// TypeScript materialiser makes for its backfill path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlanMode {
    /// The live write path: read-path projections are maintained as changes land.
    #[default]
    Live,
    /// A replay into a database that is being rebuilt: read-path projections are
    /// invalidated rather than written.
    Backfill,
}

impl PlanMode {
    /// Whether this is a replay into a database being rebuilt.
    pub fn is_backfill(self) -> bool {
        matches!(self, PlanMode::Backfill)
    }
}

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
    /// The instant the log assigns this change, in epoch milliseconds: the time
    /// half of the entry's ordering stamp.
    ///
    /// An ordering stamp is assigned at ingest and travels with the change, so
    /// this is a value the log determines and a replay reproduces exactly. It
    /// is what the rules stamp `created_at`, `updated_at` and the federation
    /// decision instants with; nothing in materialisation reads a clock.
    pub decided_at_ms: i64,
}

impl RuleContext {
    /// The context of a live change: no backfill, and no prior room or parent
    /// for the planner to have read.
    pub fn new(
        stream_id: SpaceDid,
        actor: Did,
        event_id: impl Into<String>,
        decided_at_ms: i64,
    ) -> Self {
        Self {
            stream_id,
            is_backfill: false,
            actor,
            event_id: event_id.into(),
            prior_room: None,
            prior_parent: None,
            decided_at_ms,
        }
    }
}
