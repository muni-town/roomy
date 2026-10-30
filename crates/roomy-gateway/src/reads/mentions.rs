//! `space.roomy.mention.getMentions`.
//!
//! The mention index is global: one row per (mentioned DID, message) in the
//! gateway's `global.sqlite`. The messages it names are not — each one lives in
//! its own space's database. The read is therefore a global query followed by a
//! per-space hydration: the index gives the page and its cursor, and each
//! mention's space renders its message.
//!
//! The index is reached through [`MentionIndex`], a one-method seam. This crate
//! serves it from a read-only SQLite replica ([`SqliteMentionIndex`]); an
//! out-of-process index can replace it without the handler changing.
//!
//! No block set is applied: the reads this gateway serves carry none, so a
//! mention by an author the caller has hidden is not redacted — the same
//! limitation the per-space handlers have.
//!
//! Pagination is keyset over the index's `created_at`: the cursor is the
//! millisecond stamp of the last mention on the page, and the next page is the
//! mentions strictly older than it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use space_xrpc::dto::MessageDto;
use space_xrpc::error::XrpcError;
use space_xrpc::handlers::common::Context;
use space_xrpc::ids::Nsid;
use space_xrpc::params::Params;
use space_xrpc::queries::messages::{select_messages, SelectScope};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::store::{
    FederationOrder, FederationReceiverPermission, FederationRecord, FederationRoomPermission,
    FederationView, GlobalStores, ProfileFields,
};

use crate::GatewayState;

/// The XRPC method this module answers.
pub const NSID: &str = "space.roomy.mention.getMentions";

/// One row of the global mention index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionRow {
    /// The message the DID was mentioned in, or was replied to.
    pub message_id: String,
    /// The space whose database holds that message.
    pub space_did: String,
    pub room_id: String,
    /// `mention` for a `#didMention` (or an extension's mention), `reply` for
    /// a depth-1 reply to a message the DID wrote.
    pub kind: String,
    /// When the message was materialised, in milliseconds. The page's cursor.
    pub created_at: i64,
}

/// The mention index, as this read needs it.
pub trait MentionIndex: Send + Sync {
    /// The newest mentions of `did`, newest first: at most `limit` rows,
    /// starting strictly before `cursor` when one is given.
    ///
    /// An index that cannot be read answers with no rows — the endpoint is a
    /// backfill, and an empty backfill is a valid answer.
    fn mentions_for(&self, did: &str, limit: i64, cursor: Option<&str>) -> Vec<MentionRow>;
}

/// The global mention index, read from the gateway's SQLite store through the
/// same read-only pooled connection the per-space reads use.
pub struct SqliteMentionIndex {
    db: SpaceReadDb,
}

impl SqliteMentionIndex {
    /// Open `path` read-only.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, XrpcError> {
        Ok(Self {
            db: SpaceReadDb::open_readonly(path)?,
        })
    }

    /// The index at this process's global store, when it is readable.
    fn from_env() -> Option<Self> {
        let path = global_db_path();
        match Self::open(&path) {
            Ok(index) => Some(index),
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "mention index unavailable"
                );
                None
            }
        }
    }
}

