//! `space.roomy.search.rooms`.
//!
//! Name search over one space's channels and threads: a case-insensitive
//! substring match on the room name, filtered by the caller's read access.
//! Channels come first, then threads, each alphabetically by name; the whole
//! answer is capped at `limit` rows across both kinds. There is no cursor —
//! the caller is a picker that needs the top matches only.
//!
//! A thread inherits its access from its canonical parent channel, so the
//! canonical parent's id and name travel with each thread row.
//!
//! Unread state comes from the caller's read positions: this worker holds no
//! read state, so the watermarks and with-thread engagement arrive on
//! `x-roomy-read-positions` and are matched against `entities` here.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::access;
use crate::dto::RoomActivityDto;
use crate::error::XrpcError;
use crate::handlers::common;
use crate::handlers::common::Context;
use crate::params::Params;
use crate::queries::thread_activity;
use crate::state::XrpcState;

/// One matched room.
///
/// Field order is the wire order. The appserver builds a channel row and a
/// thread row in the same order, then assigns `channelId`/`channelName` onto a
/// thread row afterwards, so those two keys follow `activity` and appear only
/// on threads.
#[derive(Debug, Clone, Serialize)]
pub struct RoomSearchResult {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(rename = "canWrite")]
    pub can_write: bool,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    pub unread: bool,
    pub activity: RoomActivityDto,
    #[serde(rename = "channelId", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(rename = "channelName", skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

/// `search.rooms`'s response body.
#[derive(Debug, Clone, Serialize)]
pub struct SearchRoomsResult {
    pub rooms: Vec<RoomSearchResult>,
}

/// `search.rooms`: the space's channels and threads whose name matches `q`.
pub fn search_rooms(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<SearchRoomsResult, XrpcError> {
    let space_id = common::parse_space(params)?;
    let query = params.require_string("q")?;
    let query = query.trim();
    if query.is_empty() {
        return Err(XrpcError::invalid_request(
            "Param q must be a non-empty string",
        ));
    }
    let limit = params
        .optional_int("limit", Some(1), Some(100), Some(20))?
        .unwrap_or(20);
    let like = format!("%{query}%");
    let did = ctx.did();

    state.db.with(|conn| {
        access::require_space_read(conn, space_id.as_str(), did)?;

        let mut rooms: Vec<RoomSearchResult> = Vec::new();

        // Channels first, alphabetically.
        for (id, name) in named_rooms(conn, space_id.as_str(), CHANNEL, &like, limit)? {
            let access = access::room_access(conn, &id, did)?;
            if !access.can_read {
                continue;
            }
            rooms.push(RoomSearchResult {
                id,
                name,
                kind: "channel".to_owned(),
                can_write: access.can_write,
                // Filled in by the activity pass below.
                unread_count: 0,
                unread: false,
                activity: empty_activity(),
                channel_id: None,
                channel_name: None,
            });
            if rooms.len() as i64 >= limit {
                break;
            }
        }

        // Threads next, alphabetically, carrying their canonical parent.
        let threads = named_rooms(conn, space_id.as_str(), THREAD, &like, limit)?;
        if !threads.is_empty() {
            let thread_ids: Vec<&str> = threads.iter().map(|(id, _)| id.as_str()).collect();
            let parents = canonical_parents(conn, &thread_ids)?;
            let parent_ids: Vec<String> = parents.values().cloned().collect();
            let parent_names = room_names(conn, &parent_ids)?;

            for (id, name) in threads {
                if rooms.len() as i64 >= limit {
                    break;
                }
                let access = access::room_access(conn, &id, did)?;
                if !access.can_read {
                    continue;
                }
                let parent = parents.get(&id);
                let channel_id = parent.cloned();
                let channel_name = parent.and_then(|parent| parent_names.get(parent).cloned());
                rooms.push(RoomSearchResult {
                    id,
                    name,
                    kind: "thread".to_owned(),
                    can_write: access.can_write,
                    // Filled in by the activity pass below.
                    unread_count: 0,
                    unread: false,
                    activity: empty_activity(),
                    channel_id,
                    channel_name,
                });
            }
        }

        // Activity and unread state for the matched rooms, in one pass.
        if !rooms.is_empty() {
            let room_ids: Vec<String> = rooms.iter().map(|room| room.id.clone()).collect();
            let activity =
                thread_activity::fetch_room_activity(conn, state.stores.as_ref(), &room_ids)?;
            for room in &mut rooms {
                let act = activity.get(&room.id);
                if let Some(act) = act {
                    room.activity = act.to_dto();
                }
                let unread = common::unread_count(conn, &ctx.positions, &room.id)?;
                room.unread_count = unread;
                let has_activity = act.and_then(|act| act.latest_timestamp.as_ref()).is_some();
                let engaged = ctx.positions.is_engaged(&room.id);
                // Channels flag plain unread counts; threads are unread until
                // the caller has both read them and been active in them.
                room.unread = has_activity && (unread > 0 || (room.kind == "thread" && !engaged));
            }
        }

        Ok(SearchRoomsResult { rooms })
    })
}

const CHANNEL: &str = "space.roomy.channel";
const THREAD: &str = "space.roomy.thread";

fn empty_activity() -> RoomActivityDto {
    RoomActivityDto {
        latest_members: Vec::new(),
        latest_timestamp: None,
        latest_message: None,
    }
}

/// Live, named rooms of one kind in the space, alphabetically by name.
///
/// The `like` filter runs against the joined `comp_info.name`, which is
/// non-null for every row it admits.
fn named_rooms(
    conn: &Connection,
    space_id: &str,
    label: &str,
    like: &str,
    limit: i64,
) -> Result<Vec<(String, String)>, XrpcError> {
    let mut stmt = conn.prepare(
        "select e.id as id, ci.name as name
           from entities e
           join comp_room cr on cr.entity = e.id
           join comp_info ci on ci.entity = e.id
          where e.stream_id = ?
            and cr.label = ?
            and coalesce(cr.deleted, 0) = 0
            and ci.name like ?
          order by ci.name asc
          limit ?",
    )?;
    let rows = stmt
        .query_map((space_id, label, like, limit), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The canonical parent channel of each thread that has one.
fn canonical_parents(
    conn: &Connection,
    thread_ids: &[&str],
) -> Result<HashMap<String, String>, XrpcError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let json = serde_json::to_string(thread_ids).unwrap_or_default();
    let mut stmt = conn.prepare(
        "select tail, head from edges
          where tail in (select value from json_each(?1))
            and label = 'link'
            and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1",
    )?;
    let rows = stmt
        .query_map([json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().collect())
}

/// Names of the given rooms, for the ones that have one.
fn room_names(
    conn: &Connection,
    room_ids: &[String],
) -> Result<HashMap<String, String>, XrpcError> {
    if room_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let json = serde_json::to_string(room_ids).unwrap_or_default();
    let mut stmt = conn.prepare(
        "select e.id as id, ci.name as name
           from entities e
           left join comp_info ci on ci.entity = e.id
          where e.id in (select value from json_each(?1))",
    )?;
    let rows = stmt
        .query_map([json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut names = HashMap::new();
    for (id, name) in rows {
        if let Some(name) = name {
            names.insert(id, name);
        }
    }
    Ok(names)
}
