//! `space.roomy.room.updateSeen`: move a caller's read watermark in a room.
//!
//! This is not an event and not a materialised row: a read position is the
//! caller's own state, so the write is answered at the edge from the read-state
//! store and needs no space worker. The per-space database is read only to
//! decide access and to resolve the watermark — an explicit message id is
//! translated to its `sort_idx`, and an absent one anchors at the newest
//! message the caller can see.
//!
//! Reading a thread is also engagement, recorded in the read-state store's
//! thread activity, and opening a room cancels any pending push digest for it.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

use space_xrpc::access::require_room_read;
use space_xrpc::error::XrpcError;
use space_xrpc::ids::Nsid;

use crate::GatewayState;

/// The XRPC method this module answers.
pub const NSID: &str = "space.roomy.room.updateSeen";

/// A thread room, as `comp_room` labels it: reads of one count as engagement.
const THREAD_LABEL: &str = "space.roomy.thread";

/// axum handler for `POST /xrpc/space.roomy.room.updateSeen`.
pub async fn http(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(_query): RawQuery,
    body: Bytes,
) -> Response {
    match update_seen(&state, &headers, &body).await {
        // The procedure returns void: a successful call has no body.
        Ok(()) => StatusCode::OK.into_response(),
        Err(error) => error.into_response(),
    }
}

async fn update_seen(
    state: &GatewayState,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(), XrpcError> {
    let nsid = Nsid::try_from(NSID).expect("static nsid");
    let context = crate::reads::context(state, headers, &nsid).await?;
    let Some(user_did) = context.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };

    // The body, not the query string: this is a POST procedure.
    let body = parse_body(headers, body)?;
    let room_id = match body.get("roomId") {
        Some(Value::String(room_id)) if !room_id.is_empty() => room_id.as_str(),
        _ => {
            return Err(XrpcError::invalid_request(
                "Missing or empty required field: roomId",
            ))
        }
    };
    let seen_up_to_raw = match body.get("seenUpTo") {
        None => None,
        Some(Value::String(seen_up_to)) => Some(seen_up_to.as_str()),
        Some(_) => {
            return Err(XrpcError::invalid_request(
                "Field seenUpTo must be a string if provided",
            ))
        }
    };

    let Some(db) = state.reads.spaces.resolve_entity(room_id) else {
        return Err(XrpcError::not_found(format!("Room not found: {room_id}")));
    };
    let access = db.with(|conn| require_room_read(conn, room_id, Some(user_did)))?;

    // The reader's hidden authors: the watermark written here excludes them,
    // matching the unread count derived from it.
    let hidden = state
        .reads
        .read_state
        .blocked(user_did)
        .map_err(read_state_error)?;

    let seen_up_to = match seen_up_to_raw {
        Some(message_id) => {
            // An explicit watermark is the message's timeline key. A row that
            // is not a message of this room cannot anchor a position.
            let sort_idx: Option<String> = db.with(|conn| {
                let sort_idx = conn.query_row(
                    "select max(sort_idx) from entities where id = ? and room = ?",
                    (message_id, room_id),
                    |row| row.get(0),
                )?;
                Ok(sort_idx)
            })?;
            let Some(sort_idx) = sort_idx else {
                return Err(XrpcError::invalid_request(format!(
                    "Message {message_id} does not exist in room {room_id}"
                )));
            };
            sort_idx
        }
        None => {
            // No watermark: anchor at the newest message the reader can see, so
            // a hidden author's newer message does not jump the position past
            // content the reader still has to read.
            let hidden_dids: Vec<&str> = hidden.iter().collect();
            let hidden_json = serde_json::to_string(&hidden_dids)
                .map_err(|error| XrpcError::internal(error.to_string()))?;
            let max: Option<String> = db.with(|conn| {
                let max = conn.query_row(
                    "select max(e.sort_idx)
                       from entities e
                      where e.room = ?1
                        and not exists (select 1 from edges author_e
                                         where author_e.head = e.id
                                           and author_e.label = 'author'
                                           and author_e.tail in
                                               (select value from json_each(?2)))",
                    (room_id, hidden_json.as_str()),
                    |row| row.get(0),
                )?;
                Ok(max)
            })?;
            max.unwrap_or_default()
        }
    };

    let now = epoch_millis();
    state
        .reads
        .read_state
        .set_read_position(
            user_did,
            access.space_id.as_deref().unwrap_or(""),
            room_id,
            &seen_up_to,
            now,
        )
        .map_err(read_state_error)?;

    // Reading a thread counts toward its activity window. Channels leave the
    // sidebar's thread activity alone.
    let label: Option<String> = db.with(|conn| {
        let label = conn.query_row(
            "select max(label) from comp_room where entity = ?",
            [room_id],
            |row| row.get(0),
        )?;
        Ok(label)
    })?;
    if label.as_deref() == Some(THREAD_LABEL) {
        if let Some(space_id) = access.space_id.as_deref() {
            state
                .reads
                .read_state
                .mark_thread_active(user_did, space_id, room_id, now, now)
                .map_err(read_state_error)?;
        }
    }

    state
        .reads
        .read_state
        .reset_notification_state(user_did, room_id)
        .map_err(read_state_error)?;

    Ok(())
}

