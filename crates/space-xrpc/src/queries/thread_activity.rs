//! Room activity for the boards, ported from `src/queries/threadActivity.ts`
//! and the read half of `src/queries/roomActivityProjection.ts`.
//!
//! `listThreadActivity` pages rooms from `activity_item`; each page's latest
//! message, timestamp and recent authors come from the `room_activity`
//! projection when it can answer the page, and from a scan of the messages when
//! it cannot. The appserver warms missing projection rows on read; the worker
//! is a read replica and never writes, so a missing row takes the scan — the
//! two paths are required to produce the same answer.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use crate::dto::{RoomActivityDto, ThreadMember, ThreadMessage};
use crate::error::XrpcError;
use crate::queries::messages;
use crate::store::GlobalStores;
use crate::time;

/// One room's activity: its identity, its latest message, and who was in it.
#[derive(Debug, Clone)]
pub struct ThreadActivity {
    /// The room's id.
    pub id: String,
    /// `channel` or `thread`.
    pub kind: &'static str,
    /// The room's display name, when it has one.
    pub name: Option<String>,
    /// The canonical parent channel, when the room is a thread.
    pub canonical_parent: Option<String>,
    /// When the room last saw a message, ISO-formatted.
    pub latest_timestamp: Option<String>,
    /// Up to three of the room's most recent authors.
    pub latest_members: Vec<Member>,
    /// The room's newest message.
    pub latest_message: Option<LatestMessage>,
}

/// One person quoted by an activity row: a DID and the profile fields for it.
#[derive(Debug, Clone)]
pub struct Member {
    /// The person's DID.
    pub did: String,
    /// The display name the per-space tables or the global store hold.
    pub name: Option<String>,
    /// The avatar URL the per-space tables or the global store hold.
    pub avatar: Option<String>,
}

/// A room's newest message, as the boards quote it.
#[derive(Debug, Clone)]
pub struct LatestMessage {
    /// The message's id.
    pub id: String,
    /// The message's text, or the wire `content` string for a non-text body.
    pub content: String,
    /// Who wrote it.
    pub author: Member,
    /// When it was written, ISO-formatted.
    pub timestamp: Option<String>,
}

impl ThreadActivity {
    /// The wire shape of this activity row.
    #[must_use]
    pub fn to_dto(&self) -> RoomActivityDto {
        RoomActivityDto {
            latest_members: self
                .latest_members
                .iter()
                .map(|m| ThreadMember {
                    did: m.did.clone(),
                    name: m.name.clone(),
                    avatar: m.avatar.clone(),
                })
                .collect(),
            latest_timestamp: self.latest_timestamp.clone(),
            latest_message: self.latest_message.as_ref().map(|m| ThreadMessage {
                id: m.id.clone(),
                content: m.content.clone(),
                author: ThreadMember {
                    did: m.author.did.clone(),
                    name: m.author.name.clone(),
                    avatar: m.author.avatar.clone(),
                },
                timestamp: m.timestamp.clone(),
            }),
        }
    }
}

/// The rooms an activity list covers: one space, or one channel's threads.
pub enum ThreadScope<'a> {
    /// Every room in the space.
    Space(&'a str),
    /// The threads canonically linked from the channel.
    Channel(&'a str),
}

/// The query [`list_thread_activity`] answers.
pub struct ListActivity<'a> {
    /// The rooms to list.
    pub scope: ThreadScope<'a>,
    /// The maximum number of rows.
    pub limit: usize,
    /// Where the previous page ended.
    pub cursor: Option<&'a str>,
    /// A case-insensitive substring the room name must contain.
    pub search: Option<&'a str>,
    /// The room kinds to list: `channel` and/or `thread`.
    pub kinds: &'a [&'a str],
}

/// One page of activity rows, with the cursor for the next page.
pub struct ThreadActivityPage {
    /// The rows, in the query's order.
    pub activities: Vec<ThreadActivity>,
    /// The cursor to pass as `cursor` for the next page, when there is one.
    pub next_cursor: Option<String>,
}

