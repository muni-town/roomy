//! The attachment statements a message write carries.
//!
//! A message's `space.roomy.extension.attachments.v0` extension holds a list,
//! and each entry writes its own rows: a reply or a forward edge, a comment, or
//! a media entity keyed by `<uri>?message=<id>` so it is scoped to the message.
//! Ported from `sdk/src/schema/events/attachments.ts` — same statements, same
//! order, because the projection already depends on both.

use crate::effects::{Effect, Value};
use crate::ids::SpaceDid;
use crate::rules;

/// The extension a message carries its attachments under.
pub const ATTACHMENTS: &str = "space.roomy.extension.attachments.v0";

/// One attachment, as the extension's entries carry it.
#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub kind: String,
    pub uri: String,
    pub target: String,
    pub mime_type: String,
    pub alt: Option<String>,
    pub blurhash: Option<String>,
    pub size: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub length: Option<i64>,
    pub name: Option<String>,
    pub show_preview: bool,
    pub version: String,
    pub snippet: String,
    pub from: i64,
    pub to: i64,
    /// The tile payload, serialised as it will be stored. `None` when the
    /// attachment carried none.
    pub data: Option<String>,
}

impl Attachment {
    /// Read one entry of the extension's list. A value that is not shaped like
    /// an attachment still writes its rows: the materialiser trusts the
    /// extension map the same way and lets a missing field fall back.
    pub fn from_json(value: &serde_json::Value) -> Self {
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
        let number = |key: &str| value.get(key).and_then(|v| v.as_i64());
        Self {
            kind: text("$type").unwrap_or_default(),
            uri: text("uri").unwrap_or_default(),
            target: text("target").unwrap_or_default(),
            mime_type: text("mimeType").unwrap_or_default(),
            alt: text("alt"),
            blurhash: text("blurhash"),
            size: number("size"),
            width: number("width"),
            height: number("height"),
            length: number("length"),
            name: text("name"),
            show_preview: value
                .get("showPreview")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            version: text("version").unwrap_or_default(),
            snippet: text("snippet").unwrap_or_default(),
            from: number("from").unwrap_or(0),
            to: number("to").unwrap_or(0),
            data: value
                .get("data")
                .filter(|d| !d.is_null())
                .and_then(|d| serde_json::to_string(d).ok()),
        }
    }
}

/// The attachments a record's extension map carries, or none when the map has
/// no list (or a value that is not shaped like one).
pub fn attachments_of(extensions: Option<&serde_json::Value>) -> Vec<Attachment> {
    let Some(carried) = extensions.and_then(|e| e.get(ATTACHMENTS)) else {
        return Vec::new();
    };
    let Some(list) = carried.get("attachments").and_then(|a| a.as_array()) else {
        return Vec::new();
    };
    list.iter().map(Attachment::from_json).collect()
}

