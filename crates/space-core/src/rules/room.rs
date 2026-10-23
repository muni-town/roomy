//! Projection rules for the `room` kind.
//!
//! A room is created by `createRoom`, patched by `updateRoom` and the
//! soft-delete/restore pair, and linked from a parent room by the room-link
//! pair. A room is never removed from the set: a deleted room keeps its row with
//! `deleted = 1`, which is what the client's deleted-rooms list reads.
//!
//! `parent` is a `link` edge, not a column: `roomAccess` resolves a thread's
//! access through the edge whose payload marks it canonical, so the rule writes
//! the same edge shape the event materialiser does. An unlink names only the
//! room it unlinks, so the edge it removes is the parent the planner read.

use crate::change::{ChangeBase, RoomPatch, RoomRecord};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::rules::ensure_entity;

pub fn create_effects(base: &ChangeBase, record: &RoomRecord, ctx: &RuleContext) -> Vec<Effect> {
    let id = base.rkey.as_str();
    let mut effects = vec![
        ensure_entity(&ctx.stream_id, id, None),
        Effect::space(
            "insert into comp_info (entity, name, avatar, description)
             values (?, ?, ?, ?)
             on conflict do nothing",
            vec![
                Value::text(id),
                Value::opt_text(record.name.clone()),
                Value::opt_text(record.avatar.clone()),
                Value::opt_text(record.description.clone()),
            ],
        ),
        Effect::space(
            "insert into comp_room (entity, label, default_access)
             values (?, ?, ?)
             on conflict do nothing",
            vec![
                Value::text(id),
                Value::text(&record.kind),
                Value::opt_text(record.default_access.clone()),
            ],
        ),
    ];

    if let Some(origin) = &record.discord_origin {
        effects.push(Effect::space(
            "insert or ignore into comp_discord_origin (entity, snowflake, guild_id)
             values (?, ?, ?)",
            vec![
                Value::text(id),
                Value::text(&origin.snowflake),
                Value::text(&origin.guild_id),
            ],
        ));
    }
    effects
}

/// A patch writes only the fields it carries, in the event path's order: the
/// kind, the access level, the basic info, the soft-delete bit, the parent.
pub fn update_effects(base: &ChangeBase, patch: &RoomPatch, ctx: &RuleContext) -> Vec<Effect> {
    let id = base.rkey.as_str();
    let mut effects: Vec<Effect> = Vec::new();

    if let Some(kind) = &patch.kind {
        effects.push(Effect::space(
            "update comp_room set label = ? where entity = ?",
            vec![Value::text(kind), Value::text(id)],
        ));
    }
    if let Some(access) = &patch.default_access {
        effects.push(Effect::space(
            "update comp_room set default_access = ? where entity = ?",
            vec![Value::text(access), Value::text(id)],
        ));
    }

    effects.extend(info_effects(id, patch));

    if let Some(deleted) = patch.deleted {
        effects.push(Effect::space(
            "update comp_room set deleted = ? where entity = ?",
            vec![Value::flag(deleted), Value::text(id)],
        ));
    }
    if let Some(parent) = &patch.parent {
        effects.extend(parent_effects(id, parent.as_deref(), ctx));
    }
    effects
}

/// The `comp_info` fields a patch carries.
///
/// One statement per present field rather than one statement with a dynamic
/// column list: the rows it leaves behind are the same, and a fixed statement
/// is what this crate can hand to an executor.
fn info_effects(id: &str, patch: &RoomPatch) -> Vec<Effect> {
    let mut effects: Vec<Effect> = Vec::new();
    // Written out per column so each statement is fixed.
    if let Some(name) = &patch.name {
        effects.push(Effect::space(
            "insert into comp_info (entity, name) values (?, ?)
             on conflict(entity) do update set name = excluded.name",
            vec![Value::text(id), Value::opt_text(name.clone())],
        ));
    }
    if let Some(avatar) = &patch.avatar {
        effects.push(Effect::space(
            "insert into comp_info (entity, avatar) values (?, ?)
             on conflict(entity) do update set avatar = excluded.avatar",
            vec![Value::text(id), Value::opt_text(avatar.clone())],
        ));
    }
    if let Some(description) = &patch.description {
        effects.push(Effect::space(
            "insert into comp_info (entity, description) values (?, ?)
             on conflict(entity) do update set description = excluded.description",
            vec![Value::text(id), Value::opt_text(description.clone())],
        ));
    }
    effects
}

/// The `link` edge a parent write maintains. A link records whether it is the
/// room's canonical parent at the instant it is written, and "first link wins"
/// is why the insert does nothing on conflict: re-evaluating the count on a
/// replay would flip the payload of the link that is already there.
fn parent_effects(room_id: &str, parent: Option<&str>, ctx: &RuleContext) -> Vec<Effect> {
    match parent {
        None => match &ctx.prior_parent {
            None => vec![Effect::space(
                "delete from edges where label = 'link' and tail = ?",
                vec![Value::text(room_id)],
            )],
            Some(prior) => vec![Effect::space(
                "delete from edges where label = 'link' and head = ? and tail = ?",
                vec![Value::text(prior), Value::text(room_id)],
            )],
        },
        Some(parent) => vec![Effect::space(
            "insert into edges (head, tail, label, payload)
             values (
               ?, ?, 'link',
               json_object('canonical_parent', (
                 SELECT COUNT(*) = 0
                 FROM edges
                 WHERE head = ? AND tail = ? AND label = 'link'
               ))
             )
             on conflict (head, tail, label) do nothing",
            vec![
                Value::text(parent),
                Value::text(room_id),
                Value::text(parent),
                Value::text(room_id),
            ],
        )],
    }
}

/// `room_access` maintenance: a room change rewrites the space's projection,
/// because the row it writes names the room's parent.
pub fn room_access_step(ctx: &RuleContext) -> Effect {
    if ctx.is_backfill {
        Effect::space(
            "delete from room_access where space_id = ?",
            vec![Value::text(ctx.stream_id.as_str())],
        )
    } else {
        Effect::space(
            "insert into room_access (room_id, space_id, parent_channel_id)
             select e.id,
                    e.stream_id,
                    p.head
               from entities e
               join comp_room cr on cr.entity = e.id
               left join edges p
                      on p.tail = e.id
                     and p.label = 'link'
                     and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
              where e.stream_id = ?
             on conflict (room_id) do update set
               space_id = excluded.space_id,
               parent_channel_id = excluded.parent_channel_id",
            vec![Value::text(ctx.stream_id.as_str())],
        )
    }
}
