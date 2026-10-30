//! Projection rules for the role kinds: `role`, `roleGrant` and
//! `roomPermission`.
//!
//! `role` is the `roles` row; a deleted role keeps its row with `deleted = 1`,
//! which every reader filters on, so the record's delete is that update.
//! `roleGrant` is one `member_roles` row keyed by the pair the rkey carries.
//! `roomPermission` is one `role_rooms` row, written as delete-then-insert
//! because a set is a removal followed by a presence, and cleared by its delete.

use crate::change::{
    ChangeBase, RecordChange, RoleGrantRecord, RolePatch, RoleRecord, RoomPermissionRecord,
};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};

/// A role's row, written as the create names it.
pub fn role_create_effects(
    base: &ChangeBase,
    record: &RoleRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::space(
        "insert or ignore into roles (id, stream_id, name, avatar, description)
         values (?, ?, ?, ?, ?)",
        vec![
            Value::text(base.rkey.as_str()),
            Value::text(ctx.stream_id.as_str()),
            Value::opt_text(record.name.clone()),
            Value::opt_text(record.avatar.clone()),
            Value::opt_text(record.description.clone()),
        ],
    )]
}

/// An update writes the fields it names, one statement per column.
pub fn role_update_effects(
    base: &ChangeBase,
    patch: &RolePatch,
    _ctx: &RuleContext,
) -> Vec<Effect> {
    let id = base.rkey.as_str();
    let mut effects: Vec<Effect> = Vec::new();
    if let Some(name) = &patch.name {
        effects.push(Effect::space(
            "update roles set name = ? where id = ?",
            vec![Value::opt_text(name.clone()), Value::text(id)],
        ));
    }
    if let Some(avatar) = &patch.avatar {
        effects.push(Effect::space(
            "update roles set avatar = ? where id = ?",
            vec![Value::opt_text(avatar.clone()), Value::text(id)],
        ));
    }
    if let Some(description) = &patch.description {
        effects.push(Effect::space(
            "update roles set description = ? where id = ?",
            vec![Value::opt_text(description.clone()), Value::text(id)],
        ));
    }
    effects
}

/// A deleted role keeps its row with `deleted = 1`, which every reader filters
/// on.
pub fn role_delete_effects(change: &RecordChange) -> Vec<Effect> {
    vec![Effect::space(
        "update roles set deleted = 1 where id = ?",
        vec![Value::text(change.base().rkey.as_str())],
    )]
}

/// A granted role: one `member_roles` row.
pub fn role_grant_create_effects(
    _base: &ChangeBase,
    record: &RoleGrantRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::space(
        "insert or ignore into member_roles (user_id, role_id, stream_id)
         values (?, ?, ?)",
        vec![
            Value::text(record.user.as_str()),
            Value::text(&record.role),
            Value::text(ctx.stream_id.as_str()),
        ],
    )]
}

/// A revoked grant: the `member_roles` row the pair names.
pub fn role_grant_delete_effects(change: &RecordChange) -> Vec<Effect> {
    let (user_id, role_id) = change.base().rkey.pair();
    vec![Effect::space(
        "delete from member_roles where user_id = ? and role_id = ?",
        vec![Value::text(user_id), Value::text(role_id)],
    )]
}

/// One room permission: the row is replaced, so an old permission cannot
/// survive a new one.
pub fn room_permission_effects(
    _base: &ChangeBase,
    record: &RoomPermissionRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![
        Effect::space(
            "delete from role_rooms where role_id = ? and room_id = ?",
            vec![Value::text(&record.role), Value::text(&record.room)],
        ),
        Effect::space(
            "insert into role_rooms (role_id, room_id, stream_id, permission)
             values (?, ?, ?, ?)",
            vec![
                Value::text(&record.role),
                Value::text(&record.room),
                Value::text(ctx.stream_id.as_str()),
                Value::text(&record.permission),
            ],
        ),
    ]
}

/// A cleared room permission: the `role_rooms` row the pair names.
pub fn room_permission_delete_effects(change: &RecordChange) -> Vec<Effect> {
    let (role_id, room_id) = change.base().rkey.pair();
    vec![Effect::space(
        "delete from role_rooms where role_id = ? and room_id = ?",
        vec![Value::text(role_id), Value::text(room_id)],
    )]
}