/// The statements one attachment list writes onto a message.
pub fn attachment_effects(
    stream_id: &SpaceDid,
    message_id: &str,
    attachments: &[Attachment],
    decided_at_ms: i64,
) -> Vec<Effect> {
    let mut effects: Vec<Effect> = Vec::new();
    for attachment in attachments {
        match attachment.kind.as_str() {
            "space.roomy.attachment.reply.v0" => effects.push(Effect::space(
                "insert or ignore into edges (head, tail, label, created_at, updated_at)
                 values (?, ?, 'reply', ?, ?)",
                vec![
                    Value::text(message_id),
                    Value::text(&attachment.target),
                    Value::Integer(decided_at_ms),
                    Value::Integer(decided_at_ms),
                ],
            )),
            "space.roomy.attachment.comment.v0" => effects.push(Effect::space(
                "insert into comp_comment (
                   entity, version, snippet, idx_from, idx_to, created_at, updated_at
                 )
                 values (?, ?, ?, ?, ?, ?, ?)",
                vec![
                    Value::text(message_id),
                    Value::text(&attachment.version),
                    Value::text(&attachment.snippet),
                    Value::Integer(attachment.from),
                    Value::Integer(attachment.to),
                    Value::Integer(decided_at_ms),
                    Value::Integer(decided_at_ms),
                ],
            )),
            "space.roomy.attachment.image.v0" => {
                let scoped = format!("{}?message={message_id}", attachment.uri);
                effects.push(rules::ensure_entity(
                    stream_id,
                    &scoped,
                    Some(message_id),
                    decided_at_ms,
                ));
                effects.push(Effect::space(
                    "insert or replace into comp_embed_image (
                       entity, mime_type, alt, width, height, blurhash, size,
                       created_at, updated_at
                     )
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    vec![
                        Value::text(scoped),
                        Value::text(&attachment.mime_type),
                        Value::opt_text(attachment.alt.clone()),
                        Value::opt_int(attachment.width),
                        Value::opt_int(attachment.height),
                        Value::opt_text(attachment.blurhash.clone()),
                        Value::opt_int(attachment.size),
                        Value::Integer(decided_at_ms),
                        Value::Integer(decided_at_ms),
                    ],
                ));
            }
            "space.roomy.attachment.video.v0" => {
                let scoped = format!("{}?message={message_id}", attachment.uri);
                effects.push(rules::ensure_entity(
                    stream_id,
                    &scoped,
                    Some(message_id),
                    decided_at_ms,
                ));
                effects.push(Effect::space(
                    "insert or replace into comp_embed_video (
                       entity, mime_type, alt, width, height, length, blurhash, size,
                       created_at, updated_at
                     )
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    vec![
                        Value::text(scoped),
                        Value::text(&attachment.mime_type),
                        Value::opt_text(attachment.alt.clone()),
                        Value::opt_int(attachment.width),
                        Value::opt_int(attachment.height),
                        Value::opt_int(attachment.length),
                        Value::opt_text(attachment.blurhash.clone()),
                        Value::opt_int(attachment.size),
                        Value::Integer(decided_at_ms),
                        Value::Integer(decided_at_ms),
                    ],
                ));
            }
            "space.roomy.attachment.file.v0" => {
                let scoped = format!("{}?message={message_id}", attachment.uri);
                effects.push(rules::ensure_entity(
                    stream_id,
                    &scoped,
                    Some(message_id),
                    decided_at_ms,
                ));
                effects.push(Effect::space(
                    "insert or replace into comp_embed_file (
                       entity, mime_type, name, size, created_at, updated_at
                     )
                     values (?, ?, ?, ?, ?, ?)",
                    vec![
                        Value::text(scoped),
                        Value::text(&attachment.mime_type),
                        Value::opt_text(attachment.name.clone()),
                        Value::opt_int(attachment.size),
                        Value::Integer(decided_at_ms),
                        Value::Integer(decided_at_ms),
                    ],
                ));
            }
            "space.roomy.attachment.link.v0" => {
                let scoped = format!("{}?message={message_id}", attachment.uri);
                effects.push(rules::ensure_entity(
                    stream_id,
                    &scoped,
                    Some(message_id),
                    decided_at_ms,
                ));
                effects.push(Effect::space(
                    "insert into comp_embed_link (entity, show_preview, created_at, updated_at)
                     values (?, ?, ?, ?)",
                    vec![
                        Value::text(scoped),
                        Value::Integer(i64::from(attachment.show_preview)),
                        Value::Integer(decided_at_ms),
                        Value::Integer(decided_at_ms),
                    ],
                ));
            }
            "space.roomy.attachment.tile.v0" => {
                // The entity key carries the message suffix like every other
                // embed row's, but `tile_uri` holds the bare address: the read
                // path hands that straight to the client, and a tile address is
                // a record address — a `?message=` query makes it one that no
                // longer parses.
                let scoped = format!("{}?message={message_id}", attachment.uri);
                effects.push(rules::ensure_entity(
                    stream_id,
                    &scoped,
                    Some(message_id),
                    decided_at_ms,
                ));
                effects.push(Effect::space(
                    "insert or replace into comp_embed_tile (entity, tile_uri, data)
                     values (?, ?, ?)",
                    vec![
                        Value::text(scoped),
                        Value::text(&attachment.uri),
                        Value::opt_text(attachment.data.clone()),
                    ],
                ));
            }
            "space.roomy.attachment.forward.v0" => effects.push(Effect::space(
                "insert or ignore into edges (head, tail, label, created_at, updated_at)
                 select ?, ?, 'forward', ?, ?
                 where exists (select 1 from entities where id = ?)",
                vec![
                    Value::text(message_id),
                    Value::text(&attachment.target),
                    Value::Integer(decided_at_ms),
                    Value::Integer(decided_at_ms),
                    Value::text(&attachment.target),
                ],
            )),
            _ => {}
        }
    }
    effects
}

