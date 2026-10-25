//! The internal feed: the log owner answers a worker's cursor question.
//!
//! A worker on another machine cannot open the log's SQLite file — a network
//! filesystem over a live database is not a supported way to read one — so the
//! process that owns the log serves the same `ChangeFeed` contract over HTTP
//! (`space_feed::http`). The endpoint is not part of the XRPC surface: it is
//! behind a shared secret, it answers only the two questions a feed answers, and
//! mounting it is what makes a split deployment a deployment rather than a
//! second implementation.

use std::sync::Mutex;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use space_core::change::FeedRow;

use crate::GatewayState;

/// The header a worker presents. The secret is deployment configuration, not a
/// user credential: it authenticates a process, and every worker shares it.
pub const INTERNAL_HEADER: &str = "x-roomy-internal";

/// Whether `headers` carry this process's internal secret. An unset secret
/// refuses everything, so a mounted endpoint cannot be reached by accident.
pub fn authorized(secret: Option<&str>, headers: &HeaderMap) -> bool {
    let Some(secret) = secret else {
        return false;
    };
    headers
        .get(INTERNAL_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|presented| presented == secret)
}

/// `POST /internal/signal` — a worker in another process says a space moved.
pub async fn signal(
    State(state): State<std::sync::Arc<GatewayState>>,
    headers: HeaderMap,
    Json(wire): Json<roomy_space_worker::signal::WireSignal>,
) -> Response {
    if !authorized(state.internal_secret.as_deref(), &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Forbidden", "message": "the internal signal endpoint requires its secret"})),
        )
            .into_response();
    }
    match wire.into_signal() {
        Ok(signal) => {
            state.signals.publish(signal);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "InvalidRequest", "message": error.to_string()})),
        )
            .into_response(),
    }
}

/// The log's rows, and the highest index it holds for the same space.
pub struct FeedService {
    conn: Mutex<rusqlite::Connection>,
}

impl FeedService {
    /// Open the event log read-only. A gateway that accepted writes has the file
    /// already; a read replica must be pointed at the owner's copy.
    pub fn open(path: impl AsRef<std::path::Path>) -> rusqlite::Result<Self> {
        let conn = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// The rows strictly after `cursor`, oldest first, with the rest of the last
    /// entry attached so a batch never splits one.
    fn answer(
        &self,
        space: &str,
        cursor: (i64, i64),
        limit: usize,
    ) -> rusqlite::Result<(Vec<FeedRow>, i64)> {
        let conn = self.conn.lock().expect("the log handle is not poisoned");
        let mut statement = conn.prepare(
            "select stream_id, idx, ord, kind, repo, collection, rkey, op,
                    order_stamp, actor, event_id, body
               from record_changes
              where stream_id = ?
                and (idx > ? or (idx = ? and ord > ?))
              order by idx, ord
              limit ?",
        )?;
        let rows = statement.query_map(
            rusqlite::params![space, cursor.0, cursor.0, cursor.1, limit as i64],
            row_of,
        )?;
        let mut rows: Vec<FeedRow> = rows.collect::<Result<_, _>>()?;

        if let Some(last) = rows.last() {
            let mut trailing = conn.prepare(
                "select stream_id, idx, ord, kind, repo, collection, rkey, op,
                        order_stamp, actor, event_id, body
                   from record_changes
                  where stream_id = ? and idx = ? and ord > ?
                  order by ord",
            )?;
            let more = trailing.query_map(rusqlite::params![space, last.idx, last.ord], row_of)?;
            rows.extend(more.collect::<Result<Vec<_>, _>>()?);
        }

        let latest: Option<i64> = conn
            .query_row(
                "select max(idx) from record_changes where stream_id = ?",
                rusqlite::params![space],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        Ok((rows, latest.unwrap_or(-1)))
    }
}

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedRow> {
    Ok(FeedRow {
        stream_id: row.get(0)?,
        idx: row.get(1)?,
        ord: row.get(2)?,
        kind: row.get(3)?,
        repo: row.get(4)?,
        collection: row.get(5)?,
        rkey: row.get(6)?,
        op: row.get(7)?,
        order_stamp: row.get(8)?,
        actor: row.get(9)?,
        event_id: row.get(10)?,
        body: row.get(11)?,
    })
}

#[derive(Debug, Deserialize)]
pub struct FeedQuery {
    #[serde(rename = "afterIdx", default)]
    after_idx: i64,
    #[serde(rename = "afterOrd", default)]
    after_ord: i64,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    500
}

/// The most rows one answer may carry, so a cursor question cannot pull the log
/// down in one response.
const MAX_LIMIT: usize = 5_000;

/// `GET /internal/feed/{space}` — the owner's half of the HTTP change feed.
pub async fn feed(
    State(state): State<std::sync::Arc<GatewayState>>,
    Path(space): Path<String>,
    Query(query): Query<FeedQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(service) = state.feed.as_ref() else {
        // No log in this process: there is nothing to answer from, and pretending
        // otherwise would serve an empty feed forever.
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "NotFound", "message": "this process holds no event log"})),
        )
            .into_response();
    };
    if !authorized(state.internal_secret.as_deref(), &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Forbidden", "message": "the internal feed requires its secret"})),
        )
            .into_response();
    }
    let limit = query.limit.clamp(1, MAX_LIMIT);
    match service.answer(&space, (query.after_idx, query.after_ord), limit) {
        Ok((changes, latest)) => {
            Json(json!({ "changes": changes, "latestIdx": latest })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "InternalServerError", "message": error.to_string()})),
        )
            .into_response(),
    }
}
