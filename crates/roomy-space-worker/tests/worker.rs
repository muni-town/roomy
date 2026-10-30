//! The loop, end to end: a fixture's change feed in, a projection out.
//!
//! The parity test in `space-db` checks the rules against the recorded digests;
//! this one checks the process around them — the feed read, the lease, the
//! cursor written with the batch, and the global half reaching the sink.

use std::path::{Path, PathBuf};
use std::time::Duration;

use roomy_space_worker::lease::{Lease, SqliteLease};
use roomy_space_worker::signal::NoSignals;
use roomy_space_worker::sink::{GlobalSink, SqliteGlobalSink};
use roomy_space_worker::worker::{Progress, Worker, WorkerParts};
use roomy_space_worker::{Cancel, Clock, SystemClock};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;
use space_db::plan;
use space_db::{digest_of, snapshot_db, snapshot_tables, worker_snapshot, SpaceDb};
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::{ChangeFeed, Cursor};

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

#[derive(Deserialize)]
struct FixtureGlobal {
    #[serde(rename = "globalTables")]
    tables: Vec<String>,
}

/// The instant the fixture's log was received. Seeded rows carry it, so the
/// projection does not depend on when the test ran.
fn fixture_received_at() -> i64 {
    #[derive(Deserialize)]
    struct ReceivedAt {
        #[serde(rename = "receivedAt")]
        received_at: i64,
    }
    let text = std::fs::read_to_string(fixture_path()).expect("fixture readable");
    serde_json::from_str::<ReceivedAt>(&text)
        .expect("fixture carries receivedAt")
        .received_at
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
    let seeded_at = fixture_received_at();
    db.connection()
        .execute(
            "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
            rusqlite::params![stream.as_str(), stream.as_str(), seeded_at, seeded_at],
        )
        .expect("seed entity");
    db.connection()
        .execute(
            "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
            rusqlite::params![stream.as_str(), seeded_at, seeded_at],
        )
        .expect("seed space row");
    db
}

fn run_to_idle<S: GlobalSink>(worker: &mut Worker<SqliteChangeFeed, SqliteLease, S, NoSignals>) {
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
        mode: space_core::PlanMode::Live,
        feed,
        lease,
        sink,
        signals: NoSignals,
        clock: std::sync::Arc::new(SystemClock),
        cancel: Cancel::new(),
        following: false,
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
    assert!(!health.following);
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
    assert!(
        first
            .acquire(
                &stream,
                "holder-a",
                SystemClock.now_ms(),
                Duration::from_secs(30)
            )
            .expect("acquire")
            .held
    );
    let mut second = SqliteLease::open(&db_path).expect("lease");
    assert!(
        !second
            .acquire(
                &stream,
                "holder-b",
                SystemClock.now_ms(),
                Duration::from_secs(30)
            )
            .expect("acquire")
            .held
    );

    // The holder renews, and a release by a non-holder leaves the row alone.
    assert!(
        first
            .acquire(
                &stream,
                "holder-a",
                SystemClock.now_ms(),
                Duration::from_secs(30)
            )
            .expect("renew")
            .held
    );
    second
        .release(&stream, "holder-b")
        .expect("release by a non-holder");
    assert!(
        !second
            .acquire(
                &stream,
                "holder-b",
                SystemClock.now_ms(),
                Duration::from_secs(30)
            )
            .expect("acquire after the failed release")
            .held
    );

    first.release(&stream, "holder-a").expect("release");
    assert!(
        second
            .acquire(
                &stream,
                "holder-b",
                SystemClock.now_ms(),
                Duration::from_secs(30)
            )
            .expect("acquire after the holder released")
            .held
    );
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
        .batch(&stream, Cursor::from((-1, -1)), 1)
        .expect("a batch from the start");
    let broken =
        space_core::effects::Effect::space("insert into no_such_table (x) values (1)", Vec::new());
    let planned = vec![space_db::PlannedEntry {
        idx: rows[0].idx,
        effects: vec![broken],
    }];
    assert!(db
        .begin_batch(&planned, (rows[0].idx, rows[0].ord), 1)
        .is_err());
    assert_eq!(db.cursor().expect("cursor"), None);
}

