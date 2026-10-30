//! `space.roomy.space.getActivityFeed`: one page of recent activity, merged
//! across every space the caller joined.
//!
//! The feed rows are materialised per space in `activity_item`, so this read
//! opens each joined space, takes a page's worth of rows from each, merges them
//! newest-first and pages the merged list. A row's messages are hydrated from
//! that space's own tables; the latest message of each item additionally
//! carries its attachments, the media and link views derived from them, and its
//! reactions.
//!
//! Two caller-scoped filters apply after the page is chosen, so neither changes
//! the page split: a room the caller cannot read is dropped from the response,
//! and a message whose author the caller has blocked is dropped before its body
//! or its author's profile is read.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use serde_json::Value;

use space_xrpc::dto::{Attachment, LinkEmbedDto, MediaDto, ReactionDto};
use space_xrpc::error::XrpcError;
use space_xrpc::handlers::common::Context;
use space_xrpc::ids::Nsid;
use space_xrpc::params::Params;
use space_xrpc::queries::links::canonical_url;
use space_xrpc::queries::messages::decode_content;
use space_xrpc::store::GlobalStores;
use space_xrpc::time::iso_from_ms;

use crate::GatewayState;

/// The XRPC method this module answers.
pub const NSID: &str = "space.roomy.space.getActivityFeed";

/// axum handler for GET /xrpc/space.roomy.space.getActivityFeed.
pub async fn http(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let nsid = Nsid::try_from(NSID).expect("static nsid");
    let params = Params::parse(query.as_deref());
    let ctx = match crate::reads::context(&state, &headers, &nsid).await {
        Ok(ctx) => ctx,
        Err(error) => return error.into_response(),
    };
    match run(&state, &params, &ctx).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

// ─── Response ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct GetActivityFeedResult {
    feed: Vec<ActivityFeedItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

/// One room's activity.
///
/// The keys are emitted in the order the appserver builds them: the item's
/// identity and messages first, then the optional labels it appends afterwards.
#[derive(Debug)]
struct ActivityFeedItem {
    thread_id: String,
    thread_name: Option<String>,
    space_id: String,
    space_name: Option<String>,
    space_avatar: Option<String>,
    channel_id: Option<String>,
    channel_name: Option<String>,
    last_activity_at: String,
    activity_type: &'static str,
    messages: Vec<ActivityMessage>,
    unread_count: i64,
}

impl Serialize for ActivityFeedItem {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = 6
            + usize::from(self.thread_name.is_some())
            + usize::from(self.space_name.is_some())
            + usize::from(self.space_avatar.is_some())
            + usize::from(self.channel_id.is_some())
            + usize::from(self.channel_name.is_some());
        let mut state = serializer.serialize_struct("ActivityFeedItem", fields)?;
        state.serialize_field("threadId", &self.thread_id)?;
        state.serialize_field("spaceId", &self.space_id)?;
        state.serialize_field("lastActivityAt", &self.last_activity_at)?;
        state.serialize_field("activityType", self.activity_type)?;
        state.serialize_field("messages", &self.messages)?;
        state.serialize_field("unreadCount", &self.unread_count)?;
        if let Some(thread_name) = &self.thread_name {
            state.serialize_field("threadName", thread_name)?;
        }
        if let Some(space_name) = &self.space_name {
            state.serialize_field("spaceName", space_name)?;
        }
        if let Some(space_avatar) = &self.space_avatar {
            state.serialize_field("spaceAvatar", space_avatar)?;
        }
        if let Some(channel_id) = &self.channel_id {
            state.serialize_field("channelId", channel_id)?;
        }
        if let Some(channel_name) = &self.channel_name {
            state.serialize_field("channelName", channel_name)?;
        }
        state.end()
    }
}

#[derive(Debug, Clone)]
struct ActivityMessage {
    id: String,
    content: String,
    mime_type: Option<String>,
    author: ActivityAuthor,
    timestamp: Option<String>,
    attachments: Option<Vec<Attachment>>,
    reactions: Option<Vec<ReactionDto>>,
    media: Option<Vec<MediaDto>>,
    link_embeds: Option<Vec<LinkEmbedDto>>,
}

