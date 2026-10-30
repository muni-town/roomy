//! L7: the distributed invariants, in one process and one thread.
//!
//! Every other test in this crate runs one worker. This one runs two nodes over
//! one log and one lease table, moves a virtual clock instead of sleeping, and
//! interrupts them: a node pauses mid-log still holding its lease, the other is
//! refused until the lease expires, takes over with a newer epoch, and finishes.
//! What the assertions say is `rust-core-appserver.md` §6.4, one at a time:
//!
//!  * one writer at a time, and a stale writer cannot land a batch;
//!  * a takeover advances the fencing epoch, so the pause cannot resume writing;
//!  * whichever node finishes, the projection and the global index converge on
//!    the ones an uninterrupted run produces;
//!  * the cursor after a resume is the last applied position, never past it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use roomy_space_worker::lease::{Lease, LeaseGrant, SqliteLease};
use roomy_space_worker::sink::{GlobalSink, SqliteGlobalSink};
use roomy_space_worker::Clock;
use serde::Deserialize;
use space_core::ids::SpaceDid;
use space_db::plan;
use space_db::{digest_of, snapshot_db, snapshot_tables, worker_snapshot, SpaceDb};
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::{ChangeFeed, Cursor};

const SPACE: &str = "did:web:distributed.example";
const TTL: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct FixtureGlobal {
    #[serde(rename = "globalTables")]
    tables: Vec<String>,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../space-db/tests/fixtures")
}

fn fixture_path() -> PathBuf {
    fixture_dir().join("registry-corpus/fixture.json")
}

fn global_tables() -> Vec<String> {
    let path = std::fs::read_dir(fixture_dir())
        .expect("fixtures")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("fixture.json"))
        .find(|path| path.is_file())
        .expect("a fixture");
    let fixture: FixtureGlobal =
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture readable"))
            .expect("fixture parses");
    fixture.tables
}

/// The event log both nodes read, seeded with the corpus.
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

/// A clock a test moves by hand. Nothing here waits for real time.
#[derive(Clone)]
struct FakeClock(Arc<AtomicI64>);

impl FakeClock {
    fn at(ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(ms)))
    }

    fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::Relaxed);
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// One node: its own projection, the shared lease table, the shared log.
struct Node {
    holder: String,
    db: SpaceDb,
    feed: SqliteChangeFeed,
    sink: SqliteGlobalSink,
    lease: SqliteLease,
    clock: FakeClock,
    space: SpaceDid,
}

impl Node {
    fn new(
        holder: &str,
        spaces_dir: &Path,
        global_db: &Path,
        events_db: &Path,
        clock: &FakeClock,
        space: &SpaceDid,
    ) -> Self {
        std::fs::create_dir_all(spaces_dir).expect("spaces dir");
        Self {
            holder: holder.to_string(),
            db: SpaceDb::open(spaces_dir.join(format!("{space}.sqlite")), space.clone())
                .expect("space DB"),
            feed: SqliteChangeFeed::open(events_db).expect("feed"),
            sink: SqliteGlobalSink::open(global_db).expect("sink"),
            lease: SqliteLease::open(global_db).expect("lease"),
            clock: clock.clone(),
            space: space.clone(),
        }
    }

    fn acquire(&mut self) -> LeaseGrant {
        self.lease
            .acquire(&self.space, &self.holder, self.clock.now_ms(), TTL)
            .expect("the lease table is readable")
    }

    /// Apply the next batch. `crash` drops it after the global half, which is
    /// what a process dying between the two databases looks like.
    fn step(
        &mut self,
        epoch: i64,
        batch_limit: usize,
        crash: bool,
    ) -> Result<Option<(i64, i64)>, space_db::DbError> {
        let cursor = self.db.cursor()?.unwrap_or((-1, -1));
        let rows = self
            .feed
            .batch(&self.space, Cursor::from(cursor), batch_limit)
            .expect("the feed is readable");
        if rows.is_empty() {
            return Ok(None);
        }
        let entries = plan::group_entries(&rows).expect("grouped");
        let planned = plan::plan_batch(
            self.db.connection(),
            &self.space,
            &entries,
            space_core::PlanMode::Live,
        )
        .expect("planned");
        let last = rows.last().expect("a non-empty batch");
        let pending = self.db.begin_batch(&planned, (last.idx, last.ord), epoch)?;
        self.sink
            .apply(pending.globals())
            .expect("the global half applies");
        if crash {
            drop(pending);
            return Ok(Some(cursor));
        }
        pending.commit()?;
        Ok(Some((last.idx, last.ord)))
    }

    fn drain(&mut self, epoch: i64, batch_limit: usize) -> usize {
        let mut batches = 0;
        while self
            .step(epoch, batch_limit, false)
            .expect("a step")
            .is_some()
        {
            batches += 1;
        }
        batches
    }

