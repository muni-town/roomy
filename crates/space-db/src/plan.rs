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
use space_core::change::{RecordBody, RecordChange, RecordKind, RecordPatch};
use space_core::{Effect, RuleContext};

use crate::DbError;

/// One entry's effects, in application order.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEntry {
    /// The log entry the changes came from. Changes that share an `idx` are
    /// planned together, because they came from one entry and share its actor.
    pub idx: i64,
    pub effects: Vec<Effect>,
}

/// One entry's changes, with the entry's own identity.
#[derive(Debug, Clone)]
pub struct EntryChanges {
    pub idx: i64,
    /// Emission order within the entry; the changes are applied in it.
    pub changes: Vec<RecordChange>,
    pub actor: Did,
    pub event_id: String,
    pub order_stamp: String,
}

/// Plan a batch, reading the prior state its changes need.
pub fn plan_batch(
    conn: &Connection,
    stream_id: &space_core::SpaceDid,
    entries: &[EntryChanges],
    now_ms: i64,
) -> Result<Vec<PlannedEntry>, DbError> {
    let needed_rooms = rooms_needed(entries);
    let needed_parents = parents_needed(entries);
    let needed_calls = calls_needed(entries);

    let mut rooms = read_rooms(conn, &needed_rooms)?;
    let mut parents = read_canonical_parents(conn, &needed_parents)?;
    let mut calls = read_call_rooms(conn, &needed_calls)?;

    let mut planned: Vec<PlannedEntry> = Vec::new();
    for entry in entries {
        let mut effects: Vec<Effect> = Vec::new();
        for change in &entry.changes {
            let key = change.base().rkey.as_str().to_string();
            let mut ctx = RuleContext {
                stream_id: stream_id.clone(),
                is_backfill: false,
                actor: entry.actor.clone(),
                event_id: entry.event_id.clone(),
                prior_room: None,
                prior_parent: None,
                now_ms,
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

            effects.extend(space_core::plan(change, &ctx)?);
        }
        planned.push(PlannedEntry {
            idx: entry.idx,
            effects,
        });
    }
    Ok(planned)
}

fn rooms_needed(entries: &[EntryChanges]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        for change in &entry.changes {
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
        for change in &entry.changes {
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
        for change in &entry.changes {
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

/// Flatten a planned batch: every entry's statements first, then every entry's
/// derived steps, which is the order the TypeScript materialiser applies a
/// chunk in.
pub fn flatten(
    planned: &[PlannedEntry],
) -> (Vec<&space_core::SqlEffect>, Vec<&space_core::DerivedStep>) {
    let mut statements: Vec<&space_core::SqlEffect> = Vec::new();
    let mut steps: Vec<&space_core::DerivedStep> = Vec::new();
    for entry in planned {
        let (entry_statements, entry_steps) = crate::split(&entry.effects);
        statements.extend(entry_statements);
        steps.extend(entry_steps);
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
pub fn apply_plan(
    db: &mut crate::SpaceDb,
    planned: &[PlannedEntry],
) -> Result<Vec<space_core::SqlEffect>, DbError> {
    let (statements, steps) = flatten(planned);
    let mut globals = db.apply_statements(&statements)?;
    globals.extend(db.apply_steps(&steps)?);
    Ok(globals)
}