/// One page of a room activity list.
///
/// A page's latest message, timestamp and recent authors come from the
/// `room_activity` projection when it can answer the whole page, and from a
/// scan of the messages when it cannot.
pub fn list_thread_activity(
    conn: &Connection,
    stores: &dyn GlobalStores,
    query: ListActivity<'_>,
) -> Result<ThreadActivityPage, XrpcError> {
    if query.kinds.is_empty() {
        return Ok(ThreadActivityPage {
            activities: Vec::new(),
            next_cursor: None,
        });
    }

    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    match query.scope {
        ThreadScope::Space(space_id) => {
            conditions.push("e.stream_id = ?".to_owned());
            params.push(Value::Text(space_id.to_owned()));
        }
        ThreadScope::Channel(channel_id) => {
            conditions.push("link_e.head = ?".to_owned());
            params.push(Value::Text(channel_id.to_owned()));
        }
    }

    let labels: Vec<&str> = query
        .kinds
        .iter()
        .map(|kind| {
            if *kind == "thread" {
                "space.roomy.thread"
            } else {
                "space.roomy.channel"
            }
        })
        .collect();
    conditions.push(format!(
        "cr.label in ({})",
        labels.iter().map(|_| "?").collect::<Vec<_>>().join(",")
    ));
    for label in labels {
        params.push(Value::Text(label.to_owned()));
    }
    conditions.push("coalesce(cr.deleted, 0) = 0".to_owned());

    if let Some(search) = query.search.filter(|s| !s.trim().is_empty()) {
        conditions.push("ci.name like ?".to_owned());
        params.push(Value::Text(format!("%{}%", search.trim())));
    }

    if let Some(cursor) = query.cursor {
        if let Some(sep) = cursor.rfind("::") {
            let cursor_at: i64 = cursor[..sep].parse().unwrap_or(0);
            let cursor_id = &cursor[sep + 2..];
            conditions.push(
                "(coalesce(ai.last_activity_at, 0) < ? or (coalesce(ai.last_activity_at, 0) = ? and e.id > ?))"
                    .to_owned(),
            );
            params.push(Value::Integer(cursor_at));
            params.push(Value::Integer(cursor_at));
            params.push(Value::Text(cursor_id.to_owned()));
        }
    }

    let join_clause = match query.scope {
        ThreadScope::Space(_) => "",
        ThreadScope::Channel(_) => {
            "join edges link_e on link_e.tail = e.id and link_e.label = 'link' and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1"
        }
    };

    let sql = format!(
        "select e.id as id, ci.name as name, cr.label as label,
                coalesce(ai.last_activity_at, 0) as sort_key
           from entities e
           join comp_room cr on cr.entity = e.id
           left join comp_info ci on ci.entity = e.id
           left join activity_item ai on ai.room_id = e.id
           {join_clause}
          where {}
          order by sort_key desc, e.id asc
          limit ?",
        conditions.join(" and ")
    );
    params.push(Value::Integer(query.limit as i64 + 1));

    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<RoomRow> = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(RoomRow {
                id: row.get(0)?,
                name: row.get(1)?,
                label: row.get(2)?,
                sort_key: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if rows.is_empty() {
        return Ok(ThreadActivityPage {
            activities: Vec::new(),
            next_cursor: None,
        });
    }

    let has_more = rows.len() > query.limit;
    let mut page = rows;
    page.truncate(query.limit);
    let ids: Vec<String> = page.iter().map(|row| row.id.clone()).collect();
    let activity = fetch_room_activity(conn, stores, &ids)?;

    let results: Vec<ThreadActivity> = page
        .iter()
        .map(|row| {
            let mut entry = activity
                .get(&row.id)
                .cloned()
                .unwrap_or_else(|| blank(&row.id));
            entry.kind = if row.label.as_deref() == Some("space.roomy.channel") {
                "channel"
            } else {
                "thread"
            };
            entry.name = row.name.clone();
            entry
        })
        .collect();

    let next_cursor = if has_more {
        page.last()
            .map(|row| format!("{}::{}", row.sort_key, row.id))
    } else {
        None
    };

    Ok(ThreadActivityPage {
        activities: results,
        next_cursor,
    })
}

fn blank(id: &str) -> ThreadActivity {
    ThreadActivity {
        id: id.to_owned(),
        kind: "thread",
        name: None,
        canonical_parent: None,
        latest_timestamp: None,
        latest_members: Vec::new(),
        latest_message: None,
    }
}

/// `fetchRoomActivity`: projection first, live scan when the projection has no
/// row for any requested room.
pub fn fetch_room_activity(
    conn: &Connection,
    stores: &dyn GlobalStores,
    room_ids: &[String],
) -> Result<IndexMap<String, ThreadActivity>, XrpcError> {
    if room_ids.is_empty() {
        return Ok(IndexMap::new());
    }
    let mut out = match project_room_activity(conn, room_ids)? {
        Some(projected) => projected,
        None => scan_room_activity(conn, room_ids)?,
    };
    for activity in out.values_mut() {
        for member in &mut activity.latest_members {
            apply_profile(member, stores);
        }
        if let Some(message) = &mut activity.latest_message {
            apply_profile(&mut message.author, stores);
        }
    }
    Ok(out)
}

fn apply_profile(member: &mut Member, stores: &dyn GlobalStores) {
    if let Some(profile) = stores.profile(&member.did) {
        if profile.name.is_some() {
            member.name = profile.name;
        }
        if profile.avatar.is_some() {
            member.avatar = profile.avatar;
        }
    }
}

/// One `room_activity` row.
struct ProjectedRow {
    room_id: String,
    latest_at: Option<i64>,
    recent_authors: String,
}

/// What `room_activity` says about one room.
struct ProjectedSummary {
    latest_at: Option<i64>,
    /// The recent authors' DIDs, most recent first.
    authors: Vec<String>,
}

fn read_projection(
    conn: &Connection,
    room_ids: &[String],
) -> rusqlite::Result<Option<HashMap<String, ProjectedSummary>>> {
    let placeholders = room_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql = format!(
        "select room_id, latest_message_id, latest_at, recent_authors
           from room_activity
          where room_id in ({placeholders})"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return Ok(None),
    };
    let rows: Vec<ProjectedRow> = stmt
        .query_map(rusqlite::params_from_iter(room_ids.iter()), |row| {
            Ok(ProjectedRow {
                room_id: row.get(0)?,
                latest_at: row.get(2)?,
                recent_authors: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = HashMap::new();
    for row in rows {
        out.insert(
            row.room_id,
            ProjectedSummary {
                latest_at: row.latest_at,
                authors: parse_authors(Some(&row.recent_authors)),
            },
        );
    }
    if room_ids.iter().any(|id| !out.contains_key(id)) {
        return Ok(None);
    }
    Ok(Some(out))
}

fn project_room_activity(
    conn: &Connection,
    room_ids: &[String],
) -> Result<Option<IndexMap<String, ThreadActivity>>, XrpcError> {
    let Some(projected) = read_projection(conn, room_ids)? else {
        return Ok(None);
    };

    let placeholders = room_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "select cr.entity as room_id,
                cr.label as label,
                ci.name as name,
                p.head as parent_id,
                ra.latest_message_id as latest_message_id,
                coalesce(mc.mime_type, fc.mime_type) as mime_type,
                coalesce(mc.data, fc.data) as data,
                coalesce(a.tail, fa.tail) as author_did
           from comp_room cr
           left join comp_info ci on ci.entity = cr.entity
           left join edges p
                  on p.tail = cr.entity and p.label = 'link'
                 and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
           left join room_activity ra on ra.room_id = cr.entity
           left join entities m on m.id = ra.latest_message_id
           left join comp_content mc on mc.entity = m.id
           left join edges a on a.head = m.id and a.label = 'author'
           left join edges f on f.head = m.id and f.label = 'forward'
           left join comp_content fc on fc.entity = f.tail
           left join edges fa on fa.head = f.tail and fa.label = 'author'
          where cr.entity in ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<RoomShapeRow> = stmt
        .query_map(rusqlite::params_from_iter(room_ids.iter()), |row| {
            Ok(RoomShapeRow {
                room_id: row.get(0)?,
                label: row.get(1)?,
                name: row.get(2)?,
                parent_id: row.get(3)?,
                latest_message_id: row.get(4)?,
                mime_type: row.get(5)?,
                data: row.get(6)?,
                author_did: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if rows.len() != room_ids.len() {
        return Ok(None);
    }

    let info = load_room_info(conn, &projected)?;

    let mut out = IndexMap::new();
    for row in rows {
        let summary = projected.get(&row.room_id).expect("projection row");
        let author = row
            .author_did
            .as_ref()
            .and_then(|did| info.get(did))
            .cloned()
            .unwrap_or_default();
        let latest_message = match (&row.latest_message_id, &row.author_did) {
            (Some(id), Some(author_did)) => Some(LatestMessage {
                id: id.clone(),
                content: messages::decode_board_preview(
                    row.mime_type.as_deref(),
                    row.data.as_deref(),
                ),
                author: Member {
                    did: author_did.clone(),
                    name: author.name,
                    avatar: author.avatar,
                },
                timestamp: summary.latest_at.map(time::iso_from_ms),
            }),
            _ => None,
        };
        out.insert(
            row.room_id.clone(),
            ThreadActivity {
                id: row.room_id,
                kind: if row.label.as_deref() == Some("space.roomy.channel") {
                    "channel"
                } else {
                    "thread"
                },
                name: row.name,
                canonical_parent: row.parent_id,
                latest_timestamp: summary.latest_at.map(time::iso_from_ms),
                latest_members: summary
                    .authors
                    .iter()
                    .take(3)
                    .map(|did| Member {
                        did: did.clone(),
                        name: None,
                        avatar: None,
                    })
                    .collect(),
                latest_message,
            },
        );
    }

    // Names/avatars from comp_info, then the caller's global overlay.
    for activity in out.values_mut() {
        for member in &mut activity.latest_members {
            if let Some(info) = info.get(&member.did) {
                member.name = info.name.clone();
                member.avatar = info.avatar.clone();
            }
        }
        if let Some(message) = &mut activity.latest_message {
            if let Some(info) = info.get(&message.author.did) {
                message.author.name = info.name.clone();
                message.author.avatar = info.avatar.clone();
            }
        }
    }

    Ok(Some(out))
}

struct RoomShapeRow {
    room_id: String,
    label: Option<String>,
    name: Option<String>,
    parent_id: Option<String>,
    latest_message_id: Option<String>,
    mime_type: Option<String>,
    data: Option<Vec<u8>>,
    author_did: Option<String>,
}

/// One row of the activity list's page query.
struct RoomRow {
    id: String,
    name: Option<String>,
    label: Option<String>,
    sort_key: i64,
}

/// A person's name and avatar from the per-space `comp_info`.
#[derive(Debug, Clone, Default)]
struct MemberInfo {
    name: Option<String>,
    avatar: Option<String>,
}

/// `comp_info` rows keyed by entity DID.
type InfoMap = HashMap<String, MemberInfo>;

/// The `comp_info` names and avatars for every recent author in `projected`.
fn load_room_info(
    conn: &Connection,
    projected: &HashMap<String, ProjectedSummary>,
) -> rusqlite::Result<InfoMap> {
    let mut dids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for summary in projected.values() {
        for did in &summary.authors {
            if seen.insert(did.clone()) {
                dids.push(did.clone());
            }
        }
    }
    load_info(conn, &dids)
}

/// The `comp_info` names and avatars for `dids`.
fn load_info(conn: &Connection, dids: &[String]) -> rusqlite::Result<InfoMap> {
    if dids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = dids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut stmt = conn.prepare(&format!(
        "select entity, name, avatar from comp_info where entity in ({placeholders})"
    ))?;
    let rows: Vec<CompInfoRow> = stmt
        .query_map(rusqlite::params_from_iter(dids.iter()), |row| {
            Ok(CompInfoRow {
                entity: row.get(0)?,
                name: row.get(1)?,
                avatar: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.entity,
                MemberInfo {
                    name: row.name,
                    avatar: row.avatar,
                },
            )
        })
        .collect())
}

/// One `comp_info` row: a person's display name and avatar.
struct CompInfoRow {
    entity: String,
    name: Option<String>,
    avatar: Option<String>,
}

fn scan_room_activity(
    conn: &Connection,
    room_ids: &[String],
) -> Result<IndexMap<String, ThreadActivity>, XrpcError> {
    let sql = "
      with rooms as (select distinct cr.entity as id, p.head as parent, cr.label as label, ci.name as name
                       from comp_room cr
                       left join comp_info ci on ci.entity = cr.entity
                       left join edges p
                              on p.tail = cr.entity and p.label = 'link'
                             and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
                      where cr.entity in (select value from json_each(?1))),
           entries as (
             select e.id as id, e.room as room,
                    coalesce(a.tail, fa.tail) as did,
                    coalesce(cc.timestamp, fcc.timestamp) as ts,
                    coalesce(cc.mime_type, fcc.mime_type) as mime_type,
                    coalesce(cc.data, fcc.data) as data
               from entities e
               left join comp_content cc on cc.entity = e.id
               left join edges a  on a.head  = e.id and a.label  = 'author'
               left join edges f  on f.head  = e.id and f.label  = 'forward'
               left join comp_content fcc on fcc.entity = f.tail
               left join edges fa on fa.head = f.tail and fa.label = 'author'
              where e.room in (select id from rooms)
                and (cc.entity is not null or f.tail is not null)),
           latest as (
             select room, id, ts, mime_type, data from (
               select room, id, ts, mime_type, data,
                      row_number() over (partition by room order by ts desc, id desc) as rn
                 from entries
                where ts is not null
             ) where rn = 1),
           recent as (
             select room, did, ts, row_number() over (
                      partition by room order by ts desc, did asc) as rn
               from (select room, did, max(ts) as ts
                       from entries
                      where did is not null
                      group by room, did))
      select r.id as room_id,
             r.parent as parent_id,
             r.label as label,
             r.name as name,
             l.id as latest_message_id,
             l.ts as latest_ts,
             l.mime_type as latest_mime_type,
             l.data as latest_data,
             coalesce(la.tail, lfa.tail) as latest_author_did,
             (select json_group_array(json_object('did', did, 'ts', ts) order by ts desc, did asc)
                from (select did, ts from recent
                       where room = r.id and rn <= 3)) as latest_members
        from rooms r
        left join latest l on l.room = r.id
        left join edges la on la.head = l.id and la.label = 'author'
        left join edges lf on lf.head = l.id and lf.label = 'forward'
        left join edges lfa on lfa.head = lf.tail and lfa.label = 'author'";

    let mut stmt = conn.prepare(sql)?;
    let json = serde_json::to_string(room_ids).unwrap_or_else(|_| "[]".to_owned());
    let rows: Vec<ScanRow> = stmt
        .query_map([json], |row| {
            Ok(ScanRow {
                room_id: row.get(0)?,
                parent_id: row.get(1)?,
                label: row.get(2)?,
                name: row.get(3)?,
                latest_message_id: row.get(4)?,
                latest_ts: row.get(5)?,
                latest_mime_type: row.get(6)?,
                latest_data: row.get(7)?,
                latest_author_did: row.get(8)?,
                latest_members: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut dids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for row in &rows {
        for did in parse_authors(row.latest_members.as_deref()) {
            if seen.insert(did.clone()) {
                dids.push(did);
            }
        }
        if let Some(did) = &row.latest_author_did {
            if seen.insert(did.clone()) {
                dids.push(did.clone());
            }
        }
    }
    let info = load_info(conn, &dids)?;

    let mut out = IndexMap::new();
    for row in rows {
        let latest_members = parse_authors(row.latest_members.as_deref())
            .into_iter()
            .map(|did| {
                let info = info.get(&did).cloned().unwrap_or_default();
                Member {
                    did,
                    name: info.name,
                    avatar: info.avatar,
                }
            })
            .collect();
        let latest_message = match (&row.latest_message_id, &row.latest_author_did) {
            (Some(id), Some(author_did)) => {
                let info = info.get(author_did).cloned().unwrap_or_default();
                Some(LatestMessage {
                    id: id.clone(),
                    content: messages::decode_board_preview(
                        row.latest_mime_type.as_deref(),
                        row.latest_data.as_deref(),
                    ),
                    author: Member {
                        did: author_did.clone(),
                        name: info.name,
                        avatar: info.avatar,
                    },
                    timestamp: row.latest_ts.map(time::iso_from_ms),
                })
            }
            _ => None,
        };
        out.insert(
            row.room_id.clone(),
            ThreadActivity {
                id: row.room_id,
                kind: if row.label.as_deref() == Some("space.roomy.channel") {
                    "channel"
                } else {
                    "thread"
                },
                name: row.name,
                canonical_parent: row.parent_id,
                latest_timestamp: row.latest_ts.map(time::iso_from_ms),
                latest_members,
                latest_message,
            },
        );
    }

    for room_id in room_ids {
        out.entry(room_id.clone()).or_insert_with(|| blank(room_id));
    }

    Ok(out)
}

struct ScanRow {
    room_id: String,
    parent_id: Option<String>,
    label: Option<String>,
    name: Option<String>,
    latest_message_id: Option<String>,
    latest_ts: Option<i64>,
    latest_mime_type: Option<String>,
    latest_data: Option<Vec<u8>>,
    latest_author_did: Option<String>,
    latest_members: Option<String>,
}

/// The DIDs a `recent_authors` JSON array carries, in its order.
///
/// An entry whose `ts` is not a number or null is not an author row and is
/// dropped, as the appserver's parser drops it.
fn parse_authors(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Ok(JsonValue::Array(entries)) = serde_json::from_str(raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let Some(did) = object.get("did").and_then(|v| v.as_str()) else {
            continue;
        };
        match object.get("ts") {
            Some(JsonValue::Null) | Some(JsonValue::Number(_)) | None => {}
            _ => continue,
        }
        out.push(did.to_owned());
    }
    out
}

/// One sidebar thread's name, activity and canonical parent.
pub struct ThreadMeta {
    /// The thread's display name, when it has one.
    pub name: Option<String>,
    /// When the thread last saw a message, ISO-formatted.
    pub latest_timestamp: Option<String>,
    /// Up to three of the thread's most recent authors.
    pub latest_members: Vec<Member>,
    /// The canonical parent channel, when the thread has one.
    pub canonical_parent: Option<String>,
}

/// The activity and parent of every thread in `thread_ids` that has one.
pub fn resolve_threads_by_ids(
    conn: &Connection,
    stores: &dyn GlobalStores,
    thread_ids: &[String],
) -> Result<HashMap<String, ThreadMeta>, XrpcError> {
    let mut out = HashMap::new();
    if thread_ids.is_empty() {
        return Ok(out);
    }

    let placeholders = thread_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut stmt = conn.prepare(&format!(
        "select tail, head from edges
          where tail in ({placeholders})
            and label = 'link'
            and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1"
    ))?;
    let parents: Vec<(String, String)> = stmt
        .query_map(rusqlite::params_from_iter(thread_ids.iter()), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let parent_map: HashMap<_, _> = parents.into_iter().collect();

    let activity = fetch_room_activity(conn, stores, thread_ids)?;

    let mut info_dids: Vec<String> = thread_ids.to_vec();
    let mut seen: HashSet<String> = thread_ids.iter().cloned().collect();
    for entry in activity.values() {
        for member in &entry.latest_members {
            if seen.insert(member.did.clone()) {
                info_dids.push(member.did.clone());
            }
        }
    }
    let info = load_info(conn, &info_dids)?;

    for thread_id in thread_ids {
        let entry = activity.get(thread_id);
        let name = info.get(thread_id).and_then(|entry| entry.name.clone());
        let latest_members = entry
            .map(|e| {
                e.latest_members
                    .iter()
                    .map(|m| {
                        let info = info.get(&m.did).cloned().unwrap_or_default();
                        Member {
                            did: m.did.clone(),
                            name: info.name,
                            avatar: info.avatar,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.insert(
            thread_id.clone(),
            ThreadMeta {
                name,
                latest_timestamp: entry.and_then(|e| e.latest_timestamp.clone()),
                latest_members,
                canonical_parent: parent_map.get(thread_id).cloned(),
            },
        );
    }

    // Global profile overlay.
    for meta in out.values_mut() {
        for member in &mut meta.latest_members {
            apply_profile(member, stores);
        }
    }

    Ok(out)
}

/// Utility used by the room-metadata badge: the canonical parent of a room.
pub fn canonical_parent(conn: &Connection, room_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "select head from edges
          where tail = ? and label = 'link'
            and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
          limit 1",
        [room_id],
        |row| row.get(0),
    )
    .optional()
}
