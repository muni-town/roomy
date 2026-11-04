//! Discovery: a process that derives its space set from the log.
//!
//! A process that is told its spaces materialises those and no others. A process
//! that follows the log reads its set from the feed, so a space appended after it
//! booted is one it materialises — and a stream with nothing in it is reported as
//! such instead of being opened. Discovery is scheduling: a lease still decides
//! who writes, which is why the tests here are about which actors exist and what
//! they applied, never about the rules.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use roomy_space_worker::supervisor::{FeedFactory, Ownership};
use roomy_space_worker::{Discovery, Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;
use space_db::SpaceDb;
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::{ChangeFeed, Cursor, FeedError};

/// The fixture corpus, replayed under whatever space a test names.
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

const SCHEMA: &str = "create table if not exists record_changes (
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
     ) strict;";

/// Append the corpus to the log under `space`. Called again after a supervisor
/// has started, which is what "a space the log gained later" means.
fn append_space(events_db: &Path, space: &SpaceDid) {
    let conn = rusqlite::Connection::open(events_db).expect("events DB");
    conn.execute_batch(SCHEMA).expect("schema");
    let fixture = fixture();
    for row in &fixture.changes {
        let insert = || {
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
        };
        // A reader holding the log for a batch is another process's business: the
        // writer waits it out rather than failing the test that proves discovery.
        let mut attempts = 0;
        loop {
            match insert() {
                Ok(_) => break,
                Err(error) if attempts < 50 && format!("{error}").contains("locked") => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("inserting a feed row: {error}"),
            }
        }
    }
}

fn space(did: &str) -> SpaceDid {
    SpaceDid::parse(did.to_string()).expect("space DID")
}

/// A follower over `events_db`: it takes no lease, which is the role that reads
/// its space set from the log.
fn config(dir: &Path, events_db: &Path) -> SupervisorConfig {
    SupervisorConfig {
        events_db: events_db.to_path_buf(),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: "discovery-test".to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: Ownership::Follower,
    }
}

fn sqlite_feed(events_db: &Path) -> FeedFactory {
    let events_db = events_db.to_path_buf();
    Arc::new(move || Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn ChangeFeed>))
}

/// How often these tests ask the feed. Short, so a pass is never the thing a
/// test waits on.
const TICK: Duration = Duration::from_millis(20);

/// Wait until `predicate` holds, failing the test after `timeout`.
fn wait_for(timeout: Duration, mut predicate: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + timeout;
    while !predicate() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Whether `space`'s actor has applied the last entry the log holds for it.
fn caught_up(config: &SupervisorConfig, space: &SpaceDid) -> bool {
    let latest: i64 = {
        let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
        conn.query_row(
            "select max(idx) from record_changes where stream_id = ?",
            [space.as_str()],
            |row| row.get(0),
        )
        .expect("latest idx")
    };
    match SpaceDb::open(config.space_path(space), space.clone()) {
        Ok(db) => matches!(db.cursor(), Ok(Some((idx, _))) if idx >= latest),
        Err(_) => false,
    }
}

/// A space the log gains after the process started is discovered and applied,
/// and the pass that found it says so.
#[test]
fn a_stream_written_after_boot_is_discovered_and_applied() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let early = space("did:web:early.example");
    let late = space("did:web:late.example");
    append_space(&events_db, &early);

    let config = config(dir.path(), &events_db);
    let supervisor = Arc::new(Supervisor::new(config.clone()).with_feed(sqlite_feed(&events_db)));
    supervisor
        .discover(Discovery {
            interval: TICK,
            only: Vec::new(),
        })
        .expect("the discovery loop starts");

    wait_for(
        Duration::from_secs(20),
        || supervisor.spaces() == [early.as_str().to_string()],
        "the log's first stream",
    );

    append_space(&events_db, &late);

    wait_for(
        Duration::from_secs(20),
        || supervisor.spaces().contains(&late.as_str().to_string()),
        "the stream appended after boot",
    );
    wait_for(
        Duration::from_secs(20),
        || caught_up(&config, &late),
        "the late stream to be applied",
    );

    let pass = supervisor.discovery().expect("a discovery pass");
    supervisor.stop();
    assert!(
        pass.started.contains(&late.as_str().to_string()),
        "the pass that found the space names it: {pass:?}"
    );
    assert!(
        pass.streams.contains(&early.as_str().to_string())
            && pass.streams.contains(&late.as_str().to_string()),
        "the pass reports the whole log: {pass:?}"
    );
}