/// Where the process finds its global store: `ROOMY_GLOBAL_DB` when set,
/// otherwise `global.sqlite` inside `ROOMY_DATA_DIR` (default `data`).
fn global_db_path() -> PathBuf {
    if let Some(path) = env_path("ROOMY_GLOBAL_DB") {
        return path;
    }
    env_path("ROOMY_DATA_DIR")
        .unwrap_or_else(|| PathBuf::from("data"))
        .join("global.sqlite")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The newest mentions of one DID, older than an optional cursor.
///
/// The cursor is compared as a number, as the appserver binds it: a cursor
/// that is not a number matches no row, so a malformed one ends the walk
/// rather than repeating the first page.
const PAGE_SQL: &str = "
  select message_id, space_did, room_id, kind, created_at
    from mentions
   where did = ?
     and (? is null or created_at < ?)
   order by created_at desc
   limit ?
";

impl MentionIndex for SqliteMentionIndex {
    fn mentions_for(&self, did: &str, limit: i64, cursor: Option<&str>) -> Vec<MentionRow> {
        let bound = cursor.map(js_number);
        if bound.is_some_and(f64::is_nan) {
            return Vec::new();
        }
        let page = self.db.with(|conn| {
            let mut statement = conn.prepare(PAGE_SQL)?;
            let mut rows = statement.query((did, bound, bound, limit))?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                out.push(MentionRow {
                    message_id: row.get::<_, String>(0)?,
                    space_did: row.get::<_, String>(1)?,
                    room_id: row.get::<_, String>(2)?,
                    kind: row.get::<_, String>(3)?,
                    created_at: row.get::<_, i64>(4)?,
                });
            }
            Ok(out)
        });
        page.unwrap_or_default()
    }
}

/// `Number(raw)` for a cursor. A cursor this endpoint minted is a plain
/// decimal; anything that is not a finite number (or the unbounded
/// `Infinity` spelling) is `NaN`.
fn js_number(raw: &str) -> f64 {
    let trimmed = raw.trim();
    match trimmed {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => match trimmed.parse::<f64>() {
            Ok(value) if value.is_finite() => value,
            _ => f64::NAN,
        },
    }
}

/// The index a process without a readable global store answers from.
struct NoMentionIndex;

impl MentionIndex for NoMentionIndex {
    fn mentions_for(&self, _did: &str, _limit: i64, _cursor: Option<&str>) -> Vec<MentionRow> {
        Vec::new()
    }
}

static NO_INDEX: NoMentionIndex = NoMentionIndex;

static INDEX: LazyLock<Option<SqliteMentionIndex>> = LazyLock::new(SqliteMentionIndex::from_env);

fn index() -> &'static dyn MentionIndex {
    match &*INDEX {
        Some(index) => index,
        None => &NO_INDEX,
    }
}

#[derive(Debug, Serialize)]
struct GetMentionsResult {
    mentions: Vec<MentionEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

#[derive(Debug, Serialize)]
struct MentionEntry {
    message: MessageDto,
    #[serde(rename = "spaceId")]
    space_id: String,
    #[serde(rename = "roomId")]
    room_id: String,
    kind: String,
}

/// One page of index rows and the cursor past it.
fn paginate(mut rows: Vec<MentionRow>, limit: i64) -> (Vec<MentionRow>, Option<String>) {
    if rows.len() as i64 <= limit {
        return (rows, None);
    }
    rows.truncate(limit as usize);
    let cursor = rows.last().map(|row| row.created_at.to_string());
    (rows, cursor)
}

/// The store view a mention's message is hydrated through.
///
/// The snapshot is rendered by the same query a room's messages are, with the
/// profile store — but without the link-card store: the mention backfill
/// renders bare links, and a mention's row carries no card of its own.
struct SnapshotStores<'a>(&'a dyn GlobalStores);

impl GlobalStores for SnapshotStores<'_> {
    fn profile(&self, did: &str) -> Option<ProfileFields> {
        self.0.profile(did)
    }

    fn link_embed_json(&self, _url: &str) -> Option<String> {
        None
    }

    fn space_handle(&self, space_did: &str) -> Option<String> {
        self.0.space_handle(space_did)
    }

    fn federations(
        &self,
        view: FederationView<'_>,
        status: Option<&str>,
        order: FederationOrder,
    ) -> Vec<FederationRecord> {
        self.0.federations(view, status, order)
    }

    fn federation_origin_grants(&self, space_id: &str) -> Vec<FederationRoomPermission> {
        self.0.federation_origin_grants(space_id)
    }

    fn federation_receiver_grants(&self, space_id: &str) -> Vec<FederationReceiverPermission> {
        self.0.federation_receiver_grants(space_id)
    }
}

