//! L3: batch/replay equivalence.
//!
//! The projection must not depend on how the feed is cut into batches, nor on
//! where a process dies. This test applies one log five ways — one change per
//! batch, two, three, seven, and all of it at once — and, for every batch
//! boundary in each, crashes the worker *after the global half was written and
//! before the space half committed*, then restarts it on the same files. Every
//! run has to end on the same digest, the same cursor, and the same global rows.
//!
//! The crash is a dropped [`PendingBatch`]: the space transaction rolls back, so
//! the cursor stays where it was and the same changes are read again. The global
//! half has already reached the sink, which is the state the ordering is designed
//! for — the index may be ahead, and every global statement is idempotent, so the
//! replay rewrites the same rows.

use std::path::Path;

use roomy_space_worker::sink::{GlobalSink, SqliteGlobalSink};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;
use space_db::plan::{group_entries, plan_batch};
use space_db::{digest_of, snapshot_db, snapshot_tables, worker_snapshot, SpaceDb};

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<FeedRow>,
    #[serde(rename = "globalTables")]
    global_tables: Vec<String>,
}

fn fixture() -> Fixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture readable"))
        .expect("fixture parses")
}

fn space_db(path: &Path, space: &SpaceDid) -> SpaceDb {
    let db = SpaceDb::open(path, space.clone()).expect("space DB");
    db.connection()
        .execute(
            "insert or ignore into entities (id, stream_id, created_at, updated_at)
             values (?, ?, 1700000000000, 1700000000000)",
            rusqlite::params![space.as_str(), space.as_str()],
        )
        .expect("seed entity");
    db.connection()
        .execute(
            "insert or ignore into comp_space (entity, created_at, updated_at)
             values (?, 1700000000000, 1700000000000)",
            rusqlite::params![space.as_str()],
        )
        .expect("seed space row");
    db
}

/// Apply the log in batches, dropping the batch at `crash_at` instead of
/// committing it, then restart on the same files and finish.
fn replay_with_crash(
    dir: &Path,
    space: &SpaceDid,
    rows: &[FeedRow],
    batch_limit: usize,
    crash_at: Option<usize>,
) -> ((i64, i64), String, String) {
    let space_path = dir.join("space.sqlite");
    let global_path = dir.join("global.sqlite");
    let mut batch_index = 0usize;

    // The first run: up to the crash point.
    {
        let mut db = space_db(&space_path, space);
        let mut sink = SqliteGlobalSink::open(&global_path).expect("sink");
        loop {
            let (idx, ord) = db.cursor().expect("cursor").unwrap_or((-1, -1));
            let remaining = rows
                .iter()
                .filter(|row| row.idx > idx || (row.idx == idx && row.ord > ord))
                .cloned()
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                break;
            }
            let batch: Vec<FeedRow> = remaining.into_iter().take(batch_limit).collect();
            let entries = group_entries(&batch).expect("group");
            let planned = plan_batch(db.connection(), space, &entries, space_core::PlanMode::Live)
                .expect("plan");
            let last = batch.last().expect("a non-empty batch");
            let pending = db
                .begin_batch(&planned, (last.idx, last.ord), 1)
                .expect("begin");
            sink.apply(pending.globals())
                .expect("the global half applies");
            if crash_at == Some(batch_index) {
                // The crash: the space half rolls back, the global half stays.
                drop(pending);
                break;
            }
            pending.commit().expect("commit");
            batch_index += 1;
        }
    }

    // The restart: a new process over the same files, replaying from the cursor.
    {
        let mut db = space_db(&space_path, space);
        let mut sink = SqliteGlobalSink::open(&global_path).expect("sink");
        loop {
            let (idx, ord) = db.cursor().expect("cursor").unwrap_or((-1, -1));
            let remaining = rows
                .iter()
                .filter(|row| row.idx > idx || (row.idx == idx && row.ord > ord))
                .cloned()
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                break;
            }
            let batch: Vec<FeedRow> = remaining.into_iter().take(batch_limit).collect();
            let entries = group_entries(&batch).expect("group");
            let planned = plan_batch(db.connection(), space, &entries, space_core::PlanMode::Live)
                .expect("plan");
            let last = batch.last().expect("a non-empty batch");
            let pending = db
                .begin_batch(&planned, (last.idx, last.ord), 1)
                .expect("begin");
            sink.apply(pending.globals())
                .expect("the global half applies");
            pending.commit().expect("commit");
        }

        let cursor = db.cursor().expect("cursor").expect("a committed cursor");
        let digest = digest_of(&worker_snapshot(
            &snapshot_db(db.connection()).expect("snapshot"),
        ));
        let global = rusqlite::Connection::open(&global_path).expect("global DB");
        let global_digest = digest_of(
            &snapshot_tables(&global, &fixture().global_tables).expect("global snapshot"),
        );
        (cursor, digest, global_digest)
    }
}

