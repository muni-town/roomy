//! What a failed statement says.
//!
//! SQLite's own text for a rejected statement — `FOREIGN KEY constraint failed`
//! — names neither the change whose effects produced it nor the statement and
//! values involved, so a batch that cannot be applied reports the same sentence
//! for every cause. These tests pin the context a failure carries instead: the
//! change's position in the log, the SQL, and the bound values, bounded so one
//! large value cannot flood the log.

use space_core::change::FeedRow;
use space_core::effects::{Effect, SqlEffect, Value};
use space_core::ids::SpaceDid;
use space_core::{ChangeOp, PlanMode, RecordKind};
use space_db::plan::{group_entries, plan_batch};
use space_db::{DbError, PlannedChange, PlannedEntry, SpaceDb, StatementContext};

const STREAM: &str = "did:web:missing-parent.example";
const ACTOR: &str = "did:plc:adapter-user";

fn space() -> (SpaceDid, SpaceDb) {
    let stream = SpaceDid::parse(STREAM).expect("stream is a DID");
    let db = SpaceDb::open_in_memory(stream.clone()).expect("space DB opens");
    (stream, db)
}

/// A reaction whose target message was never materialised: the rule writes a
/// `comp_reaction` row keyed by that missing message, which is a row the schema's
/// foreign key refuses.
fn reaction_of_a_missing_message() -> FeedRow {
    FeedRow {
        stream_id: STREAM.to_string(),
        idx: 7,
        ord: 0,
        kind: "reaction".to_string(),
        repo: ACTOR.to_string(),
        collection: "space.roomy.room.reaction".to_string(),
        rkey: "01HF7YAT000000000000000008".to_string(),
        op: "create".to_string(),
        order_stamp: "01HF7YAT00000000000000000M".to_string(),
        actor: ACTOR.to_string(),
        event_id: "01HF7YAT000000000000000008".to_string(),
        body: Some(
            "{\"target\":\"01HF7YAT000000000000000005\",\
              \"user\":\"did:plc:adapter-user\",\
              \"reaction\":\"👍\"}"
                .to_string(),
        ),
    }
}

fn statement_of(error: &DbError) -> &StatementContext {
    match error {
        DbError::Statement(failure) => &failure.context,
        other => panic!("a rejected statement must name itself, got {other:?}"),
    }
}

#[test]
fn a_failed_statement_names_the_change_and_the_statement() {
    let (stream, mut db) = space();
    let rows = vec![reaction_of_a_missing_message()];

    let entries = group_entries(&rows).expect("the feed row decodes");
    let planned = plan_batch(db.connection(), &stream, &entries, PlanMode::Live)
        .expect("the rules plan the reaction");

    let error = db
        .begin_batch(&planned, (rows[0].idx, rows[0].ord), 1)
        .err()
        .expect("a reaction to a message that is not there cannot be applied");

    let change = &statement_of(&error).change;
    assert_eq!(change.idx, 7);
    assert_eq!(change.ord, 0);
    assert_eq!(change.kind, RecordKind::Reaction);
    assert_eq!(change.op, ChangeOp::Create);
    assert_eq!(change.rkey, "01HF7YAT000000000000000008");

    let message = error.to_string();
    for expected in [
        "change idx=7 ord=0 kind=reaction op=create rkey=01HF7YAT000000000000000008",
        "space statement failed: insert or replace into comp_reaction",
        // The parameters are rendered, so the value the key refused is readable.
        "text(26B) \"01HF7YAT000000000000000005\"",
        "text(20B) \"did:plc:adapter-user\"",
        "FOREIGN KEY constraint failed",
    ] {
        assert!(
            message.contains(expected),
            "missing {expected:?} in: {message}"
        );
    }
    // One line: the supervisor logs this as a single field.
    assert!(
        !message.contains('\n'),
        "the failure is one line: {message}"
    );
}

/// The same change applies once the row it references is there: the context is
/// what a failure says, not a change to what a batch applies.
#[test]
fn the_same_batch_applies_when_the_parent_is_there() {
    let (stream, mut db) = space();
    let rows = vec![reaction_of_a_missing_message()];
    let entries = group_entries(&rows).expect("the feed row decodes");
    let planned = plan_batch(db.connection(), &stream, &entries, PlanMode::Live)
        .expect("the rules plan the reaction");

    // The two entities the reaction's foreign keys name.
    for id in ["01HF7YAT000000000000000005", "did:plc:adapter-user"] {
        db.connection()
            .execute(
                "insert into entities (id, stream_id, room, created_at, updated_at)
                 values (?, ?, null, 0, 0)",
                rusqlite::params![id, STREAM],
            )
            .expect("seeding the entity the reaction names");
    }

    db.begin_batch(&planned, (rows[0].idx, rows[0].ord), 1)
        .expect("the reaction applies once its targets exist")
        .commit()
        .expect("the batch commits");
    assert_eq!(db.cursor().expect("cursor"), Some((7, 0)));
}

#[test]
fn a_failed_statement_bounds_what_it_renders() {
    let (_stream, mut db) = space();

    // A message body is the value that has to stay out of the log: the content
    // is a blob, and its text can be as long as a post.
    let body = b"<p>a message body</p>".repeat(400);
    let long_text = "x".repeat(500);
    let planned = vec![PlannedEntry {
        idx: 9,
        changes: vec![PlannedChange {
            ord: 1,
            kind: RecordKind::Message,
            op: ChangeOp::Create,
            rkey: "01HF7YAT000000000000000009".to_string(),
            effects: vec![Effect::Sql(SqlEffect {
                target: space_core::Target::Space,
                sql: "insert or replace into comp_content (
                        entity, mime_type, data, last_edit, timestamp, created_at, updated_at
                      )
                      values (?, ?, ?, ?, ?, ?, ?)",
                params: vec![
                    Value::text("01HF7YAT00000000000000000B"),
                    Value::text("text/html"),
                    Value::Blob(body.clone()),
                    Value::text(&long_text),
                    Value::Integer(1700000000000),
                    Value::Integer(1700000000000),
                    Value::Integer(1700000000000),
                ],
            })],
        }],
    }];

    let error = db
        .begin_batch(&planned, (9, 1), 1)
        .err()
        .expect("the message's entity is not there, so the content row cannot land");

    let message = error.to_string();
    // A blob renders as its size, never its bytes.
    assert!(
        message.contains(&format!("blob({}B)", body.len())),
        "the blob's size is rendered: {message}"
    );
    assert!(
        !message.contains("<p>a message body</p>"),
        "the blob's bytes are not rendered: {message}"
    );
    // A long text value is cut at 200 characters.
    assert!(
        message.contains(&format!("text(500B) \"{}\u{2026}\"", "x".repeat(200))),
        "the text is truncated: {message}"
    );
    assert!(
        !message.contains(&"x".repeat(201)),
        "no more than 200 characters are rendered: {message}"
    );
    // Five values are rendered, and the rest are counted.
    assert!(
        message.contains("+2 more"),
        "the count is bounded: {message}"
    );
    assert!(
        message.contains("FOREIGN KEY constraint failed"),
        "{message}"
    );
}
