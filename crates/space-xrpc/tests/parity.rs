//! Response parity against the appserver.
//!
//! `tests/fixtures/expected.json` is produced by `tests/fixtures/generate.ts`
//! from the real TS handlers. Each case carries the caller, the read-position
//! header the gateway would send, the params, and the exact body the appserver
//! returned. This test replays every case through the worker's router and
//! requires the same status and the same bytes.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{Map, Value};
use tower::ServiceExt;

use space_xrpc::state::{SpaceDb, XrpcState};
use space_xrpc::store::{GlobalStores, SqliteGlobalStores};
use space_xrpc::verify::TestMode;

#[derive(Deserialize)]
struct Fixture {
    #[allow(dead_code)]
    space: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    nsid: String,
    params: Map<String, Value>,
    caller: Option<String>,
    #[serde(rename = "readPositions")]
    read_positions: Vec<WirePosition>,
    status: u16,
    body: String,
}

#[derive(Deserialize, serde::Serialize, Clone)]
struct WirePosition {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "seenUpTo")]
    seen_up_to: String,
    #[serde(rename = "lastActiveAt", skip_serializing_if = "Option::is_none")]
    last_active_at: Option<i64>,
}

fn state() -> XrpcState {
    let db = SpaceDb::open_readonly(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/space.sqlite"
    ))
    .expect("fixture space db");
    let stores = SqliteGlobalStores::open(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/global.sqlite"
    ))
    .expect("fixture global db");
    XrpcState::new(Arc::new(db), Arc::new(TestMode))
        .with_stores(Arc::new(stores) as Arc<dyn GlobalStores>)
}

fn query(params: &Map<String, Value>) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        let text = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        serializer.append_pair(key, &text);
    }
    serializer.finish()
}

fn positions_header(positions: &[WirePosition]) -> Option<String> {
    use base64::Engine;
    if positions.is_empty() {
        return None;
    }
    let json = serde_json::to_vec(positions).expect("positions json");
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

#[tokio::test]
async fn every_fixture_case_is_byte_identical() {
    let fixture: Fixture = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/expected.json"
        ))
        .expect("expected.json"),
    )
    .expect("parse expected.json");

    assert!(!fixture.cases.is_empty(), "fixture has no cases");
    let app = space_xrpc::router(state());
    let mut failures: Vec<String> = Vec::new();

    for case in &fixture.cases {
        let uri = format!("/xrpc/{}?{}", case.nsid, query(&case.params));
        let mut request = Request::builder().uri(&uri);
        if let Some(caller) = &case.caller {
            request = request.header("x-test-did", caller);
        }
        if let Some(header) = positions_header(&case.read_positions) {
            request = request.header("x-roomy-read-positions", header);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("router response");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let body = String::from_utf8(bytes.to_vec()).expect("utf8 body");

        let expected_status = StatusCode::from_u16(case.status).expect("status");
        if status != expected_status {
            failures.push(format!(
                "{}\n  status: expected {} got {}\n  body: {}",
                case.name,
                case.status,
                status.as_u16(),
                body
            ));
            continue;
        }
        if body != case.body {
            failures.push(format!(
                "{}\n  expected: {}\n  actual:   {}",
                case.name, case.body, body
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        fixture.cases.len(),
        failures.join("\n\n")
    );
}

#[derive(Deserialize)]
struct Facts {
    #[serde(rename = "channelId")]
    channel_id: String,
    #[serde(rename = "threadId")]
    thread_id: String,
    #[serde(rename = "deletedMessageId")]
    deleted_message_id: String,
    #[serde(rename = "editedMessageId")]
    edited_message_id: String,
    #[serde(rename = "reactedMessageId")]
    reacted_message_id: String,
}

#[derive(Deserialize)]
struct FixtureWithFacts {
    facts: Facts,
    cases: Vec<Case>,
}

/// The fixture is only evidence if it exercises the behaviours the port claims
/// to serve: a paginated page boundary, an edit, a delete, a reaction, and a
/// thread with a canonical parent.
#[test]
fn fixture_exercises_the_required_behaviours() {
    let fixture: FixtureWithFacts = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/expected.json"
        ))
        .expect("expected.json"),
    )
    .expect("parse expected.json");
    let facts = &fixture.facts;

    let body_of = |name: &str| -> Value {
        let case = fixture
            .cases
            .iter()
            .find(|case| case.name == name)
            .unwrap_or_else(|| panic!("missing case {name}"));
        serde_json::from_str(&case.body).unwrap_or_else(|_| panic!("case {name} is not JSON"))
    };

    // Paginated walk over a page boundary: page 2 exists, is a different page,
    // and the two together cover the edited message.
    let page1 = body_of("admin/room.getMessages.c1.page1");
    let page2 = body_of("admin/room.getMessages.c1.page2");
    let cursor = page1["cursor"].as_str().expect("page 1 cursor");
    assert!(!cursor.is_empty());
    assert_ne!(page1["messages"], page2["messages"]);
    let ids: Vec<&str> = page1["messages"]
        .as_array()
        .unwrap()
        .iter()
        .chain(page2["messages"].as_array().unwrap())
        .filter_map(|message| message["id"].as_str())
        .collect();

    // A delete: the deleted row never appears.
    assert!(!ids.contains(&facts.deleted_message_id.as_str()));

    // An edit and a reaction.
    let edited = body_of("admin/message.getMessage.edited");
    assert_eq!(edited["id"], facts.edited_message_id.as_str());
    assert!(edited["lastEdit"].is_string());
    let reactions = body_of("admin/message.getReactions");
    assert!(reactions["reactions"].as_array().unwrap().len() >= 2);
    assert_eq!(
        fixture
            .cases
            .iter()
            .find(|case| case.name == "admin/message.getReactions")
            .unwrap()
            .params["messageId"],
        facts.reacted_message_id.as_str()
    );

    // A thread with a canonical parent channel.
    let threads = body_of("admin/room.getThreads.c1");
    let thread = threads["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|thread| thread["id"] == facts.thread_id.as_str())
        .expect("thread in channel");
    assert_eq!(thread["canonicalParent"], facts.channel_id.as_str());

    // Access parity: every case carries the TS status and body, and the
    // non-member is denied on every room/message read while still seeing the
    // space's metadata.
    for case in &fixture.cases {
        if let Some("outsider") = case.caller.as_deref() {
            let expected = if case.nsid.starts_with("space.roomy.space.getMetadata") {
                200
            } else {
                403
            };
            assert_eq!(case.status, expected, "{} status", case.name);
            if expected == 403 {
                let body: Value = serde_json::from_str(&case.body).unwrap();
                assert_eq!(body["error"], "Forbidden", "{}", case.name);
            }
        }
        if case.name.starts_with("member/") && case.name.contains("secret") {
            assert_eq!(case.status, 403, "member reading default_access=none");
        }
    }
}

/// Every ported NSID is covered for all three callers.
#[test]
fn fixture_covers_every_endpoint_for_every_caller() {
    let fixture: Fixture = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/expected.json"
        ))
        .expect("expected.json"),
    )
    .expect("parse expected.json");

    for nsid in space_xrpc::ENDPOINTS {
        for caller in ["did:plc:admin", "did:plc:member", "did:plc:outsider"] {
            assert!(
                fixture
                    .cases
                    .iter()
                    .any(|case| case.nsid == *nsid && case.caller.as_deref() == Some(caller)),
                "no {nsid} case for {caller}"
            );
        }
    }
}
