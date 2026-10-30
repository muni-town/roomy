//! Message selection, ported from `src/queries/selectMessages.ts`.
//!
//! Same keyset pagination over `coalesce(sort_idx, id)`, same message-shaped
//! filter, same batch joins for reactions/embeds/forwards, and the same DTO
//! assembly order.

use std::collections::{HashMap, HashSet};

use indexmap::{IndexMap, IndexSet};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use serde_json::value::RawValue;
use serde_json::Value as JsonValue;

use crate::dto::{
    Attachment, BlockedMessage, ForwardedFrom, FullMessage, LinkEmbedDto, MediaDto, MessageDto,
    ReactionDto,
};
use crate::error::XrpcError;
use crate::ids;
use crate::queries::links;
use crate::store::{GlobalStores, ProfileFields};
use crate::time;

const RICHTEXT_MIME: &str = "application/vnd.roomy.richtext+json";

/// Which messages a call selects.
pub enum SelectScope<'a> {
    /// One page of `room_id`'s messages, newest first.
    Room {
        room_id: &'a str,
        limit: usize,
        cursor: Option<&'a str>,
    },
    /// The messages named by `ids`.
    Ids {
        ids: Vec<String>,
        /// Forwarded targets already being resolved, so a cycle terminates.
        forward_chain: Vec<String>,
        /// Skip the global-store profile overlay, for a caller that has one.
        skip_profile_hydration: bool,
    },
}

/// The messages a call selected, oldest first, and the cursor for the page
/// before them.
pub struct SelectResult {
    pub messages: Vec<MessageDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug)]
struct BaseRow {
    id: String,
    blocked: i64,
    stream_id: Option<String>,
    sort_idx: Option<String>,
    mime_type: Option<String>,
    data: Option<Vec<u8>>,
    timestamp: Option<i64>,
    last_edit: Option<String>,
    author_did: Option<String>,
    author_name: Option<String>,
    author_handle: Option<String>,
    author_avatar: Option<String>,
    reply_to: Option<String>,
    forward_target: Option<String>,
    forward_target_room: Option<String>,
    forward_target_room_name: Option<String>,
}

#[derive(Debug)]
struct EmbedRow {
    message_id: String,
    kind: EmbedKind,
    url: String,
    /// Null for a tile row, which carries no blob — the loader resolves the
    /// tile's resources from its own PDS.
    mime_type: Option<String>,
    alt: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    blurhash: Option<String>,
    size: Option<i64>,
    length: Option<i64>,
    name: Option<String>,
    /// A tile's JSON payload as stored; `None` for every other kind.
    data: Option<String>,
}

/// One row of `comp_reaction`, as stored.
struct ReactionRow {
    entity: String,
    reaction: String,
    user: String,
    reaction_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmbedKind {
    Image,
    Video,
    File,
    Link,
    Tile,
}

/// `roomPageSql` — order and filter on the same timeline key. `has_cursor`
/// adds the keyset predicate for the page after `cursor`.
fn room_page_sql(has_cursor: bool, limit: usize) -> String {
    format!(
        "
      select
        e.id as id,
        (case when author_e.tail in (select value from json_each(?2))
              then 1 else 0 end) as blocked,
        e.stream_id as stream_id,
        e.sort_idx as sort_idx,
        e.room as room,
        cc.mime_type as mime_type,
        cc.data as data,
        cc.timestamp as timestamp,
        cc.last_edit as last_edit,
        author_e.tail as author_did,
        author_info.name as author_name,
        author_info.avatar as author_avatar,
        author_user.handle as author_handle,
        reply_e.tail as reply_to,
        forward_e.tail as forward_target,
        forward_target_entity.room as forward_target_room,
        forward_target_room_info.name as forward_target_room_name
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join comp_info author_info on author_info.entity = author_e.tail
      left join comp_user author_user on author_user.did = author_e.tail
      left join edges reply_e
        on reply_e.head = e.id and reply_e.label = 'reply'
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join entities forward_target_entity
        on forward_target_entity.id = forward_e.tail
      left join comp_info forward_target_room_info
        on forward_target_room_info.entity = forward_target_entity.room
      where e.room = ?1
        and (cc.entity is not null or forward_e.tail is not null)
        {}
      order by coalesce(e.sort_idx, e.id) desc, e.id desc
      limit {}
    ",
        if has_cursor {
            "and (coalesce(e.sort_idx, e.id) < ?3
                  or (coalesce(e.sort_idx, e.id) = ?3 and e.id < ?4))"
        } else {
            ""
        },
        limit.clamp(1, 100)
    )
}