    fn digest(&self) -> String {
        digest_of(&worker_snapshot(
            &snapshot_db(self.db.connection()).expect("snapshot"),
        ))
    }
}

fn global_digest(global_db: &Path) -> String {
    let conn = rusqlite::Connection::open(global_db).expect("global DB");
    digest_of(&snapshot_tables(&conn, &global_tables()).expect("global snapshot"))
}

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

/// An uninterrupted run: the answer every interrupted run must reach, and the
/// log position it ends at.
fn reference(space: &SpaceDid) -> ((i64, i64), String, String, (i64, i64)) {
    let dir = tempfile::tempdir().expect("reference dir");
    let events_db = dir.path().join("events.sqlite");
    build_events_db(&events_db, space);
    let global_db = dir.path().join("global.sqlite");
    let clock = FakeClock::at(1_000_000);
    let mut node = Node::new(
        "reference",
        &dir.path().join("spaces"),
        &global_db,
        &events_db,
        &clock,
        space,
    );
    let grant = node.acquire();
    assert!(grant.held);
    node.drain(grant.epoch, 500);
    (
        node.db
            .cursor()
            .expect("cursor")
            .expect("a committed cursor"),
        node.digest(),
        global_digest(&global_db),
        last_entry(&events_db, space),
    )
}

#[test]
fn one_writer_at_a_time_and_takeover_advances_the_epoch() {
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let dir = tempfile::tempdir().expect("dir");
    let events_db = dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);
    let global_db = dir.path().join("global.sqlite");
    let clock = FakeClock::at(1_000_000);
    // Both nodes write the same projection, so the takeover is a real handover
    // rather than two writers on different files.
    let spaces_dir = dir.path().join("spaces");

    let mut first = Node::new(
        "node-a",
        &spaces_dir,
        &global_db,
        &events_db,
        &clock,
        &space,
    );
    let mut second = Node::new(
        "node-b",
        &spaces_dir,
        &global_db,
        &events_db,
        &clock,
        &space,
    );

    let a = first.acquire();
    assert!(a.held, "the first node takes the lease");
    // One entry per batch, and the node pauses after the first: the log is left
    // unfinished, so the takeover has something to commit.
    first.step(a.epoch, 1, false).expect("a first batch");

    // Same instant, lease unexpired: the second node is refused, and refused
    // means it does not write.
    let refused = second.acquire();
    assert!(!refused.held, "two writers must not both hold the space");

    // The first node pauses; time passes; the second takes over.
    clock.advance(TTL.as_millis() as i64 + 1);
    let b = second.acquire();
    assert!(b.held, "an expired lease is takeable");
    assert!(
        b.epoch > a.epoch,
        "a takeover advances the epoch: {} -> {}",
        a.epoch,
        b.epoch
    );

    // The paused node wakes up. Its lease is not its own any more.
    let stale = first.acquire();
    assert!(
        !stale.held,
        "the paused writer must not resume: {} held epoch {}",
        first.holder, a.epoch
    );

    // The second node finishes whatever the first left, on the same projection.
    let committed = second.drain(b.epoch, 4);
    assert!(committed > 0, "the takeover commits the rest of the log");
    let (_, reference_digest, _, last) = reference(&space);
    assert_eq!(
        second.db.cursor().expect("cursor"),
        Some(last),
        "the takeover ends at the last log position"
    );
    assert_eq!(
        second.digest(),
        reference_digest,
        "the takeover's projection equals the uninterrupted one"
    );

    // The first node's next batch carries its old epoch. Even if it could reach
    // the database, the fence refuses it: the epoch stored is the takeover's.
    assert_eq!(first.db.fence().expect("fence"), b.epoch);

    // The fence is checked where the batch would land, not where it is planned:
    // the commit is refused and its transaction rolls back, so the projection the
    // takeover wrote is the one that stays.
    let before = first.digest();
    let stale_batch = first
        .db
        .begin_batch(&[], last_entry(&events_db, &space), a.epoch)
        .expect("a stale batch can still be planned");
    let refused_write = stale_batch
        .commit()
        .expect_err("a stale epoch cannot land a batch");
    assert_eq!(
        first.digest(),
        before,
        "the refusal left nothing of the batch behind"
    );
    assert!(
        matches!(refused_write, space_db::DbError::Fenced { granted, stored } if granted == a.epoch && stored == b.epoch),
        "the refusal names both epochs: {refused_write:?}"
    );
}

