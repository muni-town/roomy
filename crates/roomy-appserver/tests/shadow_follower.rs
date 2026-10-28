//! A follower process reading a log that is not its own.
//!
//! The deployment this exists for: production keeps writing
//! `/data/roomy-events.sqlite` while a second process, with its own
//! `ROOMY_DATA_DIR`, replays that log and answers reads from its own projection.
//! Two things have to hold for that to be safe, and neither is visible from a
//! unit test:
//!
//!  * the log's directory is untouched — the follower writes no `spaces/`, no
//!    `global.sqlite`, and never the log;
//!  * the follower takes no lease, so it cannot stop the owner materialising,
//!    and its `/health` says so.
//!
//! The process is the real binary: environment parsing, the supervisor, the
//! listener and the projection are exercised as deployed.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};

/// The corpus's own space, whose projection the fixture digests.
const SPACE: &str = "did:web:adapter-fixture.example";
/// A second space, so `/health` reports more than one.
const SECOND_SPACE: &str = "did:web:second.example";

#[derive(Deserialize)]
struct Fixture {
    #[serde(rename = "receivedAt")]
    received_at: i64,
    changes: Vec<serde_json::Value>,
    #[serde(rename = "spaceSeed")]
    space_seed: SpaceSeed,
    expected: Expected,
}

/// The rows the corpus's projection starts from.
#[derive(Deserialize)]
struct SpaceSeed {
    entities: Vec<(String, String)>,
    #[serde(rename = "compSpace")]
    comp_space: Vec<(String,)>,
}

#[derive(Deserialize)]
struct Expected {
    #[serde(rename = "spaceDigest")]
    space_digest: String,
}