impl Serialize for ActivityMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = 3
            + usize::from(self.mime_type.is_some())
            + usize::from(self.timestamp.is_some())
            + usize::from(self.attachments.is_some())
            + usize::from(self.reactions.is_some())
            + usize::from(self.media.is_some())
            + usize::from(self.link_embeds.is_some());
        let mut state = serializer.serialize_struct("ActivityMessage", fields)?;
        state.serialize_field("id", &self.id)?;
        state.serialize_field("content", &self.content)?;
        if let Some(mime_type) = &self.mime_type {
            state.serialize_field("mimeType", mime_type)?;
        }
        state.serialize_field("author", &self.author)?;
        if let Some(timestamp) = &self.timestamp {
            state.serialize_field("timestamp", timestamp)?;
        }
        if let Some(attachments) = &self.attachments {
            state.serialize_field("attachments", attachments)?;
        }
        if let Some(media) = &self.media {
            state.serialize_field("media", media)?;
        }
        if let Some(link_embeds) = &self.link_embeds {
            state.serialize_field("linkEmbeds", link_embeds)?;
        }
        if let Some(reactions) = &self.reactions {
            state.serialize_field("reactions", reactions)?;
        }
        state.end()
    }
}

/// A message's author.
///
/// The per-space row supplies whatever profile fields it holds; the global
/// profile store then fills or replaces them. A field the row did not supply
/// serialises after the ones it did, because that is where the appserver's
/// post-assembly assignment puts it.
#[derive(Debug, Clone)]
struct ActivityAuthor {
    did: String,
    name: Option<String>,
    handle: Option<String>,
    avatar: Option<String>,
    name_at_assembly: bool,
    handle_at_assembly: bool,
    avatar_at_assembly: bool,
}

impl Serialize for ActivityAuthor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let trailing_name = !self.name_at_assembly && self.name.is_some();
        let trailing_handle = !self.handle_at_assembly && self.handle.is_some();
        let trailing_avatar = !self.avatar_at_assembly && self.avatar.is_some();
        let fields = 1
            + usize::from(self.name_at_assembly && self.name.is_some())
            + usize::from(self.handle_at_assembly && self.handle.is_some())
            + usize::from(self.avatar_at_assembly && self.avatar.is_some())
            + usize::from(trailing_name)
            + usize::from(trailing_handle)
            + usize::from(trailing_avatar);
        let mut state = serializer.serialize_struct("ActivityAuthor", fields)?;
        state.serialize_field("did", &self.did)?;
        if self.name_at_assembly {
            if let Some(name) = &self.name {
                state.serialize_field("name", name)?;
            }
        }
        if self.handle_at_assembly {
            if let Some(handle) = &self.handle {
                state.serialize_field("handle", handle)?;
            }
        }
        if self.avatar_at_assembly {
            if let Some(avatar) = &self.avatar {
                state.serialize_field("avatar", avatar)?;
            }
        }
        if trailing_name {
            state.serialize_field("name", &self.name)?;
        }
        if trailing_handle {
            state.serialize_field("handle", &self.handle)?;
        }
        if trailing_avatar {
            state.serialize_field("avatar", &self.avatar)?;
        }
        state.end()
    }
}

// ─── Rows ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
struct ActivityRow {
    room_id: String,
    space_id: String,
    parent_channel_id: Option<String>,
    parent_channel_name: Option<String>,
    last_activity_at: i64,
    recent_message_ids: String,
    room_name: Option<String>,
    space_name: Option<String>,
    space_avatar: Option<String>,
}

