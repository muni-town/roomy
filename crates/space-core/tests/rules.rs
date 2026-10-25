//! Per-kind rule tests, mirroring the TypeScript rule tests.
//!
//! Each case plans one change and asserts what it writes — the tables, the
//! order, and the values the record carries — rather than the exact statement
//! text, so the assertions describe the projection a reader sees.

use roomy_events::Did;
use space_core::change::{
    ChangeBase, FederationGrantPatch, MembershipPatch, MessageContent, MessagePatch, MessageRecord,
    RecordBody, RecordChange, RecordKind, RecordPatch, RoomPatch, RoomPermissionRecord, RoomRecord,
};
use space_core::effects::{DerivedStep, Effect, Target, Value};
use space_core::ids::{Collection, Rkey, SpaceDid};
use space_core::{plan, RuleContext};

const STREAM: &str = "did:web:space.example";
const ACTOR: &str = "did:plc:actor";

fn stream() -> SpaceDid {
    SpaceDid::parse(STREAM).expect("space")
}

fn ctx() -> RuleContext {
    RuleContext::new(
        stream(),
        Did::parse(ACTOR).expect("actor"),
        "01HF7YAT00000000000000000A",
        1_700_000_000_000,
    )
}

fn base(kind: RecordKind, key: &str) -> ChangeBase {
    ChangeBase {
        kind,
        repo: Did::parse(STREAM).expect("repo"),
        collection: Collection::parse(kind.collection()).expect("collection"),
        rkey: Rkey::parse(key).expect("rkey"),
        order_stamp: serde_json::from_str("\"01HF7YAT000000000000000005\"").expect("stamp"),
    }
}

fn statements(effects: &[Effect]) -> Vec<(&'static str, Target, &[Value])> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Sql(statement) => {
                Some((statement.sql, statement.target, statement.params.as_slice()))
            }
            Effect::Step(_) => None,
        })
        .collect()
}

fn steps(effects: &[Effect]) -> Vec<&DerivedStep> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Step(step) => Some(step),
            Effect::Sql(_) => None,
        })
        .collect()
}

fn writes_to(effects: &[Effect], table: &str) -> bool {
    statements(effects)
        .iter()
        .any(|(sql, _, _)| sql.contains(table))
}

fn message(content: &str, room: &str) -> RecordBody {
    RecordBody::Message(MessageRecord {
        room: room.to_string(),
        author: Did::parse(ACTOR).expect("author"),
        actor: None,
        extensions: None,
        content: Some(MessageContent {
            mime_type: "text/markdown".to_string(),
            data: content.as_bytes().to_vec(),
        }),
        system: None,
        forward_of: None,
    })
}

#[test]
fn a_message_create_writes_its_content_author_and_order_key() {
    let change = RecordChange::Create {
        base: base(RecordKind::Message, "01HF7YAT000000000000000010"),
        record: message("hello https://example.com/x", "room-1"),
    };
    let effects = plan(&change, &ctx()).expect("planned");

    assert!(writes_to(&effects, "into entities"));
    assert!(writes_to(&effects, "into comp_content"));
    assert!(writes_to(&effects, "into edges"));
    assert!(writes_to(&effects, "set sort_idx"));
    // The link entity and the feed window are steps, not statements.
    let steps = steps(&effects);
    assert!(steps.iter().any(|step| matches!(
        step,
        DerivedStep::UpsertActivityItem { message_id, .. } if message_id == "01HF7YAT000000000000000010"
    )));
    assert!(steps.iter().any(|step| matches!(
        step,
        DerivedStep::StoreLinks { urls, .. } if urls == &vec!["https://example.com/x".to_string()]
    )));
}

#[test]
fn a_backfill_invalidates_the_read_path_projections_instead_of_writing_them() {
    let change = RecordChange::Create {
        base: base(RecordKind::Message, "01HF7YAT000000000000000010"),
        record: message("hello", "room-1"),
    };
    let live = plan(&change, &ctx()).expect("planned");
    let backfill = plan(
        &change,
        &RuleContext {
            is_backfill: true,
            ..ctx()
        },
    )
    .expect("planned");

    // A live write folds the message into its room's feed row; a replay deletes
    // it instead, so a read rebuilds it from the rows the replay has written.
    assert!(writes_to(&live, "insert into room_activity"));
    assert!(writes_to(&backfill, "delete from room_activity"));
    assert!(!writes_to(&backfill, "insert into room_activity"));

    // The same choice, on the other read-path projection: a room change
    // recomputes `room_access` live and invalidates the space's rows on a
    // replay.
    let room_change = RecordChange::Create {
        base: base(RecordKind::Room, "01HF7YAT000000000000000020"),
        record: RecordBody::Room(RoomRecord {
            kind: "space.roomy.channel".to_string(),
            name: Some("general".to_string()),
            avatar: None,
            description: None,
            default_access: Some("readwrite".to_string()),
            deleted: false,
            parent: None,
            discord_origin: None,
        }),
    };
    let live = plan(&room_change, &ctx()).expect("planned");
    let backfill = plan(
        &room_change,
        &RuleContext {
            is_backfill: true,
            ..ctx()
        },
    )
    .expect("planned");
    assert!(writes_to(&live, "insert into room_access"));
    assert!(writes_to(&backfill, "delete from room_access"));
    assert!(!writes_to(&backfill, "insert into room_access"));
}

