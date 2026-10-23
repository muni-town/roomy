//! Parity with the TypeScript materialiser.
//!
//! Each fixture under `tests/fixtures/` carries one log's change feed and the
//! digests of the two databases the TypeScript rules produce from it. This test
//! applies the feed through the Rust rules and asserts its digests equal the
//! recorded ones — the acceptance oracle of `docs/plans/replicable-space-workers.md`
//! §7, run across two implementations.
//!
//! The comparison is the oracle's: `worker_snapshot` drops the cursor tables and
//! columns each implementation owns, the clock columns, and nothing else. The
//! global side compares the tables the projection rules write, over a fresh
//! `schema-global.sql`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Deserialize;
use space_core::change::{decode_row, FeedRow, RecordChange};
use space_core::ids::SpaceDid;
use space_core::time;
use space_db::plan::{apply_plan, plan_batch, EntryChanges};
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};

const GLOBAL_SCHEMA: &str = include_str!("../../../packages/appserver/src/db/schema-global.sql");

#[derive(Deserialize)]
struct Fixture {
    stream: String,
    #[serde(rename = "receivedAt")]
    received_at: i64,
    #[serde(rename = "spaceSeed")]
    space_seed: SpaceSeed,
    #[serde(rename = "globalTables")]
    global_tables: Vec<String>,
    #[serde(rename = "globalClockColumns")]
    global_clock_columns: Vec<String>,
    expected: Expected,
    changes: Vec<FeedRow>,
}

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
    #[serde(rename = "globalDigest")]
    global_digest: String,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn every_fixture_projects_to_the_typescript_digests() {
    let dir = fixtures_dir();
    let mut fixtures: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("no fixtures at {}: {err}", dir.display()))
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("fixture.json"))
        .filter(|path| path.is_file())
        .collect();
    fixtures.sort();
    assert!(!fixtures.is_empty(), "no fixtures under {}", dir.display());

    for path in fixtures {
        let text = std::fs::read_to_string(&path).expect("fixture is readable");
        let fixture: Fixture = serde_json::from_str(&text).expect("fixture parses");
        let name = path
            .parent()
            .and_then(|dir| dir.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();

        let stream = SpaceDid::parse(fixture.stream.clone()).expect("fixture stream is a DID");
        let mut db = SpaceDb::open_in_memory(stream.clone()).expect("space DB opens");
        for (id, stream_id) in &fixture.space_seed.entities {
            db.connection()
                .execute(
                    "insert into entities (id, stream_id) values (?, ?)",
                    rusqlite::params![id, stream_id],
                )
                .expect("seeding an entity");
        }
        for (entity,) in &fixture.space_seed.comp_space {
            db.connection()
                .execute(
                    "insert into comp_space (entity) values (?)",
                    rusqlite::params![entity],
                )
                .expect("seeding the space row");
        }

        let global = Connection::open_in_memory().expect("global DB opens");
        global.execute_batch(GLOBAL_SCHEMA).expect("global schema");

        // Group the rows into entries, in the order the worker reads them.
        let mut entries: BTreeMap<i64, Vec<(usize, RecordChange)>> = BTreeMap::new();
        for (position, row) in fixture.changes.iter().enumerate() {
            let change = decode_row(row)
                .unwrap_or_else(|err| panic!("{name}: row {position} does not decode: {err}"));
            entries.entry(row.idx).or_default().push((position, change));
        }

        let batch: Vec<EntryChanges> = entries
            .into_iter()
            .map(|(idx, mut changes)| {
                changes.sort_by_key(|(position, _)| *position);
                let first = &fixture.changes[changes[0].0];
                EntryChanges {
                    idx,
                    changes: changes.into_iter().map(|(_, change)| change).collect(),
                    actor: roomy_events::Did::parse(first.actor.clone()).expect("actor is a DID"),
                    event_id: first.event_id.clone(),
                    order_stamp: first.order_stamp.clone(),
                }
            })
            .collect();

        let planned = plan_batch(db.connection(), &stream, &batch, fixture.received_at)
            .unwrap_or_else(|err| panic!("{name}: planning failed: {err}"));

        // The effects and steps are planned once and applied in the batch's
        // order, which is how a worker drains a feed batch.
        apply_plan(&mut db, &planned)
            .unwrap_or_else(|err| panic!("{name}: applying the feed failed: {err}"));

        // The global statements the rules produced were returned, not applied:
        // the sink applies them, and this test is that sink.
        for entry in &planned {
            for effect in &entry.effects {
                let space_core::Effect::Sql(statement) = effect else {
                    continue;
                };
                if statement.target != space_core::Target::Global {
                    continue;
                }
                let params: Vec<rusqlite::types::Value> =
                    statement.params.iter().map(space_db::to_sql).collect();
                global
                    .prepare(statement.sql)
                    .expect("global statement prepares")
                    .execute(rusqlite::params_from_iter(params))
                    .unwrap_or_else(|err| panic!("{name}: global statement failed: {err}"));
            }
        }

        let space_digest = digest_of(&worker_snapshot(
            &snapshot_db(db.connection()).expect("space snapshot"),
        ));
        let global_digest = digest_of(&global_snapshot(
            &global,
            &fixture.global_tables,
            &fixture.global_clock_columns,
        ));

        assert_eq!(
            space_digest, fixture.expected.space_digest,
            "{name}: the space projection does not match the TypeScript one"
        );
        assert_eq!(
            global_digest, fixture.expected.global_digest,
            "{name}: the global projection does not match the TypeScript one"
        );
    }
}