#[test]
fn a_batch_from_a_lost_lease_is_refused_and_leaves_the_cursor() {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let stream = SpaceDid::parse(fixture.stream.clone()).expect("stream is a DID");
    let feed = seeded_feed(&fixture);
    let mut db = seeded_space(&stream);
    let rows = feed
        .batch(&stream, Cursor::from((-1, -1)), 1)
        .expect("a batch from the start");

    // The first batch commits under epoch 1, as the lease's first grant carries.
    let planned = plan::plan_batch(
        db.connection(),
        &stream,
        &plan::group_entries(&rows).expect("group"),
        space_core::PlanMode::Live,
    )
    .expect("plan");
    db.begin_batch(&planned, (rows[0].idx, rows[0].ord), 1)
        .expect("begin")
        .commit()
        .expect("commit");
    let cursor = db.cursor().expect("cursor");
    assert_eq!(db.fence().expect("fence"), 1);

    // Another worker takes the lease while this one is paused: the epoch
    // advances, and the batch this worker had planned is now stale.
    let planned = plan::plan_batch(
        db.connection(),
        &stream,
        &plan::group_entries(&rows).expect("group"),
        space_core::PlanMode::Live,
    )
    .expect("plan");
    let stale = db
        .begin_batch(&planned, (rows[0].idx, rows[0].ord), 2)
        .expect("begin");
    stale.commit().expect("the takeover's own batch lands");
    let planned = plan::plan_batch(
        db.connection(),
        &stream,
        &plan::group_entries(&rows).expect("group"),
        space_core::PlanMode::Live,
    )
    .expect("plan");
    let refused = db
        .begin_batch(&planned, (rows[0].idx, rows[0].ord), 1)
        .expect("begin");
    match refused.commit() {
        Err(space_db::DbError::Fenced { granted, stored }) => {
            assert_eq!((granted, stored), (1, 2));
        }
        other => panic!("a stale batch must be fenced out, got {other:?}"),
    }
    assert_eq!(
        db.cursor().expect("cursor"),
        cursor,
        "the cursor did not move"
    );
}

/// The fixture, its stream, and the global tables a comparison covers.
struct FixtureParts {
    space: SpaceDid,
    changes: Vec<FeedRow>,
    space_digest: String,
    global_tables: Vec<String>,
}

fn load_fixture() -> FixtureParts {
    let path = fixture_path();
    let text = std::fs::read_to_string(&path).expect("fixture readable");
    let fixture: Fixture = serde_json::from_str(&text).expect("fixture parses");
    let globals: FixtureGlobal = serde_json::from_str(&text).expect("fixture globals parse");
    FixtureParts {
        space: SpaceDid::parse(fixture.stream).expect("stream is a DID"),
        changes: fixture
            .changes
            .iter()
            .map(|row| serde_json::from_value(row.clone()).expect("feed row parses"))
            .collect(),
        space_digest: fixture.expected.space_digest,
        global_tables: globals.tables,
    }
}

/// A feed holding `changes`, in the order the worker reads them.
fn feed_of(changes: &[FeedRow]) -> SqliteChangeFeed {
    let feed = SqliteChangeFeed::in_memory().expect("feed");
    let conn = feed.connection();
    for row in changes {
        conn.execute(
            "insert into record_changes (
               stream_id, idx, ord, kind, repo, collection, rkey, op,
               order_stamp, actor, event_id, body
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                row.stream_id,
                row.idx,
                row.ord,
                row.kind,
                row.repo,
                row.collection,
                row.rkey,
                row.op,
                row.order_stamp,
                row.actor,
                row.event_id,
                row.body,
            ],
        )
        .expect("inserting a feed row");
    }
    feed
}

/// A space database on disk, with the fixture's pre-materialisation rows.
fn seeded_file(space: &SpaceDid, path: &Path) -> SpaceDb {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    let seeded_at = fixture_received_at();
    db.connection()
        .execute(
            "insert or ignore into entities (id, stream_id, created_at, updated_at)
             values (?, ?, ?, ?)",
            rusqlite::params![space.as_str(), space.as_str(), seeded_at, seeded_at],
        )
        .expect("seed entity");
    db.connection()
        .execute(
            "insert or ignore into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
            rusqlite::params![space.as_str(), seeded_at, seeded_at],
        )
        .expect("seed space row");
    db
}