const IDS_SQL: &str = "
  select
    e.id as id,
    (case when author_e.tail in (select value from json_each(?1))
          then 1 else 0 end) as blocked,
    e.stream_id as stream_id,
    e.sort_idx as sort_idx,
    e.room as room,
    cc.mime_type as mime_type,
    cc.data as data,
    cc.timestamp as timestamp,
    cc.last_edit as last_edit,
    author_e.tail as author_did,
    author_info.name as author_name,
    author_info.avatar as author_avatar,
    author_user.handle as author_handle,
    reply_e.tail as reply_to,
    forward_e.tail as forward_target,
    forward_target_entity.room as forward_target_room,
    forward_target_room_info.name as forward_target_room_name
  from entities e
  left join comp_content cc on cc.entity = e.id
  left join edges author_e
    on author_e.head = e.id and author_e.label = 'author'
  left join comp_info author_info on author_info.entity = author_e.tail
  left join comp_user author_user on author_user.did = author_e.tail
  left join edges reply_e
    on reply_e.head = e.id and reply_e.label = 'reply'
  left join edges forward_e
    on forward_e.head = e.id and forward_e.label = 'forward'
  left join entities forward_target_entity
    on forward_target_entity.id = forward_e.tail
  left join comp_info forward_target_room_info
    on forward_target_room_info.entity = forward_target_entity.room
  where e.id in ({})
";

