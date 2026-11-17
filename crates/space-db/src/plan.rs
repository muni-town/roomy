//! Planning a batch: reading the state a rule needs before it runs.
//!
//! A change's record carries everything about the record itself, and nothing
//! about where it was. A move names only its destination, a delete names no room
//! at all, an unlink names only the room it unlinks, and a call fact names only
//! the call. Those values are read from the rows, once per batch, replaying the
//! batch's own changes in order so a change that both creates and moves a record
//! sees the state the earlier one produced.
//!
//! This is `materialization/records/recordPath.ts`'s planner, over the change
//! feed instead of the log: the reads are the same three, and the order they are
//! taken in is the order the worker applies changes.

use std::collections::HashMap;

use roomy_events::Did;
use rusqlite::Connection;
use space_core::change::{
    decode_row, ChangeOp, DecodeError, FeedRow, RecordBody, RecordChange, RecordKind, RecordPatch,
};
use space_core::effects::{DerivedStep, SqlEffect};
use space_core::ids::SpaceDid;
use space_core::time;
use space_core::{Effect, PlanMode, RuleContext};

use crate::{ChangeLabel, DbError, SpaceDb};

/// One entry's changes, each with the effects it produced.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEntry {
    /// The log entry the changes came from. Changes that share an `idx` are
    /// planned together, because they came from one entry and share its actor.
    pub idx: i64,
    pub changes: Vec<PlannedChange>,
}

impl PlannedEntry {
    /// Every effect the entry's changes produced, in application order.
    pub fn effects(&self) -> impl Iterator<Item = &Effect> {
        self.changes.iter().flat_map(|change| &change.effects)
    }
}

/// One change's effects, with the identity a failure reports it by.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedChange {
    /// Emission order within the entry, as the feed recorded it.
    pub ord: i64,
    pub kind: RecordKind,
    pub op: ChangeOp,
    pub rkey: String,
    pub effects: Vec<Effect>,
}

/// One entry's changes, with the entry's own identity.
#[derive(Debug, Clone)]
pub struct EntryChanges {
    pub idx: i64,
    /// Emission order within the entry; the changes are applied in it.
    pub changes: Vec<EntryChange>,
    pub actor: Did,
    pub event_id: String,
    pub order_stamp: String,
}

/// One change in an entry, at the position the feed emitted it.
#[derive(Debug, Clone)]
pub struct EntryChange {
    pub ord: i64,
    pub change: RecordChange,
}

/// A feed row that does not decode into a change.
#[derive(Debug, thiserror::Error)]
#[error("change at idx {idx} does not decode: {source}")]
pub struct GroupError {
    pub idx: i64,
    pub source: DecodeError,
}

/// Group feed rows into the entries they came from.
///
/// Rows sharing an `idx` came from one log entry, share its actor, and are
/// applied in emission order; the entry carries the id and ordering stamp the
/// rules read. The feed returns rows already in `(idx, ord)` order, so a single
/// pass is enough.
pub fn group_entries(rows: &[FeedRow]) -> Result<Vec<EntryChanges>, GroupError> {
    let mut entries: Vec<EntryChanges> = Vec::new();
    for row in rows {
        let change = decode_row(row).map_err(|source| GroupError {
            idx: row.idx,
            source,
        })?;
        let actor = Did::parse(row.actor.clone()).map_err(|_| GroupError {
            idx: row.idx,
            source: DecodeError::Did,
        })?;
        match entries.last_mut() {
            Some(entry) if entry.idx == row.idx => entry.changes.push(EntryChange {
                ord: row.ord,
                change,
            }),
            _ => entries.push(EntryChanges {
                idx: row.idx,
                changes: vec![EntryChange {
                    ord: row.ord,
                    change,
                }],
                actor,
                event_id: row.event_id.clone(),
                order_stamp: row.order_stamp.clone(),
            }),
        }
    }
    Ok(entries)
}