#[derive(Debug)]
struct MessageRow {
    id: String,
    mime_type: Option<String>,
    data: Option<Vec<u8>>,
    author_did: String,
    author_name: Option<String>,
    author_avatar: Option<String>,
    author_handle: Option<String>,
    timestamp: Option<i64>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmbedKind {
    Image,
    Video,
    File,
    Link,
    Tile,
}

// ─── Request ──────────────────────────────────────────────────────────────

async fn run(
    state: &Arc<GatewayState>,
    params: &Params,
    ctx: &Context,
) -> Result<GetActivityFeedResult, XrpcError> {
    let Some(user_did) = ctx.did().map(str::to_owned) else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let space_filter = params.optional_string("spaceId");
    let limit = params
        .optional_int("limit", Some(1), Some(100), Some(50))?
        .unwrap_or(50) as usize;
    let cursor = params.optional_string("cursor");

    let space_dids: Vec<String> = match &space_filter {
        Some(space_id) => {
            let db = state
                .reads
                .spaces
                .resolve_space(space_id)
                .ok_or_else(|| XrpcError::not_found(format!("Space not found: {space_id}")))?;
            db.with(|conn| {
                space_xrpc::access::require_space_read(conn, space_id, Some(user_did.as_str()))
            })?;
            vec![space_id.clone()]
        }
        None => state
            .reads
            .read_state
            .space_memberships(&user_did)
            .map_err(read_state_error)?
            .into_iter()
            .map(|membership| membership.space_did)
            .collect(),
    };
    if space_dids.is_empty() {
        return Ok(empty_feed());
    }

    // The authors hidden from this viewer, in either direction.
    let blocked = state
        .reads
        .read_state
        .blocked(&user_did)
        .map_err(read_state_error)?;

    // One page per space, so the merged list can be paged globally without
    // reading every row of a busy space.
    let fetch_limit = limit + 1;
    let mut all_rows: Vec<ActivityRow> = Vec::new();
    for space_did in &space_dids {
        let Some(db) = state.reads.spaces.resolve_space(space_did) else {
            continue;
        };
        let mut rows = db.with(|conn| {
            let mut statement = conn.prepare(
                "select ai.room_id, ai.space_id,
                        ai.parent_channel_id, ai.parent_channel_name,
                        ai.last_activity_at, ai.recent_message_ids,
                        ai.room_name, ai.space_name, ai.space_avatar
                   from activity_item ai
                   left join comp_room cr on cr.entity = ai.room_id
                  where ai.space_id = ? and (cr.deleted is null or cr.deleted = 0)
                  order by ai.last_activity_at desc, ai.room_id desc
                  limit ?",
            )?;
            let mut mapped =
                statement.query_map((space_did.as_str(), fetch_limit as i64), |row| {
                    Ok(ActivityRow {
                        room_id: row.get(0)?,
                        space_id: row.get(1)?,
                        parent_channel_id: row.get(2)?,
                        parent_channel_name: row.get(3)?,
                        last_activity_at: row.get(4)?,
                        recent_message_ids: row.get(5)?,
                        room_name: row.get(6)?,
                        space_name: row.get(7)?,
                        space_avatar: row.get(8)?,
                    })
                })?;
            let mut rows = Vec::new();
            for row in mapped.by_ref() {
                rows.push(row?);
            }
            Ok(rows)
        })?;
        all_rows.append(&mut rows);
    }
    if all_rows.is_empty() {
        return Ok(empty_feed());
    }

    all_rows.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.room_id.cmp(&a.room_id))
    });

    // Keep the rows strictly after the cursor: a lower timestamp, or the same
    // timestamp with a lower room id.
    let filtered: Vec<usize> = match cursor.as_deref().and_then(parse_cursor) {
        Some((cursor_ts, cursor_id)) => (0..all_rows.len())
            .filter(|&index| {
                let row = &all_rows[index];
                (row.last_activity_at as f64) < cursor_ts
                    || ((row.last_activity_at as f64) == cursor_ts
                        && row.room_id.as_str() < cursor_id)
            })
            .collect(),
        None => (0..all_rows.len()).collect(),
    };

    let has_more = filtered.len() > limit;
    let page: &[usize] = if has_more {
        &filtered[..limit]
    } else {
        &filtered
    };
    if page.is_empty() {
        return Ok(empty_feed());
    }

    let mut by_space: HashMap<String, Vec<usize>> = HashMap::new();
    for &index in page {
        by_space
            .entry(all_rows[index].space_id.clone())
            .or_default()
            .push(index);
    }

    // ── Messages ──────────────────────────────────────────────────────────
    let mut messages: HashMap<String, ActivityMessage> = HashMap::new();
    for (space_did, indices) in &by_space {
        let mut message_ids: Vec<String> = Vec::new();
        for &index in indices {
            message_ids.extend(parse_recent_message_ids(
                &all_rows[index].recent_message_ids,
            ));
        }
        if message_ids.is_empty() {
            continue;
        }
        let Some(db) = state.reads.spaces.resolve_space(space_did) else {
            continue;
        };
        let id_json = serde_json::to_string(&message_ids).unwrap_or_else(|_| "[]".to_owned());
        let rows = db.with(|conn| {
            let mut statement = conn.prepare(
                "select e.id as id,
                        cc.mime_type as mime_type,
                        cc.data as data,
                        coalesce(author_e.tail, '') as author_did,
                        author_info.name as author_name,
                        author_info.avatar as author_avatar,
                        author_user.handle as author_handle,
                        cc.timestamp as timestamp
                   from entities e
                   left join comp_content cc on cc.entity = e.id
                   left join edges author_e
                     on author_e.head = e.id and author_e.label = 'author'
                   left join comp_info author_info on author_info.entity = author_e.tail
                   left join comp_user author_user on author_user.did = author_e.tail
                  where e.id in (select value from json_each(?1))",
            )?;
            let mut mapped = statement.query_map([id_json.as_str()], |row| {
                Ok(MessageRow {
                    id: row.get(0)?,
                    mime_type: row.get(1)?,
                    data: row.get(2)?,
                    author_did: row.get(3)?,
                    author_name: row.get(4)?,
                    author_avatar: row.get(5)?,
                    author_handle: row.get(6)?,
                    timestamp: row.get(7)?,
                })
            })?;
            let mut rows = Vec::new();
            for row in mapped.by_ref() {
                rows.push(row?);
            }
            Ok(rows)
        })?;

        for row in rows {
            // A blocked author's message is simply absent: the feed has no
            // reveal, so it is dropped before its body or profile is read.
            if blocked.is_hidden(&row.author_did) {
                continue;
            }
            let author = hydrated_author(
                state.reads.stores.as_ref(),
                row.author_did,
                row.author_name,
                row.author_handle,
                row.author_avatar,
            );
            let message = ActivityMessage {
                id: row.id,
                content: decode_content(row.mime_type.as_deref(), row.data.as_deref()),
                mime_type: row.mime_type,
                author,
                timestamp: row.timestamp.map(iso_from_ms),
                attachments: None,
                reactions: None,
                media: None,
                link_embeds: None,
            };
            messages.insert(message.id.clone(), message);
        }
    }

    // ── Unread counts ─────────────────────────────────────────────────────
    // The watermark is the caller's read position for the room; the messages
    // it is counted against live in the room's own space database.
    let mut unread_counts: HashMap<String, i64> = HashMap::new();
    for (space_did, indices) in &by_space {
        let room_ids: Vec<String> = indices
            .iter()
            .map(|&index| all_rows[index].room_id.clone())
            .filter(|room_id| ctx.positions.watermark(room_id).is_some())
            .collect();
        if room_ids.is_empty() {
            continue;
        }
        let Some(db) = state.reads.spaces.resolve_space(space_did) else {
            continue;
        };
        let counts = db.with(|conn| {
            let mut counts = Vec::with_capacity(room_ids.len());
            for room_id in &room_ids {
                counts.push(space_xrpc::handlers::common::unread_count(
                    conn,
                    &ctx.positions,
                    room_id,
                )?);
            }
            Ok(counts)
        })?;
        for (room_id, count) in room_ids.into_iter().zip(counts) {
            unread_counts.insert(room_id, count);
        }
    }

    // ── Page ──────────────────────────────────────────────────────────────
    let mut feed: Vec<ActivityFeedItem> = page
        .iter()
        .map(|&index| {
            let row = &all_rows[index];
            let mut item_messages = Vec::new();
            for id in parse_recent_message_ids(&row.recent_message_ids) {
                if let Some(message) = messages.get(&id) {
                    item_messages.push(message.clone());
                }
            }
            ActivityFeedItem {
                thread_id: row.room_id.clone(),
                thread_name: row.room_name.clone(),
                space_id: row.space_id.clone(),
                space_name: row.space_name.clone(),
                space_avatar: row.space_avatar.clone(),
                channel_id: row.parent_channel_id.clone(),
                channel_name: if row.parent_channel_id.is_some() {
                    row.parent_channel_name.clone()
                } else {
                    None
                },
                last_activity_at: iso_from_ms(row.last_activity_at),
                activity_type: "message",
                messages: item_messages,
                unread_count: unread_counts.get(&row.room_id).copied().unwrap_or(0),
            }
        })
        .collect();

    // ── Latest message enrichment ─────────────────────────────────────────
    // Attachments, their derived views and reactions are read only for the
    // newest message of each item, grouped per space.
    let mut last_ids_by_space: HashMap<String, Vec<String>> = HashMap::new();
    for item in &feed {
        let Some(last) = item.messages.first() else {
            continue;
        };
        last_ids_by_space
            .entry(item.space_id.clone())
            .or_default()
            .push(last.id.clone());
    }

    let mut attachments_by_message: HashMap<String, Vec<Attachment>> = HashMap::new();
    let mut reactions_by_message: HashMap<String, Vec<ReactionDto>> = HashMap::new();
    let mut page_link_urls: HashSet<String> = HashSet::new();
    for (space_did, last_ids) in &last_ids_by_space {
        let Some(db) = state.reads.spaces.resolve_space(space_did) else {
            continue;
        };
        let id_json = serde_json::to_string(last_ids).unwrap_or_else(|_| "[]".to_owned());
        let embed_rows = db.with(|conn| {
            let mut statement = conn.prepare(
                "select e.room as message_id, 'image' as kind, ei.entity as url,
                        ei.mime_type as mime_type, ei.alt as alt,
                        ei.width as width, ei.height as height,
                        ei.blurhash as blurhash, ei.size as size,
                        null as length, null as name, null as data
                   from comp_embed_image ei
                   join entities e on e.id = ei.entity
                  where e.room in (select value from json_each(?1))
                 union all
                 select e.room as message_id, 'video' as kind, ev.entity as url,
                        ev.mime_type as mime_type, ev.alt as alt,
                        ev.width as width, ev.height as height,
                        ev.blurhash as blurhash, ev.size as size,
                        ev.length as length, null as name, null as data
                   from comp_embed_video ev
                   join entities e on e.id = ev.entity
                  where e.room in (select value from json_each(?1))
                 union all
                 select e.room as message_id, 'file' as kind, ef.entity as url,
                        ef.mime_type as mime_type, null as alt,
                        null as width, null as height,
                        null as blurhash, ef.size as size,
                        null as length, ef.name as name, null as data
                   from comp_embed_file ef
                   join entities e on e.id = ef.entity
                  where e.room in (select value from json_each(?1))
                 union all
                 select e.room as message_id, 'link' as kind, el.entity as url,
                        'text/uri-list' as mime_type, null as alt,
                        null as width, null as height,
                        null as blurhash, null as size,
                        null as length, null as name, null as data
                   from comp_embed_link el
                   join entities e on e.id = el.entity
                  where e.room in (select value from json_each(?1))
                    and el.show_preview = 1
                 union all
                 select e.room as message_id, 'tile' as kind, et.tile_uri as url,
                        null as mime_type, null as alt,
                        null as width, null as height,
                        null as blurhash, null as size,
                        null as length, null as name, et.data as data
                   from comp_embed_tile et
                   join entities e on e.id = et.entity
                  where e.room in (select value from json_each(?1))",
            )?;
            let mut mapped = statement.query_map([id_json.as_str()], |row| {
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
            })?;
            let mut rows = Vec::new();
            for row in mapped.by_ref() {
                rows.push(row?);
            }
            Ok(rows)
        })?;
        for row in embed_rows {
            if row.kind == EmbedKind::Link {
                page_link_urls.insert(canonical_url(&row.url).to_owned());
            }
            attachments_by_message
                .entry(row.message_id.clone())
                .or_default()
                .push(attachment_from_embed_row(&row));
        }

        let reaction_rows = db.with(|conn| {
            let mut statement = conn.prepare(
                "select entity, reaction, user, reaction_id
                   from comp_reaction
                  where entity in (select value from json_each(?1))",
            )?;
            let mut mapped = statement.query_map([id_json.as_str()], |row| {
                Ok(ReactionRow {
                    message_id: row.get(0)?,
                    reaction: row.get(1)?,
                    user: row.get(2)?,
                    reaction_id: row.get(3)?,
                })
            })?;
            let mut rows = Vec::new();
            for row in mapped.by_ref() {
                rows.push(row?);
            }
            Ok(rows)
        })?;
        for (message_id, bucket) in group_reactions(reaction_rows, &user_did) {
            reactions_by_message.insert(message_id, bucket);
        }
    }

    // The enrichment is global and keyed by URL, so one lookup per link on the
    // page covers every space it came from.
    let mut link_embed_data: HashMap<String, Option<Box<RawValue>>> = HashMap::new();
    for url in page_link_urls {
        let embed = state
            .reads
            .stores
            .link_embed_json(&url)
            .and_then(|raw| serde_json::from_str::<Box<RawValue>>(&raw).ok());
        link_embed_data.insert(url, embed);
    }

    for item in &mut feed {
        let Some(last) = item.messages.first_mut() else {
            continue;
        };
        let last_id = last.id.clone();
        if let Some(attachments) = attachments_by_message.get(&last_id) {
            if !attachments.is_empty() {
                // A link attachment takes its card from the global store, the
                // only place one is held.
                let resolved: Vec<Attachment> = attachments
                    .iter()
                    .map(|attachment| match attachment {
                        Attachment::Link { url, .. } => {
                            match link_embed_data.get(canonical_url(url)).cloned().flatten() {
                                Some(embed) => Attachment::Link {
                                    url: url.clone(),
                                    embed: Some(embed),
                                },
                                None => attachment.clone(),
                            }
                        }
                        other => other.clone(),
                    })
                    .collect();
                let (media, link_embeds) = derive_attachment_views(&resolved);
                last.attachments = Some(resolved);
                if !media.is_empty() {
                    last.media = Some(media);
                }
                if !link_embeds.is_empty() {
                    last.link_embeds = Some(link_embeds);
                }
            }
        }
        if let Some(reactions) = reactions_by_message.get(&last_id) {
            if !reactions.is_empty() {
                last.reactions = Some(reactions.clone());
            }
        }
    }

    let next_cursor = if has_more {
        let last = &all_rows[*page.last().expect("non-empty page")];
        Some(format!("{}::{}", last.last_activity_at, last.room_id))
    } else {
        None
    };

    // A room the caller cannot read is silently absent from the page; the
    // cursor is already fixed, so the split does not move.
    let mut rooms_by_space: HashMap<String, Vec<String>> = HashMap::new();
    for item in &feed {
        rooms_by_space
            .entry(item.space_id.clone())
            .or_default()
            .push(item.thread_id.clone());
    }
    let mut readable: HashMap<String, bool> = HashMap::new();
    for (space_id, room_ids) in rooms_by_space {
        let Some(db) = state.reads.spaces.resolve_space(&space_id) else {
            continue;
        };
        let access = db.with(|conn| {
            let mut access = Vec::with_capacity(room_ids.len());
            for room_id in &room_ids {
                access.push(
                    space_xrpc::access::room_access(conn, room_id, Some(user_did.as_str()))?
                        .can_read,
                );
            }
            Ok(access)
        })?;
        for (room_id, can_read) in room_ids.into_iter().zip(access) {
            readable.insert(room_id, can_read);
        }
    }
    feed.retain(|item| readable.get(&item.thread_id).copied().unwrap_or(false));

    Ok(GetActivityFeedResult {
        feed,
        cursor: next_cursor,
    })
}