#[test]
fn every_interruption_converges_on_the_uninterrupted_projection() {
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let (reference_cursor, reference_digest, reference_global, last) = reference(&space);
    assert_eq!(
        reference_cursor, last,
        "an uninterrupted run ends at the last log position"
    );

    // Where the first node pauses: after one batch, after three, and inside the
    // middle of the log.
    for pause_after in [1usize, 3, 5] {
        let dir = tempfile::tempdir().expect("dir");
        let events_db = dir.path().join("events.sqlite");
        build_events_db(&events_db, &space);
        let global_db = dir.path().join("global.sqlite");
        let clock = FakeClock::at(1_000_000);

        // Node A applies `pause_after` batches into its own projection, then
        // stops without releasing the lease.
        let mut a = Node::new(
            "node-a",
            &dir.path().join("node-a"),
            &global_db,
            &events_db,
            &clock,
            &space,
        );
        let grant_a = a.acquire();
        for _ in 0..pause_after {
            a.step(grant_a.epoch, 3, false).expect("a step");
        }
        let cursor_at_pause = a.db.cursor().expect("cursor");
        assert!(
            cursor_at_pause.is_some(),
            "the node applied at least one batch"
        );
        let epoch_a = grant_a.epoch;

        // Node B cannot take the space while A's lease stands.
        let mut b = Node::new(
            "node-b",
            &dir.path().join("node-b"),
            &global_db,
            &events_db,
            &clock,
            &space,
        );
        assert!(!b.acquire().held, "the lease is still A's");

        clock.advance(TTL.as_millis() as i64 + 1);
        let grant_b = b.acquire();
        assert!(grant_b.held, "the lease expires into B's hands");
        assert!(grant_b.epoch > epoch_a);

        // A wakes and is refused, so its cursor cannot advance past B's work.
        assert!(!a.acquire().held);
        let a_cursor_after_wake = a.db.cursor().expect("cursor");
        assert_eq!(
            a_cursor_after_wake, cursor_at_pause,
            "a writer that lost the lease writes nothing"
        );

        b.drain(grant_b.epoch, 3);

        assert_eq!(
            b.db.cursor().expect("cursor"),
            Some(reference_cursor),
            "B finishes at the last log position (paused after {pause_after})"
        );
        assert_eq!(
            b.digest(),
            reference_digest,
            "B's projection equals the uninterrupted one (paused after {pause_after})"
        );
        // The global half is written first and is idempotent, so a lease handover
        // leaves the index at the same content, never behind it.
        assert_eq!(
            global_digest(&global_db),
            reference_global,
            "the global index converges too (paused after {pause_after})"
        );
    }
}

#[test]
fn a_crash_between_the_two_halves_leaves_the_index_ahead_and_never_behind() {
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let (reference_cursor, reference_digest, reference_global, _) = reference(&space);

    let dir = tempfile::tempdir().expect("dir");
    let events_db = dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);
    let global_db = dir.path().join("global.sqlite");
    let clock = FakeClock::at(1_000_000);
    let spaces_dir = dir.path().join("spaces");

    let mut node = Node::new(
        "node-a",
        &spaces_dir,
        &global_db,
        &events_db,
        &clock,
        &space,
    );
    let grant = node.acquire();
    node.step(grant.epoch, 4, false).expect("a first batch");
    let committed = node.db.cursor().expect("cursor").expect("committed");

    // The crash: the global half landed, the space half rolled back.
    node.step(grant.epoch, 4, true)
        .expect("an interrupted batch");
    assert_eq!(
        node.db.cursor().expect("cursor"),
        Some(committed),
        "the cursor did not move with the rolled-back batch"
    );

    // The index is ahead of the projection; it is never behind it. Both are
    // compared by what they hold, not by timing.
    let global_ahead = rusqlite::Connection::open(&global_db).expect("global DB");
    let space_behind = digest_of(&worker_snapshot(
        &snapshot_db(node.db.connection()).expect("snapshot"),
    ));
    assert_ne!(
        global_ahead
            .query_row("select count(*) from entity_space", [], |row| row
                .get::<_, i64>(0))
            .expect("rows"),
        0,
        "the global half of the interrupted batch is written"
    );
    assert_ne!(
        space_behind, reference_digest,
        "and the projection is still short of the reference, which is the point"
    );

    // A restart replays from the committed cursor and converges.
    let mut restarted = Node::new(
        "node-a",
        &spaces_dir,
        &global_db,
        &events_db,
        &clock,
        &space,
    );
    let again = restarted.acquire();
    assert!(again.held, "the same holder renews its lease");
    restarted.drain(again.epoch, 4);

    assert_eq!(
        restarted.db.cursor().expect("cursor"),
        Some(reference_cursor)
    );
    assert_eq!(restarted.digest(), reference_digest);
    assert_eq!(global_digest(&global_db), reference_global);
}