/// The global tables a projection is compared over, in the oracle's encoding.
fn global_snapshot(
    global: &Connection,
    tables: &[String],
    clock_columns: &[String],
) -> Vec<space_db::TableSnapshot> {
    let mut out: Vec<space_db::TableSnapshot> = Vec::new();
    for table in tables {
        let all_columns: Vec<String> = {
            let mut statement = global
                .prepare("select name from pragma_table_info(?1)")
                .expect("table info");
            let rows = statement
                .query_map([table], |row| row.get::<_, String>(0))
                .expect("columns query");
            rows.collect::<Result<_, _>>().expect("columns")
        };
        let columns: Vec<String> = all_columns
            .into_iter()
            .filter(|column| !clock_columns.contains(column))
            .collect();
        let select = format!(
            "select {} from \"{}\"",
            columns
                .iter()
                .map(|column| format!("\"{column}\""))
                .collect::<Vec<_>>()
                .join(", "),
            table
        );
        let mut statement = global.prepare(&select).expect("select prepares");
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut cursor = statement.query([]).expect("query runs");
        while let Some(row) = cursor.next().expect("row") {
            let mut values: Vec<serde_json::Value> = Vec::new();
            for index in 0..columns.len() {
                let value = row.get_ref(index).expect("value");
                values.push(value_to_json(value));
            }
            rows.push(values);
        }
        rows.sort_by_key(|row| serde_json::Value::Array(row.clone()).to_string());
        out.push(space_db::TableSnapshot {
            table: table.clone(),
            columns,
            rows,
        });
    }
    out
}

fn value_to_json(value: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use base64::Engine as _;
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::json!(value),
        ValueRef::Real(value) if value.fract() == 0.0 => serde_json::json!(value as i64),
        ValueRef::Real(value) => serde_json::json!(value),
        ValueRef::Text(bytes) => serde_json::Value::String(String::from_utf8_lossy(bytes).into()),
        ValueRef::Blob(bytes) => serde_json::json!({
            "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes)
        }),
    }
}

#[test]
fn a_stamp_and_its_log_position_are_the_fixture_order() {
    // The feed is written in `(idx, ord)` order and a stamp sorts by time then
    // log position, so the fixture's rows must already be non-decreasing.
    let dir = fixtures_dir();
    let Ok(entry) = std::fs::read_dir(&dir) else {
        return;
    };
    for path in entry.filter_map(|entry| entry.ok()) {
        let file = path.path().join("fixture.json");
        if !file.is_file() {
            continue;
        }
        let fixture: Fixture =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).expect("fixture parses");
        let mut previous: Option<&str> = None;
        for row in &fixture.changes {
            if let Some(previous) = previous {
                assert!(
                    previous <= row.order_stamp.as_str(),
                    "a stamp went backwards in {}",
                    file.display()
                );
            }
            previous = Some(row.order_stamp.as_str());
            assert!(time::ulid_time_ms(&row.order_stamp).is_some());
        }
    }
}