fn empty_feed() -> GetActivityFeedResult {
    GetActivityFeedResult {
        feed: Vec::new(),
        cursor: None,
    }
}

fn read_state_error(error: roomy_readstate::ReadStateError) -> XrpcError {
    XrpcError::internal(format!("read-state: {error}"))
}

/// The author as the message row carried it, with the global profile store
/// filling or replacing each field it holds.
fn hydrated_author(
    stores: &dyn GlobalStores,
    did: String,
    name: Option<String>,
    handle: Option<String>,
    avatar: Option<String>,
) -> ActivityAuthor {
    let mut author = ActivityAuthor {
        name_at_assembly: name.is_some(),
        handle_at_assembly: handle.is_some(),
        avatar_at_assembly: avatar.is_some(),
        did,
        name,
        handle,
        avatar,
    };
    if let Some(profile) = stores.profile(&author.did) {
        if let Some(name) = profile.name {
            author.name = Some(name);
        }
        if let Some(handle) = profile.handle {
            author.handle = Some(handle);
        }
        if let Some(avatar) = profile.avatar {
            author.avatar = Some(avatar);
        }
    }
    author
}

// ─── Parsing ──────────────────────────────────────────────────────────────

/// The `recent_message_ids` window, newest first.
///
/// The column stores `{ id, ts }` objects; a legacy row stores plain ULID
/// strings. Only the ids are needed here, because the array's order already
/// carries the ordering the window was built in.
fn parse_recent_message_ids(raw: &str) -> Vec<String> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(id) => ids.push(id),
            Value::Object(entry) => {
                if let (Some(Value::String(id)), Some(Value::Number(_))) =
                    (entry.get("id"), entry.get("ts"))
                {
                    ids.push(id.clone());
                }
            }
            _ => {}
        }
    }
    ids
}

