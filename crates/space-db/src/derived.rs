//! The derived steps, executed against the rows that are there.
//!
//! Each one mirrors the TypeScript implementation it was ported from, because
//! their output is compared byte for byte: the activity window decodes the
//! ordering time out of `sort_idx` and JSON-encodes the window exactly as
//! `JSON.stringify` does, the feed upsert reads and rewrites one JSON array, and
//! a reorder key is computed between the neighbours it names.

use rusqlite::{params, Connection};
use space_core::effects::{DerivedStep, SqlEffect};
use space_core::ids::SpaceDid;
use space_core::time;

/// A step that could not be applied.
#[derive(Debug, thiserror::Error)]
pub enum DerivedError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Json(String),
}

/// Apply one step, returning the global statements it produced.
pub fn apply_step(
    conn: &Connection,
    stream_id: &SpaceDid,
    step: &DerivedStep,
) -> Result<Vec<SqlEffect>, DerivedError> {
    match step {
        DerivedStep::RebuildActivityWindow { room_id } => {
            rebuild_activity_window(conn, room_id)?;
            // The window's names are the current ones: a rename rebuilds the
            // row it renamed rather than leaving the old name in the feed.
            refresh_activity_meta(conn, stream_id, room_id)?;
            rebuild_room_activity(conn, room_id)?;
            Ok(Vec::new())
        }
        DerivedStep::UpsertActivityItem {
            space_id,
            room_id,
            message_id,
            timestamp,
        } => {
            upsert_activity_item(conn, space_id, room_id, message_id, *timestamp)?;
            Ok(Vec::new())
        }
        DerivedStep::StoreLinks {
            space_id,
            message_id,
            urls,
            decided_at_ms,
        } => store_links(conn, stream_id, space_id, message_id, urls, *decided_at_ms),
        DerivedStep::SetMessageSortIdxByReorder {
            stream_id,
            message_id,
            after,
        } => {
            set_sort_idx_by_reorder(conn, stream_id, message_id, after)?;
            Ok(Vec::new())
        }
    }
}

