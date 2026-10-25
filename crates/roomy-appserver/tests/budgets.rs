//! L10: the numbers a cutover is decided on.
//!
//! This is not a micro-benchmark of the projection. It measures the three things
//! an operator budgets for, on the fixture corpus, in this process: how long a
//! per-space read takes, how long a cold rebuild of one space takes, and how many
//! rows one message read touches. It is `#[ignore]`d because a wall-clock budget on
//! shared CI hardware fails for reasons that have nothing to do with the code; run
//! it on the machine that will serve the traffic:
//!
//! ```text
//! cargo test -p roomy-appserver --test budgets -- --ignored --nocapture
//! ```
//!
//! The budgets below are the ones this deployment accepts. A number that misses
//! one is a reason not to cut over, not a test to retune.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use http_body_util::BodyExt;
use tower::ServiceExt;

use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_feed::sqlite::SqliteChangeFeed;
use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SPACE: &str = "did:web:budget.example";

/// A read at the ninety-fifth percentile may take this long.
const P95_READ: Duration = Duration::from_millis(50);
/// A cold rebuild of one space from the corpus may take this long.
const REBUILD: Duration = Duration::from_secs(5);
/// A message read may touch this many rows for a fifty-message page.
const ROWS_PER_PAGE: i64 = 50 * 12;

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> PathBuf {
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

fn config(dir: &Path) -> SupervisorConfig {
    SupervisorConfig {
        events_db: dir.join("events.sqlite"),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: "budget-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    }
}

fn wait_until_drained(config: &SupervisorConfig, space: &SpaceDid) {
    let latest: i64 = {
        let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
        conn.query_row(
            "select max(idx) from record_changes where stream_id = ?",
            [space.as_str()],
            |row| row.get(0),
        )
        .expect("latest")
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(db) = space_db::SpaceDb::open(config.space_path(space), space.clone()) {
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx >= latest {
                    return;
                }
            }
        }
        assert!(Instant::now() < deadline, "the rebuild did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn percentile(samples: &mut [Duration], fraction: f64) -> Duration {
    samples.sort();
    let index = ((samples.len() as f64 - 1.0) * fraction).round() as usize;
    samples[index]
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a timing budget is meaningless on shared CI hardware"]
async fn a_read_a_rebuild_and_a_page_stay_inside_their_budgets() {
    let dir = tempfile::tempdir().expect("dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    build_events_db(&dir.path().join("events.sqlite"), &space);
    let config = config(dir.path());

    // Rebuild: a cold materialisation of the corpus, which is what a worker does
    // after a lease handover or a per-space DB loss.
    let rebuild_started = Instant::now();
    let supervisor = Supervisor::new(config.clone()).with_feed({
        let events_db = config.events_db.clone();
        Arc::new(move || {
            Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn space_feed::ChangeFeed>)
        })
    });
    supervisor
        .start_all([space.clone()])
        .expect("the space starts");
    tokio::task::spawn_blocking({
        let config = config.clone();
        let space = space.clone();
        move || wait_until_drained(&config, &space)
    })
    .await
    .expect("join");
    let rebuild = rebuild_started.elapsed();
    supervisor.stop();

    // Reads through the router the gateway mounts, over a registry, as a request
    // would arrive.
    let registry = Arc::new(SpaceRegistry::new(
        config.spaces_dir.clone(),
        Some(config.global_db.clone()),
        16,
    ));
    let placeholder = SpaceReadDb::open_readonly(config.space_path(&space)).expect("space DB");
    let reads = XrpcState::new(Arc::new(placeholder), Arc::new(TestMode))
        .with_spaces(Arc::clone(&registry) as Arc<dyn SpaceResolver>);

    let room: String = {
        let db = SpaceReadDb::open_readonly(config.space_path(&space)).expect("space DB");
        db.with(|conn| {
            conn.query_row("select entity from comp_room limit 1", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| space_xrpc::error::XrpcError::internal(error.to_string()))
        })
        .expect("the corpus has a room")
    };
    let uri = format!("/xrpc/space.roomy.room.getMessages?roomId={room}&limit=50");

    // The first call pays for opening the space; the rest are the steady state.
    let (status, _) = get(&reads, &uri).await;
    assert_eq!(status, 200);

    let mut samples: Vec<Duration> = Vec::with_capacity(200);
    for _ in 0..200 {
        let started = Instant::now();
        let (status, _) = get(&reads, &uri).await;
        samples.push(started.elapsed());
        assert_eq!(status, 200);
    }

    // What a page costs in rows: the messages, their reactions, their attachments
    // and the authors behind them.
    let rows = {
        let db = SpaceReadDb::open_readonly(config.space_path(&space)).expect("space DB");
        db.with(|conn| {
            conn.query_row(
                "select count(*) from entities where sort_idx is not null",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| space_xrpc::error::XrpcError::internal(error.to_string()))
        })
        .expect("messages")
    };

    let p50 = percentile(&mut samples.clone(), 0.50);
    let p95 = percentile(&mut samples, 0.95);

    println!(
        "reads: p50 {p50:?}, p95 {p95:?} over {} calls; rebuild {rebuild:?}; messages {rows}",
        samples.len()
    );

    assert!(
        p95 <= P95_READ,
        "p95 read {p95:?} exceeds the {P95_READ:?} budget"
    );
    assert!(
        rebuild <= REBUILD,
        "cold rebuild {rebuild:?} exceeds the {REBUILD:?} budget"
    );
    assert!(
        rows <= ROWS_PER_PAGE,
        "a fifty-message page holds more than {ROWS_PER_PAGE} rows' worth of messages: {rows}"
    );
}