/// Render each mention row's message, keyed by message id.
///
/// Rows are grouped by space, so each space's database is queried once for the
/// whole page. A space this process does not serve contributes no messages,
/// and its mentions drop out of the answer.
fn load_messages(
    reads: &XrpcState,
    rows: &[MentionRow],
    viewer: Option<&str>,
) -> Result<HashMap<String, MessageDto>, XrpcError> {
    let mut by_space: HashMap<&str, Vec<String>> = HashMap::new();
    for row in rows {
        by_space
            .entry(row.space_did.as_str())
            .or_default()
            .push(row.message_id.clone());
    }

    let stores = SnapshotStores(reads.stores.as_ref());
    let mut messages = HashMap::with_capacity(rows.len());
    for (space_did, ids) in by_space {
        let Some(db) = reads.spaces.resolve_space(space_did) else {
            continue;
        };
        let result = db.with(|conn| {
            select_messages(
                conn,
                &stores,
                SelectScope::Ids {
                    ids,
                    forward_chain: Vec::new(),
                    skip_profile_hydration: false,
                },
                viewer,
                &[],
            )
        })?;
        for message in result.messages {
            let id = message.id().to_owned();
            messages.insert(id, message);
        }
    }
    Ok(messages)
}

async fn mentions(
    state: &GatewayState,
    params: &Params,
    context: &Context,
    index: &dyn MentionIndex,
) -> Result<GetMentionsResult, XrpcError> {
    // `did` is required by the params schema, which rejects an absent value
    // before the handler runs; an empty one is the handler's own rejection.
    if params.raw("did").is_none() {
        return Err(XrpcError::invalid_request(format!(
            "{NSID} params validation failed: did must be a string (was missing)"
        )));
    }
    let did = params.require_string("did")?;
    if context.did() != Some(did.as_str()) {
        return Err(XrpcError::forbidden("You can only query your own mentions"));
    }

    let limit = params
        .optional_int("limit", Some(1), Some(100), Some(50))?
        .unwrap_or(50);
    let cursor = params.optional_string("cursor");

    // One row past the page says whether a cursor is owed.
    let (page, next_cursor) = paginate(
        index.mentions_for(&did, limit + 1, cursor.as_deref()),
        limit,
    );

    let blocked = state.reads.read_state.blocked(&did).unwrap_or_default();
    let mut messages = load_messages(&state.reads, &page, Some(&did))?;

    let mut mentions = Vec::with_capacity(page.len());
    for row in page {
        let Some(message) = messages.remove(&row.message_id) else {
            continue;
        };
        if blocked.is_hidden(message.author_did()) {
            continue;
        }
        mentions.push(MentionEntry {
            message,
            space_id: row.space_did,
            room_id: row.room_id,
            kind: row.kind,
        });
    }

    Ok(GetMentionsResult {
        mentions,
        cursor: next_cursor,
    })
}