/// Recompute a room's `activity_item` window from its newest five message-shaped
/// rows, ordered by `sort_idx` descending.
///
/// A row counts when it has its own content or a forward edge — the same filter
/// the timeline uses. The window's entries carry the ordering time decoded from
/// `sort_idx`, so the feed orders by the instant the timeline does. A room with
/// no messages left loses its row, so the feed stops listing it.
fn rebuild_activity_window(conn: &Connection, room_id: &str) -> Result<(), DerivedError> {
    let mut statement = conn.prepare(
        "select e.id as id, e.sort_idx as sort_idx
           from entities e
           left join comp_content cc on cc.entity = e.id
           left join edges forward_e on forward_e.head = e.id and forward_e.label = 'forward'
          where e.room = ?
            and (cc.entity is not null or forward_e.tail is not null)
          order by e.sort_idx desc
          limit 5",
    )?;
    let rows: Vec<(String, Option<String>)> = statement
        .query_map(params![room_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    if rows.is_empty() {
        conn.execute(
            "delete from activity_item where room_id = ?",
            params![room_id],
        )?;
        return Ok(());
    }

    let entries: Vec<serde_json::Value> = rows
        .iter()
        .map(|(id, sort_idx)| {
            let key = sort_idx.as_deref().unwrap_or(id);
            serde_json::json!({ "id": id, "ts": time::ulid_time_ms(key).unwrap_or(0) })
        })
        .collect();
    let newest = time::ulid_time_ms(rows[0].1.as_deref().unwrap_or(&rows[0].0)).unwrap_or(0);

    conn.execute(
        "update activity_item
            set last_activity_at = ?,
                recent_message_ids = ?,
                updated_at = (unixepoch() * 1000)
          where room_id = ?",
        params![
            newest,
            serde_json::Value::Array(entries).to_string(),
            room_id
        ],
    )?;
    Ok(())
}

/// The `room_activity` summary for one room, rebuilt from the live tables.
///
/// The same statement `rebuildRoomActivitySql` runs, for one room: the newest
/// message-shaped row supplies `latest_message_id`/`latest_at` (ties broken by
/// message id, as the scan fallback does) and each author appears once with the
/// newest message they wrote. A room with no messages left keeps its row with
/// nulls, exactly as the TypeScript upsert does.
fn rebuild_room_activity(conn: &Connection, room_id: &str) -> Result<(), DerivedError> {
    let rooms = serde_json::json!([room_id]).to_string();
    conn.execute(REBUILD_ROOM_ACTIVITY_SQL, params![rooms])?;
    Ok(())
}

const REBUILD_ROOM_ACTIVITY_SQL: &str = "
      with rooms(room_id) as (select value from json_each(?1)),
           entries as (
             select e.id as id,
                    e.room as room,
                    coalesce(a.tail, fa.tail) as did,
                    coalesce(cc.timestamp, fcc.timestamp) as ts
               from entities e
               left join comp_content cc on cc.entity = e.id
               left join edges a  on a.head  = e.id and a.label  = 'author'
               left join edges f  on f.head  = e.id and f.label  = 'forward'
               left join comp_content fcc on fcc.entity = f.tail
               left join edges fa on fa.head = f.tail and fa.label = 'author'
              where e.room in (select room_id from rooms)
                and (cc.entity is not null or f.tail is not null)
           ),
           latest as (
             select room, id, ts from (
               select room, id, ts,
                      row_number() over (partition by room order by ts desc, id desc) as rn
                 from entries
                where ts is not null
             ) where rn = 1
           ),
           authors as (
             select room, json_group_array(
                      json_object('did', did, 'ts', ts) order by ts desc, did asc
                    ) as recent_authors
               from (
                 select room, did, max(ts) as ts
                   from entries
                  where did is not null
                  group by room, did
               )
              group by room
           )
      insert into room_activity (room_id, latest_message_id, latest_at, recent_authors)
      select r.room_id, l.id, l.ts, coalesce(au.recent_authors, '[]')
        from rooms r
        left join latest  l  on l.room  = r.room_id
        left join authors au on au.room = r.room_id
      on conflict (room_id) do update set
        latest_message_id = excluded.latest_message_id,
        latest_at         = excluded.latest_at,
        recent_authors    = excluded.recent_authors
    ";

/// Fold one message into its room's feed window.
///
/// The window is a JSON array of `{id, ts}` newest first, capped at five. A row
/// that exists is rewritten; the first message in a room inserts the row with
/// the space and room metadata it denormalises.
fn upsert_activity_item(
    conn: &Connection,
    space_id: &SpaceDid,
    room_id: &str,
    message_id: &str,
    timestamp: i64,
) -> Result<(), DerivedError> {
    let existing: Option<String> = conn
        .query_row(
            "select recent_message_ids from activity_item where room_id = ?",
            params![room_id],
            |row| row.get(0),
        )
        .ok();

    if let Some(existing) = existing {
        let mut entries: Vec<serde_json::Value> =
            serde_json::from_str(&existing).unwrap_or_default();
        entries.retain(|entry| entry.get("id").and_then(|id| id.as_str()) != Some(message_id));
        entries.insert(0, serde_json::json!({ "id": message_id, "ts": timestamp }));
        entries.truncate(5);
        conn.execute(
            "update activity_item
                set last_activity_at = ?,
                    recent_message_ids = ?,
                    updated_at = (unixepoch() * 1000)
              where room_id = ?",
            params![
                timestamp,
                serde_json::Value::Array(entries).to_string(),
                room_id
            ],
        )?;
        refresh_activity_meta(conn, space_id, room_id)?;
        return Ok(());
    }

    let meta: Option<ActivityMeta> = conn
        .query_row(
            "select cr.label as label,
                    ri.name as room_name,
                    si.name as space_name,
                    si.avatar as space_avatar,
                    parent_e.head as parent_id
               from comp_room cr
               left join comp_info ri on ri.entity = cr.entity
               left join comp_info si on si.entity = ?
               left join edges parent_e
                      on parent_e.tail = cr.entity
                     and parent_e.label = 'link'
                     and coalesce(json_extract(parent_e.payload, '$.canonical_parent'), 0) = 1
              where cr.entity = ?",
            params![space_id.as_str(), room_id],
            |row| {
                Ok(ActivityMeta {
                    label: row.get(0)?,
                    room_name: row.get(1)?,
                    space_name: row.get(2)?,
                    space_avatar: row.get(3)?,
                    parent_id: row.get(4)?,
                })
            },
        )
        .ok();

    let meta = meta.unwrap_or_default();
    let (label, room_name, space_name, space_avatar, parent_id) = (
        meta.label,
        meta.room_name,
        meta.space_name,
        meta.space_avatar,
        meta.parent_id,
    );
    let is_thread = i64::from(label.as_deref() == Some("space.roomy.thread"));
    let parent_name: Option<String> = match &parent_id {
        Some(parent) => conn
            .query_row(
                "select name from comp_info where entity = ?",
                params![parent],
                |row| row.get(0),
            )
            .ok()
            .flatten(),
        None => None,
    };

    conn.execute(
        "insert into activity_item (
           room_id, space_id, is_thread, parent_channel_id, parent_channel_name,
           last_activity_at, recent_message_ids,
           room_name, space_name, space_avatar,
           created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))",
        params![
            room_id,
            space_id.as_str(),
            is_thread,
            parent_id,
            parent_name,
            timestamp,
            serde_json::json!([{ "id": message_id, "ts": timestamp }]).to_string(),
            room_name,
            space_name,
            space_avatar,
        ],
    )?;
    Ok(())
}

