//! Projection rules for the account and call kinds: `profile`, `calendarLink`
//! and `voiceCall`.
//!
//! `profile` writes the space-local copy of a user's profile — `comp_info` and,
//! when the bridge supplied one, the handle on `comp_user`. The global profile
//! store is not written by either path: profile hydration moved to read time, so
//! the materialiser's output is exactly these two local rows.
//!
//! `calendarLink` is the space's OpenMeet connection: an upsert while a group is
//! configured, a delete when the slug is cleared.
//!
//! `voiceCall` is one call's facts, which live in three tables: `active_calls`
//! and `call_participants` in the space, `voice_projected_calls` in the global
//! index the reconciler walks. A new call supersedes the participants recorded
//! for the previous one in its room.

use crate::change::{
    CalendarLinkRecord, ChangeBase, ProfilePatch, ProfileRecord, RecordChange, VoiceCallPatch,
    VoiceCallRecord,
};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::rules::{ensure_entity, RuleError};

/// The three `comp_info` fields a profile writes, whichever op carried them.
pub struct ProfileFields<'a> {
    pub name: Option<Option<&'a str>>,
    pub avatar: Option<Option<&'a str>>,
    pub description: Option<Option<&'a str>>,
    pub handle: Option<&'a str>,
}

impl<'a> ProfileFields<'a> {
    pub fn from_record(record: &'a ProfileRecord) -> Self {
        Self {
            name: Some(record.name.as_deref()),
            avatar: Some(record.avatar.as_deref()),
            description: Some(record.description.as_deref()),
            handle: record.handle.as_deref(),
        }
    }

    pub fn from_patch(patch: &'a ProfilePatch) -> Self {
        Self {
            name: patch.name.as_ref().map(|value| value.as_deref()),
            avatar: patch.avatar.as_ref().map(|value| value.as_deref()),
            description: patch.description.as_ref().map(|value| value.as_deref()),
            handle: patch.handle.as_deref(),
        }
    }
}

fn text_of(value: &Option<Option<&str>>) -> Value {
    match value {
        Some(Some(text)) => Value::text(*text),
        Some(None) => Value::Null,
        None => Value::Null,
    }
}

pub fn profile_effects(
    base: &ChangeBase,
    fields: &ProfileFields<'_>,
    ctx: &RuleContext,
) -> Vec<Effect> {
    let subject = base.repo.as_str();
    let mut effects = vec![ensure_entity(&ctx.stream_id, subject, None)];

    let mut wrote_info = false;
    if fields.name.is_some() {
        effects.push(Effect::space(
            "insert into comp_info (entity, name) values (?, ?)
             on conflict(entity) do update set name = excluded.name",
            vec![Value::text(subject), text_of(&fields.name)],
        ));
        wrote_info = true;
    }
    if fields.avatar.is_some() {
        effects.push(Effect::space(
            "insert into comp_info (entity, avatar) values (?, ?)
             on conflict(entity) do update set avatar = excluded.avatar",
            vec![Value::text(subject), text_of(&fields.avatar)],
        ));
        wrote_info = true;
    }
    if fields.description.is_some() {
        effects.push(Effect::space(
            "insert into comp_info (entity, description) values (?, ?)
             on conflict(entity) do update set description = excluded.description",
            vec![Value::text(subject), text_of(&fields.description)],
        ));
        wrote_info = true;
    }
    let _ = wrote_info;

    if let Some(handle) = fields.handle {
        effects.push(Effect::space(
            "insert into comp_user (did, handle) values (?, ?)
             on conflict(did) do update set handle = ?",
            vec![
                Value::text(subject),
                Value::text(handle),
                Value::text(handle),
            ],
        ));
    }
    effects
}

pub fn calendar_link_effects(
    _base: &ChangeBase,
    record: &CalendarLinkRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    vec![Effect::space(
        "insert or replace into comp_calendar_link (entity, group_slug, tenant_id, api_url)
         values (?, ?, ?, ?)",
        vec![
            Value::text(ctx.stream_id.as_str()),
            Value::text(&record.group_slug),
            Value::text(&record.tenant_id),
            Value::text(&record.api_url),
        ],
    )]
}

