//! What `/health` reports, for the two ownership modes.
//!
//! A follower answers reads from a projection it built beside the owner. It owns
//! no lease, so the only honest health it can give is "following, no lease,
//! cursor here" — and asking the lease seam would be a write to a table that is
//! not its. The owner keeps the behaviour it had: a health probe renews.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use roomy_space_worker::supervisor::{FeedFactory, Ownership};
use roomy_space_worker::{Health, Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::{ChangeFeed, Cursor, FeedError};

const SPACE: &str = "did:web:adapter-fixture.example";

/// One batch is one log entry, so the drain takes as many steps as the corpus
/// has entries and the lag is observable while it falls.
const BATCH_LIMIT: usize = 1;

/// What a batch costs, so the drain is still running when the first samples are
/// taken instead of finishing before the supervisor returns.
const BATCH_PAUSE: Duration = Duration::from_millis(15);

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

fn fixture() -> Fixture {
    serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
        .expect("fixture parses")
}

/// The event log: the fixture's rows under `space`.
fn build_events_db(path: &Path, space: &SpaceDid) -> Fixture {
    let fixture = fixture();
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
    fixture
}

/// The last position the log holds for `space`.
fn last_entry(events_db: &Path, space: &SpaceDid) -> (i64, i64) {
    let conn = rusqlite::Connection::open(events_db).expect("events DB");
    conn.query_row(
        "select idx, ord from record_changes where stream_id = ?
          order by idx desc, ord desc limit 1",
        [space.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("the log has an entry")
}

fn config(dir: &Path, events_db: &Path, ownership: Ownership) -> SupervisorConfig {
    SupervisorConfig {
        events_db: events_db.to_path_buf(),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: "health-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: BATCH_LIMIT,
        idle_unload: None,
        ownership,
    }
}

/// A feed that pauses before each batch.
struct SlowFeed(SqliteChangeFeed);

impl ChangeFeed for SlowFeed {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        std::thread::sleep(BATCH_PAUSE);
        self.0.batch(space, cursor, limit)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        self.0.latest_idx(space)
    }
}

fn slow_feed(events_db: &Path) -> FeedFactory {
    let events_db = events_db.to_path_buf();
    Arc::new(move || {
        Ok(Box::new(SlowFeed(SqliteChangeFeed::open(&events_db)?)) as Box<dyn ChangeFeed>)
    })
}

/// The health row for `space`, waiting until the actor has published one.
fn health_of(supervisor: &Supervisor, space: &SpaceDid) -> Health {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(health) = supervisor
            .health()
            .into_iter()
            .find(|health| health.space == space.as_str())
        {
            return health;
        }
        assert!(
            Instant::now() < deadline,
            "the supervisor published no health for {space}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn a_follower_reports_its_cursor_and_a_falling_lag_without_a_lease() {
    let dir = tempfile::tempdir().expect("temp dir");
    // The log lives outside the follower's data directory: that is the whole
    // point of the split, and nothing it does may write beside the log.
    let log_dir = tempfile::tempdir().expect("log dir");
    let events_db = log_dir.path().join("roomy-events.sqlite");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    build_events_db(&events_db, &space);
    let last = last_entry(&events_db, &space);

    let config = config(dir.path(), &events_db, Ownership::Follower);
    let supervisor = Supervisor::new(config.clone()).with_feed(slow_feed(&events_db));
    supervisor
        .start_all([space.clone()])
        .expect("the actor starts");

    // Watch the lag fall while the actor drains, one entry per batch.
    let mut lags = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let health = health_of(&supervisor, &space);
        assert!(health.following, "a follower says so");
        assert!(!health.lease_held, "a follower holds no lease");
        lags.push(health.lag);
        if health.lag == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the follower did not catch up");
        std::thread::sleep(Duration::from_millis(2));
    }

    assert!(
        lags.first().copied().unwrap_or_default() > 0,
        "the first sample saw work left: {lags:?}"
    );
    assert!(
        lags.windows(2).all(|pair| pair[1] <= pair[0]),
        "the lag never grows: {lags:?}"
    );
    assert!(
        lags.iter().filter(|lag| **lag > 0).count() > 1,
        "the lag was observed falling, not just arrived: {lags:?}"
    );

    let health = health_of(&supervisor, &space);
    assert_eq!(health.cursor, last, "the cursor is the log's last position");
    assert_eq!(health.lag, 0);
    assert!(health.is_healthy(), "a caught-up follower is healthy");
    assert_eq!(health.last_error, None);
    assert!(
        health.to_json().contains("\"following\":true"),
        "{}",
        health.to_json()
    );
    assert!(health.to_json().contains("\"leaseHeld\":false"));

    // The probe acquired nothing: a follower's copy of the global database has
    // the lease table and no rows in it.
    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let held: i64 = global
        .query_row("select count(*) from worker_leases", [], |row| row.get(0))
        .expect("lease count");
    assert_eq!(held, 0, "a health probe must not take a lease");

    supervisor.stop();
}

#[test]
fn an_owner_still_reports_the_lease_it_holds() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    build_events_db(&events_db, &space);

    let config = config(dir.path(), &events_db, Ownership::Owner);
    let supervisor = Supervisor::start(config.clone(), [space.clone()]).expect("the supervisor");

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let health = health_of(&supervisor, &space);
        if health.lag == 0 && health.cursor.0 > 0 {
            assert!(!health.following, "an owner is not a follower");
            assert!(health.lease_held, "an owner reports its lease");
            assert!(health.is_healthy());
            assert!(
                health.to_json().contains("\"leaseHeld\":true"),
                "{}",
                health.to_json()
            );
            break;
        }
        assert!(Instant::now() < deadline, "the owner did not catch up");
        std::thread::sleep(Duration::from_millis(2));
    }

    let global = rusqlite::Connection::open(&config.global_db).expect("global DB");
    let holder: String = global
        .query_row(
            "select holder from worker_leases where name = ?",
            [format!("space-worker:{space}")],
            |row| row.get(0),
        )
        .expect("the owner's lease row");
    assert_eq!(holder, "health-test");

    supervisor.stop();
}
