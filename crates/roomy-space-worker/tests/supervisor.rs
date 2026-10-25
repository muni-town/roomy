//! The supervisor: one process, several spaces.
//!
//! The gate this file exists for is the M1 gate: a process materialises N spaces
//! and stops cleanly. The log is the fixture corpus, replayed under three
//! different space DIDs, so the projections it compares are the ones the
//! TypeScript rules produce from that corpus.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The events database: the fixture's rows, once per space.
fn build_events_db(path: &Path, spaces: &[SpaceDid]) {
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

fn config(dir: &Path) -> SupervisorConfig {
    SupervisorConfig {
        events_db: dir.join("events.sqlite"),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: "supervisor-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    }
}

fn digest_of_space(path: &Path, space: &SpaceDid) -> String {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    digest_of(&worker_snapshot(
        &snapshot_db(db.connection()).expect("snapshot"),
    ))
}

/// Each table's row count, which is what two spaces holding the same log agree
/// on: the rows themselves name the space, so their columns differ by design.
fn shape_of_space(path: &Path, space: &SpaceDid) -> Vec<(String, usize)> {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    let snapshot = worker_snapshot(&snapshot_db(db.connection()).expect("snapshot"));
    snapshot
        .into_iter()
        .map(|table| (table.table, table.rows.len()))
        .collect()
}

/// Wait until every space's cursor has reached the last entry in its feed.
fn wait_for_catch_up(config: &SupervisorConfig, spaces: &[SpaceDid], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let mut ready = 0;
        for space in spaces {
            let db = SpaceDb::open(config.space_path(space), space.clone()).expect("space DB");
            let latest: i64 = {
                let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
                conn.query_row(
                    "select max(idx) from record_changes where stream_id = ?",
                    [space.as_str()],
                    |row| row.get(0),
                )
                .expect("latest idx")
            };
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx >= latest {
                    ready += 1;
                }
            }
        }
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

#[test]
fn one_process_materialises_several_spaces_and_stops_them_cleanly() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spaces: Vec<SpaceDid> = [
        "did:web:first.example",
        "did:web:second.example",
        "did:web:third.example",
    ]
    .iter()
    .map(|did| SpaceDid::parse(did.to_string()).expect("space DID"))
    .collect();
    let config = config(dir.path());
    build_events_db(&config.events_db, &spaces);

    let supervisor = Supervisor::start(config.clone(), spaces.clone()).expect("supervisor starts");
    wait_for_catch_up(&config, &spaces, Duration::from_secs(20));

    // Every space's projection is the corpus's: the three hold the same rows,
    // table for table. The rows themselves name the space, so their columns
    // differ by design and the comparison is the shape each projection has.
    let shapes: Vec<Vec<(String, usize)>> = spaces
        .iter()
        .map(|space| shape_of_space(&config.space_path(space), space))
        .collect();
    assert!(
        shapes[0].iter().any(|(_, rows)| *rows > 0),
        "the log wrote rows"
    );
    assert_eq!(shapes[0], shapes[1]);
    assert_eq!(shapes[1], shapes[2]);
    let digests: Vec<String> = spaces
        .iter()
        .map(|space| digest_of_space(&config.space_path(space), space))
        .collect();

    // Health is per space, and each actor reports the lease it holds.
    let health = supervisor.health();
    assert_eq!(health.len(), 3, "one health row per running actor");
    assert!(health.iter().all(|health| health.lease_held));
    assert!(health.iter().all(|health| health.lag == 0));
    assert_eq!(supervisor.spaces().len(), 3);

    // Stopping gives the leases back: another process can take them at once.
    supervisor.stop();
    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let held: i64 = global
        .query_row("select count(*) from worker_leases", [], |row| row.get(0))
        .expect("lease count");
    assert_eq!(held, 0, "stopping must release every lease");

    // The projections survive the stop.
    let after: Vec<String> = spaces
        .iter()
        .map(|space| digest_of_space(&config.space_path(space), space))
        .collect();
    assert_eq!(after, digests);
}

#[test]
fn stopping_one_space_leaves_the_others_running() {
    let dir = tempfile::tempdir().expect("temp dir");
    let spaces: Vec<SpaceDid> = ["did:web:keep.example", "did:web:drop.example"]
        .iter()
        .map(|did| SpaceDid::parse(did.to_string()).expect("space DID"))
        .collect();
    let config = config(dir.path());
    build_events_db(&config.events_db, &spaces);

    let supervisor = Supervisor::start(config.clone(), spaces.clone()).expect("supervisor starts");
    wait_for_catch_up(&config, &spaces, Duration::from_secs(20));

    supervisor.stop_space(&spaces[1]);
    assert_eq!(supervisor.spaces(), vec![spaces[0].as_str().to_string()]);

    // The survivor keeps its lease; the stopped space's is released.
    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let lease = |space: &SpaceDid| -> Option<String> {
        global
            .query_row(
                "select holder from worker_leases where name = ?",
                [format!("space-worker:{space}")],
                |row| row.get(0),
            )
            .ok()
    };
    assert_eq!(lease(&spaces[0]).as_deref(), Some("supervisor-test"));
    assert_eq!(lease(&spaces[1]), None);

    supervisor.stop();
}
