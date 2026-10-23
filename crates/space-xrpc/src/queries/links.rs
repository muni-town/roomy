//! Link index, ported from `src/queries/links.ts` and
//! `src/handlers/space.roomy.room.getLinks.ts`.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::dto::LinkRow;
use crate::ids::ulid_time_ms;
use crate::store::GlobalStores;
use crate::time::iso_from_ms;

#[derive(Debug, Clone)]
pub struct RawLinkRow {
    pub url: String,
    pub room_id: String,
    pub message_id: String,
    pub sort_key: String,
}

pub struct LinkPage {
    pub links: Vec<RawLinkRow>,
    pub has_more: bool,
}

/// Newest-first by the containing message's sort key, tie-broken by URL.
pub fn list_links(
    conn: &Connection,
    room_id: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<LinkPage, crate::error::XrpcError> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<rusqlite::types::Value> = Vec::new();

    conditions.push("msg.room = ?".to_owned());
    params.push(rusqlite::types::Value::Text(room_id.to_owned()));
    conditions.push("el.entity is not null".to_owned());
    conditions.push("msg.room is not null".to_owned());

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

const MESSAGE_SUFFIX_LEN: usize = "?message=".len() + 26;

fn is_crockford(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
}

/// `canonicalUrl`: strip the machine-appended `?message=<ulid>` suffix.
pub fn canonical_url(url: &str) -> &str {
    let bytes = url.as_bytes();
    if bytes.len() < MESSAGE_SUFFIX_LEN {
        return url;
    }
    let start = bytes.len() - MESSAGE_SUFFIX_LEN;
    let prefix_ok = bytes[start] == b'?' || bytes[start] == b'&';
    let rest = &bytes[start + 1..];
    let tag_ok = rest.starts_with(b"message=");
    let id = &url[bytes.len() - 26..];
    if prefix_ok && tag_ok && id.bytes().all(is_crockford) {
        &url[..start]
    } else {
        url
    }
}

/// Collapse duplicate canonical URLs, keeping the newest occurrence's place.
pub fn dedupe_links(rows: Vec<RawLinkRow>) -> Vec<RawLinkRow> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if seen.insert(canonical_url(&row.url).to_owned()) {
            out.push(row);
        }
    }
    out
}

pub fn cursor_for_row(row: Option<&RawLinkRow>) -> Option<String> {
    row.map(|row| format!("{}::{}", row.sort_key, row.url))
}

/// `linkTimestamp`: the ISO time encoded in the message's ordering key.
pub fn link_timestamp(sort_key: &str) -> Option<String> {
    ulid_time_ms(sort_key).map(iso_from_ms)
}

/// Build the handler's rows: global link cards hydrated by URL, timestamp from
/// the ordering key, absent when not derivable.
pub fn build_link_rows(stores: &dyn GlobalStores, deduped: Vec<RawLinkRow>) -> Vec<LinkRow> {
    deduped
        .into_iter()
        .map(|row| {
            let embed = stores.link_embed_json(&row.url).and_then(|raw| {
                serde_json::from_str::<Box<serde_json::value::RawValue>>(&raw).ok()
            });
            LinkRow {
                url: row.url,
                room_id: row.room_id,
                message_id: row.message_id,
                timestamp: link_timestamp(&row.sort_key),
                embed,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_url_strips_the_attachment_suffix() {
        let id = "01HK0000000000000000000000";
        assert_eq!(
            canonical_url(&format!("https://example.com/a?message={id}")),
            "https://example.com/a"
        );
        assert_eq!(
            canonical_url("https://example.com/a?message=short"),
            "https://example.com/a?message=short"
        );
        assert_eq!(
            canonical_url("https://example.com/a"),
            "https://example.com/a"
        );
    }
}
