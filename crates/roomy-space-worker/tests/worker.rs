//! The loop, end to end: a fixture's change feed in, a projection out.
//!
//! The parity test in `space-db` checks the rules against the recorded digests;
//! this one checks the process around them — the feed read, the lease, the
//! cursor written with the batch, and the global half reaching the sink.

use std::path::{Path, PathBuf};
use std::time::Duration;

use roomy_space_worker::feed::{ChangeFeed, SqliteChangeFeed};
use roomy_space_worker::lease::{Lease, SqliteLease};
use roomy_space_worker::sink::{GlobalSink, SqliteGlobalSink};
use roomy_space_worker::worker::{Progress, Worker, WorkerParts};
use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};

#[derive(Deserialize)]
struct Fixture {
    stream: String,
    expected: Expected,
    changes: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Expected {
    #[serde(rename = "spaceDigest")]
    space_digest: String,
}

fn fixture_path() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../space-db/tests/fixtures");
    std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("no fixtures at {}: {err}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("fixture.json"))
        .find(|path| path.is_file())
        .expect("a fixture")
}

/// A feed holding the fixture's rows.
fn seeded_feed(fixture: &Fixture) -> SqliteChangeFeed {
    let feed = SqliteChangeFeed::in_memory().expect("feed");
    let conn = feed.connection();
    for row in &fixture.changes {
        conn.execute(
            "insert into record_changes (
               stream_id, idx, ord, kind, repo, collection, rkey, op,
               order_stamp, actor, event_id, body
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                row["streamId"].as_str(),
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
    feed
}

fn seeded_space(stream: &SpaceDid) -> SpaceDb {
    let db = SpaceDb::open_in_memory(stream.clone()).expect("space DB");
    db.connection()
        .execute(
            "insert into entities (id, stream_id) values (?, ?)",
            rusqlite::params![stream.as_str(), stream.as_str()],
        )
        .expect("seed entity");
    db.connection()
        .execute(
            "insert into comp_space (entity) values (?)",
            rusqlite::params![stream.as_str()],
        )
        .expect("seed space row");
    db
}

fn run_to_idle<S: GlobalSink>(worker: &mut Worker<SqliteChangeFeed, SqliteLease, S>) {
    for _ in 0..50 {
        match worker.step().expect("a step") {
            Progress::Applied { .. } => continue,
            Progress::Idle { .. } => return,
            Progress::NotLeased => panic!("the worker lost its own lease"),
        }
    }
    panic!("the loop did not drain the feed");
}

#[test]
fn a_fixture_feed_drains_to_the_typescript_digest() {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let stream = SpaceDid::parse(fixture.stream.clone()).expect("stream is a DID");

    let feed = seeded_feed(&fixture);
    let lease = SqliteLease::in_memory().expect("lease");
    let sink = SqliteGlobalSink::in_memory().expect("sink");
    let mut worker = Worker::new(WorkerParts {
        space: stream.clone(),
        holder: "test-holder".to_string(),
        lease_ttl: Duration::from_secs(30),
        // One batch, matching the chunk the TypeScript materialiser applies the
        // same log in: the derived steps see a batch's rows as a whole.
        batch_limit: 500,
        feed,
        lease,
        sink,
        db: seeded_space(&stream),
    });

    run_to_idle(&mut worker);

    let digest = digest_of(&worker_snapshot(
        &snapshot_db(worker.space_db().connection()).expect("snapshot"),
    ));
    assert_eq!(
        digest, fixture.expected.space_digest,
        "the worker's projection differs from the TypeScript one"
    );

    // The cursor sits at the last row the feed held, and the lag it reports is
    // zero now that everything is applied.
    let cursor = worker.cursor().expect("cursor");
    assert!(cursor.0 > 0);
    assert_eq!(worker.lag().expect("lag"), 0);

    let health = worker.health();
    assert!(health.lease_held);
    assert_eq!(health.last_error, None);
    assert!(health.is_healthy());
    assert!(health.to_json().contains("\"leaseHeld\":true"));
}

#[test]
fn a_second_worker_cannot_take_a_held_lease() {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let stream = SpaceDid::parse(fixture.stream.clone()).expect("stream is a DID");
    let path = tempfile::NamedTempFile::new().expect("temp file");
    let db_path = path.path().to_path_buf();

    let mut first = SqliteLease::open(&db_path).expect("lease");
    assert!(first
        .acquire(&stream, "holder-a", Duration::from_secs(30))
        .expect("acquire"));
    let mut second = SqliteLease::open(&db_path).expect("lease");
    assert!(!second
        .acquire(&stream, "holder-b", Duration::from_secs(30))
        .expect("acquire"));

    // The holder renews, and a release by a non-holder leaves the row alone.
    assert!(first
        .acquire(&stream, "holder-a", Duration::from_secs(30))
        .expect("renew"));
    second
        .release(&stream, "holder-b")
        .expect("release by a non-holder");
    assert!(!second
        .acquire(&stream, "holder-b", Duration::from_secs(30))
        .expect("acquire after the failed release"));

    first.release(&stream, "holder-a").expect("release");
    assert!(second
        .acquire(&stream, "holder-b", Duration::from_secs(30))
        .expect("acquire after the holder released"));
}

#[test]
fn a_batch_is_applied_with_its_cursor_or_not_at_all() {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let stream = SpaceDid::parse(fixture.stream.clone()).expect("stream is a DID");
    let feed = seeded_feed(&fixture);
    let mut db = seeded_space(&stream);

    // A batch that cannot be applied leaves the cursor where it was, so the
    // same changes are read again rather than skipped.
    let rows = feed
        .batch(&stream, (-1, -1), 1)
        .expect("a batch from the start");
    let broken =
        space_core::effects::Effect::space("insert into no_such_table (x) values (1)", Vec::new());
    let planned = vec![space_db::PlannedEntry {
        idx: rows[0].idx,
        effects: vec![broken],
    }];
    assert!(db
        .apply_batch(&planned, (rows[0].idx, rows[0].ord))
        .is_err());
    assert_eq!(db.cursor().expect("cursor"), None);
}

#[test]
fn a_batch_never_splits_an_entry() {
    let feed = SqliteChangeFeed::in_memory().expect("feed");
    let space = SpaceDid::parse("did:web:batch.example").expect("space");
    let conn = feed.connection();
    for (idx, ord) in [(1, 0), (2, 0), (2, 1), (2, 2), (3, 0)] {
        conn.execute(
            "insert into record_changes (
               stream_id, idx, ord, kind, repo, collection, rkey, op,
               order_stamp, actor, event_id, body
             ) values (?, ?, ?, 'ban', ?, 'space.roomy.space.ban', ?, 'delete', ?, ?, ?, null)",
            rusqlite::params![
                space.as_str(),
                idx,
                ord,
                space.as_str(),
                format!("did:plc:user{idx}"),
                "01HF7YAT000000000000000001",
                space.as_str(),
                "01HF7YAT00000000000000000A",
            ],
        )
        .expect("inserting a feed row");
    }

    // A limit of one still returns the whole of entry 2, because its changes
    // are planned together.
    let rows = feed.batch(&space, (0, 0), 2).expect("a batch");
    assert_eq!(
        rows.iter()
            .map(|row| (row.idx, row.ord))
            .collect::<Vec<_>>(),
        vec![(1, 0), (2, 0), (2, 1), (2, 2)]
    );

    let rest = feed.batch(&space, (2, 2), 2).expect("the next batch");
    assert_eq!(
        rest.iter()
            .map(|row| (row.idx, row.ord))
            .collect::<Vec<_>>(),
        vec![(3, 0)]
    );
}