/// Split a `timestamp::roomId` cursor. A cursor whose timestamp is not a
/// number is ignored, as the appserver ignores it.
fn parse_cursor(cursor: &str) -> Option<(f64, &str)> {
    let separator = cursor.rfind("::")?;
    let timestamp = parse_js_number(&cursor[..separator])?;
    Some((timestamp, &cursor[separator + 2..]))
}

fn parse_js_number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    match trimmed {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => trimmed.parse::<f64>().ok().filter(|value| !value.is_nan()),
    }
}

// ─── Attachments ──────────────────────────────────────────────────────────

fn attachment_from_embed_row(row: &EmbedRow) -> Attachment {
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
            embed: None,
        },
        // Unlike a link card, the payload is not enrichment: it is the
        // attachment's own bytes, so the feed carries it exactly as the
        // message read does. A payload that is not JSON costs the attachment
        // its `data`, not its place.
        EmbedKind::Tile => Attachment::Tile {
            url: row.url.clone(),
            data: row
                .data
                .as_deref()
                .and_then(|text| serde_json::from_str::<Box<RawValue>>(text).ok()),
        },
    }
}

/// `deriveAttachmentViews`: media in attachment order, and the link rows with
/// the enrichment each already carries.
fn derive_attachment_views(attachments: &[Attachment]) -> (Vec<MediaDto>, Vec<LinkEmbedDto>) {
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
            // A tile is not media, and neither derived view carries it.
            Attachment::Tile { .. } => {}
            Attachment::Reply { .. } | Attachment::Forward { .. } => {}
        }
    }
    (media, link_embeds)
}