fn row_to_base(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaseRow> {
    Ok(BaseRow {
        id: row.get("id")?,
        blocked: row.get("blocked")?,
        stream_id: row.get("stream_id")?,
        sort_idx: row.get("sort_idx")?,
        mime_type: row.get("mime_type")?,
        data: row.get("data")?,
        timestamp: row.get("timestamp")?,
        last_edit: row.get("last_edit")?,
        author_did: row.get("author_did")?,
        author_name: row.get("author_name")?,
        author_handle: row.get("author_handle")?,
        author_avatar: row.get("author_avatar")?,
        reply_to: row.get("reply_to")?,
        forward_target: row.get("forward_target")?,
        forward_target_room: row.get("forward_target_room")?,
        forward_target_room_name: row.get("forward_target_room_name")?,
    })
}

fn resolve_cursor_key(conn: &Connection, cursor_id: &str) -> rusqlite::Result<String> {
    let row: Option<String> = conn
        .query_row(
            "select coalesce(sort_idx, id) as key from entities where id = ?",
            [cursor_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(row.unwrap_or_else(|| cursor_id.to_owned()))
}

/// `decodeContent`: text and JSON as UTF-8, everything else as base64.
#[must_use]
pub fn decode_content(mime: Option<&str>, data: Option<&[u8]>) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let Some(data) = data else {
        return String::new();
    };
    match mime {
        None => String::from_utf8_lossy(data).into_owned(),
        Some(m) if m.starts_with("text/") || m == "application/json" => {
            String::from_utf8_lossy(data).into_owned()
        }
        Some(_) => STANDARD.encode(data),
    }
}

/// Board preview: rich-text bodies reduce to plaintext; everything else is the
/// wire `content` string.
#[must_use]
pub fn decode_board_preview(mime: Option<&str>, data: Option<&[u8]>) -> String {
    if mime == Some(RICHTEXT_MIME) {
        return data.and_then(richtext_plaintext).unwrap_or_default();
    }
    decode_content(mime, data)
}

/// Best-effort reduction of a serialised blocks document to its text.
fn richtext_plaintext(data: &[u8]) -> Option<String> {
    let value: JsonValue = serde_json::from_slice(data).ok()?;
    let mut out = String::new();
    collect_text(&value, &mut out);
    Some(out)
}

fn collect_text(value: &JsonValue, out: &mut String) {
    match value {
        JsonValue::Object(map) => {
            if let Some(JsonValue::String(text)) = map.get("text") {
                out.push_str(text);
            }
            for value in map.values() {
                collect_text(value, out);
            }
        }
        JsonValue::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        _ => {}
    }
}

fn attachment_from_embed(
    row: &EmbedRow,
    link_embeds: &HashMap<String, Option<Box<RawValue>>>,
) -> Attachment {
    match row.kind {
        EmbedKind::Image => Attachment::Image {
            url: row.url.clone(),
            media_type: row.mime_type.clone().unwrap_or_default(),
            alt: row.alt.clone(),
            width: row.width,
            height: row.height,
            blurhash: row.blurhash.clone(),
            size: row.size,
        },
        EmbedKind::Video => Attachment::Video {
            url: row.url.clone(),
            media_type: row.mime_type.clone().unwrap_or_default(),
            alt: row.alt.clone(),
            width: row.width,
            height: row.height,
            length: row.length,
            blurhash: row.blurhash.clone(),
            size: row.size,
        },
        EmbedKind::File => Attachment::File {
            url: row.url.clone(),
            media_type: row.mime_type.clone().unwrap_or_default(),
            name: row.name.clone(),
            size: row.size,
        },
        EmbedKind::Link => Attachment::Link {
            url: row.url.clone(),
            embed: link_embeds
                .get(links::canonical_url(&row.url))
                .cloned()
                .flatten(),
        },
        // A payload the writer produced is always valid JSON. A row that is
        // not — written by an older or a wrong writer — loses its payload, not
        // the attachment: the tile still renders, it just has no data.
        EmbedKind::Tile => Attachment::Tile {
            url: row.url.clone(),
            data: row
                .data
                .as_deref()
                .and_then(|text| serde_json::from_str::<Box<RawValue>>(text).ok()),
        },
    }
}

/// The `media` and `linkEmbeds` arrays an attachment list derives.
struct AttachmentViews {
    media: Vec<MediaDto>,
    link_embeds: Vec<LinkEmbedDto>,
}

/// `deriveAttachmentViews`: media in kind order, then links as uri-lists.
fn derive_attachment_views(attachments: &[Attachment]) -> AttachmentViews {
    let mut media = Vec::new();
    let mut link_embeds = Vec::new();
    for attachment in attachments {
        match attachment {
            Attachment::Link { url, embed } => {
                media.push(MediaDto {
                    url: url.clone(),
                    media_type: "text/uri-list".to_owned(),
                    alt: None,
                    width: None,
                    height: None,
                    blurhash: None,
                    size: None,
                    length: None,
                    name: None,
                });
                link_embeds.push(LinkEmbedDto {
                    url: url.clone(),
                    embed: embed.clone(),
                });
            }
            Attachment::Image {
                url,
                media_type,
                alt,
                width,
                height,
                blurhash,
                size,
            } => media.push(MediaDto {
                url: url.clone(),
                media_type: media_type.clone(),
                alt: alt.clone(),
                width: *width,
                height: *height,
                blurhash: blurhash.clone(),
                size: *size,
                length: None,
                name: None,
            }),
            Attachment::Video {
                url,
                media_type,
                alt,
                width,
                height,
                length,
                blurhash,
                size,
            } => media.push(MediaDto {
                url: url.clone(),
                media_type: media_type.clone(),
                alt: alt.clone(),
                width: *width,
                height: *height,
                blurhash: blurhash.clone(),
                size: *size,
                length: *length,
                name: None,
            }),
            Attachment::File {
                url,
                media_type,
                name,
                size,
            } => media.push(MediaDto {
                url: url.clone(),
                media_type: media_type.clone(),
                alt: None,
                width: None,
                height: None,
                blurhash: None,
                size: *size,
                length: None,
                name: name.clone(),
            }),
            // A tile is not media: it renders from its own record, so neither
            // derived view carries it.
            Attachment::Tile { .. } => {}
            Attachment::Reply { .. } | Attachment::Forward { .. } => {}
        }
    }
    AttachmentViews { media, link_embeds }
}

fn blocked_tombstone(row: &BaseRow) -> MessageDto {
    let timestamp = match row.timestamp {
        Some(ts) => time::iso_from_ms(ts),
        None => match &row.forward_target {
            Some(_) => ids::ulid_time_ms(&row.id)
                .map(time::iso_from_ms)
                .unwrap_or_default(),
            None => String::new(),
        },
    };
    MessageDto::Blocked(BlockedMessage {
        id: row.id.clone(),
        sort_idx: row.sort_idx.clone(),
        content: String::new(),
        author_did: row.author_did.clone().unwrap_or_default(),
        author_name: String::new(),
        blocked: true,
        timestamp,
        attachments: Vec::new(),
        reactions: Vec::new(),
        media: Vec::new(),
        link_embeds: Vec::new(),
    })
}

/// Select the messages `scope` names, in the wire shape the appserver builds.
///
/// `viewer_did` marks the caller's own reactions; `hidden` is the author block
/// set, which hides a message behind a tombstone.
pub fn select_messages(
    conn: &Connection,
    stores: &dyn GlobalStores,
    scope: SelectScope<'_>,
    viewer_did: Option<&str>,
    hidden: &[String],
) -> Result<SelectResult, XrpcError> {
    // The worker has no block set of its own; the gateway resolves it. An
    // empty set (the supplied `hidden`, always empty today) makes every row
    // live, which is the same query shape `selectMessages` runs.
    let hidden_param = serde_json::to_string(hidden).unwrap_or_else(|_| "[]".to_owned());

    let mut scope_limit: Option<usize> = None;
    let skip_profile_hydration = matches!(
        &scope,
        SelectScope::Ids {
            skip_profile_hydration: true,
            ..
        }
    );

    let base_rows: Vec<BaseRow> = match &scope {
        SelectScope::Room {
            room_id,
            limit,
            cursor,
        } => {
            scope_limit = Some(*limit);
            let cursor_key = match cursor {
                Some(cursor) => Some(resolve_cursor_key(conn, cursor)?),
                None => None,
            };
            let sql = room_page_sql(cursor_key.is_some(), *limit);
            let mut stmt = conn.prepare(&sql)?;
            let rows = if let Some(key) = &cursor_key {
                stmt.query_map(
                    rusqlite::params![room_id, hidden_param, key, cursor],
                    row_to_base,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                stmt.query_map(rusqlite::params![room_id, hidden_param], row_to_base)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            rows
        }
        SelectScope::Ids { ids, .. } => {
            if ids.is_empty() {
                return Ok(SelectResult {
                    messages: Vec::new(),
                    next_cursor: None,
                });
            }
            let placeholders = (0..ids.len())
                .map(|i| format!("?{}", i + 2))
                .collect::<Vec<_>>()
                .join(",");
            let sql = IDS_SQL.replace("{}", &placeholders);
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<Value> = Vec::with_capacity(ids.len() + 1);
            params.push(Value::Text(hidden_param.clone()));
            params.extend(ids.iter().cloned().map(Value::Text));
            let rows = stmt.query_map(rusqlite::params_from_iter(params), row_to_base)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        }
    };

    if base_rows.is_empty() {
        return Ok(SelectResult {
            messages: Vec::new(),
            next_cursor: None,
        });
    }

    // ── Step 2: forwarded originals ───────────────────────────────────────
    let chain: Vec<String> = match &scope {
        SelectScope::Ids { forward_chain, .. } => forward_chain.clone(),
        SelectScope::Room { .. } => Vec::new(),
    };
    let forward_targets: Vec<String> = base_rows
        .iter()
        .filter(|row| {
            row.forward_target
                .as_ref()
                .is_some_and(|target| !chain.contains(target))
        })
        .filter_map(|row| row.forward_target.clone())
        .collect();

    let mut forward_originals: HashMap<String, MessageDto> = HashMap::new();
    if !forward_targets.is_empty() {
        let unique: Vec<String> = {
            let mut seen = HashSet::new();
            forward_targets
                .into_iter()
                .filter(|id| seen.insert(id.clone()))
                .collect()
        };
        let mut next_chain = chain.clone();
        next_chain.extend(unique.iter().cloned());
        let originals = select_messages(
            conn,
            stores,
            SelectScope::Ids {
                ids: unique,
                forward_chain: next_chain,
                skip_profile_hydration: false,
            },
            viewer_did,
            hidden,
        )?;
        for original in originals.messages {
            forward_originals.insert(original.id().to_owned(), original);
        }
    }

    // ── Step 3: reactions, embeds, link cards ─────────────────────────────
    let live_ids: Vec<String> = base_rows.iter().map(|row| row.id.clone()).collect();
    let placeholders = live_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // `created_at asc, reaction_id asc` is the oracle's order: reactions are
    // grouped in the order they were made, and the id breaks a tie.
    let reaction_rows: Vec<ReactionRow> = if live_ids.is_empty() {
        Vec::new()
    } else {
        let mut stmt = conn.prepare(&format!(
            "select entity, reaction, user, reaction_id from comp_reaction
              where entity in ({placeholders})
              order by created_at asc, reaction_id asc"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(live_ids.iter()), |row| {
                Ok(ReactionRow {
                    entity: row.get(0)?,
                    reaction: row.get(1)?,
                    user: row.get(2)?,
                    reaction_id: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    let embed_rows: Vec<EmbedRow> = if live_ids.is_empty() {
        Vec::new()
    } else {
        let sql = format!(
            "select e.room as message_id, 'image' as kind, ei.entity as url,
                    ei.mime_type as mime_type, ei.alt as alt,
                    ei.width as width, ei.height as height,
                    ei.blurhash as blurhash, ei.size as size,
                    null as length, null as name, null as data
               from comp_embed_image ei
               join entities e on e.id = ei.entity
              where e.room in ({placeholders})
             union all
             select e.room as message_id, 'video' as kind, ev.entity as url,
                    ev.mime_type as mime_type, ev.alt as alt,
                    ev.width as width, ev.height as height,
                    ev.blurhash as blurhash, ev.size as size,
                    ev.length as length, null as name, null as data
               from comp_embed_video ev
               join entities e on e.id = ev.entity
              where e.room in ({placeholders})
             union all
             select e.room as message_id, 'file' as kind, ef.entity as url,
                    ef.mime_type as mime_type, null as alt,
                    null as width, null as height,
                    null as blurhash, ef.size as size,
                    null as length, ef.name as name, null as data
               from comp_embed_file ef
               join entities e on e.id = ef.entity
              where e.room in ({placeholders})
             union all
             select e.room as message_id, 'link' as kind, el.entity as url,
                    'text/uri-list' as mime_type, null as alt,
                    null as width, null as height,
                    null as blurhash, null as size,
                    null as length, null as name, null as data
               from comp_embed_link el
               join entities e on e.id = el.entity
              where e.room in ({placeholders})
                and el.show_preview = 1
             union all
             select e.room as message_id, 'tile' as kind, et.tile_uri as url,
                    null as mime_type, null as alt,
                    null as width, null as height,
                    null as blurhash, null as size,
                    null as length, null as name, et.data as data
               from comp_embed_tile et
               join entities e on e.id = et.entity
              where e.room in ({placeholders})",
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<Value> = Vec::with_capacity(live_ids.len() * 5);
        for _ in 0..5 {
            params.extend(live_ids.iter().cloned().map(Value::Text));
        }
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params), |row| {
                let kind: String = row.get(1)?;
                Ok(EmbedRow {
                    message_id: row.get(0)?,
                    kind: match kind.as_str() {
                        "image" => EmbedKind::Image,
                        "video" => EmbedKind::Video,
                        "file" => EmbedKind::File,
                        "tile" => EmbedKind::Tile,
                        _ => EmbedKind::Link,
                    },
                    url: row.get(2)?,
                    mime_type: row.get(3)?,
                    alt: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    blurhash: row.get(7)?,
                    size: row.get(8)?,
                    length: row.get(9)?,
                    name: row.get(10)?,
                    data: row.get(11)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    // Viewer's own reaction id, per (message, emoji).
    let mut reaction_map: IndexMap<String, IndexMap<String, IndexSet<String>>> = IndexMap::new();
    let mut viewer_reaction: IndexMap<String, IndexMap<String, String>> = IndexMap::new();
    for row in &reaction_rows {
        let per_msg = reaction_map.entry(row.entity.clone()).or_default();
        per_msg
            .entry(row.reaction.clone())
            .or_default()
            .insert(row.user.clone());
        if viewer_did == Some(row.user.as_str()) {
            viewer_reaction
                .entry(row.entity.clone())
                .or_default()
                .insert(row.reaction.clone(), row.reaction_id.clone());
        }
    }

    // Enriched link cards, keyed by the canonical URL: the store holds one row
    // per bare URL, while an attachment carries the message id in its own.
    let mut link_embeds: HashMap<String, Option<Box<RawValue>>> = HashMap::new();
    for row in embed_rows.iter().filter(|r| r.kind == EmbedKind::Link) {
        let canonical = links::canonical_url(&row.url);
        if link_embeds.contains_key(canonical) {
            continue;
        }
        // Raw, so the stored card's key order survives serialisation exactly
        // as `JSON.parse` → `JSON.stringify` preserves it in the appserver.
        let parsed = stores
            .link_embed_json(canonical)
            .and_then(|raw| serde_json::from_str::<Box<RawValue>>(&raw).ok());
        link_embeds.insert(canonical.to_owned(), parsed);
    }

    let mut attachments_map: IndexMap<String, Vec<Attachment>> = IndexMap::new();
    for row in &embed_rows {
        attachments_map
            .entry(row.message_id.clone())
            .or_default()
            .push(attachment_from_embed(row, &link_embeds));
    }

    let mut media_map: HashMap<String, Vec<MediaDto>> = HashMap::new();
    let mut link_embeds_map: HashMap<String, Vec<LinkEmbedDto>> = HashMap::new();
    for (message_id, attachments) in &attachments_map {
        let views = derive_attachment_views(attachments);
        media_map.insert(message_id.clone(), views.media);
        link_embeds_map.insert(message_id.clone(), views.link_embeds);
    }

    let mut messages: Vec<MessageDto> = Vec::with_capacity(base_rows.len());
    for row in &base_rows {
        // Tombstones are unreachable here today (the hidden set is empty), but
        // the assembly rule is kept so the code matches the query it ports.
        if row.blocked == 1 {
            messages.push(blocked_tombstone(row));
            continue;
        }

        let content = decode_content(row.mime_type.as_deref(), row.data.as_deref());
        let mut reactions = Vec::new();
        if let Some(per_msg) = reaction_map.get(&row.id) {
            let viewer_for_msg = viewer_reaction.get(&row.id);
            for (emoji, dids) in per_msg {
                reactions.push(ReactionDto {
                    emoji: emoji.clone(),
                    count: dids.len(),
                    my_reaction_id: viewer_for_msg.and_then(|m| m.get(emoji)).cloned(),
                });
            }
        }

        let media = media_map.get(&row.id).cloned().unwrap_or_default();
        let link_embeds_for_msg = link_embeds_map.get(&row.id).cloned().unwrap_or_default();

        let mut attachments: Vec<Attachment> = Vec::new();
        if let Some(reply_to) = &row.reply_to {
            attachments.push(Attachment::Reply {
                message_id: reply_to.clone(),
            });
        }
        let forwarded_from = row.forward_target.as_ref().map(|target| {
            let message = forward_originals.get(target).cloned().map(Box::new);
            ForwardedFrom {
                message_id: target.clone(),
                name: row.forward_target_room_name.clone().unwrap_or_default(),
                room_id: row.forward_target_room.clone().unwrap_or_default(),
                message,
            }
        });
        if let Some(forwarded) = &forwarded_from {
            attachments.push(Attachment::Forward {
                message_id: forwarded.message_id.clone(),
                name: forwarded.name.clone(),
                room_id: forwarded.room_id.clone(),
                message: forwarded.message.clone(),
            });
        }
        if let Some(rows) = attachments_map.get(&row.id) {
            attachments.extend(rows.iter().cloned());
        }

        let timestamp = match row.timestamp {
            Some(ts) => time::iso_from_ms(ts),
            None => match &row.forward_target {
                Some(_) => ids::ulid_time_ms(&row.id)
                    .map(time::iso_from_ms)
                    .unwrap_or_default(),
                None => String::new(),
            },
        };
        let system = row
            .author_did
            .as_deref()
            .zip(row.stream_id.as_deref())
            .map(|(author, stream)| author == stream)
            .filter(|same| *same);

        messages.push(MessageDto::Full(FullMessage {
            id: row.id.clone(),
            sort_idx: row.sort_idx.clone(),
            content,
            mime_type: row.mime_type.clone(),
            author_did: row.author_did.clone().unwrap_or_default(),
            author_name: row.author_name.clone().unwrap_or_default(),
            author_handle_at_assembly: row.author_handle.is_some(),
            author_avatar_at_assembly: row.author_avatar.is_some(),
            author_handle: row.author_handle.clone(),
            author_avatar: row.author_avatar.clone(),
            system,
            timestamp,
            last_edit: row.last_edit.clone().filter(|edit| edit != &row.id),
            attachments,
            reply_to: row.reply_to.clone(),
            forwarded_from,
            reactions,
            media,
            link_embeds: link_embeds_for_msg,
        }));
    }

    // Author profiles from the global store (with the per-space value as the
    // fallback).
    if !skip_profile_hydration {
        hydrate_profiles(&mut messages, stores);
    }
    resolve_system_message_names(&mut messages, stores);

    // Oldest → newest, tie-broken by id, matching the page order's reverse.
    messages.sort_by(|a, b| {
        let (a_key, a_id) = a.key();
        let (b_key, b_id) = b.key();
        a_key.cmp(b_key).then_with(|| a_id.cmp(b_id))
    });

    let mut next_cursor = None;
    if let Some(limit) = scope_limit {
        let limit = limit.clamp(1, 100);
        if base_rows.len() == limit {
            next_cursor = messages.first().map(|m| m.id().to_owned());
        }
    }
    Ok(SelectResult {
        messages,
        next_cursor,
    })
}

fn hydrate_profiles(messages: &mut [MessageDto], stores: &dyn GlobalStores) {
    for message in messages.iter_mut() {
        let MessageDto::Full(full) = message else {
            continue;
        };
        if let Some(ProfileFields {
            name,
            handle,
            avatar,
        }) = stores.profile(&full.author_did)
        {
            if let Some(name) = name {
                full.author_name = name;
            }
            if let Some(handle) = handle {
                full.author_handle = Some(handle);
            }
            if let Some(avatar) = avatar {
                full.author_avatar = Some(avatar);
            }
        }
    }
}

/// Rewrite the deterministic DID label in system messages to the author's
/// current display name or handle (`selectMessages.resolveSystemMessageNames`).
fn resolve_system_message_names(messages: &mut [MessageDto], stores: &dyn GlobalStores) {
    for message in messages.iter_mut() {
        let MessageDto::Full(full) = message else {
            continue;
        };
        if full.system != Some(true) || !full.content.contains("/user/") {
            continue;
        }
        full.content = rewrite_user_links(&full.content, stores);
    }
}

fn rewrite_user_links(content: &str, stores: &dyn GlobalStores) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(link_at) = rest.find("](/user/") {
        let path_start = link_at + "](/user/".len();
        let Some(close_rel) = rest[path_start..].find(')') else {
            break;
        };
        let path = &rest[path_start..path_start + close_rel];
        // The label is `[@<label>]` immediately before `](`.
        let Some(label_marker) = rest[..link_at].rfind("[@") else {
            out.push_str(&rest[..path_start + close_rel + 1]);
            rest = &rest[path_start + close_rel + 1..];
            continue;
        };
        let label = &rest[label_marker + 2..link_at];
        let did = percent_decode(path);
        let rendered = stores.profile(&did).and_then(|p| {
            let name = p.name.filter(|n| !n.trim().is_empty());
            name.or_else(|| p.handle.map(|h| format!("@{h}")))
        });
        out.push_str(&rest[..label_marker]);
        match rendered {
            Some(rendered) if label == path => {
                out.push('[');
                out.push_str(&rendered);
                out.push_str(&rest[link_at..path_start + close_rel + 1]);
            }
            _ => out.push_str(&rest[label_marker..path_start + close_rel + 1]),
        }
        rest = &rest[path_start + close_rel + 1..];
    }
    out.push_str(rest);
    out
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