pub fn calendar_link_delete_effects(ctx: &RuleContext) -> Vec<Effect> {
    vec![Effect::space(
        "delete from comp_calendar_link where entity = ?",
        vec![Value::text(ctx.stream_id.as_str())],
    )]
}

pub fn call_create_effects(
    base: &ChangeBase,
    record: &VoiceCallRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    let call_id = base.rkey.as_str();
    let room = record.room.as_str();
    vec![
        Effect::space(
            "insert into active_calls (room_id, call_id, started_at, source)
             values (?, ?, ?, ?)
             on conflict (room_id) do update set
               started_at = excluded.started_at,
               source = excluded.source",
            vec![
                Value::text(room),
                Value::text(call_id),
                Value::Integer(record.started_at),
                Value::text(&record.source),
            ],
        ),
        // A new call supersedes every participant recorded for the previous
        // one in the same room.
        Effect::space(
            "delete from call_participants where room_id = ? and call_id != ?",
            vec![Value::text(room), Value::text(call_id)],
        ),
        Effect::global(
            "insert into voice_projected_calls (room_id, space_id, call_id, started_at)
             values (?, ?, ?, ?)
             on conflict (room_id) do update set
               space_id = excluded.space_id,
               call_id = excluded.call_id,
               started_at = excluded.started_at",
            vec![
                Value::text(room),
                Value::text(ctx.stream_id.as_str()),
                Value::text(call_id),
                Value::Integer(record.started_at),
            ],
        ),
    ]
}

pub fn call_update_effects(
    base: &ChangeBase,
    patch: &VoiceCallPatch,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    let call_id = base.rkey.as_str();
    let room = ctx.prior_room.clone().ok_or_else(|| RuleError::Invalid {
        kind: "voiceCall",
        message: format!("no room for call {call_id}"),
    })?;

    if let Some(joined) = &patch.joined {
        // The join instant is the entry's own ULID time, which is why the feed
        // carries the event id.
        let joined_at = crate::time::ulid_time_ms(&ctx.event_id).unwrap_or(0);
        return Ok(vec![Effect::space(
            "insert into call_participants (room_id, did, call_id, joined_at, source)
             values (?, ?, ?, ?, ?)
             on conflict (room_id, did) do update set
               call_id = excluded.call_id,
               joined_at = excluded.joined_at,
               source = excluded.source",
            vec![
                Value::text(&room),
                Value::text(joined.as_str()),
                Value::text(call_id),
                Value::Integer(joined_at),
                Value::text(&patch.source),
            ],
        )]);
    }

    let left = patch.left.as_ref().ok_or_else(|| RuleError::Invalid {
        kind: "voiceCall",
        message: "a call fact joins or leaves".to_string(),
    })?;
    Ok(vec![Effect::space(
        "delete from call_participants
         where room_id = ? and did = ? and call_id = ?",
        vec![
            Value::text(&room),
            Value::text(left.as_str()),
            Value::text(call_id),
        ],
    )])
}

pub fn call_delete_effects(
    change: &RecordChange,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    let call_id = change.base().rkey.as_str();
    let room = ctx.prior_room.clone().ok_or_else(|| RuleError::Invalid {
        kind: "voiceCall",
        message: format!("no room for call {call_id}"),
    })?;
    Ok(vec![
        Effect::space(
            "delete from active_calls where room_id = ? and call_id = ?",
            vec![Value::text(&room), Value::text(call_id)],
        ),
        Effect::space(
            "delete from call_participants where room_id = ? and call_id = ?",
            vec![Value::text(&room), Value::text(call_id)],
        ),
        Effect::global(
            "delete from voice_projected_calls where room_id = ? and call_id = ?",
            vec![Value::text(&room), Value::text(call_id)],
        ),
    ])
}
