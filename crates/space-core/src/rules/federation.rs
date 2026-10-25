//! Projection rules for the federation kinds: `federationRequest` and
//! `federationGrant`.
//!
//! Both live in the global DB — the relationship registry and the origin and
//! receiver grants — because they are cross-space facts: a request arrives on
//! the origin space's stream, while a receiver grant arrives on the receiving
//! space's stream and belongs to the origin space's record. Every statement here
//! is global rather than routed.
//!
//! A relationship is never removed from the set: a removal marks it `removed`,
//! which is why the record's delete is a status update. The decision instant is
//! the change's own: the time half of the entry's ordering stamp, which the log
//! assigned at ingest and a replay reproduces.

use crate::change::{
    ChangeBase, FederationGrantPatch, FederationRequestPatch, FederationRequestRecord, RecordChange,
};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};

pub fn request_create_effects(record: &FederationRequestRecord, ctx: &RuleContext) -> Vec<Effect> {
    vec![Effect::global(
        "insert into space_federations (
           space_id, federating_space_did, status,
           requested_by_did, requested_at, message
         )
         values (?, ?, 'pending', ?, ?, ?)
         on conflict(space_id, federating_space_did) do update set
           status = case
             when space_federations.status = 'removed' then 'pending'
             else space_federations.status
           end,
           requested_by_did = excluded.requested_by_did,
           requested_at = excluded.requested_at,
           message = excluded.message",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(&record.federating_space),
            Value::text(record.requested_by.as_str()),
            Value::Integer(ctx.decided_at_ms),
            Value::opt_text(record.message.clone()),
        ],
    )]
}

pub fn request_update_effects(
    base: &ChangeBase,
    patch: &FederationRequestPatch,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::global(
        "update space_federations set
           status = ?,
           decided_by_did = ?,
           decided_at = ?,
           decision_message = ?
         where space_id = ?
           and federating_space_did = ?
           and status = 'pending'",
        vec![
            Value::text(&patch.status),
            Value::text(patch.decided_by.as_str()),
            Value::Integer(ctx.decided_at_ms),
            Value::opt_text(patch.message.clone()),
            Value::text(ctx.stream_id.as_str()),
            Value::text(base.rkey.as_str()),
        ],
    )]
}

pub fn request_delete_effects(change: &RecordChange, ctx: &RuleContext) -> Vec<Effect> {
    // A removed relationship keeps its row so a later request can revive it.
    vec![Effect::global(
        "update space_federations set
           status = 'removed',
           decided_by_did = ?,
           decided_at = ?
         where space_id = ?
           and federating_space_did = ?",
        vec![
            Value::text(ctx.actor.as_str()),
            Value::Integer(ctx.decided_at_ms),
            Value::text(ctx.stream_id.as_str()),
            Value::text(change.base().rkey.as_str()),
        ],
    )]
}

/// The statements that apply one `federationGrant` change. The record's repo is
/// the origin space and its key the receiving space, whichever stream the event
/// arrived on.
pub fn grant_update_effects(
    base: &ChangeBase,
    patch: &FederationGrantPatch,
    _ctx: &RuleContext,
) -> Vec<Effect> {
    let origin = base.repo.as_str();
    let receiving = base.rkey.as_str();

    match patch {
        FederationGrantPatch::Origin { room, permission } => {
            let mut effects = vec![Effect::global(
                "delete from federation_room_permissions
                 where space_id = ? and federating_space_did = ? and room_id = ?",
                vec![
                    Value::text(origin),
                    Value::text(receiving),
                    Value::text(room),
                ],
            )];
            if let Some(permission) = permission {
                effects.push(Effect::global(
                    "insert into federation_room_permissions (
                       space_id, federating_space_did, room_id, permission
                     )
                     values (?, ?, ?, ?)",
                    vec![
                        Value::text(origin),
                        Value::text(receiving),
                        Value::text(room),
                        Value::text(permission),
                    ],
                ));
            }
            effects
        }
        FederationGrantPatch::Receiver {
            room,
            grantee,
            grantee_kind,
            permission,
        } => {
            let mut effects = vec![Effect::global(
                "delete from federation_receiver_permissions
                 where space_id = ? and federating_space_did = ? and room_id = ?
                   and grantee = ? and kind = ?",
                vec![
                    Value::text(origin),
                    Value::text(receiving),
                    Value::text(room),
                    Value::text(grantee),
                    Value::text(grantee_kind),
                ],
            )];
            if let Some(permission) = permission {
                effects.push(Effect::global(
                    "insert into federation_receiver_permissions (
                       space_id, federating_space_did, room_id, grantee, kind, permission
                     )
                     values (?, ?, ?, ?, ?, ?)",
                    vec![
                        Value::text(origin),
                        Value::text(receiving),
                        Value::text(room),
                        Value::text(grantee),
                        Value::text(grantee_kind),
                        Value::text(permission),
                    ],
                ));
            }
            effects
        }
    }
}

pub fn grant_delete_effects(change: &RecordChange) -> Vec<Effect> {
    let base = change.base();
    let origin = base.repo.as_str();
    let receiving = base.rkey.as_str();
    vec![
        Effect::global(
            "delete from federation_room_permissions
             where space_id = ? and federating_space_did = ?",
            vec![Value::text(origin), Value::text(receiving)],
        ),
        Effect::global(
            "delete from federation_receiver_permissions
             where space_id = ? and federating_space_did = ?",
            vec![Value::text(origin), Value::text(receiving)],
        ),
    ]
}
