//! `space.roomy.room.getMetadata`, `getMessages`, `getThreads`, `getLinks`.

use rusqlite::{Connection, OptionalExtension};

use crate::access;
use crate::dto::{
    GetLinksResult, GetMessagesResult, GetRoomThreadsResult, RoomMetadata, RoomThreadRow,
};
use crate::error::XrpcError;
use crate::handlers::common;
use crate::handlers::common::Context;
use crate::ids::RoomId;
use crate::params::Params;
use crate::queries::links;
use crate::queries::messages;
use crate::queries::messages::SelectScope;
use crate::queries::thread_activity;
use crate::queries::thread_activity::{ListActivity, ThreadScope};
use crate::state::XrpcState;

/// `room.getMetadata`: the room's identity, kind and the caller's access.
pub fn get_metadata(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<RoomMetadata, XrpcError> {
    let room_id = RoomId::try_from(params.require_string("roomId")?)?;
    let did = ctx.did();

    state.db.with(|conn| {
        let access = access::require_room_read(conn, room_id.as_str(), did)?;

        let row = conn
            .query_row(
                "select ci.name as name, cr.label as label
                   from comp_room cr
                   left join comp_info ci on ci.entity = cr.entity
                  where cr.entity = ?",
                [room_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let (name, label) = row.unwrap_or((None, None));

        let (unread, last_read, unread_thread_count) = match did {
            Some(_) => {
                let unread = common::unread_count(conn, &ctx.positions, room_id.as_str())?;
                let last_read = ctx.positions.last_read(room_id.as_str());
                let unread_threads = if access.parent_channel_id.is_none() {
                    channel_unread_thread_count(conn, ctx, room_id.as_str())?
                } else {
                    0
                };
                (unread, last_read, unread_threads)
            }
            None => (0, None, 0),
        };

        Ok(RoomMetadata {
            name,
            kind: strip_label(label.as_deref()),
            space_id: access.space_id.unwrap_or_default(),
            parent_channel_id: access.parent_channel_id,
            default_access: access.default_access.as_str().to_owned(),
            can_read: access.can_read,
            can_write: access.can_write,
            last_read,
            unread_count: unread,
            unread_thread_count,
        })
    })
}

/// `getChannelUnreadThreadCount`: engaged threads canonically linked from a
/// channel, readable by the caller, with messages past their watermark.
fn channel_unread_thread_count(
    conn: &Connection,
    ctx: &Context,
    channel_id: &str,
) -> Result<i64, XrpcError> {
    let engaged: Vec<String> = ctx
        .positions
        .iter()
        .map(|(room_id, _)| room_id.clone())
        .collect();
    if engaged.is_empty() {
        return Ok(0);
    }
    let json = serde_json::to_string(&engaged).unwrap_or_default();
    let mut stmt = conn.prepare(
        "select link_e.tail as thread_id
           from edges link_e
          where link_e.head = ?
            and link_e.label = 'link'
            and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
            and link_e.tail in (select value from json_each(?2))",
    )?;
    let linked = stmt
        .query_map((channel_id, json), |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if linked.is_empty() {
        return Ok(0);
    }

    let did = ctx.did();
    let mut count = 0;
    for thread_id in linked {
        let access = access::room_access(conn, &thread_id, did)?;
        if !access.can_read {
            continue;
        }
        if common::unread_count(conn, &ctx.positions, &thread_id)? > 0 {
            count += 1;
        }
    }
    Ok(count)
}

fn strip_label(label: Option<&str>) -> String {
    let Some(label) = label else {
        return String::new();
    };
    label
        .strip_prefix("space.roomy.")
        .unwrap_or(label)
        .to_owned()
}

/// `room.getMessages`: one page of the room's messages.
pub fn get_messages(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetMessagesResult, XrpcError> {
    let room_id = RoomId::try_from(params.require_string("roomId")?)?;
    let limit = params.limit(50)?;
    let cursor = params.cursor()?;

    state.db.with(|conn| {
        access::require_room_read(conn, room_id.as_str(), ctx.did())?;
        let result = messages::select_messages(
            conn,
            state.stores.as_ref(),
            SelectScope::Room {
                room_id: room_id.as_str(),
                limit: limit.get(),
                cursor: cursor.as_ref().map(|c| c.as_str()),
            },
            ctx.did(),
            &[],
        )?;
        Ok(GetMessagesResult {
            messages: result.messages,
            cursor: result.next_cursor,
        })
    })
}

/// `room.getThreads`: the channel's threads the caller may read.
pub fn get_threads(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetRoomThreadsResult, XrpcError> {
    let room_id = RoomId::try_from(params.require_string("roomId")?)?;
    let limit = params.limit(50)?;
    let cursor = params.cursor()?;
    let search = params.optional_string("search");
    let did = ctx.did();

    state.db.with(|conn| {
        access::require_room_read(conn, room_id.as_str(), did)?;

        let page = thread_activity::list_thread_activity(
            conn,
            state.stores.as_ref(),
            ListActivity {
                scope: ThreadScope::Channel(room_id.as_str()),
                limit: limit.get(),
                cursor: cursor.as_ref().map(|c| c.as_str()),
                search: search.as_deref(),
                kinds: &["thread"],
            },
        )?;

        let mut threads = Vec::new();
        for thread in &page.activities {
            let access = access::room_access(conn, &thread.id, did)?;
            if !access.can_read {
                continue;
            }
            let unread = common::unread_count(conn, &ctx.positions, &thread.id)?;
            let engaged = ctx.positions.is_engaged(&thread.id);
            threads.push(RoomThreadRow {
                id: thread.id.clone(),
                activity: thread.to_dto(),
                unread_count: unread,
                unread: thread.latest_timestamp.is_some() && (unread > 0 || !engaged),
                name: thread.name.clone(),
                canonical_parent: thread.canonical_parent.clone(),
            });
        }

        Ok(GetRoomThreadsResult {
            threads,
            cursor: page.next_cursor,
        })
    })
}

/// `room.getLinks`: the room's link rows, deduped by canonical URL.
pub fn get_links(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetLinksResult, XrpcError> {
    let room_id = RoomId::try_from(params.require_string("roomId")?)?;
    let limit = params.limit(50)?;
    let cursor = params.cursor()?;

    state.db.with(|conn| {
        access::require_room_read(conn, room_id.as_str(), ctx.did())?;

        let page = links::list_links(
            conn,
            room_id.as_str(),
            limit.get(),
            cursor.as_ref().map(|c| c.as_str()),
        )?;
        // No block set on the worker: the hidden-author filter is identity
        // here, exactly as the appserver's when the caller hides nobody.
        let deduped = links::dedupe_links(page.links);
        let mut next_cursor = None;
        if page.has_more && !deduped.is_empty() {
            next_cursor = links::cursor_for_row(deduped.last());
        }

        Ok(GetLinksResult {
            links: links::build_link_rows(state.stores.as_ref(), deduped),
            cursor: next_cursor,
        })
    })
}