fn fixture() -> Fixture {
    let path = fixture_path();
    serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture readable"))
        .expect("fixture parses")
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The event log: the fixture's rows under each space.
fn build_events_db(path: &Path, spaces: &[&SpaceDid], fixture: &Fixture) {
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

fn seed_space(path: &Path, space: &SpaceDid, fixture: &Fixture) {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    for (id, stream_id) in &fixture.space_seed.entities {
        db.connection()
            .execute(
                "insert into entities (id, stream_id, created_at, updated_at)
                 values (?, ?, ?, ?)",
                rusqlite::params![id, stream_id, fixture.received_at, fixture.received_at],
            )
            .expect("seed entity");
    }
    for (entity,) in &fixture.space_seed.comp_space {
        db.connection()
            .execute(
                "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
                rusqlite::params![entity, fixture.received_at, fixture.received_at],
            )
            .expect("seed space row");
    }
}

fn digest_of_space(path: &Path, space: &SpaceDid) -> String {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    digest_of(&worker_snapshot(
        &snapshot_db(db.connection()).expect("snapshot"),
    ))
}

/// The highest entry index the log holds for `space`.
fn last_idx(events_db: &Path, space: &str) -> i64 {
    let conn = rusqlite::Connection::open(events_db).expect("events DB");
    conn.query_row(
        "select max(idx) from record_changes where stream_id = ?",
        [space],
        |row| row.get(0),
    )
    .expect("the log has an entry")
}

/// A port nothing holds right now. The follower binds it a moment later.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("a free port")
        .local_addr()
        .expect("local address")
        .port()
}

fn health(port: u16) -> Result<serde_json::Value, String> {
    let response = ureq::get(&format!("http://127.0.0.1:{port}/health"))
        .call()
        .map_err(|error| error.to_string())?;
    let body = response.into_string().map_err(|error| error.to_string())?;
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

/// The follower process, with an environment of its own: nothing the test
/// process happens to carry leaks into it.
struct Follower {
    child: Child,
    port: u16,
}

impl Follower {
    fn start(data_dir: &Path, events_db: &Path, spaces: &[&str]) -> Self {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_roomy-appserver"))
            .arg("--role")
            .arg("worker")
            .env_clear()
            .env("ROOMY_DATA_DIR", data_dir)
            .env("ROOMY_EVENTS_DB", events_db)
            .env("ROOMY_SPACES", spaces.join(","))
            .env("ROOMY_OWNERSHIP", "follower")
            .env("ROOMY_HEALTH_ADDR", format!("127.0.0.1:{port}"))
            .env("RUST_LOG", "info")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the follower starts");
        Self { child, port }
    }

    /// The health body, once `ready` accepts one.
    fn wait_for(&mut self, ready: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(exited) = self.child.try_wait().expect("try_wait") {
                panic!("the follower exited early: {exited}");
            }
            if let Ok(body) = health(self.port) {
                if ready(&body) {
                    return body;
                }
            }
            assert!(
                Instant::now() < deadline,
                "the follower did not catch up within the deadline"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Follower {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn a_follower_reads_a_log_outside_its_data_dir_and_reports_itself() {
    let fixture = fixture();
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let second = SpaceDid::parse(SECOND_SPACE.to_string()).expect("space DID");

    // The owner's directory: the log lives here and nothing else may appear.
    let owner = tempfile::tempdir().expect("owner dir");
    let events_db = owner.path().join("roomy-events.sqlite");
    build_events_db(&events_db, &[&space, &second], &fixture);
    let last = last_idx(&events_db, SPACE);

    // The follower's own directory, holding the projection it replays into.
    let shadow = tempfile::tempdir().expect("shadow dir");
    let shadow_space = shadow.path().join("spaces").join(format!("{space}.sqlite"));
    std::fs::create_dir_all(shadow_space.parent().expect("a spaces dir")).expect("spaces dir");
    seed_space(&shadow_space, &space, &fixture);

    let mut follower = Follower::start(shadow.path(), &events_db, &[SPACE, SECOND_SPACE]);

    let body = follower.wait_for(|body| {
        let spaces = match body["spaces"].as_array() {
            Some(spaces) => spaces,
            None => return false,
        };
        spaces.len() == 2
            && spaces.iter().all(|space| space["lag"] == 0)
            && spaces
                .iter()
                .find(|row| row["space"] == SPACE)
                .map(|row| row["cursor"]["idx"] == last)
                .unwrap_or(false)
    });

    assert_eq!(body["status"], "ok");
    let rows = body["spaces"].as_array().expect("spaces is an array");
    assert_eq!(rows.len(), 2, "one health row per space: {body}");
    let ours = rows
        .iter()
        .find(|row| row["space"] == SPACE)
        .expect("the corpus's space is reported");
    assert_eq!(ours["following"], true, "{ours}");
    assert_eq!(
        ours["leaseHeld"], false,
        "a follower must report no lease: {ours}"
    );
    assert_eq!(ours["lag"], 0);
    assert_eq!(ours["cursor"]["idx"], last);
    assert_eq!(ours["lastError"], serde_json::Value::Null);

    // The projection it built is the corpus's.
    assert_eq!(
        digest_of_space(&shadow_space, &space),
        fixture.expected.space_digest,
        "the follower's projection differs from the recorded one"
    );

    // Its own data directory gained a projection for every space it follows.
    assert!(shadow
        .path()
        .join("spaces")
        .join(format!("{second}.sqlite"))
        .exists());

    // Nothing was written beside the log: the log is the only file there.
    let mut beside: Vec<String> = std::fs::read_dir(owner.path())
        .expect("owner dir")
        .map(|entry| {
            entry
                .expect("a dirent")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    beside.sort();
    assert_eq!(beside, vec!["roomy-events.sqlite".to_string()]);

    // The follower's own global database holds no lease: it acquired none.
    let global = rusqlite::Connection::open(shadow.path().join("global.sqlite"))
        .expect("the follower's global DB");
    let held: i64 = global
        .query_row("select count(*) from worker_leases", [], |row| row.get(0))
        .expect("lease count");
    assert_eq!(held, 0, "a follower takes no lease");
}

/// A worker without `ROOMY_HEALTH_ADDR` binds nothing, and materialises anyway:
/// the endpoint is for watching a worker, not for running one.
#[test]
fn a_worker_without_a_health_address_binds_no_listener() {
    let fixture = fixture();
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let owner = tempfile::tempdir().expect("owner dir");
    let events_db = owner.path().join("roomy-events.sqlite");
    build_events_db(&events_db, &[&space], &fixture);
    let last = last_idx(&events_db, SPACE);

    let shadow = tempfile::tempdir().expect("shadow dir");
    // The port a worker with the variable set would have bound.
    let port = free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_roomy-appserver"))
        .arg("--role")
        .arg("worker")
        .env_clear()
        .env("ROOMY_DATA_DIR", shadow.path())
        .env("ROOMY_EVENTS_DB", &events_db)
        .env("ROOMY_SPACES", SPACE)
        .env("ROOMY_OWNERSHIP", "follower")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the worker starts");

    let space_db = shadow.path().join("spaces").join(format!("{space}.sqlite"));
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(exited) = child.try_wait().expect("try_wait") {
            panic!("the worker exited early: {exited}");
        }
        if space_db.exists() {
            let db = SpaceDb::open(&space_db, space.clone()).expect("space DB");
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx == last {
                    break;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "the worker did not drain the log within the deadline"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    // Nothing is listening where the variable would have put one.
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
        "a worker with no ROOMY_HEALTH_ADDR bound {port}"
    );

    let _ = child.kill();
    let _ = child.wait();
}
