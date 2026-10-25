//! The M1 gate: one process materialises several spaces and serves the eight
//! per-space read NSIDs from the log-derived databases.
//!
//! The supervisor materialises two spaces from the same corpus under different
//! DIDs; the registry then answers requests for both, resolving a space by
//! `spaceId` and a room or message by the global entity→space index the worker's
//! sink wrote.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use roomy_space_worker::{Supervisor, SupervisorConfig};
use space_core::ids::SpaceDid;
use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The events database: the fixture's rows, once per space.
fn build_events_db(path: &Path, spaces: &[SpaceDid]) {
    #[derive(serde::Deserialize)]
    struct Fixture {
        changes: Vec<Value>,
    }
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let conn = rusqlite::Connection::open(path).expect("events DB");
    conn.execute_batch(
        "create table record_changes (
           stream_id text not null,
           idx integer not null,
           ord integer not null,
           kind text not null,
           repo text not null,
           collection text not null,
           rkey text not null,
           op text not null,
           order_stamp text not null,
           actor text not null,
           event_id text not null,
           body text,
           primary key (stream_id, idx, ord)
         ) strict;",
    )
    .expect("schema");
    for space in spaces {
        for row in &fixture.changes {
            conn.execute(
                "insert into record_changes (
                   stream_id, idx, ord, kind, repo, collection, rkey, op,
                   order_stamp, actor, event_id, body
                 ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    space.as_str(),
                    row["idx"].as_i64(),
                    row["ord"].as_i64(),
                    row["kind"].as_str(),
                    row["repo"].as_str(),
                    row["collection"].as_str(),
                    row["rkey"].as_str(),
                    row["op"].as_str(),
                    row["orderStamp"].as_str(),
                    row["actor"].as_str(),
                    row["eventId"].as_str(),
                    row["body"].as_str(),
                ],
            )
            .expect("inserting a feed row");
        }
    }
}

fn wait_for_catch_up(config: &SupervisorConfig, spaces: &[SpaceDid], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let ready = spaces
            .iter()
            .filter(|space| {
                let latest: i64 = {
                    let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
                    conn.query_row(
                        "select max(idx) from record_changes where stream_id = ?",
                        [space.as_str()],
                        |row| row.get(0),
                    )
                    .expect("latest idx")
                };
                matches!(cursor_of(config.space_path(space)), Some((idx, _)) if idx >= latest)
            })
            .count();
        if ready == spaces.len() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor did not drain {ready}/{} spaces in time",
            spaces.len()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Read one row out of a materialised space, the way a reader would.
fn space_query(path: PathBuf, sql: &str) -> Option<String> {
    SpaceReadDb::open_readonly(path)
        .ok()?
        .with(|conn| {
            conn.query_row(sql, [], |row| row.get::<_, String>(0))
                .ok()
                .ok_or_else(|| space_xrpc::error::XrpcError::internal("no row"))
        })
        .ok()
}

/// The cursor the worker committed for a space.
fn cursor_of(path: PathBuf) -> Option<(i64, i64)> {
    SpaceReadDb::open_readonly(path)
        .ok()?
        .with(|conn| {
            conn.query_row(
                "select idx, ord from worker_cursor where id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
            .ok_or_else(|| space_xrpc::error::XrpcError::internal("no cursor"))
        })
        .ok()
}

async fn get(state: &XrpcState, uri: &str) -> (u16, String) {
    let app = space_xrpc::router(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("x-test-did", "did:plc:reader")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("router response");
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn one_process_serves_every_space_it_materialised() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spaces: Vec<SpaceDid> = ["did:web:alpha.example", "did:web:beta.example"]
        .iter()
        .map(|did| SpaceDid::parse(did.to_string()).expect("space DID"))
        .collect();
    let config = SupervisorConfig {
        events_db: dir.path().join("events.sqlite"),
        global_db: dir.path().join("global.sqlite"),
        spaces_dir: dir.path().join("spaces"),
        holder: "registry-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    };
    build_events_db(&config.events_db, &spaces);
    let supervisor = Supervisor::start(config.clone(), spaces.clone()).expect("supervisor starts");
    wait_for_catch_up(&config, &spaces, Duration::from_secs(20));

    // The registry the gateway's per-space router uses.
    let registry = Arc::new(SpaceRegistry::new(
        dir.path().join("spaces"),
        Some(config.global_db.clone()),
        8,
    ));
    let placeholder = registry
        .resolve_space(spaces[0].as_str())
        .expect("the first space is open");
    let state = XrpcState::new(placeholder, Arc::new(TestMode))
        .with_spaces(Arc::clone(&registry) as Arc<dyn SpaceResolver>);

    for space in &spaces {
        let (status, body) = get(
            &state,
            &format!(
                "/xrpc/space.roomy.space.getMetadata?spaceId={}",
                space.as_str()
            ),
        )
        .await;
        assert_eq!(status, 200, "getMetadata for {space}: {body}");
        assert!(
            body.contains(space.as_str()) || body.contains("name"),
            "the metadata is the materialised space's: {body}"
        );

        // A room and a message the log created, resolved through the global
        // entity→space index rather than named by spaceId.
        let room = space_query(
            config.space_path(space),
            "select entity from comp_room limit 1",
        )
        .expect("the space has a room");
        let message = space_query(
            config.space_path(space),
            "select id from entities where room is not null and sort_idx is not null limit 1",
        )
        .expect("the space has a message");

        assert!(
            registry.resolve_entity(&room).is_some(),
            "the registry resolves a room id through entity_space"
        );

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.room.getMessages?roomId={room}"),
        )
        .await;
        assert_eq!(status, 200, "getMessages for {room} in {space}: {body}");

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.message.getMessage?messageId={message}"),
        )
        .await;
        assert_eq!(status, 200, "getMessage for {message} in {space}: {body}");

        let (status, body) = get(
            &state,
            &format!(
                "/xrpc/space.roomy.space.getThreads?spaceId={}",
                space.as_str()
            ),
        )
        .await;
        assert_eq!(status, 200, "getThreads for {space}: {body}");

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.room.getMetadata?roomId={room}"),
        )
        .await;
        assert_eq!(
            status, 200,
            "room.getMetadata for {room} in {space}: {body}"
        );

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.room.getThreads?roomId={room}"),
        )
        .await;
        assert_eq!(status, 200, "room.getThreads for {room} in {space}: {body}");

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.room.getLinks?roomId={room}"),
        )
        .await;
        assert_eq!(status, 200, "room.getLinks for {room} in {space}: {body}");

        let (status, body) = get(
            &state,
            &format!("/xrpc/space.roomy.message.getReactions?messageId={message}"),
        )
        .await;
        assert_eq!(status, 200, "getReactions for {message} in {space}: {body}");
    }

    // A space nobody materialised is not served, rather than answered from the
    // wrong database.
    let (status, _) = get(
        &state,
        "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:unknown.example",
    )
    .await;
    assert_eq!(status, 404);

    supervisor.stop();
    drop(state);
    let _ = SpaceReadDb::open_readonly(config.space_path(&spaces[0]));
}