/// Drain `space_path`'s feed to idle, and return the digest of its projection.
fn drain(space: &SpaceDid, changes: &[FeedRow], space_path: &Path, global_path: &Path) -> String {
    let feed = feed_of(changes);
    let lease = SqliteLease::open(global_path).expect("lease");
    let sink = SqliteGlobalSink::open(global_path).expect("sink");
    let db = seeded_file(space, space_path);
    let mut worker = Worker::new(WorkerParts {
        space: space.clone(),
        holder: "test-holder".to_string(),
        lease_ttl: Duration::from_secs(30),
        batch_limit: 500,
        mode: space_core::PlanMode::Live,
        feed,
        lease,
        sink,
        signals: NoSignals,
        clock: std::sync::Arc::new(SystemClock),
        cancel: Cancel::new(),
        following: false,
        db,
    });
    run_to_idle(&mut worker);
    digest_of(&worker_snapshot(
        &snapshot_db(worker.space_db().connection()).expect("snapshot"),
    ))
}

/// The digest of the global tables the manifest compares, in the oracle's
/// encoding.
fn global_digest(path: &Path, tables: &[String]) -> String {
    let conn = rusqlite::Connection::open(path).expect("global DB");
    digest_of(&snapshot_tables(&conn, tables).expect("global snapshot"))
}

/// A crash after the global write and before the space commit leaves the
/// global index ahead, the cursor unadvanced, and replay converges.
#[test]
fn a_crash_between_the_global_write_and_the_commit_replays_to_the_same_projection() {
    let fixture = load_fixture();
    let space = fixture.space.clone();
    let dir = tempfile::tempdir().expect("temp dir");

    // What an uninterrupted worker produces from the same log.
    let reference_space = drain(
        &space,
        &fixture.changes,
        &dir.path().join("reference.sqlite"),
        &dir.path().join("reference-global.sqlite"),
    );
    assert_eq!(reference_space, fixture.space_digest);
    let reference_global = global_digest(
        &dir.path().join("reference-global.sqlite"),
        &fixture.global_tables,
    );

    let space_path = dir.path().join("space.sqlite");
    let global_path = dir.path().join("global.sqlite");

    // Stop a worker after the sink accepted a batch's global half and before
    // the space transaction committed: the batch is dropped, which rolls the
    // space half back.
    {
        let mut db = seeded_file(&space, &space_path);
        let feed = feed_of(&fixture.changes);
        let rows = feed
            .batch(&space, Cursor::from((-1, -1)), 500)
            .expect("a batch from the start");
        let entries = plan::group_entries(&rows).expect("the rows group into entries");
        let planned = plan::plan_batch(
            db.connection(),
            &space,
            &entries,
            space_core::PlanMode::Live,
        )
        .expect("planning");
        let last = rows.last().expect("a non-empty batch");
        let mut sink = SqliteGlobalSink::open(&global_path).expect("sink");
        let batch = db
            .begin_batch(&planned, (last.idx, last.ord), 1)
            .expect("beginning the batch");
        sink.apply(batch.globals())
            .expect("the global half applies");
        drop(batch);

        assert_eq!(
            db.cursor().expect("cursor"),
            None,
            "the cursor must not advance before the space batch commits"
        );
        let empty = dir.path().join("empty-global.sqlite");
        drop(SqliteGlobalSink::open(&empty).expect("empty sink"));
        assert_ne!(
            global_digest(&global_path, &fixture.global_tables),
            global_digest(&empty, &fixture.global_tables),
            "the global half is written before the space half commits"
        );
    }

    // A worker that starts where that one stopped replays the batch from the
    // unadvanced cursor and lands on the same projection.
    let replayed_space = drain(&space, &fixture.changes, &space_path, &global_path);
    assert_eq!(
        replayed_space, fixture.space_digest,
        "the replay after the crash does not match the TypeScript projection"
    );
    assert_eq!(
        global_digest(&global_path, &fixture.global_tables),
        reference_global,
        "replaying the global half is not idempotent"
    );
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
    let rows = feed
        .batch(&space, Cursor::from((0, 0)), 2)
        .expect("a batch");
    assert_eq!(
        rows.iter()
            .map(|row| (row.idx, row.ord))
            .collect::<Vec<_>>(),
        vec![(1, 0), (2, 0), (2, 1), (2, 2)]
    );

    let rest = feed
        .batch(&space, Cursor::from((2, 2)), 2)
        .expect("the next batch");
    assert_eq!(
        rest.iter()
            .map(|row| (row.idx, row.ord))
            .collect::<Vec<_>>(),
        vec![(3, 0)]
    );
}
