//! Projection rules for the `message` kind.
//!
//! `create` and `update` are upserts, `delete` is a removal from the set. Two
//! things the event materialiser did are deliberately not here: a delete
//! records nothing — the room's window and summary are recomputed from the rows
//! that remain — and an edit replaces the content with the body the record
//! carries, because nothing produces a `text/x-dmp-patch` body and no such SQL
//! function exists.

use roomy_events::Did;

use crate::change::{
    ChangeBase, MessagePatch, MessageRecord, RecordBody, RecordChange, RecordPatch,
};
use crate::context::RuleContext;
use crate::effects::{DerivedStep, Effect, Value};
use crate::ids::OrderStamp;
use crate::links::{self, RICHTEXT_MIME};
use crate::rules::{self, attachments, RuleError};

/// The extension a bridged message carries its canonical send time under.
const TIMESTAMP_OVERRIDE: &str = "space.roomy.extension.timestampOverride.v0";

/// A message's canonical send time: the bridged override when there is one,
/// else the message id's own ULID time. It is not the sort key — that is the
/// stamp — and it is what the timeline renders and the feed orders by.
#[must_use]
pub fn canonical_send_time(id: &str, record: &MessageRecord) -> i64 {
    if let Some(timestamp) = record
        .extensions
        .as_ref()
        .and_then(|e| e.get(TIMESTAMP_OVERRIDE))
        .and_then(|e| e.get("timestamp"))
        .and_then(|t| t.as_i64())
    {
        return timestamp;
    }
    crate::time::ulid_time_ms(id).unwrap_or(0)
}

/// A new message: its content, its author edge, its attachments and its
/// ordering key — or, for a system message, the link announcement it renders.
pub fn create_effects(
    base: &ChangeBase,
    record: &MessageRecord,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    if record.system.is_some() {
        return system_link_effects(base, record, ctx);
    }

    let id = base.rkey.as_str();
    let mut effects = vec![rules::ensure_entity(
        &ctx.stream_id,
        id,
        Some(&record.room),
        ctx.decided_at_ms,
    )];

    if let Some(forward_of) = &record.forward_of {
        for target in forward_of {
            effects.push(Effect::space(
                "insert or ignore into edges (head, tail, label, created_at, updated_at)
                 select ?, ?, 'forward', ?, ?
                 where exists (select 1 from entities where id = ?)",
                vec![
                    Value::text(id),
                    Value::text(target),
                    Value::Integer(ctx.decided_at_ms),
                    Value::Integer(ctx.decided_at_ms),
                    Value::text(target),
                ],
            ));
        }
        effects.push(ordering_key(id, &base.order_stamp));
        return Ok(effects);
    }

    let content = record.content.as_ref().ok_or_else(|| RuleError::Invalid {
        kind: "message",
        message: "a message record carries content, a system text or a forward".to_string(),
    })?;

    effects.push(Effect::space(
        "insert or replace into comp_content (
           entity, mime_type, data, last_edit, timestamp, created_at, updated_at
         )
         values (?, ?, ?, ?, ?, ?, ?)",
        vec![
            Value::text(id),
            Value::text(&content.mime_type),
            Value::Blob(content.data.clone()),
            Value::text(id),
            Value::Integer(canonical_send_time(id, record)),
            Value::Integer(ctx.decided_at_ms),
            Value::Integer(ctx.decided_at_ms),
        ],
    ));
    // The author is the record's own: a bridged message is attributed to the
    // author the bridge overrode, which is the DID the record carries.
    effects.push(rules::ensure_entity(
        &ctx.stream_id,
        record.author.as_str(),
        None,
        ctx.decided_at_ms,
    ));
    effects.push(Effect::space(
        "insert or replace into edges (head, tail, label, created_at, updated_at)
         select ?, ?, 'author', ?, ?",
        vec![
            Value::text(id),
            Value::text(record.author.as_str()),
            Value::Integer(ctx.decided_at_ms),
            Value::Integer(ctx.decided_at_ms),
        ],
    ));
    effects.extend(attachments::attachment_effects(
        &ctx.stream_id,
        id,
        &attachments::attachments_of(record.extensions.as_ref()),
        ctx.decided_at_ms,
    ));
    effects.push(ordering_key(id, &base.order_stamp));
    Ok(effects)
}

