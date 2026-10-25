//! The write differential: what the appserver appends, and what it refuses.
//!
//! `tests/fixtures/writes.json` is produced by the fixture generator
//! (`crates/space-xrpc/tests/fixtures/generate.ts`) from the real
//! `space.roomy.space.sendEvents` handler. Each case carries the batch as the
//! client sent it, the caller, the response the appserver gave, and the log rows
//! that batch wrote — the entry, and the record changes the projection will
//! consume.
//!
//! This test replays every case through the Rust ingress, in order, against the
//! same space database the appserver read, and requires the same status, the
//! same bytes, and the same rows.
//!
//! `created_at` is the one column not compared: the appserver stamps it from the
//! wall clock at second resolution, and the replay supplies its own instant. The
//! rows are otherwise compared exactly, `order_stamp` included — its time
//! component is the batch instant, which the replay takes from the recording.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use roomy_ingest::{send_events, EventLog, IngestState, SendEventsBody, WriteDenial};
use space_xrpc::state::SpaceReadDb;
use space_xrpc::store::{GlobalStores, SqliteGlobalStores};

#[derive(Deserialize)]
struct Fixture {
    #[allow(dead_code)]
    space: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    caller: Option<String>,
    request: Value,
    status: u16,
    body: String,
    events: Vec<Entry>,
    changes: Vec<Change>,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
struct Entry {
    idx: i64,
    user: String,
    #[serde(rename = "eventType")]
    event_type: Option<String>,
    #[serde(rename = "receivedAt")]
    received_at: i64,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
struct Change {
    idx: i64,
    ord: i64,
    kind: String,
    repo: String,
    collection: String,
    rkey: String,
    op: String,
    #[serde(rename = "orderStamp")]
    order_stamp: String,
    actor: String,
    #[serde(rename = "eventId")]
    event_id: String,
    body: Option<String>,
}

fn fixture_dir() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures").to_string()
}

#[test]
fn every_batch_is_accepted_or_refused_as_the_appserver_decides() {
    let fixture: Fixture = serde_json::from_str(
        &std::fs::read_to_string(format!("{}/writes.json", fixture_dir())).expect("writes.json"),
    )
    .expect("parse writes.json");
    assert!(!fixture.cases.is_empty(), "the corpus has no cases");

    let space = SpaceReadDb::open_readonly(format!("{}/space.sqlite", fixture_dir()))
        .expect("fixture space db");
    let stores = SqliteGlobalStores::open(&format!("{}/global.sqlite", fixture_dir()))
        .expect("fixture global db");
    let state = IngestState {
        space: Arc::new(space),
        stores: Arc::new(stores) as Arc<dyn GlobalStores>,
        service_did: None,
    };
    let mut log = EventLog::in_memory().expect("in-memory log");

    let mut failures: Vec<String> = Vec::new();
    let mut written = -1i64;
    // The instant the replay stamps a batch with. It starts at the fixture's own
    // and advances to the recording's whenever a case wrote entries, so a
    // recorded `order_stamp` and the replay's agree.
    let mut now = 1_700_000_000_000i64;

    for case in &fixture.cases {
        // The batch instant the appserver stamped this case with, so the rows
        // that encode it are comparable byte for byte.
        if let Some(first) = case.events.first() {
            now = first.received_at;
        }
        let bytes = serde_json::to_vec(&case.request).expect("request json");
        // An unauthenticated call never reaches the ingress: the edge refuses it
        // and the crate is handed a caller DID or nothing at all.
        let (status, body) = match case.caller.as_deref() {
            None => (
                401u16,
                serde_json::json!({
                    "error": "AuthRequired",
                    "message": "Authentication required",
                })
                .to_string(),
            ),
            Some(caller) => match SendEventsBody::parse(&bytes) {
                Ok(parsed) => match send_events(&mut log, &state, caller, &parsed, now) {
                    Ok(_) => (200u16, String::new()),
                    Err(denial) => denied(&denial),
                },
                Err(denial) => denied(&denial),
            },
        };

        if status != case.status || body != case.body {
            failures.push(format!(
                "{}\n  expected {} {:?}\n  actual   {} {:?}",
                case.name, case.status, case.body, status, body
            ));
        }

        let entries = read_entries(&log, written);
        let changes = read_changes(&log, written);
        if entries != case.events {
            failures.push(format!(
                "{}\n  expected entries {:?}\n  actual   entries {:?}",
                case.name, case.events, entries
            ));
        }
        if changes != case.changes {
            failures.push(format!(
                "{}\n  expected changes {:?}\n  actual   changes {:?}",
                case.name, case.changes, changes
            ));
        }
        if let Some(last) = case.events.last() {
            written = written.max(last.idx);
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} write cases differ:\n{}",
        failures.len(),
        fixture.cases.len(),
        failures.join("\n\n")
    );
}

fn denied(denial: &WriteDenial) -> (u16, String) {
    (
        denial.status,
        serde_json::json!({ "error": denial.error, "message": denial.message }).to_string(),
    )
}

fn read_entries(log: &EventLog, after: i64) -> Vec<Entry> {
    let mut statement = log
        .connection()
        .prepare(
            "select idx, user, event_type, received_at from stream_events
              where idx > ? order by idx",
        )
        .expect("prepare entries");
    statement
        .query_map([after], |row| {
            Ok(Entry {
                idx: row.get(0)?,
                user: row.get(1)?,
                event_type: row.get(2)?,
                received_at: row.get(3)?,
            })
        })
        .expect("query entries")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("entries")
}

fn read_changes(log: &EventLog, after: i64) -> Vec<Change> {
    let mut statement = log
        .connection()
        .prepare(
            "select idx, ord, kind, repo, collection, rkey, op, order_stamp,
                    actor, event_id, body
               from record_changes where idx > ? order by idx, ord",
        )
        .expect("prepare changes");
    statement
        .query_map([after], |row| {
            Ok(Change {
                idx: row.get(0)?,
                ord: row.get(1)?,
                kind: row.get(2)?,
                repo: row.get(3)?,
                collection: row.get(4)?,
                rkey: row.get(5)?,
                op: row.get(6)?,
                order_stamp: row.get(7)?,
                actor: row.get(8)?,
                event_id: row.get(9)?,
                body: row.get(10)?,
            })
        })
        .expect("query changes")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("changes")
}
