//! Badge summaries and the space-wide link index:
//! `space.roomy.space.getSpaceSummary`, `space.roomy.space.getLinks`, and
//! `space.roomy.room.getRoomSummary`.
//!
//! The two summaries are the cheap counterpart of `getMetadata`: a badge that
//! renders an internal link needs a label, an avatar and a room kind, not a
//! sidebar tree or a per-channel access sweep.
//!
//! The space link index is the cross-room view of the same rows
//! `room.getLinks` serves: paginated newest-first, deduped by canonical URL,
//! and filtered to the rooms the caller may read.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::access::{require_room_read, require_space_read, room_access, space_access};
use crate::dto::GetLinksResult;
use crate::error::XrpcError;
use crate::handlers::common::{parse_space, Context};
use crate::ids::RoomId;
use crate::params::Params;
use crate::queries::links::{build_link_rows, cursor_for_row, dedupe_links, LinkPage, RawLinkRow};
use crate::state::XrpcState;

/// A space's badge fields.
#[derive(Debug, Clone, Serialize)]
pub struct GetSpaceSummaryResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

/// A room's badge fields: its display name, its kind, and the space it
/// belongs to.
#[derive(Debug, Clone, Serialize)]
pub struct GetRoomSummaryResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: String,
    #[serde(rename = "spaceId")]
    pub space_id: String,
}

pub fn get_space_summary(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetSpaceSummaryResult, XrpcError> {
    let space_id = parse_space(params)?;
    let did = ctx.did();

    state.db.with(|conn| {
        // A ban is the only denial badges observe: public spaces are readable
        // anonymously, and membership/admin status changes nothing a badge
        // shows.
        let access = space_access(conn, space_id.as_str(), did)?;
        if access.is_banned {
            return Err(XrpcError::forbidden("Caller is banned from this space"));
        }

        let row = conn
            .query_row(
                "select ci.name as name, ci.avatar as avatar
                   from comp_space cs
                   left join comp_info ci on ci.entity = cs.entity
                  where cs.entity = ?",
                [space_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;

        let Some((name, avatar)) = row else {
            return Err(XrpcError::not_found(format!("Space not found: {space_id}")));
        };

        Ok(GetSpaceSummaryResult { name, avatar })
    })
}

pub fn get_links(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetLinksResult, XrpcError> {
    let space_id = parse_space(params)?;
    let limit = params.limit(50)?;
    let cursor = params.cursor()?;
    let did = ctx.did();

    state.db.with(|conn| {
        require_space_read(conn, space_id.as_str(), did)?;

        let page = list_space_links(
            conn,
            space_id.as_str(),
            limit.get(),
            cursor.as_ref().map(|cursor| cursor.as_str()),
        )?;

        // A links view spans every room in the space, so every row's room must
        // be readable: one access decision per distinct room, applied before
        // dedup so a URL seen in a readable room is never suppressed in favour
        // of an unreadable duplicate.
        let mut can_read: HashMap<String, bool> = HashMap::new();
        let mut readable: Vec<RawLinkRow> = Vec::with_capacity(page.links.len());
        for row in page.links {
            let readable_room = match can_read.get(row.room_id.as_str()) {
                Some(can_read) => *can_read,
                None => {
                    let verdict = room_access(conn, row.room_id.as_str(), did)?.can_read;
                    can_read.insert(row.room_id.clone(), verdict);
                    verdict
                }
            };
            if readable_room {
                readable.push(row);
            }
        }

        // The author block set is resolved upstream, so the hidden-author
        // filter is identity here and the page dedupes as-is.
        let deduped = dedupe_links(readable);
        let mut next_cursor = None;
        if page.has_more && !deduped.is_empty() {
            next_cursor = cursor_for_row(deduped.last());
        }

        Ok(GetLinksResult {
            links: build_link_rows(state.stores.as_ref(), deduped),
            cursor: next_cursor,
        })
    })
}

pub fn get_room_summary(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetRoomSummaryResult, XrpcError> {
    let room_id = RoomId::try_from(params.require_string("roomId")?)?;

    state.db.with(|conn| {
        let access = require_room_read(conn, room_id.as_str(), ctx.did())?;

        let (name, label) = conn
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
            .optional()?
            .unwrap_or((None, None));

        Ok(GetRoomSummaryResult {
            name,
            kind: strip_label(label.as_deref()),
            space_id: access.space_id.unwrap_or_default(),
        })
    })
}

/// `stripLabel`: drop the `space.roomy.` prefix, leaving any other label
/// untouched.
fn strip_label(label: Option<&str>) -> String {
    let Some(label) = label else {
        return String::new();
    };
    match label.strip_prefix("space.roomy.") {
        Some(rest) if !rest.is_empty() => rest.to_owned(),
        _ => label.to_owned(),
    }
}

/// One page of a space's link rows.
///
/// Same shape and ordering as [`crate::queries::links::list_links`], scoped by
/// the *containing message's* `stream_id` — a link entity's own stream is
/// empty, so the message is the only row that carries the space.
fn list_space_links(
    conn: &Connection,
    space_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<LinkPage, XrpcError> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    conditions.push("msg.stream_id = ?".to_owned());
    params.push(rusqlite::types::Value::Text(space_id.to_owned()));
    conditions.push("el.entity is not null".to_owned());
    conditions.push("msg.room is not null".to_owned());

    // A row sorts after the cursor when its ordering key is strictly smaller,
    // or the key matches and the tie-break URL is strictly greater.
    if let Some(cursor) = cursor {
        if let Some(sep) = cursor.rfind("::") {
            let cursor_key = &cursor[..sep];
            let cursor_url = &cursor[sep + 2..];
            conditions.push(
                "(coalesce(msg.sort_idx, msg.id) < ? or (coalesce(msg.sort_idx, msg.id) = ? and el.entity > ?))"
                    .to_owned(),
            );
            params.push(rusqlite::types::Value::Text(cursor_key.to_owned()));
            params.push(rusqlite::types::Value::Text(cursor_key.to_owned()));
            params.push(rusqlite::types::Value::Text(cursor_url.to_owned()));
        }
    }

    let sql = format!(
        "select el.entity as url,
                msg.room as room_id,
                link.room as message_id,
                coalesce(msg.sort_idx, msg.id) as sort_key
           from entities link
           join entities msg on msg.id = link.room
           left join comp_embed_link el on el.entity = link.id
          where {}
          order by sort_key desc, el.entity asc
          limit ?",
        conditions.join(" and ")
    );
    // One row beyond the page tells the caller whether a next page exists.
    params.push(rusqlite::types::Value::Integer(limit as i64 + 1));

    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<RawLinkRow> = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(RawLinkRow {
                url: row.get(0)?,
                room_id: row.get(1)?,
                message_id: row.get(2)?,
                sort_key: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if rows.is_empty() {
        return Ok(LinkPage {
            links: Vec::new(),
            has_more: false,
        });
    }

    let has_more = rows.len() > limit;
    let mut links = rows;
    links.truncate(limit);
    Ok(LinkPage { links, has_more })
}