/// A link announcement: an entity in the linking room, an author edge on the
/// space, and the markdown the event path renders from the linked room's
/// current name. No ordering key — the event path never stamped one.
fn system_link_effects(
    base: &ChangeBase,
    record: &MessageRecord,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    let link = record.system.as_ref().ok_or_else(|| RuleError::Invalid {
        kind: "message",
        message: "a system message names its link".to_string(),
    })?;
    let actor: &Did = record.actor.as_ref().ok_or_else(|| RuleError::Invalid {
        kind: "message",
        message: "a system message names its actor".to_string(),
    })?;
    let id = base.rkey.as_str();

    Ok(vec![
        Effect::space(
            "insert into entities (id, stream_id, room, created_at, updated_at)
             values (?, ?, ?, ?, ?) on conflict do nothing",
            vec![
                Value::text(id),
                Value::text(ctx.stream_id.as_str()),
                Value::text(&record.room),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
        Effect::space(
            "insert or ignore into edges (head, tail, label, created_at, updated_at)
             select ?, ?, 'author', ?, ?",
            vec![
                Value::text(id),
                Value::text(ctx.stream_id.as_str()),
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
               cast((
                 '[@' || ? || '](/user/' || ? || ') '
                 || ?
                 || coalesce((select name from comp_info where entity = ?), 'this room')
                 || '](' || ? || '?parent=' || ? || ').'
               ) as blob),
               ?,
               ?,
               ?
             )",
            vec![
                Value::text(id),
                Value::text(actor.as_str()),
                Value::text(actor.as_str()),
                Value::text(if link.is_creation_link {
                    "created ["
                } else {
                    "linked to ["
                }),
                Value::text(&link.link_to_room),
                Value::text(&link.link_to_room),
                Value::text(&record.room),
                Value::text(id),
                Value::Integer(ctx.decided_at_ms),
                Value::Integer(ctx.decided_at_ms),
            ],
        ),
    ])
}

/// An update is a content replacement (edit) or a room rewrite (move).
pub fn update_effects(
    base: &ChangeBase,
    patch: &MessagePatch,
    ctx: &RuleContext,
) -> Result<Vec<Effect>, RuleError> {
    let id = base.rkey.as_str();

    if let Some(room) = &patch.room {
        // A move rewrites the room and re-keys the message at the move's
        // ordering instant, so it lands at the top of the destination timeline.
        return Ok(vec![
            Effect::space(
                "update entities set room = ? where id = ?",
                vec![Value::text(room), Value::text(id)],
            ),
            Effect::space(
                "update entities set sort_idx = ? where id = ? and room = ?",
                vec![
                    Value::text(base.order_stamp.as_str()),
                    Value::text(id),
                    Value::text(room),
                ],
            ),
        ]);
    }

    let mut effects: Vec<Effect> = Vec::new();
    if let Some(content) = &patch.content {
        // The record body is the message's new content. `last_edit` records the
        // write that set it, and has only to differ from the message id for the
        // read path to report the message as edited.
        effects.push(Effect::space(
            "update comp_content set mime_type = ?, data = ?, last_edit = ? where entity = ?",
            vec![
                Value::text(&content.mime_type),
                Value::Blob(content.data.clone()),
                Value::text(base.order_stamp.as_str()),
                Value::text(id),
            ],
        ));
    }
    effects.extend(attachments::attachment_update_effects(
        &ctx.stream_id,
        id,
        &patch.extensions,
        ctx.decided_at_ms,
    ));
    Ok(effects)
}

/// A delete removes the message, after the forward references that point at it
/// — while their edges still exist — so no orphan entity is left behind.
pub fn delete_effects(change: &RecordChange) -> Vec<Effect> {
    let id = change.base().rkey.as_str();
    vec![
        Effect::space(
            "delete from entities where id in (
               select head from edges where tail = ? and label = 'forward'
             )",
            vec![Value::text(id)],
        ),
        Effect::space("delete from entities where id = ?", vec![Value::text(id)]),
    ]
}

/// The message's ordering key, guarded so a replayed create cannot re-key a
/// message an earlier derivation already keyed.
fn ordering_key(id: &str, order_stamp: &OrderStamp) -> Effect {
    Effect::space(
        "update entities set sort_idx = ? where id = ? and sort_idx is null",
        vec![Value::text(order_stamp.as_str()), Value::text(id)],
    )
}

/// The `room_activity` maintenance a message change appends: one statement,
/// after the kind's own.
pub fn activity_step(change: &RecordChange, ctx: &RuleContext) -> Option<Effect> {
    let message_id = change.base().rkey.as_str().to_string();
    match change {
        RecordChange::Create {
            record: RecordBody::Message(record),
            ..
        } => {
            if record.system.is_some() || record.forward_of.is_some() {
                // A system message is not a feed entry, and a forward reference
                // carries no content of its own.
                return None;
            }
            Some(if ctx.is_backfill {
                Effect::space(
                    "delete from room_activity
                     where room_id = (select room from entities where id = ?)",
                    vec![Value::text(&message_id)],
                )
            } else {
                Effect::space(MERGE_ROOM_ACTIVITY_SQL, vec![Value::text(&message_id)])
            })
        }
        RecordChange::Update {
            patch: RecordPatch::Message(patch),
            ..
        } => {
            let to_room = patch.room.as_ref()?;
            let mut rooms: Vec<&str> = Vec::new();
            if let Some(from) = &ctx.prior_room {
                rooms.push(from.as_str());
            }
            if ctx.prior_room.as_deref() != Some(to_room.as_str()) {
                rooms.push(to_room.as_str());
            }
            invalidate_room_activity(&rooms)
        }
        RecordChange::Delete { .. } => {
            let room = ctx.prior_room.as_ref()?;
            invalidate_room_activity(&[room.as_str()])
        }
        _ => None,
    }
}

fn invalidate_room_activity(rooms: &[&str]) -> Option<Effect> {
    match rooms.len() {
        0 => None,
        1 => Some(Effect::space(
            "delete from room_activity where room_id in (?)",
            vec![Value::text(rooms[0])],
        )),
        _ => Some(Effect::space(
            "delete from room_activity where room_id in (?, ?)",
            vec![Value::text(rooms[0]), Value::text(rooms[1])],
        )),
    }
}

/// The derived steps a message change invalidates.
pub fn derived_steps(change: &RecordChange, ctx: &RuleContext) -> Vec<DerivedStep> {
    let mut steps: Vec<DerivedStep> = Vec::new();
    let message_id = change.base().rkey.as_str().to_string();

    match change {
        RecordChange::Create {
            record: RecordBody::Message(record),
            ..
        } => {
            if record.system.is_some() || record.forward_of.is_some() {
                return steps;
            }
            steps.push(DerivedStep::UpsertActivityItem {
                space_id: ctx.stream_id.clone(),
                room_id: record.room.clone(),
                message_id: message_id.clone(),
                timestamp: canonical_send_time(&message_id, record),
            });
            let urls = links_in(record);
            if !urls.is_empty() {
                steps.push(DerivedStep::StoreLinks {
                    space_id: ctx.stream_id.clone(),
                    message_id,
                    urls,
                    decided_at_ms: ctx.decided_at_ms,
                });
            }
        }
        RecordChange::Update {
            patch: RecordPatch::Message(patch),
            base,
        } => {
            let Some(to_room) = &patch.room else {
                return steps;
            };
            // A move lands at the top of the destination's feed window, stamped
            // with the move's own ordering instant — the stamp's time half.
            steps.push(DerivedStep::UpsertActivityItem {
                space_id: ctx.stream_id.clone(),
                room_id: to_room.clone(),
                message_id,
                timestamp: base.order_stamp.time_ms(),
            });
            let mut rooms: Vec<String> = Vec::new();
            if let Some(from) = &ctx.prior_room {
                rooms.push(from.clone());
            }
            if !rooms.iter().any(|room| room == to_room) {
                rooms.push(to_room.clone());
            }
            for room_id in rooms {
                steps.push(DerivedStep::RebuildActivityWindow { room_id });
            }
        }
        RecordChange::Delete { .. } => {
            if let Some(room) = &ctx.prior_room {
                steps.push(DerivedStep::RebuildActivityWindow {
                    room_id: room.clone(),
                });
            }
        }
        _ => {}
    }

    steps
}

/// The URLs a message's content names — a rich-text body's `#link` facets, or
/// the URLs its plain text carries.
fn links_in(record: &MessageRecord) -> Vec<String> {
    let Some(content) = &record.content else {
        return Vec::new();
    };
    if content.mime_type == RICHTEXT_MIME {
        return match serde_json::from_slice::<serde_json::Value>(&content.data) {
            Ok(blocks) => links::extract_facet_urls(&blocks),
            Err(_) => Vec::new(),
        };
    }
    links::extract_urls(&String::from_utf8_lossy(&content.data))
}

/// `room_activity`'s live merge for one message, verbatim from
/// `queries/roomActivityProjection.ts`.
const MERGE_ROOM_ACTIVITY_SQL: &str = "
      insert into room_activity (room_id, latest_message_id, latest_at, recent_authors)
      select e.room,
             e.id,
             coalesce(cc.timestamp, fcc.timestamp),
             case
               when coalesce(a.tail, fa.tail) is null then '[]'
               else json_array(json_object(
                 'did', coalesce(a.tail, fa.tail),
                 'ts',  coalesce(cc.timestamp, fcc.timestamp)
               ))
             end
        from entities e
        left join comp_content cc on cc.entity = e.id
        left join edges a  on a.head  = e.id and a.label  = 'author'
        left join edges f  on f.head  = e.id and f.label  = 'forward'
        left join comp_content fcc on fcc.entity = f.tail
        left join edges fa on fa.head = f.tail and fa.label = 'author'
       where e.id = ?
         and e.room is not null
         and (cc.entity is not null or f.tail is not null)
      on conflict (room_id) do update set
        latest_message_id = case
          when excluded.latest_at is not null
            and (room_activity.latest_at is null
                 or excluded.latest_at > room_activity.latest_at
                 or (excluded.latest_at = room_activity.latest_at
                     and excluded.latest_message_id > room_activity.latest_message_id))
            then excluded.latest_message_id
            else room_activity.latest_message_id
        end,
        latest_at = case
          when room_activity.latest_at is null then excluded.latest_at
          when excluded.latest_at is null then room_activity.latest_at
          when excluded.latest_at > room_activity.latest_at then excluded.latest_at
          else room_activity.latest_at
        end,
        recent_authors = case
          when json_array_length(excluded.recent_authors) = 0
            then room_activity.recent_authors
          else (
            select coalesce(
                     json_group_array(json_object('did', did, 'ts', ts) order by ts desc, did asc),
                     '[]'
                   )
              from (
                select did, max(ts) as ts
                  from (
                    select json_extract(value, '$.did') as did,
                           json_extract(value, '$.ts')  as ts
                      from json_each(room_activity.recent_authors)
                    union all
                    select json_extract(value, '$.did'),
                           json_extract(value, '$.ts')
                      from json_each(excluded.recent_authors)
                  )
                 group by did
              )
          )
        end
    ";