/// axum handler for `GET /xrpc/space.roomy.mention.getMentions`.
/// axum handler for `GET /xrpc/space.roomy.mention.getMentions`.
pub async fn http(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let nsid = Nsid::try_from(NSID).expect("static nsid");
    let params = Params::parse(query.as_deref());
    let context = match crate::reads::context(&state, &headers, &nsid).await {
        Ok(context) => context,
        Err(error) => return error.into_response(),
    };
    match mentions(&state, &params, &context, index()).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use space_xrpc::dto::BlockedMessage;

    fn index_with(rows: &[(&str, &str, i64)]) -> SqliteMentionIndex {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory global db");
        conn.execute_batch(
            "create table mentions (
               did text not null,
               message_id text not null,
               space_did text not null,
               room_id text not null,
               kind text not null default 'mention',
               created_at integer not null,
               primary key (did, message_id)
             );",
        )
        .expect("schema");
        for (did, message_id, created_at) in rows {
            conn.execute(
                "insert into mentions (did, message_id, space_did, room_id, kind, created_at)
                 values (?1, ?2, 'did:web:space.example', 'room-1', 'mention', ?3)",
                rusqlite::params![did, message_id, created_at],
            )
            .expect("insert");
        }
        SqliteMentionIndex {
            db: SpaceReadDb::from_connection(conn),
        }
    }

    fn ids(rows: &[MentionRow]) -> Vec<&str> {
        rows.iter().map(|row| row.message_id.as_str()).collect()
    }

    #[test]
    fn index_pages_newest_first_and_cursors_on_created_at() {
        let index = index_with(&[
            ("did:plc:a", "m1", 100),
            ("did:plc:a", "m2", 200),
            ("did:plc:a", "m3", 300),
            ("did:plc:b", "m4", 400),
        ]);

        assert_eq!(ids(&index.mentions_for("did:plc:a", 2, None)), ["m3", "m2"]);
        assert_eq!(
            ids(&index.mentions_for("did:plc:a", 2, Some("200"))),
            ["m1"]
        );
        assert!(index.mentions_for("did:plc:a", 2, Some("100")).is_empty());
        assert!(index
            .mentions_for("did:plc:a", 10, Some("not-a-number"))
            .is_empty());
    }

    #[test]
    fn a_page_past_the_limit_owes_a_cursor() {
        let rows = |n: usize| {
            (0..n)
                .map(|i| MentionRow {
                    message_id: format!("m{i}"),
                    space_did: "did:web:space.example".into(),
                    room_id: "room-1".into(),
                    kind: "mention".into(),
                    created_at: 100 * (i as i64 + 1),
                })
                .collect::<Vec<_>>()
        };

        let (page, cursor) = paginate(rows(3), 2);
        assert_eq!(ids(&page), ["m0", "m1"]);
        assert_eq!(cursor.as_deref(), Some("200"));

        let (page, cursor) = paginate(rows(2), 2);
        assert_eq!(ids(&page), ["m0", "m1"]);
        assert_eq!(cursor, None);
    }

    #[test]
    fn cursors_are_numbers() {
        assert_eq!(js_number(" 200 "), 200.0);
        assert_eq!(js_number("1.5"), 1.5);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert!(js_number("not-a-number").is_nan());
        assert!(js_number("inf").is_nan());
    }

    fn blocked_message() -> MessageDto {
        MessageDto::Blocked(BlockedMessage {
            id: "m1".to_owned(),
            sort_idx: None,
            content: String::new(),
            author_did: "did:plc:author".to_owned(),
            author_name: String::new(),
            blocked: true,
            timestamp: "2024-01-01T00:00:00.000Z".to_owned(),
            attachments: Vec::new(),
            reactions: Vec::new(),
            media: Vec::new(),
            link_embeds: Vec::new(),
        })
    }

    #[test]
    fn serialises_fields_in_wire_order() {
        let result = GetMentionsResult {
            mentions: vec![MentionEntry {
                message: blocked_message(),
                space_id: "did:web:space.example".to_owned(),
                room_id: "room-1".to_owned(),
                kind: "reply".to_owned(),
            }],
            cursor: Some("1700000000000".to_owned()),
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"mentions":[{"message":{"id":"m1","content":"","authorDid":"did:plc:author","authorName":"","blocked":true,"timestamp":"2024-01-01T00:00:00.000Z","attachments":[],"reactions":[],"media":[],"linkEmbeds":[]},"spaceId":"did:web:space.example","roomId":"room-1","kind":"reply"}],"cursor":"1700000000000"}"#
        );
    }

    #[test]
    fn omits_the_cursor_when_the_page_is_the_last() {
        let result = GetMentionsResult {
            mentions: Vec::new(),
            cursor: None,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"mentions":[]}"#
        );
    }
}