/// Refresh the rows a feed entry denormalises.
///
/// The window's rows are the message set; its *names* are the current room,
/// space and parent names. Writing them only on the first insert would make the
/// projection depend on how the log was batched — a message applied before its
/// room's rename would keep the old name for ever — so every write to the window
/// refreshes them, and the row is a function of the log prefix instead.
fn refresh_activity_meta(
    conn: &Connection,
    space_id: &SpaceDid,
    room_id: &str,
) -> Result<(), DerivedError> {
    conn.execute(
        "update activity_item
            set room_name = (select name from comp_info where entity = activity_item.room_id),
                space_name = (select name from comp_info where entity = ?),
                space_avatar = (select avatar from comp_info where entity = ?),
                parent_channel_id = (
                  select p.head from edges p
                   where p.tail = activity_item.room_id
                     and p.label = 'link'
                     and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
                ),
                parent_channel_name = (
                  select pi.name from edges p
                    join comp_info pi on pi.entity = p.head
                   where p.tail = activity_item.room_id
                     and p.label = 'link'
                     and coalesce(json_extract(p.payload, '$.canonical_parent'), 0) = 1
                )
          where room_id = ?",
        params![space_id.as_str(), space_id.as_str(), room_id],
    )?;
    Ok(())
}

/// The denormalised facts the first message in a room records.
#[derive(Default)]
struct ActivityMeta {
    label: Option<String>,
    room_name: Option<String>,
    space_name: Option<String>,
    space_avatar: Option<String>,
    parent_id: Option<String>,
}

/// Store a message's links: an entity row per URL and its `comp_embed_link` row.
///
/// Returns the global index statements the caller's sink applies — the link
/// entity carries an empty stream id, so the global entity→space index is what
/// resolves it, and the pending-links index is what the embed sweeper walks.
fn store_links(
    conn: &Connection,
    _stream_id: &SpaceDid,
    space_id: &SpaceDid,
    message_id: &str,
    urls: &[String],
    decided_at_ms: i64,
) -> Result<Vec<SqlEffect>, DerivedError> {
    let mut globals: Vec<SqlEffect> = Vec::new();
    for url in urls {
        conn.execute(
            "insert or ignore into entities (id, stream_id, room, created_at, updated_at)
             values (?, '', ?, ?, ?)",
            params![url, message_id, decided_at_ms, decided_at_ms],
        )?;
        let inserted = conn.execute(
            "insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
             values (?, 1, ?, ?)",
            params![url, decided_at_ms, decided_at_ms],
        )?;
        if inserted == 0 {
            continue;
        }
        globals.push(SqlEffect {
            target: space_core::Target::Global,
            sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
            params: vec![
                space_core::Value::text(url),
                space_core::Value::text(space_id.as_str()),
            ],
        });
        globals.push(SqlEffect {
            target: space_core::Target::Global,
            sql: "insert or ignore into pending_links (space_did, message_id, url, created_at)
                  values (?, ?, ?, ?)",
            params: vec![
                space_core::Value::text(space_id.as_str()),
                space_core::Value::text(message_id),
                space_core::Value::text(url),
                space_core::Value::Integer(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                ),
            ],
        });
    }
    Ok(globals)
}

/// Key a message between its neighbours: lexicographically after `after` and
/// before whichever entity currently sorts immediately after it.
fn set_sort_idx_by_reorder(
    conn: &Connection,
    stream_id: &SpaceDid,
    message_id: &str,
    after: &str,
) -> Result<(), DerivedError> {
    let existing: Option<Option<String>> = conn
        .query_row(
            "select sort_idx from entities where id = ?",
            params![message_id],
            |row| row.get(0),
        )
        .ok();
    // The materialiser failed earlier: there is no row to key.
    if existing.is_none() {
        return Ok(());
    }

    let before: Option<String> = conn
        .query_row(
            "select coalesce(sort_idx, id) as sort_idx
               from entities
              where stream_id = ? and id = ?
              limit 1",
            params![stream_id.as_str(), after],
            |row| row.get(0),
        )
        .ok();
    let Some(before) = before else {
        return Ok(());
    };

    let next: Option<String> = conn
        .query_row(
            "select sort_idx
               from entities
              where stream_id = ?
                and sort_idx > ?
                and id != ?
              order by sort_idx
              limit 1",
            params![stream_id.as_str(), before, message_id],
            |row| row.get(0),
        )
        .ok();

    let Ok(sort_idx) = time::midpoint_sort_key(&before, next.as_deref()) else {
        return Ok(());
    };
    conn.execute(
        "update entities set sort_idx = ? where id = ?",
        params![sort_idx, message_id],
    )?;
    Ok(())
}
