//! `space.roomy.space.getMetadata` and `space.roomy.space.getThreads`.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension};

use crate::access::{require_space_read, room_access, space_access};
use crate::dto::{
    ActiveSidebarThread, ActiveThreadActivity, DeletedRoom, GetSpaceThreadsResult, JoinPolicy,
    Sidebar, SidebarCategory, SidebarChannel, SpaceMetadata, SpaceThreadRow, ThreadMember,
};
use crate::error::XrpcError;
use crate::handlers::common::{parse_space, unread_count, Context};
use crate::ids::Limit;
use crate::params::Params;
use crate::queries::thread_activity::{
    list_thread_activity, resolve_threads_by_ids, ListActivity, ThreadScope,
};
use crate::state::XrpcState;

const ACTIVE_WINDOW_MS: i64 = 120 * 60 * 60 * 1000;
const MAX_ACTIVE_THREADS: usize = 8;

struct RoomListing {
    id: String,
    name: Option<String>,
    label: Option<String>,
}

pub fn get_metadata(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<SpaceMetadata, XrpcError> {
    let space_id = parse_space(params)?;
    let did = ctx.did();

    state.db.with(|conn| {
        let access = space_access(conn, space_id.as_str(), did)?;
        if access.is_banned {
            return Err(XrpcError::forbidden("Caller is banned from this space"));
        }

        let space_row = conn
            .query_row(
                "select
                   ci.name as name,
                   ci.avatar as avatar,
                   ci.description as description,
                   cs.allow_public_join as allow_public_join,
                   cs.allow_member_invites as allow_member_invites,
                   cs.suggest_to_others as suggest_to_others,
                   cs.sidebar_config as sidebar_config
                 from comp_space cs
                 left join comp_info ci on ci.entity = cs.entity
                where cs.entity = ?",
                [space_id.as_str()],
                |row| {
                    Ok(SpaceRow {
                        name: row.get(0)?,
                        avatar: row.get(1)?,
                        description: row.get(2)?,
                        allow_public_join: row.get(3)?,
                        allow_member_invites: row.get(4)?,
                        suggest_to_others: row.get(5)?,
                        sidebar_config: row.get(6)?,
                    })
                },
            )
            .optional()?;
        let Some(space_row) = space_row else {
            return Err(XrpcError::not_found(format!("Space not found: {space_id}")));
        };

        let handle = state.stores.space_handle(space_id.as_str());
        let config = parse_sidebar_config(&space_row.sidebar_config);

        let mut categories = Vec::new();
        let mut orphans = Vec::new();
        let mut voice_rooms = Vec::new();
        let mut unread_room_count = 0;
        let mut unread_thread_count = 0;

        if did.is_some() && (access.is_member || access.is_admin) {
            let listings = list_rooms(conn, space_id.as_str())?;
            let channels: Vec<&RoomListing> = listings
                .iter()
                .filter(|room| room.label.as_deref() == Some("space.roomy.channel"))
                .collect();
            let voices: Vec<&RoomListing> = listings
                .iter()
                .filter(|room| room.label.as_deref() == Some("space.roomy.voice"))
                .collect();

            let mut access_by_room = HashMap::new();
            for room in channels.iter().chain(voices.iter()) {
                access_by_room.insert(room.id.clone(), room_access(conn, &room.id, did)?);
            }
            let accessible: Vec<String> = channels
                .iter()
                .filter(|room| access_by_room.get(&room.id).is_some_and(|a| a.can_read))
                .map(|room| room.id.clone())
                .collect();

            let thread_ids = engaged_threads(conn, space_id.as_str(), ctx)?;

            // Aggregates over accessible channels + engaged threads.
            let mut rooms_with_unread = 0;
            let mut thread_rooms_with_unread = 0;
            for id in accessible.iter().chain(thread_ids.iter()) {
                if unread_count(conn, &ctx.positions, id)? > 0 {
                    rooms_with_unread += 1;
                    if thread_ids.contains(id) {
                        thread_rooms_with_unread += 1;
                    }
                }
            }
            unread_room_count = rooms_with_unread - thread_rooms_with_unread;
            unread_thread_count = thread_rooms_with_unread;

            let room_by_id: HashMap<&str, &RoomListing> = listings
                .iter()
                .map(|room| (room.id.as_str(), room))
                .collect();

            let build_channel = |id: &str| -> Result<Option<SidebarChannel>, XrpcError> {
                let Some(row) = room_by_id.get(id) else {
                    return Ok(None);
                };
                let Some(acc) = access_by_room.get(id) else {
                    return Ok(None);
                };
                if !acc.can_read {
                    return Ok(None);
                }
                Ok(Some(SidebarChannel {
                    id: row.id.clone(),
                    name: row.name.clone(),
                    default_access: acc.default_access.as_str().to_owned(),
                    can_read: acc.can_read,
                    can_write: acc.can_write,
                    unread_count: unread_count(conn, &ctx.positions, id)?,
                    last_read: ctx.positions.last_read(id),
                    active_threads: None,
                }))
            };

            for voice in &voices {
                if let Some(channel) = build_channel(&voice.id)? {
                    voice_rooms.push(channel);
                }
            }

            let mut referenced: HashSet<String> = HashSet::new();
            for (position, category) in config.iter().enumerate() {
                let mut children = Vec::new();
                for child_id in &category.children {
                    referenced.insert(child_id.clone());
                    if room_by_id.contains_key(child_id.as_str()) {
                        if let Some(channel) = build_channel(child_id)? {
                            children.push(channel);
                        }
                    }
                    // Federated channels are resolved by the gateway; the
                    // worker serves native rooms only.
                }
                categories.push(SidebarCategory {
                    id: category.id.clone(),
                    name: category.name.clone(),
                    position,
                    channels: children,
                });
            }

            for room in &channels {
                if referenced.contains(&room.id) {
                    continue;
                }
                if let Some(channel) = build_channel(&room.id)? {
                    orphans.push(channel);
                }
            }

            // Active threads: engaged threads the gateway reported activity for.
            let mut active = Vec::new();
            let now = now_ms();
            for (room_id, entry) in ctx.positions.iter() {
                let Some(last_active_at) = entry.last_active_at else {
                    continue;
                };
                if last_active_at <= now - ACTIVE_WINDOW_MS {
                    continue;
                }
                active.push((room_id.clone(), last_active_at));
            }
            active.sort_by_key(|(_, last_active_at)| std::cmp::Reverse(*last_active_at));
            active.truncate(MAX_ACTIVE_THREADS);
            let active_ids: Vec<String> = active.iter().map(|(id, _)| id.clone()).collect();
            let mut confirmed = HashSet::new();
            if !active_ids.is_empty() {
                let json = serde_json::to_string(&active_ids).unwrap_or_default();
                let mut stmt = conn.prepare(
                    "select e.id as id from entities e
                       join comp_room cr on cr.entity = e.id
                      where e.id in (select value from json_each(?1))
                        and e.stream_id = ?
                        and cr.label = 'space.roomy.thread'
                        and coalesce(cr.deleted, 0) = 0",
                )?;
                let rows = stmt
                    .query_map((json, space_id.as_str()), |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                confirmed.extend(rows);
            }
            let active_ids: Vec<String> = active
                .into_iter()
                .map(|(id, _)| id)
                .filter(|id| confirmed.contains(id))
                .collect();

            if !active_ids.is_empty() {
                let metas = resolve_threads_by_ids(conn, state.stores.as_ref(), &active_ids)?;
                let mut by_parent: HashMap<String, Vec<ActiveSidebarThread>> = HashMap::new();
                for thread_id in &active_ids {
                    let Some(meta) = metas.get(thread_id) else {
                        continue;
                    };
                    let acc = room_access(conn, thread_id, did)?;
                    if !acc.can_read {
                        continue;
                    }
                    let Some(parent) = meta.canonical_parent.clone() else {
                        continue;
                    };
                    by_parent
                        .entry(parent)
                        .or_default()
                        .push(ActiveSidebarThread {
                            id: thread_id.clone(),
                            name: meta.name.clone(),
                            activity: ActiveThreadActivity {
                                latest_timestamp: meta.latest_timestamp.clone(),
                                latest_members: meta
                                    .latest_members
                                    .iter()
                                    .map(|m| ThreadMember {
                                        did: m.did.clone(),
                                        name: m.name.clone(),
                                        avatar: m.avatar.clone(),
                                    })
                                    .collect(),
                            },
                            can_read: acc.can_read,
                            can_write: acc.can_write,
                            unread_count: unread_count(conn, &ctx.positions, thread_id)?,
                            last_read: ctx.positions.last_read(thread_id),
                        });
                }
                for category in &mut categories {
                    for channel in &mut category.channels {
                        channel.active_threads = by_parent.remove(&channel.id);
                    }
                }
                for channel in &mut orphans {
                    channel.active_threads = by_parent.remove(&channel.id);
                }
            }
        }

        let deleted_rooms = if params.raw("includeDeleted") == Some("true") {
            let mut stmt = conn.prepare(
                "select e.id as id, ci.name as name
                   from entities e
                   join comp_room cr on cr.entity = e.id
                   left join comp_info ci on ci.entity = e.id
                  where e.stream_id = ?
                    and cr.label = 'space.roomy.channel'
                    and cr.deleted = 1",
            )?;
            let rows = stmt
                .query_map([space_id.as_str()], |row| {
                    Ok(DeletedRoom {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Some(rows)
        } else {
            None
        };

        Ok(SpaceMetadata {
            name: space_row.name,
            avatar: space_row.avatar,
            description: space_row.description,
            handle,
            join_policy: JoinPolicy {
                allow_public_join: space_row.allow_public_join != Some(0),
                allow_member_invites: space_row.allow_member_invites == Some(1),
            },
            suggest_to_others: space_row.suggest_to_others.map(|value| value == 1),
            is_member: access.is_member,
            is_admin: access.is_admin,
            unread_room_count,
            unread_thread_count,
            sidebar: Sidebar {
                categories,
                orphans,
            },
            voice_rooms,
            deleted_rooms,
        })
    })
}

struct SpaceRow {
    name: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
    allow_public_join: Option<i64>,
    allow_member_invites: Option<i64>,
    suggest_to_others: Option<i64>,
    sidebar_config: String,
}

struct SidebarCategoryConfig {
    id: Option<String>,
    name: String,
    children: Vec<String>,
}

fn parse_sidebar_config(raw: &str) -> Vec<SidebarCategoryConfig> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(categories) = value.get("categories").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    categories
        .iter()
        .filter_map(|category| {
            let name = category.get("name")?.as_str()?.to_owned();
            let id = category
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let children = category
                .get("children")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            Some(SidebarCategoryConfig { id, name, children })
        })
        .collect()
}

fn list_rooms(conn: &Connection, space_id: &str) -> rusqlite::Result<Vec<RoomListing>> {
    let mut stmt = conn.prepare(
        "select e.id as id, ci.name as name, cr.label as label
           from entities e
           join comp_room cr on cr.entity = e.id
           left join comp_info ci on ci.entity = e.id
          where e.stream_id = ?
            and cr.label in ('space.roomy.channel', 'space.roomy.voice', 'space.roomy.page')
            and coalesce(cr.deleted, 0) = 0",
    )?;
    let rows = stmt
        .query_map([space_id], |row| {
            Ok(RoomListing {
                id: row.get(0)?,
                name: row.get(1)?,
                label: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Engaged threads in the space: a position for a live, non-deleted thread.
fn engaged_threads(
    conn: &Connection,
    space_id: &str,
    ctx: &Context,
) -> Result<Vec<String>, XrpcError> {
    let ids: Vec<String> = ctx
        .positions
        .iter()
        .map(|(room_id, _)| room_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(&ids).unwrap_or_default();
    let mut stmt = conn.prepare(
        "select e.id as id
           from entities e
           join comp_room cr on cr.entity = e.id
          where e.id in (select value from json_each(?1))
            and e.stream_id = ?
            and cr.label = 'space.roomy.thread'",
    )?;
    let rows = stmt
        .query_map((json, space_id), |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn get_threads(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetSpaceThreadsResult, XrpcError> {
    let space_id = parse_space(params)?;
    let limit = params.limit(50)?;
    let cursor = params.cursor()?;
    let search = params.optional_string("search");
    let did = ctx.did();

    state.db.with(|conn| {
        require_space_read(conn, space_id.as_str(), did)?;

        let (all, next_cursor) = list_thread_activity(
            conn,
            state.stores.as_ref(),
            ListActivity {
                scope: ThreadScope::Space(space_id.as_str()),
                limit: limit_static(limit),
                cursor: cursor.as_ref().map(|c| c.as_str()),
                search: search.as_deref(),
                kinds: &["thread", "channel"],
            },
        )?;

        // Channel names for threads' canonical parents.
        let mut parent_ids: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for thread in &all {
            if let Some(parent) = &thread.canonical_parent {
                if seen.insert(parent.clone()) {
                    parent_ids.push(parent.clone());
                }
            }
        }
        let mut channel_names = HashMap::new();
        if !parent_ids.is_empty() {
            let json = serde_json::to_string(&parent_ids).unwrap_or_default();
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
            for (id, name) in rows {
                if let Some(name) = name {
                    channel_names.insert(id, name);
                }
            }
        }

        let mut rooms = Vec::new();
        for thread in &all {
            let access = room_access(conn, &thread.id, did)?;
            if !access.can_read {
                continue;
            }
            let unread = unread_count(conn, &ctx.positions, &thread.id)?;
            let is_thread = thread.kind == "thread";
            let engaged = ctx.positions.is_engaged(&thread.id);
            rooms.push(SpaceThreadRow {
                id: thread.id.clone(),
                kind: thread.kind.to_owned(),
                activity: thread.to_dto(),
                unread_count: unread,
                unread: thread.latest_timestamp.is_some()
                    && (unread > 0 || (is_thread && !engaged)),
                name: thread.name.clone(),
                channel: if is_thread {
                    thread.canonical_parent.clone()
                } else {
                    None
                },
                channel_name: if is_thread {
                    thread
                        .canonical_parent
                        .as_ref()
                        .and_then(|parent| channel_names.get(parent).cloned())
                } else {
                    None
                },
            });
        }

        Ok(GetSpaceThreadsResult {
            rooms,
            cursor: next_cursor,
        })
    })
}

fn limit_static(limit: Limit) -> usize {
    limit.get()
}
