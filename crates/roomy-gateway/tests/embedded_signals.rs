//! The embedded mode's signal path: a worker's commit, and the socket plane
//! that must be woken by it.
//!
//! The supervisor and the gateway share a process in `--role all`, but they do
//! not share state: the worker emits through the `SignalSink` seam, and the
//! gateway's sockets receive from it. This is the test that the seam is
//! actually connected — without it a committed batch would never invalidate a
//! cache entry or wake a subscription until its TTL ran out.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use roomy_gateway::GatewaySignals;
use roomy_space_worker::signal::SignalSink;
use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::ids::SpaceDid;

const SPACE: &str = "did:web:embedded.example";

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The events database: the fixture corpus under this test's space.
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
        holder: "embedded-signals-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    }
}

#[tokio::test]
async fn a_worker_s_commit_reaches_the_gateway_s_sockets() {
    let dir = tempfile::tempdir().expect("temp dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    build_events_db(&dir.path().join("events.sqlite"), &space);

    let signals = GatewaySignals::new(16);
    // Subscribed before any actor starts, so the first commit is observable.
    let mut received = signals.subscribe();

    let supervisor = Supervisor::new(config(dir.path())).with_signals({
        let signals = signals.clone();
        Arc::new(move || Box::new(signals.clone()) as Box<dyn SignalSink>)
    });
    supervisor
        .start_all([space.clone()])
        .expect("the space starts");

    let signal = tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .expect("a signal arrives")
        .expect("the gateway's sender is alive");

    supervisor.stop();

    assert_eq!(signal.space, space, "the signal names the space it moved");
    assert!(signal.entries > 0, "a commit applied at least one entry");
    assert!(
        signals.received() >= 1,
        "the gateway counted the signal it fanned out"
    );
}
