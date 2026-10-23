//! The projection rules: one per record kind, one entry point.
//!
//! `plan(change, ctx)` is what a worker calls. It is a pure function of the
//! change, the context and the record's own bytes: nothing here reads a clock
//! the log did not determine (the two federation instants are the documented
//! exception) and nothing reaches outside the crate.

mod account;
mod attachments;
mod federation;
mod membership;
mod message;
mod permission;
mod reaction;
mod room;
mod space_config;

use crate::change::{RecordChange, RecordKind, RecordPatch};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::ids::SpaceDid;

/// A change that cannot be planned.
#[derive(Debug, thiserror::Error)]
pub enum RuleError {
    #[error("no projection rule for {0}")]
    NoRule(String),
    #[error("{kind}: {message}")]
    Invalid { kind: &'static str, message: String },
    #[error("{0} has no delete")]
    NotImplemented(String),
}

/// The effects that apply one change, in application order.
pub fn plan(change: &RecordChange, ctx: &RuleContext) -> Result<Vec<Effect>, RuleError> {
    let mut effects = match change {
        RecordChange::Create { base, record } => create_effects(base.kind, base, record, ctx)?,
        RecordChange::Update { base, patch } => update_effects(base.kind, base, patch, ctx)?,
        RecordChange::Delete { base } => delete_effects(base.kind, change, ctx)?,
    };
    // The per-space projection each entry maintains, after the kind's own
    // statements: `room_activity` for a message, `room_access` for a room.
    match change.kind() {
        RecordKind::Message => {
            if let Some(step) = message::activity_step(change, ctx) {
                effects.push(step);
            }
            effects.extend(
                message::derived_steps(change, ctx)
                    .into_iter()
                    .map(Effect::Step),
            );
        }
        RecordKind::Room => effects.push(room::room_access_step(ctx)),
        _ => {}
    }
    index_created_entities(&mut effects);
    Ok(effects)
}

/// Every entity a rule creates is also indexed by the space that owns it, in
/// the global DB.
///
/// The write path derives that from the statement's text, and the effect layer
/// names it there so the global half of a change sits in the same list as the
/// space half. The same rule applies here: an `insert into entities` bound with
/// `(id, stream_id, …)` indexes the entity. A link entity carries an empty
/// stream id and is indexed by its message instead, so it is skipped.
fn index_created_entities(effects: &mut Vec<Effect>) {
    const ENTITY_SPACE: &str =
        "insert or ignore into entity_space (entity_id, space_did) values (?, ?)";

    let mut extra: Vec<Effect> = Vec::new();
    for effect in effects.iter() {
        let Effect::Sql(statement) = effect else {
            continue;
        };
        if statement.target != crate::effects::Target::Space {
            continue;
        }
        if !statement
            .sql
            .trim_start()
            .starts_with("insert into entities")
        {
            continue;
        }
        match (statement.params.first(), statement.params.get(1)) {
            (Some(Value::Text(id)), Some(Value::Text(stream))) if !stream.is_empty() => {
                extra.push(Effect::global(
                    ENTITY_SPACE,
                    vec![Value::Text(id.clone()), Value::Text(stream.clone())],
                ));
            }
            _ => {}
        }
    }
    effects.extend(extra);
}

fn create_effects(
    kind: RecordKind,
    base: &crate::change::ChangeBase,
    record: &crate::change::RecordBody,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    use crate::change::RecordBody as B;
    let effects = match (kind, record) {
        (RecordKind::Message, B::Message(record)) => message::create_effects(base, record, ctx)?,
        (RecordKind::Reaction, B::Reaction(record)) => reaction::create_effects(base, record, ctx),
        (RecordKind::Room, B::Room(record)) => room::create_effects(base, record, ctx),
        (RecordKind::SpaceInfo, B::SpaceInfo(record)) => {
            space_config::space_info_effects(record.clone(), ctx)
        }
        (RecordKind::SpaceSidebar, B::SpaceSidebar(record)) => {
            space_config::space_sidebar_effects(record, ctx)
        }
        (RecordKind::Membership, B::Membership(record)) => {
            membership::join_effects(base, record, ctx)
        }
        (RecordKind::Ban, B::Ban(record)) => membership::ban_create_effects(base, record, ctx),
        (RecordKind::Invite, B::Invite(record)) => {
            membership::invite_create_effects(base, record, ctx)
        }
        (RecordKind::Role, B::Role(record)) => permission::role_create_effects(base, record, ctx),
        (RecordKind::RoleGrant, B::RoleGrant(record)) => {
            permission::role_grant_create_effects(base, record, ctx)
        }
        (RecordKind::RoomPermission, B::RoomPermission(record)) => {
            permission::room_permission_effects(base, record, ctx)
        }
        (RecordKind::FederationRequest, B::FederationRequest(record)) => {
            federation::request_create_effects(record, ctx)
        }
        (RecordKind::FederationGrant, B::FederationGrant(_)) => {
            return Err(RuleError::Invalid {
                kind: "federationGrant",
                message: "a grant is created by an update".to_string(),
            })
        }
        (RecordKind::Profile, B::Profile(record)) => {
            account::profile_effects(base, &account::ProfileFields::from_record(record), ctx)
        }
        (RecordKind::CalendarLink, B::CalendarLink(record)) => {
            account::calendar_link_effects(base, record, ctx)
        }
        (RecordKind::VoiceCall, B::VoiceCall(record)) => {
            account::call_create_effects(base, record, ctx)
        }
        _ => {
            return Err(RuleError::Invalid {
                kind: kind.name(),
                message: "record body does not match its kind".to_string(),
            })
        }
    };
    Ok(effects)
}

fn update_effects(
    kind: RecordKind,
    base: &crate::change::ChangeBase,
    patch: &RecordPatch,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    use crate::change::RecordPatch as P;
    let effects = match (kind, patch) {
        (RecordKind::Message, P::Message(patch)) => message::update_effects(base, patch, ctx)?,
        (RecordKind::Room, P::Room(patch)) => room::update_effects(base, patch, ctx),
        (RecordKind::SpaceInfo, P::SpaceInfo(patch)) => {
            space_config::space_info_effects(patch.clone(), ctx)
        }
        (RecordKind::SpaceSidebar, P::SpaceSidebar(patch)) => {
            space_config::space_sidebar_effects(patch, ctx)
        }
        (RecordKind::Membership, P::Membership(patch)) => {
            membership::admin_effects(base, patch, ctx)
        }
        (RecordKind::Role, P::Role(patch)) => permission::role_update_effects(base, patch, ctx),
        (RecordKind::RoomPermission, P::RoomPermission(patch)) => {
            permission::room_permission_effects(base, patch, ctx)
        }
        (RecordKind::FederationRequest, P::FederationRequest(patch)) => {
            federation::request_update_effects(base, patch, ctx)
        }
        (RecordKind::FederationGrant, P::FederationGrant(patch)) => {
            federation::grant_update_effects(base, patch, ctx)
        }
        (RecordKind::Profile, P::Profile(patch)) => {
            account::profile_effects(base, &account::ProfileFields::from_patch(patch), ctx)
        }
        (RecordKind::CalendarLink, P::CalendarLink(patch)) => {
            account::calendar_link_effects(base, patch, ctx)
        }
        (RecordKind::VoiceCall, P::VoiceCall(patch)) => {
            account::call_update_effects(base, patch, ctx)?
        }
        _ => {
            return Err(RuleError::Invalid {
                kind: kind.name(),
                message: "the kind carries no such update".to_string(),
            })
        }
    };
    Ok(effects)
}

fn delete_effects(
    kind: RecordKind,
    change: &RecordChange,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    let effects = match kind {
        RecordKind::Message => message::delete_effects(change),
        RecordKind::Reaction => reaction::delete_effects(change),
        RecordKind::Membership => membership::leave_effects(change, ctx),
        RecordKind::Ban => membership::ban_delete_effects(change, ctx),
        RecordKind::Invite => membership::invite_delete_effects(change, ctx),
        RecordKind::Role => permission::role_delete_effects(change),
        RecordKind::RoleGrant => permission::role_grant_delete_effects(change),
        RecordKind::RoomPermission => permission::room_permission_delete_effects(change),
        RecordKind::FederationRequest => federation::request_delete_effects(change, ctx),
        RecordKind::FederationGrant => federation::grant_delete_effects(change),
        RecordKind::VoiceCall => account::call_delete_effects(change, ctx)?,
        RecordKind::CalendarLink => account::calendar_link_delete_effects(ctx),
        RecordKind::Room => {
            return Err(RuleError::Invalid {
                kind: "room",
                message: "a room is never deleted".to_string(),
            })
        }
        RecordKind::SpaceInfo | RecordKind::SpaceSidebar | RecordKind::Profile => {
            return Err(RuleError::NotImplemented(kind.name().to_string()))
        }
    };
    Ok(effects)
}

/// The statement every rule uses to make sure an entity row exists.
///
/// `created_at` is the entity's own ULID time, or the derivation instant for an
/// id that is not a ULID (a URL, a DID) — a clock column, so not a value any
/// two derivations are compared on.
pub(crate) fn ensure_entity(stream_id: &SpaceDid, entity_id: &str, room: Option<&str>) -> Effect {
    let created_at = crate::time::ulid_time_ms(entity_id).unwrap_or(0);
    ensure_entity_at(stream_id, entity_id, room, created_at)
}

pub(crate) fn ensure_entity_at(
    stream_id: &SpaceDid,
    entity_id: &str,
    room: Option<&str>,
    created_at: i64,
) -> Effect {
    Effect::space(
        "insert into entities (id, stream_id, room, created_at)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           room = coalesce(entities.room, excluded.room),
           updated_at = case
             when entities.room is null and excluded.room is not null
             then excluded.updated_at
             else entities.updated_at
           end",
        vec![
            Value::text(entity_id),
            Value::text(stream_id.as_str()),
            Value::opt_text(room),
            Value::Integer(created_at),
        ],
    )
}