/// Plan a batch, reading the prior state its changes need.
pub fn plan_batch(
    conn: &Connection,
    stream_id: &SpaceDid,
    entries: &[EntryChanges],
    mode: PlanMode,
) -> Result<Vec<PlannedEntry>, DbError> {
    let needed_rooms = rooms_needed(entries);
    let needed_parents = parents_needed(entries);
    let needed_calls = calls_needed(entries);

    let mut rooms = read_rooms(conn, &needed_rooms)?;
    let mut parents = read_canonical_parents(conn, &needed_parents)?;
    let mut calls = read_call_rooms(conn, &needed_calls)?;

    let mut planned: Vec<PlannedEntry> = Vec::new();
    for entry in entries {
        let mut planned_changes: Vec<PlannedChange> = Vec::new();
        for entry_change in &entry.changes {
            let change = &entry_change.change;
            let key = change.base().rkey.as_str().to_string();
            // The change's instant comes from its entry's ordering stamp, so a
            // replay stamps the same values the live path did.
            let decided_at_ms = time::ulid_time_ms(&entry.order_stamp)
                .ok_or_else(|| DbError::Stamp(entry.order_stamp.clone()))?;
            let mut ctx = RuleContext {
                stream_id: stream_id.clone(),
                is_backfill: mode.is_backfill(),
                actor: entry.actor.clone(),
                event_id: entry.event_id.clone(),
                prior_room: None,
                prior_parent: None,
                decided_at_ms,
            };

            match change {
                RecordChange::Create {
                    record: RecordBody::Message(record),
                    ..
                } => {
                    rooms.insert(key.clone(), record.room.clone());
                }
                RecordChange::Update {
                    patch: RecordPatch::Message(patch),
                    ..
                } if patch.room.is_some() => {
                    ctx.prior_room = rooms.get(&key).cloned();
                    rooms.insert(key.clone(), patch.room.clone().unwrap_or_default());
                }
                RecordChange::Delete { base } if base.kind == RecordKind::Message => {
                    ctx.prior_room = rooms.get(&key).cloned();
                    rooms.remove(&key);
                }
                RecordChange::Update {
                    patch: RecordPatch::Room(patch),
                    ..
                } if patch.parent.is_some() => match patch.parent.clone().flatten() {
                    None => {
                        ctx.prior_parent = parents.get(&key).cloned();
                        parents.remove(&key);
                    }
                    Some(parent) => {
                        parents.insert(key.clone(), parent);
                    }
                },
                RecordChange::Create {
                    record: RecordBody::VoiceCall(record),
                    ..
                } => {
                    calls.insert(key.clone(), record.room.clone());
                }
                RecordChange::Delete { base } if base.kind == RecordKind::VoiceCall => {
                    ctx.prior_room = calls.get(&key).cloned();
                    calls.remove(&key);
                }
                RecordChange::Update {
                    patch: RecordPatch::VoiceCall(_),
                    ..
                } => {
                    ctx.prior_room = calls.get(&key).cloned();
                }
                _ => {}
            }

            planned_changes.push(PlannedChange {
                ord: entry_change.ord,
                kind: change.kind(),
                op: change.op(),
                rkey: change.base().rkey.as_str().to_string(),
                effects: space_core::plan(change, &ctx)?,
            });
        }
        planned.push(PlannedEntry {
            idx: entry.idx,
            changes: planned_changes,
        });
    }
    Ok(planned)
}

fn rooms_needed(entries: &[EntryChanges]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        for entry_change in &entry.changes {
            let change = &entry_change.change;
            let needed = match change {
                RecordChange::Delete { base } => base.kind == RecordKind::Message,
                RecordChange::Update {
                    patch: RecordPatch::Message(patch),
                    ..
                } => patch.room.is_some(),
                _ => false,
            };
            if needed {
                let key = change.base().rkey.as_str().to_string();
                if !ids.contains(&key) {
                    ids.push(key);
                }
            }
        }
    }
    ids
}

fn parents_needed(entries: &[EntryChanges]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        for entry_change in &entry.changes {
            let change = &entry_change.change;
            if let RecordChange::Update {
                patch: RecordPatch::Room(patch),
                ..
            } = change
            {
                if patch.parent.as_ref().map(|parent| parent.is_none()) == Some(true) {
                    let key = change.base().rkey.as_str().to_string();
                    if !ids.contains(&key) {
                        ids.push(key);
                    }
                }
            }
        }
    }
    ids
}