/// The attachment half of an edit: an edit that did not mention the attachments
/// leaves them alone, a link-only list flips `show_preview` in place, and
/// anything else replaces the set wholesale.
///
/// `carried` is the extension's value: `None` when the patch did not mention
/// it, `Some(None)` when it set it to null (remove every attachment), and
/// `Some(Some(list))` when it replaced them.
pub fn attachment_update_effects(
    stream_id: &SpaceDid,
    message_id: &str,
    carried: &Option<Option<serde_json::Value>>,
    decided_at_ms: i64,
) -> Vec<Effect> {
    let Some(carried) = carried else {
        return Vec::new();
    };

    let attachments = match carried {
        None => Vec::new(),
        Some(value) => match value.get("attachments").and_then(|a| a.as_array()) {
            Some(list) => list.iter().map(Attachment::from_json).collect(),
            None => Vec::new(),
        },
    };
    let link_attachments: Vec<&Attachment> = attachments
        .iter()
        .filter(|a| a.kind == "space.roomy.attachment.link.v0")
        .collect();

    if carried.is_some() && !attachments.is_empty() && link_attachments.len() == attachments.len() {
        // A link-only edit toggles an embed preview and is non-destructive: it
        // must not wipe the images, videos, comments or replies on the message.
        let mut effects: Vec<Effect> = Vec::new();
        for attachment in link_attachments {
            let scoped = format!("{}?message={message_id}", attachment.uri);
            effects.push(rules::ensure_entity(
                stream_id,
                &scoped,
                Some(message_id),
                decided_at_ms,
            ));
            effects.push(Effect::space(
                "update comp_embed_link set show_preview = ?
                  where entity in (
                    select e.id from entities e
                    where e.room = ? and (e.id = ? or e.id = ?)
                  )",
                vec![
                    Value::flag(attachment.show_preview),
                    Value::text(message_id),
                    Value::text(&attachment.uri),
                    Value::text(&scoped),
                ],
            ));
            effects.push(Effect::space(
                "insert into comp_embed_link (entity, show_preview, created_at, updated_at)
                 select ?, ?, ?, ?
                 where not exists (
                   select 1 from entities e
                   join comp_embed_link el on el.entity = e.id
                   where e.room = ? and (e.id = ? or e.id = ?)
                 )",
                vec![
                    Value::text(scoped),
                    Value::flag(attachment.show_preview),
                    Value::Integer(decided_at_ms),
                    Value::Integer(decided_at_ms),
                    Value::text(message_id),
                    Value::text(&attachment.uri),
                    Value::text(message_id),
                ],
            ));
        }
        return effects;
    }

    let suffix = format!("%?message={message_id}");
    let mut effects: Vec<Effect> = vec![
        Effect::space(
            "delete from comp_embed_image where entity like ?",
            vec![Value::text(suffix.clone())],
        ),
        Effect::space(
            "delete from comp_embed_video where entity like ?",
            vec![Value::text(suffix.clone())],
        ),
        Effect::space(
            "delete from comp_embed_file where entity like ?",
            vec![Value::text(suffix.clone())],
        ),
        Effect::space(
            "delete from comp_embed_link where entity like ?",
            vec![Value::text(suffix.clone())],
        ),
        Effect::space(
            "delete from comp_embed_tile where entity like ?",
            vec![Value::text(suffix)],
        ),
        Effect::space(
            "delete from comp_comment where entity = ?",
            vec![Value::text(message_id)],
        ),
        Effect::space(
            "delete from edges where head = ? and label = 'reply'",
            vec![Value::text(message_id)],
        ),
        // Media entities carry the message as their room.
        Effect::space(
            "delete from entities where room = ? and id != ?",
            vec![Value::text(message_id), Value::text(message_id)],
        ),
    ];

    // A forward edge belongs to the message's original send and the cleanup
    // above leaves it, so an edit never writes one.
    if carried.is_some() {
        let replacements: Vec<Attachment> = attachments
            .into_iter()
            .filter(|a| a.kind != "space.roomy.attachment.forward.v0")
            .collect();
        effects.extend(attachment_effects(
            stream_id,
            message_id,
            &replacements,
            decided_at_ms,
        ));
    }
    effects
}
