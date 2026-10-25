//! What a rule emits: fixed statements, and the steps that must read first.
//!
//! The shape is `materialization/records/effects.ts`'s, so the two
//! implementations apply one change the same way: the kind's statements, the
//! projection its entry maintains, then the derived state it invalidates.
//!
//! Statements name their target rather than leaving it to be inferred — the
//! federation and membership rules write the global DB by construction, and
//! every other rule writes the space's own. A [`DerivedStep`] is work that has
//! to read rows and compute before it writes: one variant per step, never a
//! closure, because the same list is what a worker executes.

use crate::ids::SpaceDid;

/// Which database a statement targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Space,
    Global,
}

/// A statement parameter, in the shapes SQLite takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    pub fn text(value: impl Into<String>) -> Self {
        Value::Text(value.into())
    }

    pub fn opt_text(value: Option<impl Into<String>>) -> Self {
        match value {
            Some(value) => Value::Text(value.into()),
            None => Value::Null,
        }
    }

    pub fn flag(value: bool) -> Self {
        Value::Integer(if value { 1 } else { 0 })
    }

    pub fn opt_flag(value: Option<bool>) -> Self {
        match value {
            Some(value) => Value::flag(value),
            None => Value::Null,
        }
    }

    pub fn opt_int(value: Option<i64>) -> Self {
        match value {
            Some(value) => Value::Integer(value),
            None => Value::Null,
        }
    }
}

/// A fixed statement, applied as it stands.
#[derive(Debug, Clone, PartialEq)]
pub struct SqlEffect {
    pub target: Target,
    pub sql: &'static str,
    pub params: Vec<Value>,
}

/// An effect that reads the rows first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DerivedStep {
    /// Recompute a room's `activity_item` window and its `room_activity`
    /// summary from the messages that remain.
    RebuildActivityWindow { room_id: String },
    /// Fold one message into its room's feed window and board summary.
    UpsertActivityItem {
        space_id: SpaceDid,
        room_id: String,
        message_id: String,
        /// The message's canonical send time — not its ordering key.
        timestamp: i64,
    },
    /// The link entities and `comp_embed_link` rows a message's content names.
    StoreLinks {
        space_id: SpaceDid,
        message_id: String,
        urls: Vec<String>,
        /// The instant the log assigns the change: the rows' clock stamp.
        decided_at_ms: i64,
    },
    /// Key a message between its neighbours: the one ordering key whose value
    /// depends on the rows around it.
    SetMessageSortIdxByReorder {
        stream_id: SpaceDid,
        message_id: String,
        after: String,
    },
}

/// One change's effects, in application order.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Sql(SqlEffect),
    Step(DerivedStep),
}

impl Effect {
    /// A statement against the space's own DB.
    pub fn space(sql: &'static str, params: Vec<Value>) -> Self {
        Effect::Sql(SqlEffect {
            target: Target::Space,
            sql,
            params,
        })
    }

    /// A statement against the global DB, returned to the caller to apply.
    pub fn global(sql: &'static str, params: Vec<Value>) -> Self {
        Effect::Sql(SqlEffect {
            target: Target::Global,
            sql,
            params,
        })
    }
}
