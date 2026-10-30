//! Projection rules for the membership kinds: `membership`, `ban` and `invite`.
//!
//! Membership is a pair of `member`/`admin` edges in the space's DB and a
//! `joinedSpace`/`leftSpace` pair in the global one, plus — for a join — the
//! system message announcing it. The message is keyed by the join event's id and
//! lands in the space's first channel, so both come from the planner's context
//! rather than from the record.
//!
//! A rejoin keeps the admin bit through the member edge's own subquery, not
//! through the record's `can`: `joinSpace` always carries `post`, and the
//! projection's rule is "an existing `admin` edge wins".

use crate::change::{
    BanRecord, ChangeBase, InviteRecord, MembershipPatch, MembershipRecord, RecordChange,
};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::rules;

/// A join: the member edge, the global `joinedSpace` edge, and the system
/// message announcing it in the space's first live channel.
pub fn join_effects(
    _base: &ChangeBase,
    record: &MembershipRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    let user = record.user.as_str();
    let stream = ctx.stream_id.as_str();
    vec![
        rules::ensure_entity(&ctx.stream_id, user, None, ctx.decided_at_ms),
        rules::ensure_entity(&ctx.stream_id, stream, None, ctx.decided_at_ms),
        Effect::global(
            "insert or ignore into edges (head, tail, label, created_at, updated_at)
             values (?, ?, 'joinedSpace', ?, ?)",
            vec![
                Value::text(user),
                Value::text(stream),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
        Effect::global(
            "delete from edges where head = ? and tail = ? and label = 'leftSpace'",
            vec![Value::text(user), Value::text(stream)],
        ),
        Effect::space(
            "insert into edges (head, tail, label, payload, created_at, updated_at)
             select
               ?, ?,
               'member',
               case when exists (
                 select 1 from edges where head = ? and tail = ? and label = 'admin'
               ) then '{\"can\":\"admin\"}' else '{\"can\":\"post\"}' end,
               ?, ?
             where not exists (
               select 1 from edges where head = ? and tail = ? and label = 'member'
             )",
            vec![
                Value::text(stream),
                Value::text(user),
                Value::text(stream),
                Value::text(user),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
                Value::text(stream),
                Value::text(user),
            ],
        ),
        // The announcement: an entity in the space's first live channel, an
        // author edge on the space, and a markdown body naming the joiner.
        Effect::space(
            "insert into entities (id, stream_id, room, created_at, updated_at)
             values (
               ?, ?,
               (
                 select entity
                   from comp_room join entities e on e.id = entity
                   where label = 'space.roomy.channel' and deleted = 0 and e.stream_id = ?
                   order by entity
                   limit 1
               ),
               ?, ?
             ) on conflict do nothing",
            vec![
                Value::text(&ctx.event_id),
                Value::text(stream),
                Value::text(stream),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
        Effect::space(
            "insert or replace into edges (head, tail, label, created_at, updated_at)
             select ?, ?, 'author', ?, ?",
            vec![
                Value::text(&ctx.event_id),
                Value::text(stream),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
        Effect::space(
            "insert or replace into comp_content (
               entity, mime_type, data, last_edit, created_at, updated_at
             )
             values (
               ?,
               'text/markdown',
               cast(('[@' || ? || '](/user/' || ? || ') joined the space.') as blob),
               ?,
               ?,
               ?
             )",
            vec![
                Value::text(&ctx.event_id),
                Value::text(user),
                Value::text(user),
                Value::text(&ctx.event_id),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
    ]
}

/// `addAdmin`/`removeAdmin`: the member edge carries the admin bit, and the
/// durable admin edge appears or goes.
pub fn admin_effects(base: &ChangeBase, patch: &MembershipPatch, ctx: &RuleContext) -> Vec<Effect> {
    let stream = ctx.stream_id.as_str();
    let user = base.rkey.as_str();
    if patch.can == "admin" {
        return vec![
            rules::ensure_entity(&ctx.stream_id, stream, None, ctx.decided_at_ms),
            rules::ensure_entity(&ctx.stream_id, user, None, ctx.decided_at_ms),
            Effect::space(
                "insert or replace into edges (head, tail, label, payload, created_at, updated_at)
                 values (?, ?, 'member', '{\"can\":\"admin\"}', ?, ?)",
                vec![
                    Value::text(stream),
                    Value::text(user),
                    Value::Integer(ctx.decided_at_ms),
                    Value::Integer(ctx.decided_at_ms),
                ],
            ),
            Effect::space(
                "insert or ignore into edges (head, tail, label, created_at, updated_at)
                 values (?, ?, 'admin', ?, ?)",
                vec![
                    Value::text(stream),
                    Value::text(user),
                    Value::Integer(ctx.decided_at_ms),
                    Value::Integer(ctx.decided_at_ms),
                ],
            ),
        ];
    }
    vec![
        Effect::space(
            "update edges set payload = '{\"can\":\"post\"}'
             where head = ? and tail = ? and label = 'member'",
            vec![Value::text(stream), Value::text(user)],
        ),
        Effect::space(
            "delete from edges where head = ? and tail = ? and label = 'admin'",
            vec![Value::text(stream), Value::text(user)],
        ),
    ]
}

/// A leave: the member edge goes, the global membership edge goes, and the leave
/// marker stays so the space still lists for the user as one they left.
pub fn leave_effects(change: &RecordChange, ctx: &RuleContext) -> Vec<Effect> {
    let user = change.base().rkey.as_str();
    let stream = ctx.stream_id.as_str();
    vec![
        Effect::space(
            "delete from edges where head = ? and tail = ? and label = 'member'",
            vec![Value::text(stream), Value::text(user)],
        ),
        Effect::global(
            "delete from edges where head = ? and tail = ? and label = 'joinedSpace'",
            vec![Value::text(user), Value::text(stream)],
        ),
        Effect::global(
            "insert or ignore into edges (head, tail, label, created_at, updated_at)
             values (?, ?, 'leftSpace', ?, ?)",
            vec![
                Value::text(user),
                Value::text(stream),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
    ]
}

/// A ban: the row `comp_bans` keeps for the user.
pub fn ban_create_effects(
    _base: &ChangeBase,
    record: &BanRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::space(
        "insert into comp_bans (entity, user_did, created_at) values (?, ?, ?)",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(record.user.as_str()),
            Value::Integer(ctx.decided_at_ms),
        ],
    )]
}

/// A lifted ban: the `comp_bans` row the ban wrote.
pub fn ban_delete_effects(change: &RecordChange, ctx: &RuleContext) -> Vec<Effect> {
    vec![Effect::space(
        "delete from comp_bans where entity = ? and user_did = ?",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(change.base().rkey.as_str()),
        ],
    )]
}

/// An invite: the token row, keyed by the space, with the event that minted
/// it.
pub fn invite_create_effects(
    _base: &ChangeBase,
    record: &InviteRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::space(
        "insert or ignore into comp_invite (
           entity, token, created_by_did, event_ulid, created_at
         )
         values (?, ?, ?, ?, ?)",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(&record.token),
            Value::text(record.created_by.as_str()),
            Value::text(&ctx.event_id),
            Value::Integer(ctx.decided_at_ms),
        ],
    )]
}

/// A revoked invite: the token row.
pub fn invite_delete_effects(change: &RecordChange, ctx: &RuleContext) -> Vec<Effect> {
    vec![Effect::space(
        "delete from comp_invite where entity = ? and token = ?",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(change.base().rkey.as_str()),
        ],
    )]
}