/// A process with no spaces named materialises every stream the log holds.
#[test]
fn an_empty_space_list_covers_every_stream() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let first = space("did:web:first.example");
    let second = space("did:web:second.example");
    append_space(&events_db, &first);
    append_space(&events_db, &second);

    let config = config(dir.path(), &events_db);
    let supervisor = Arc::new(Supervisor::new(config.clone()).with_feed(sqlite_feed(&events_db)));
    supervisor
        .discover(Discovery {
            interval: TICK,
            only: Vec::new(),
        })
        .expect("the discovery loop starts");

    wait_for(
        Duration::from_secs(20),
        || {
            let running = supervisor.spaces();
            running.contains(&first.as_str().to_string())
                && running.contains(&second.as_str().to_string())
        },
        "both streams",
    );
    wait_for(
        Duration::from_secs(20),
        || caught_up(&config, &first) && caught_up(&config, &second),
        "both streams applied",
    );
    supervisor.stop();
}

/// A named space list still means "these spaces only": a stream the log holds
/// but the process does not name is not started.
#[test]
fn a_named_space_list_narrows_discovery() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let named = space("did:web:named.example");
    let other = space("did:web:other.example");
    append_space(&events_db, &named);
    append_space(&events_db, &other);

    let config = config(dir.path(), &events_db);
    let supervisor = Arc::new(Supervisor::new(config.clone()).with_feed(sqlite_feed(&events_db)));
    supervisor
        .discover(Discovery {
            interval: TICK,
            only: vec![named.clone()],
        })
        .expect("the discovery loop starts");

    wait_for(
        Duration::from_secs(20),
        || caught_up(&config, &named),
        "the named stream applied",
    );
    // Several more passes over a log that still holds the other stream.
    std::thread::sleep(TICK * 5);

    let running = supervisor.spaces();
    let pass = supervisor.discovery().expect("a discovery pass");
    supervisor.stop();
    assert_eq!(running, vec![named.as_str().to_string()]);
    assert!(
        pass.streams.contains(&other.as_str().to_string()),
        "the pass still reports the whole log: {pass:?}"
    );
    assert!(
        !pass.started.contains(&other.as_str().to_string()),
        "the unnamed stream is never started: {pass:?}"
    );
    assert!(!config.space_path(&other).exists(), "no database is opened");
}

/// A feed that names a stream it holds no rows for. The owner's answer is
/// derived from the log, so this is a feed telling the truth about a stream whose
/// entries have not landed yet — the case discovery must not open a space
/// database for.
struct EmptyStreamFeed {
    inner: SqliteChangeFeed,
    empty: SpaceDid,
}

impl ChangeFeed for EmptyStreamFeed {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        self.inner.batch(space, cursor, limit)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        if *space == self.empty {
            return Ok(-1);
        }
        self.inner.latest_idx(space)
    }

    fn streams(&self) -> Result<Vec<SpaceDid>, FeedError> {
        let mut streams = self.inner.streams()?;
        streams.push(self.empty.clone());
        Ok(streams)
    }
}