fn calls_needed(entries: &[EntryChanges]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        for entry_change in &entry.changes {
            let change = &entry_change.change;
            let needed = change.kind() == RecordKind::VoiceCall
                && !matches!(change, RecordChange::Create { .. });
            if needed {
                let key = change.base().rkey.as_str().to_string();
                if !ids.contains(&key) {
                    ids.push(key);
                }
            }
        }
    }
    ids
}

/// The room each `id` is currently in, skipping rows that are not there.
fn read_rooms(conn: &Connection, ids: &[String]) -> Result<HashMap<String, String>, DbError> {
    let mut rooms: HashMap<String, String> = HashMap::new();
    let mut statement = conn.prepare("select id, room from entities where id = ?")?;
    for id in ids {
        let row: Option<(String, Option<String>)> = statement
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok();
        if let Some((id, Some(room))) = row {
            rooms.insert(id, room);
        }
    }
    Ok(rooms)
}

/// The canonical parent of each `id`: the `link` edge whose payload marks it
/// first-written. A room can be linked from several parents and the record model
/// carries one, so the canonical edge is the one an unlink clears.
fn read_canonical_parents(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, String>, DbError> {
    let mut parents: HashMap<String, String> = HashMap::new();
    let mut statement = conn.prepare(
        "select tail, head from edges
          where label = 'link'
            and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
            and tail = ?",
    )?;
    for id in ids {
        let row: Option<(String, String)> = statement
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok();
        if let Some((tail, head)) = row {
            parents.insert(tail, head);
        }
    }
    Ok(parents)
}

/// The room each call is in, from `active_calls`.
fn read_call_rooms(conn: &Connection, ids: &[String]) -> Result<HashMap<String, String>, DbError> {
    let mut calls: HashMap<String, String> = HashMap::new();
    let mut statement =
        conn.prepare("select call_id, room_id from active_calls where call_id = ?")?;
    for id in ids {
        let row: Option<(String, String)> = statement
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok();
        if let Some((call_id, room_id)) = row {
            calls.insert(call_id, room_id);
        }
    }
    Ok(calls)
}

/// A statement and the change that emitted it.
#[derive(Debug, Clone, Copy)]
pub struct LabelledStatement<'a> {
    pub change: ChangeLabel<'a>,
    pub statement: &'a SqlEffect,
}

/// Flatten a planned batch: every entry's statements first, then every entry's
/// derived steps, which is the order the TypeScript materialiser applies a
/// chunk in.
///
/// Each statement keeps the change that emitted it, so a statement the database
/// rejects can name the change it came from.
#[must_use]
pub fn flatten(planned: &[PlannedEntry]) -> (Vec<LabelledStatement<'_>>, Vec<&DerivedStep>) {
    let mut statements: Vec<LabelledStatement<'_>> = Vec::new();
    let mut steps: Vec<&DerivedStep> = Vec::new();
    for entry in planned {
        for change in &entry.changes {
            let label = ChangeLabel {
                idx: entry.idx,
                ord: change.ord,
                kind: change.kind,
                op: change.op,
                rkey: &change.rkey,
            };
            for effect in &change.effects {
                match effect {
                    Effect::Sql(statement) => statements.push(LabelledStatement {
                        change: label,
                        statement,
                    }),
                    Effect::Step(step) => steps.push(step),
                }
            }
        }
    }
    (statements, steps)
}

/// Apply a planned batch: every entry's statements first, then every entry's
/// derived steps.
///
/// The order is the one the TypeScript materialiser uses for a chunk, and it
/// matters: a window rebuilt by one change has to see the rows the batch's other
/// changes wrote. Global-targeted statements, including those a step produced,
/// are returned for the caller's sink.
pub fn apply_plan(db: &mut SpaceDb, planned: &[PlannedEntry]) -> Result<Vec<SqlEffect>, DbError> {
    let (statements, steps) = flatten(planned);
    let mut globals = db.apply_statements(&statements)?;
    globals.extend(db.apply_steps(&steps)?);
    Ok(globals)
}