// ─── Reactions ────────────────────────────────────────────────────────────

#[derive(Default)]
struct ReactionBucket {
    /// Emoji in the order the reaction rows first named them.
    order: Vec<String>,
    dids: HashMap<String, HashSet<String>>,
    /// The viewer's own reaction id, per emoji.
    mine: HashMap<String, String>,
}

/// One `comp_reaction` row: the message reacted to, the emoji, who reacted, and
/// that reaction's own id.
#[derive(Debug)]
struct ReactionRow {
    message_id: String,
    reaction: String,
    user: String,
    reaction_id: String,
}

/// Group reaction rows into `{ emoji, count, myReactionId? }` per message.
fn group_reactions(rows: Vec<ReactionRow>, viewer_did: &str) -> HashMap<String, Vec<ReactionDto>> {
    let mut buckets: HashMap<String, ReactionBucket> = HashMap::new();
    for row in rows {
        let bucket = buckets.entry(row.message_id).or_default();
        if !bucket.dids.contains_key(&row.reaction) {
            bucket.order.push(row.reaction.clone());
        }
        bucket
            .dids
            .entry(row.reaction.clone())
            .or_default()
            .insert(row.user.clone());
        if row.user == viewer_did {
            bucket.mine.insert(row.reaction, row.reaction_id);
        }
    }

    buckets
        .into_iter()
        .map(|(entity, bucket)| {
            let ReactionBucket { order, dids, mine } = bucket;
            let reactions = order
                .into_iter()
                .map(|emoji| ReactionDto {
                    count: dids.get(&emoji).map(HashSet::len).unwrap_or(0),
                    my_reaction_id: mine.get(&emoji).cloned(),
                    emoji,
                })
                .collect();
            (entity, reactions)
        })
        .collect()
}