#[test]
fn a_message_delete_removes_forward_references_first_and_rebuilds_the_window() {
    let ctx = RuleContext {
        prior_room: Some("room-1".to_string()),
        ..ctx()
    };
    let change = RecordChange::Delete {
        base: base(RecordKind::Message, "01HF7YAT000000000000000010"),
    };
    let effects = plan(&change, &ctx).expect("planned");
    let written = statements(&effects);
    assert!(written[0].0.contains("label = 'forward'"));
    assert!(written[1].0.contains("delete from entities where id = ?"));
    assert!(matches!(
        steps(&effects).as_slice(),
        [DerivedStep::RebuildActivityWindow { room_id }] if room_id == "room-1"
    ));
}

#[test]
fn a_message_move_re_keys_and_rebuilds_both_rooms() {
    let ctx = RuleContext {
        prior_room: Some("room-1".to_string()),
        ..ctx()
    };
    let change = RecordChange::Update {
        base: base(RecordKind::Message, "01HF7YAT000000000000000010"),
        patch: RecordPatch::Message(MessagePatch {
            room: Some("room-2".to_string()),
            content: None,
            extensions: None,
        }),
    };
    let effects = plan(&change, &ctx).expect("planned");
    assert!(writes_to(&effects, "update entities set room = ?"));
    assert!(writes_to(&effects, "set sort_idx"));
    let rooms: Vec<String> = steps(&effects)
        .into_iter()
        .filter_map(|step| match step {
            DerivedStep::RebuildActivityWindow { room_id } => Some(room_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(rooms, vec!["room-1".to_string(), "room-2".to_string()]);
}

#[test]
fn a_reaction_delete_removes_the_row_it_names() {
    let change = RecordChange::Delete {
        base: base(RecordKind::Reaction, "01HF7YAT000000000000000020"),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    assert_eq!(statements(&effects).len(), 1);
    assert!(writes_to(&effects, "delete from comp_reaction"));
    assert!(steps(&effects).is_empty());
}

#[test]
fn a_room_create_writes_its_info_access_and_origin() {
    let change = RecordChange::Create {
        base: base(RecordKind::Room, "01HF7YAT000000000000000001"),
        record: RecordBody::Room(RoomRecord {
            kind: "space.roomy.channel".to_string(),
            name: Some("general".to_string()),
            avatar: None,
            description: None,
            default_access: Some("readwrite".to_string()),
            deleted: false,
            parent: None,
            discord_origin: None,
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    assert!(writes_to(&effects, "into comp_info"));
    assert!(writes_to(&effects, "into comp_room"));
    // A room change maintains `room_access`.
    assert!(writes_to(&effects, "into room_access"));
}

#[test]
fn an_unlink_clears_the_parent_the_planner_read() {
    let ctx = RuleContext {
        prior_parent: Some("parent-1".to_string()),
        ..ctx()
    };
    let change = RecordChange::Update {
        base: base(RecordKind::Room, "01HF7YAT000000000000000002"),
        patch: RecordPatch::Room(RoomPatch {
            kind: None,
            name: None,
            avatar: None,
            description: None,
            default_access: None,
            deleted: None,
            parent: Some(None),
        }),
    };
    let effects = plan(&change, &ctx).expect("planned");
    let written = statements(&effects);
    let delete = written
        .iter()
        .find(|(sql, _, _)| sql.contains("delete from edges"))
        .expect("the link edge goes");
    assert!(delete.0.contains("head = ?"));
    assert_eq!(delete.2[0], Value::text("parent-1"));
}

#[test]
fn a_membership_join_writes_both_edge_sets_and_the_announcement() {
    let change = RecordChange::Create {
        base: base(RecordKind::Membership, "did:plc:joiner"),
        record: RecordBody::Membership(space_core::change::MembershipRecord {
            user: Did::parse("did:plc:joiner").expect("user"),
            can: "post".to_string(),
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    let global: Vec<&str> = statements(&effects)
        .into_iter()
        .filter(|(_, target, _)| *target == Target::Global)
        .map(|(sql, _, _)| sql)
        .collect();
    assert!(global.iter().any(|sql| sql.contains("'joinedSpace'")));
    assert!(global.iter().any(|sql| sql.contains("'leftSpace'")));
    // The announcement is keyed by the entry's id and lands in the first channel.
    assert!(writes_to(
        &effects,
        "into entities (id, stream_id, room, created_at, updated_at)"
    ));
    let announcement = statements(&effects)
        .into_iter()
        .find(|(sql, _, _)| sql.contains("joined the space"))
        .expect("the announcement");
    assert_eq!(announcement.2[0], Value::text("01HF7YAT00000000000000000A"));
}

#[test]
fn remove_admin_keeps_the_member_and_drops_the_admin_edge() {
    let change = RecordChange::Update {
        base: base(RecordKind::Membership, "did:plc:member"),
        patch: RecordPatch::Membership(MembershipPatch {
            can: "post".to_string(),
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    assert!(writes_to(&effects, "'{\"can\":\"post\"}'"));
    assert!(writes_to(&effects, "label = 'admin'"));
}

#[test]
fn a_room_permission_with_a_level_is_delete_then_insert_and_without_one_is_a_delete() {
    let record = RoomPermissionRecord {
        role: "role-1".to_string(),
        room: "room-1".to_string(),
        permission: "read".to_string(),
    };
    let set = RecordChange::Update {
        base: base(RecordKind::RoomPermission, "role-1~room-1"),
        patch: RecordPatch::RoomPermission(record),
    };
    let effects = plan(&set, &ctx()).expect("planned");
    let written = statements(&effects);
    assert!(written[0].0.contains("delete from role_rooms"));
    assert!(written[1].0.contains("insert into role_rooms"));

    let cleared = RecordChange::Delete {
        base: base(RecordKind::RoomPermission, "role-1~room-1"),
    };
    let effects = plan(&cleared, &ctx()).expect("planned");
    let cleared_statements = statements(&effects);
    assert_eq!(cleared_statements.len(), 1);
    let params = cleared_statements[0].2;
    assert_eq!(params[0], Value::text("role-1"));
    assert_eq!(params[1], Value::text("room-1"));
}

#[test]
fn a_federation_grant_clears_then_sets_the_one_room_it_names() {
    let mut base = base(RecordKind::FederationGrant, "did:web:receiving.example");
    base.repo = Did::parse("did:web:origin.example").expect("origin");
    let change = RecordChange::Update {
        base,
        patch: RecordPatch::FederationGrant(FederationGrantPatch::Origin {
            room: "room-1".to_string(),
            permission: None,
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    let written = statements(&effects);
    assert_eq!(written.len(), 1, "a null level only clears");
    assert!(written[0]
        .0
        .contains("delete from federation_room_permissions"));
    assert_eq!(written[0].1, Target::Global);
    assert_eq!(written[0].2[0], Value::text("did:web:origin.example"));
}

#[test]
fn a_call_start_supersedes_the_previous_call_and_projects_globally() {
    let change = RecordChange::Create {
        base: base(RecordKind::VoiceCall, "call-1"),
        record: RecordBody::VoiceCall(space_core::change::VoiceCallRecord {
            room: "room-1".to_string(),
            source: "user".to_string(),
            started_at: 1_700_000_000_000,
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    assert!(writes_to(&effects, "into active_calls"));
    assert!(writes_to(&effects, "delete from call_participants"));
    assert!(
        statements(&effects)
            .iter()
            .any(|(sql, target, _)| sql.contains("voice_projected_calls")
                && *target == Target::Global)
    );
}

#[test]
fn a_call_fact_without_a_room_is_an_error_rather_than_a_silent_write() {
    let change = RecordChange::Update {
        base: base(RecordKind::VoiceCall, "call-1"),
        patch: RecordPatch::VoiceCall(space_core::change::VoiceCallPatch {
            source: "user".to_string(),
            joined: Some(Did::parse("did:plc:joiner").expect("user")),
            left: None,
        }),
    };
    assert!(plan(&change, &ctx()).is_err());
}

#[test]
fn a_sidebar_write_stores_the_record_as_json_with_its_key_order() {
    let change = RecordChange::Update {
        base: base(RecordKind::SpaceSidebar, "self"),
        patch: RecordPatch::SpaceSidebar(space_core::change::SpaceSidebarRecord {
            categories: vec![space_core::change::SidebarCategory {
                id: Some("cat-1".to_string()),
                name: "General".to_string(),
                children: vec!["room-1".to_string()],
            }],
            extensions: None,
        }),
    };
    let effects = plan(&change, &ctx()).expect("planned");
    let params = statements(&effects)[0].2;
    assert_eq!(
        params[0],
        Value::text(r#"{"categories":[{"id":"cat-1","name":"General","children":["room-1"]}]}"#)
    );
}