#[test]
fn the_projection_is_the_same_for_every_batch_size_and_every_crash_point() {
    let fixture = fixture();
    let space = SpaceDid::parse("did:web:replay.example").expect("space");
    let dir = tempfile::tempdir().expect("temp dir");

    // The reference: one uninterrupted run.
    let reference_dir = dir.path().join("reference");
    std::fs::create_dir_all(&reference_dir).expect("reference dir");
    let reference = replay_with_crash(&reference_dir, &space, &fixture.changes, 500, None);

    for batch_limit in [1usize, 2, 3, 7, 500] {
        // With `limit` changes per batch, there are this many commit points.
        let batches = {
            let mut count = 0;
            let mut idx = -1;
            let mut ord = -1;
            loop {
                let remaining: Vec<&FeedRow> = fixture
                    .changes
                    .iter()
                    .filter(|row| row.idx > idx || (row.idx == idx && row.ord > ord))
                    .collect();
                if remaining.is_empty() {
                    break;
                }
                let last = remaining[batch_limit.min(remaining.len()) - 1];
                idx = last.idx;
                ord = last.ord;
                count += 1;
            }
            count
        };

        // No crash: the same log in smaller batches is the same projection.
        let plain_dir = dir.path().join(format!("plain-{batch_limit}"));
        std::fs::create_dir_all(&plain_dir).expect("plain dir");
        let plain = replay_with_crash(&plain_dir, &space, &fixture.changes, batch_limit, None);
        if plain != reference {
            let reference_snapshot = snapshot_db(
                &rusqlite::Connection::open(reference_dir.join("space.sqlite"))
                    .expect("reference DB"),
            )
            .expect("snapshot");
            let plain_snapshot = snapshot_db(
                &rusqlite::Connection::open(plain_dir.join("space.sqlite")).expect("plain DB"),
            )
            .expect("snapshot");
            for divergence in space_db::diff_snapshots(&plain_snapshot, &reference_snapshot) {
                eprintln!(
                    "DIVERGES {}: plain {:?} reference {:?}",
                    divergence.table,
                    divergence.before.first(),
                    divergence.after.first()
                );
            }
        }
        assert_eq!(
            plain, reference,
            "batching {batch_limit} at a time changed the projection"
        );

        // And a crash at every commit point converges on it.
        for crash_at in 0..batches {
            let crash_dir = dir.path().join(format!("crash-{batch_limit}-{crash_at}"));
            std::fs::create_dir_all(&crash_dir).expect("crash dir");
            let crashed = replay_with_crash(
                &crash_dir,
                &space,
                &fixture.changes,
                batch_limit,
                Some(crash_at),
            );
            assert_eq!(
                crashed, reference,
                "a crash after batch {crash_at} at limit {batch_limit} diverged"
            );
        }
    }
}

/// The cursor equals the last applied `(idx, ord)`, not merely "greater than
/// zero": a worker that overshot would skip changes on its next restart.
#[test]
fn the_cursor_is_exactly_the_last_applied_position() {
    let fixture = fixture();
    let space = SpaceDid::parse("did:web:cursor.example").expect("space");
    let dir = tempfile::tempdir().expect("temp dir");
    let (cursor, _, _) = replay_with_crash(dir.path(), &space, &fixture.changes, 4, None);
    let last = fixture.changes.last().expect("a non-empty log");
    assert_eq!(cursor, (last.idx, last.ord));
}