fn read_state_error(error: roomy_readstate::ReadStateError) -> XrpcError {
    XrpcError::internal(format!("read-state: {error}"))
}

/// The procedure's JSON body. A request without a JSON content type carries no
/// fields, exactly as the appserver treats it.
fn parse_body(headers: &HeaderMap, body: &Bytes) -> Result<Map<String, Value>, XrpcError> {
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"));
    if !is_json {
        return Ok(Map::new());
    }
    match serde_json::from_slice(body) {
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => Ok(Map::new()),
        Err(_) => Err(XrpcError::invalid_request("Malformed JSON body")),
    }
}

/// Wall-clock milliseconds since the epoch.
fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
    use roomy_readstate::{ReadPosition, ReadStateStore, SqliteReadStateStore};
    use space_xrpc::registry::FixedSpaces;
    use space_xrpc::state::{SpaceReadDb, XrpcState};
    use space_xrpc::verify::TestMode;

    use axum::http::HeaderValue;

    use crate::GatewaySignals;

    use super::*;

    const SPACE_SCHEMA: &str =
        include_str!("../../../../packages/appserver/src/db/schema-space.sql");

    const SPACE: &str = "did:web:space.example";
    const ROOM: &str = "01JRZ0R00N0000000000000001";
    const THREAD: &str = "01JRZ0R00N0000000000000002";
    const MSG_A: &str = "01JRZ0R00N000000000000000A";
    const MSG_B: &str = "01JRZ0R00N000000000000000B";
    const USER: &str = "did:plc:user";
    const VIEWER: &str = "did:plc:viewer";
    const AUTHOR: &str = "did:plc:author";
    const OUTSIDER: &str = "did:plc:outsider";

    /// A space with a channel holding two messages and a thread, plus a
    /// read-state store on a real file so tests can inspect the rows the
    /// handler writes.
    struct Fixture {
        state: Arc<GatewayState>,
        store: Arc<SqliteReadStateStore>,
        read_state_path: PathBuf,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            let read_state_path = dir.path().join("readstate.sqlite");
            let store = Arc::new(
                SqliteReadStateStore::open(&read_state_path).expect("read-state database"),
            );
            store.apply_schema().expect("read-state schema");

            let space = Arc::new(space_db());
            let spaces = FixedSpaces::new([(SPACE.to_string(), Arc::clone(&space))])
                .with_entity(ROOM, SPACE)
                .with_entity(THREAD, SPACE);
            let reads = XrpcState::new(Arc::clone(&space), Arc::new(TestMode))
                .with_spaces(Arc::new(spaces))
                .with_read_state(Arc::clone(&store) as Arc<dyn ReadStateStore>);
            let secret = b"update-seen-secret".to_vec();
            let state = Arc::new(GatewayState::new(
                reads,
                Arc::new(TicketIssuer::new(secret.clone(), "gateway.test", 60)),
                Arc::new(TicketVerifier::new(
                    secret,
                    "gateway.test",
                    Box::new(InMemoryNonces::new()),
                )),
                GatewaySignals::new(8),
            ));
            Self {
                state,
                store,
                read_state_path,
                _dir: dir,
            }
        }

        fn seed_read_state(&self, sql: &str) {
            let conn = rusqlite::Connection::open(&self.read_state_path).expect("read-state file");
            conn.execute_batch(sql).expect("seed read state");
        }

        fn notification_rows(&self, user_did: &str, room_id: &str) -> i64 {
            let conn = rusqlite::Connection::open(&self.read_state_path).expect("read-state file");
            conn.query_row(
                "select count(*) from notification_state where user_did = ? and room_id = ?",
                (user_did, room_id),
                |row| row.get(0),
            )
            .expect("notification rows")
        }
    }

    fn space_db() -> SpaceReadDb {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(SPACE_SCHEMA).expect("space schema");
        conn.execute_batch(&format!(
            "insert into entities (id, stream_id) values ('{SPACE}', '{SPACE}');
             insert into comp_space (entity, allow_public_join) values ('{SPACE}', 0);
             insert into comp_info (entity, name) values ('{SPACE}', 'Seen Space');
             insert into entities (id, stream_id) values
               ('{USER}', '{SPACE}'), ('{VIEWER}', '{SPACE}'),
               ('{AUTHOR}', '{SPACE}'), ('{OUTSIDER}', '{SPACE}');
             insert into edges (head, tail, label) values
               ('{SPACE}', '{USER}', 'member'),
               ('{SPACE}', '{VIEWER}', 'member');
             insert into entities (id, stream_id) values ('{ROOM}', '{SPACE}');
             insert into comp_room (entity, label, default_access)
               values ('{ROOM}', 'space.roomy.channel', 'readwrite');
             insert into comp_info (entity, name) values ('{ROOM}', 'general');
             insert into entities (id, stream_id, room, sort_idx) values
               ('{MSG_A}', '{SPACE}', '{ROOM}', 'a'),
               ('{MSG_B}', '{SPACE}', '{ROOM}', 'b');
             insert into edges (head, tail, label) values
               ('{MSG_A}', '{USER}', 'author'),
               ('{MSG_B}', '{AUTHOR}', 'author');
             insert into entities (id, stream_id) values ('{THREAD}', '{SPACE}');
             insert into comp_room (entity, label, default_access)
               values ('{THREAD}', 'space.roomy.thread', 'readwrite');
             insert into comp_info (entity, name) values ('{THREAD}', 'a thread');"
        ))
        .expect("space rows");
        SpaceReadDb::from_connection(conn)
    }

    async fn post(fixture: &Fixture, did: Option<&str>, body: &str) -> (StatusCode, String) {
        let mut headers = HeaderMap::new();
        if let Some(did) = did {
            headers.insert(
                "x-test-did",
                HeaderValue::try_from(did).expect("did header"),
            );
        }
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let response = http(
            State(Arc::clone(&fixture.state)),
            headers,
            RawQuery(None),
            Bytes::copy_from_slice(body.as_bytes()),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn an_absent_watermark_anchors_on_the_newest_visible_message() {
        let fixture = Fixture::new();
        // The viewer hides the author of the newest message, so the anchor is
        // the older message they can still see.
        fixture.seed_read_state(
            "insert into user_blocks (user_did, blocked_did, source)
             values ('did:plc:viewer', 'did:plc:author', 'roomy')",
        );

        let (status, body) =
            post(&fixture, Some(VIEWER), &format!(r#"{{"roomId":"{ROOM}"}}"#)).await;

        assert_eq!(status, StatusCode::OK);
        assert!(body.is_empty(), "a void procedure has no body");
        assert_eq!(
            fixture.store.read_positions(VIEWER).expect("positions"),
            vec![ReadPosition {
                room_id: ROOM.to_string(),
                seen_up_to: "a".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn an_explicit_watermark_records_the_message_key_and_repeats() {
        let fixture = Fixture::new();
        let body = format!(r#"{{"roomId":"{ROOM}","seenUpTo":"{MSG_A}"}}"#);

        let (status, _) = post(&fixture, Some(USER), &body).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = post(&fixture, Some(USER), &body).await;
        assert_eq!(status, StatusCode::OK);

        assert_eq!(
            fixture.store.read_positions(USER).expect("positions"),
            vec![ReadPosition {
                room_id: ROOM.to_string(),
                seen_up_to: "a".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn a_watermark_outside_the_room_is_rejected() {
        let fixture = Fixture::new();
        let (status, body) = post(
            &fixture,
            Some(USER),
            &format!(r#"{{"roomId":"{ROOM}","seenUpTo":"{THREAD}"}}"#),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("does not exist in room"));
        assert!(fixture
            .store
            .read_positions(USER)
            .expect("positions")
            .is_empty());
    }

    #[tokio::test]
    async fn reading_a_thread_records_activity_but_a_channel_does_not() {
        let fixture = Fixture::new();

        let (status, _) = post(&fixture, Some(USER), &format!(r#"{{"roomId":"{THREAD}"}}"#)).await;
        assert_eq!(status, StatusCode::OK);

        let (status, _) = post(&fixture, Some(USER), &format!(r#"{{"roomId":"{ROOM}"}}"#)).await;
        assert_eq!(status, StatusCode::OK);

        let activity = fixture
            .store
            .thread_activity(USER)
            .expect("thread activity");
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].thread_id, THREAD);
        assert!(activity[0].last_active_at > 0);
    }

    #[tokio::test]
    async fn reading_a_room_resets_its_pending_digest() {
        let fixture = Fixture::new();
        fixture.seed_read_state(&format!(
            "insert into notification_state (user_did, room_id, unseen_count)
             values ('{USER}', '{ROOM}', 4), ('{USER}', '{THREAD}', 2)"
        ));

        let (status, _) = post(&fixture, Some(USER), &format!(r#"{{"roomId":"{ROOM}"}}"#)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(fixture.notification_rows(USER, ROOM), 0);
        assert_eq!(fixture.notification_rows(USER, THREAD), 1);
    }

    #[tokio::test]
    async fn a_caller_who_cannot_read_the_room_is_forbidden() {
        let fixture = Fixture::new();
        let (status, body) = post(
            &fixture,
            Some(OUTSIDER),
            &format!(r#"{{"roomId":"{ROOM}"}}"#),
        )
        .await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("Caller has no read access to this room"));
        assert!(fixture
            .store
            .read_positions(OUTSIDER)
            .expect("positions")
            .is_empty());
    }

    #[tokio::test]
    async fn an_unknown_room_is_not_found() {
        let fixture = Fixture::new();
        let missing = "01JRZ0R00N00000000000000ZZ";
        let (status, body) = post(
            &fixture,
            Some(USER),
            &format!(r#"{{"roomId":"{missing}"}}"#),
        )
        .await;

        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body.contains(&format!("Room not found: {missing}")));
    }

    #[tokio::test]
    async fn an_anonymous_call_requires_authentication() {
        let fixture = Fixture::new();
        let (status, body) = post(&fixture, None, &format!(r#"{{"roomId":"{ROOM}"}}"#)).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("Authentication required"));
    }

    #[tokio::test]
    async fn the_body_must_name_a_room_and_keep_seen_up_to_a_string() {
        let fixture = Fixture::new();

        let (status, body) = post(&fixture, Some(USER), "{}").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("Missing or empty required field: roomId"));

        let (status, body) = post(
            &fixture,
            Some(USER),
            &format!(r#"{{"roomId":"{ROOM}","seenUpTo":7}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("Field seenUpTo must be a string if provided"));

        let (status, body) = post(&fixture, Some(USER), "{").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("Malformed JSON body"));
    }
}
