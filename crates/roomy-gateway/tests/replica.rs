//! Replicated reads: a process serves a space it does not own.
//!
//! One writer per space, N readers following it (`rust-core-appserver.md` §2.1).
//! The owner takes the lease and applies both halves; a replica takes nothing,
//! replays the same log into its own projection, and serves per-space reads from
//! it. This test runs both against one log and requires the replica's projection
//! and its answers to equal the owner's.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use http_body_util::BodyExt;
use tower::ServiceExt;

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::internal::{FeedService, INTERNAL_HEADER};
use roomy_gateway::{router, GatewaySignals, GatewayState};
use roomy_space_worker::supervisor::{FeedFactory, Ownership};
use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};
use space_feed::http::{HttpChangeFeed, UreqPull};
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::ChangeFeed;
use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SPACE: &str = "did:web:replica.example";
const SECRET: &str = "replica-secret";

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

fn build_events_db(path: &Path, space: &SpaceDid) {
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

struct Served {
    base_url: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

async fn serve_feed(events_db: &Path) -> Served {
    let placeholder = Arc::new(SpaceReadDb::from_connection(
        rusqlite::Connection::open_in_memory().expect("placeholder"),
    ));
    let reads = XrpcState::new(placeholder, Arc::new(TestMode));
    let state = GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(b"ticket-secret".to_vec(), "test", 60)),
        Arc::new(TicketVerifier::new(
            b"ticket-secret".to_vec(),
            "test",
            Box::new(InMemoryNonces::new()),
        )),
        GatewaySignals::new(4),
    )
    .with_internal_secret(SECRET)
    .with_feed(FeedService::open(events_db).expect("feed service"));

    let app = router(Arc::new(state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await;
    });
    Served {
        base_url: format!("http://{address}"),
        shutdown,
        handle,
    }
}

fn config(dir: &Path, events_db: &Path, ownership: Ownership) -> SupervisorConfig {
    SupervisorConfig {
        events_db: events_db.to_path_buf(),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: format!("replica-test-{ownership:?}"),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership,
    }
}

fn digest(config: &SupervisorConfig, space: &SpaceDid) -> String {
    let db = SpaceDb::open(config.space_path(space), space.clone()).expect("space DB");
    digest_of(&worker_snapshot(
        &snapshot_db(db.connection()).expect("snapshot"),
    ))
}

fn wait_for_catch_up(config: &SupervisorConfig, space: &SpaceDid, timeout: Duration) {
    let latest: i64 = {
        let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
        conn.query_row(
            "select max(idx) from record_changes where stream_id = ?",
            [space.as_str()],
            |row| row.get(0),
        )
        .expect("latest idx")
    };
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(db) = SpaceDb::open(config.space_path(space), space.clone()) {
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx >= latest {
                    return;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "the projection never reached the last entry"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

async fn get(state: &XrpcState, uri: &str) -> (u16, String) {
    let app = space_xrpc::router(state.clone());
    let response = app
        .oneshot(
            axum::http::Request::builder()
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

/// The per-space router a gateway would mount, over `config`'s own files.
fn reads(config: &SupervisorConfig) -> XrpcState {
    let registry = Arc::new(SpaceRegistry::new(
        config.spaces_dir.clone(),
        Some(config.global_db.clone()),
        8,
    ));
    let placeholder = SpaceReadDb::open_readonly(
        config.space_path(&SpaceDid::parse(SPACE.to_string()).expect("space DID")),
    )
    .expect("space DB");
    XrpcState::new(Arc::new(placeholder), Arc::new(TestMode))
        .with_spaces(Arc::clone(&registry) as Arc<dyn SpaceResolver>)
}

fn room_of(config: &SupervisorConfig, space: &SpaceDid) -> String {
    let db = SpaceDb::open(config.space_path(space), space.clone()).expect("space DB");
    db.connection()
        .query_row("select entity from comp_room limit 1", [], |row| {
            row.get::<_, String>(0)
        })
        .expect("the space has a room")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_replica_serves_what_the_owner_materialised() {
    let owner_dir = tempfile::tempdir().expect("owner dir");
    let replica_dir = tempfile::tempdir().expect("replica dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");

    let events_db = owner_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);

    // The owner: the only process that takes the lease.
    let owner_config = config(owner_dir.path(), &events_db, Ownership::Owner);
    let owner = Supervisor::new(owner_config.clone()).with_feed({
        let events_db = events_db.clone();
        Arc::new(move || Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn ChangeFeed>))
    });
    owner.start_all([space.clone()]).expect("owner starts");
    tokio::task::spawn_blocking({
        let config = owner_config.clone();
        let space = space.clone();
        move || wait_for_catch_up(&config, &space, Duration::from_secs(20))
    })
    .await
    .expect("join");

    // The replica: same log, no lease, its own projection and its own global copy.
    let served = serve_feed(&events_db).await;
    let url = served.base_url.clone();
    let factory: FeedFactory = Arc::new(move || {
        Ok(Box::new(HttpChangeFeed::new(
            url.clone(),
            UreqPull::default().with_header(INTERNAL_HEADER, SECRET),
        )) as Box<dyn ChangeFeed>)
    });
    let replica_config = config(replica_dir.path(), &events_db, Ownership::Follower);
    let replica = Supervisor::new(replica_config.clone()).with_feed(factory);
    replica.start_all([space.clone()]).expect("replica starts");
    tokio::task::spawn_blocking({
        let config = replica_config.clone();
        let space = space.clone();
        move || wait_for_catch_up(&config, &space, Duration::from_secs(20))
    })
    .await
    .expect("join");

    // The owner's lease survives a replica replaying beside it.
    let lease_rows: i64 = {
        let conn = rusqlite::Connection::open(&owner_config.global_db).expect("global DB");
        conn.query_row(
            "select count(*) from worker_leases where name = ?",
            [roomy_space_worker::lease::lease_name(&space)],
            |row| row.get(0),
        )
        .expect("lease row")
    };
    assert_eq!(lease_rows, 1, "the replica took no lease");

    assert_eq!(
        digest(&replica_config, &space),
        digest(&owner_config, &space),
        "the replica's projection must equal the owner's"
    );

    // The same request answered from either projection, byte for byte.
    let room = room_of(&owner_config, &space);
    let owner_uri = format!("/xrpc/space.roomy.room.getMessages?roomId={room}");
    let owner_answer = get(&reads(&owner_config), &owner_uri).await;
    let replica_answer = get(&reads(&replica_config), &owner_uri).await;

    replica.stop();
    owner.stop();
    let _ = served.shutdown.send(());
    let _ = served.handle.await;

    assert_eq!(owner_answer.0, 200, "{}", owner_answer.1);
    assert_eq!(
        replica_answer, owner_answer,
        "a replica answers the owner's request identically"
    );
}