/// A stream with no rows is `no-events`, and nothing is opened for it.
#[test]
fn a_stream_with_no_events_is_reported_and_not_opened() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let filled = space("did:web:filled.example");
    let empty = space("did:web:empty.example");
    append_space(&events_db, &filled);

    let config = config(dir.path(), &events_db);
    let feed_db = events_db.clone();
    let named_empty = empty.clone();
    let supervisor = Arc::new(Supervisor::new(config.clone()).with_feed(Arc::new(move || {
        Ok(Box::new(EmptyStreamFeed {
            inner: SqliteChangeFeed::open(&feed_db)?,
            empty: named_empty.clone(),
        }) as Box<dyn ChangeFeed>)
    })));
    supervisor
        .discover(Discovery {
            interval: TICK,
            only: Vec::new(),
        })
        .expect("the discovery loop starts");

    wait_for(
        Duration::from_secs(20),
        || caught_up(&config, &filled),
        "the stream that holds events",
    );
    let pass = {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let pass = supervisor.discovery().expect("a discovery pass");
            if pass.no_events.contains(&empty.as_str().to_string()) {
                break pass;
            }
            assert!(
                Instant::now() < deadline,
                "the empty stream was never reported"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    let running = supervisor.spaces();
    supervisor.stop();

    assert_eq!(running, vec![filled.as_str().to_string()]);
    assert!(
        !config.space_path(&empty).exists(),
        "a stream with nothing to apply is not opened"
    );
    assert!(
        !pass.started.contains(&empty.as_str().to_string()),
        "and it is not started: {pass:?}"
    );
}

/// A feed whose stream list always fails, counting the questions it was asked.
struct UnreachableStreams {
    inner: SqliteChangeFeed,
    asks: Arc<AtomicUsize>,
}

impl ChangeFeed for UnreachableStreams {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        self.inner.batch(space, cursor, limit)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        self.inner.latest_idx(space)
    }

    fn streams(&self) -> Result<Vec<SpaceDid>, FeedError> {
        self.asks.fetch_add(1, Ordering::Relaxed);
        Err(FeedError::Transport(space_feed::PullError::Transport(
            "the owner is unreachable".into(),
        )))
    }
}

/// A discovery loop that cannot read the streams keeps the actors it has and
/// backs off instead of asking in a spin.
#[test]
fn a_failing_stream_list_neither_stops_the_actors_nor_spins() {
    let dir = tempfile::tempdir().expect("temp dir");
    let events_db = dir.path().join("events.sqlite");
    let running = space("did:web:running.example");
    append_space(&events_db, &running);

    let config = config(dir.path(), &events_db);
    let asks = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&asks);
    let feed_db = events_db.clone();
    let supervisor = Arc::new(Supervisor::new(config.clone()).with_feed(Arc::new(move || {
        Ok(Box::new(UnreachableStreams {
            inner: SqliteChangeFeed::open(&feed_db)?,
            asks: Arc::clone(&counted),
        }) as Box<dyn ChangeFeed>)
    })));
    supervisor
        .start_all([running.clone()])
        .expect("the named actor starts");
    supervisor
        .discover(Discovery {
            interval: TICK,
            only: Vec::new(),
        })
        .expect("the discovery loop starts");

    wait_for(
        Duration::from_secs(20),
        || caught_up(&config, &running),
        "the running actor to apply its stream",
    );
    let window = Duration::from_secs(2);
    std::thread::sleep(window);
    let asked = asks.load(Ordering::Relaxed);
    let pass = supervisor.discovery().expect("a discovery pass");
    let still_running = supervisor.spaces();
    let stopping = Instant::now();
    supervisor.stop();

    assert_eq!(
        still_running,
        vec![running.as_str().to_string()],
        "a failed pass leaves the actors alone"
    );
    assert!(
        asked <= 4,
        "the loop asked {asked} times in {window:?}: it is spinning"
    );
    assert!(
        pass.last_error
            .as_deref()
            .is_some_and(|error| error.contains("unreachable")),
        "health carries the failure: {pass:?}"
    );
    assert!(
        stopping.elapsed() < Duration::from_secs(1),
        "stopping took {:?}: the loop slept out its backoff",
        stopping.elapsed()
    );
}
