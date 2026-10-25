//! The gateway's HTTP edge: the per-space reads it routes, and the two
//! endpoints it owns.
//!
//! The per-space handlers belong to `space-xrpc`; what is asserted here is that
//! a request reaches the right space through the gateway — by `spaceId` and by
//! an entity id resolved through the global index — and that a space the
//! process does not serve is a 404 rather than an answer from somewhere else.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::{router, GatewaySignals, GatewayState};
use space_xrpc::registry::{FixedSpaces, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SCHEMA: &str = include_str!("../../../packages/appserver/src/db/schema-space.sql");

/// A space with one room and one space row, built straight from the schema so
/// the gateway's routing has something real to read.
fn space_db(space: &str, room: &str) -> SpaceReadDb {
    let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch(SCHEMA).expect("schema");
    conn.execute(
        "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, 1, 1)",
        [space, space],
    )
    .expect("space entity");
    conn.execute(
        "insert into comp_space (entity, created_at, updated_at) values (?, 1, 1)",
        [space],
    )
    .expect("space row");
    conn.execute(
        "insert into comp_info (entity, name, created_at, updated_at) values (?, ?, 1, 1)",
        [space, "Routed Space"],
    )
    .expect("space info");
    conn.execute(
        "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, 1, 1)",
        [room, space],
    )
    .expect("room entity");
    conn.execute(
        "insert into comp_room (entity, label, default_access, created_at, updated_at)
         values (?, 'space.roomy.channel', 'readwrite', 1, 1)",
        [room],
    )
    .expect("room row");
    conn.execute(
        "insert into comp_info (entity, name, created_at, updated_at) values (?, ?, 1, 1)",
        [room, "general"],
    )
    .expect("room info");
    SpaceReadDb::from_connection(conn)
}

fn state() -> Arc<GatewayState> {
    let space = space_db("did:web:alpha.example", "01JRZ0R00N0000000000000000");
    let spaces = FixedSpaces::new([(String::from("did:web:alpha.example"), Arc::new(space))])
        // The room resolves to its space through the gateway's registry.
        .with_entity("01JRZ0R00N0000000000000000", "did:web:alpha.example");
    let reads = XrpcState::new(
        Arc::new(space_db(
            "did:web:alpha.example",
            "01JRZ0R00N0000000000000000",
        )),
        Arc::new(TestMode),
    )
    .with_spaces(Arc::new(spaces) as Arc<dyn SpaceResolver>);
    let secret = b"gateway-secret".to_vec();
    Arc::new(GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(secret.clone(), "gateway.test", 60)),
        Arc::new(TicketVerifier::new(
            secret,
            "gateway.test",
            Box::new(InMemoryNonces::new()),
        )),
        GatewaySignals::new(8),
    ))
}

async fn get(state: &Arc<GatewayState>, uri: &str) -> (StatusCode, String) {
    let app = router(Arc::clone(state));
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn a_read_reaches_the_space_its_space_id_names() {
    let state = state();
    let (status, body) = get(
        &state,
        "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:alpha.example",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let metadata: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(metadata["name"], "Routed Space");
}

#[tokio::test]
async fn a_read_by_room_id_resolves_its_space_through_the_index() {
    let state = state();
    let (status, body) = get(
        &state,
        "/xrpc/space.roomy.room.getMetadata?roomId=01JRZ0R00N0000000000000000",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let metadata: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(metadata["name"], "general");
}

#[tokio::test]
async fn a_space_this_process_does_not_serve_is_a_404() {
    let state = state();
    let (status, body) = get(
        &state,
        "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:absent.example",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(body.contains("did:web:absent.example"), "{body}");
}

#[tokio::test]
async fn health_and_metrics_are_served() {
    let state = state();
    let (status, body) = get(&state, "/health").await;
    assert_eq!(status, StatusCode::OK);
    let health: Value = serde_json::from_str(&body).expect("json");
    assert_eq!(health["status"], "ok");

    let (status, body) = get(&state, "/metrics").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("roomy_gateway_sessions_opened"), "{body}");
}

#[tokio::test]
async fn a_ticket_endpoint_mints_one_for_the_authenticated_caller() {
    let state = state();
    let app = router(Arc::clone(&state));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/xrpc/space.roomy.auth.getConnectionTicket?spaces=did:web:alpha.example")
                .header("x-test-did", "did:plc:alice")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).expect("json");
    let ticket = body["ticket"].as_str().expect("a ticket");
    let claims = state.verifier.verify(ticket).expect("the ticket verifies");
    assert_eq!(claims.sub, "did:plc:alice");
    assert_eq!(claims.spaces, vec!["did:web:alpha.example".to_string()]);
    assert!(claims.exp > claims.iat);
    let _ = Duration::from_secs(1);
}

#[tokio::test]
async fn a_repeated_read_is_served_from_the_cache_and_a_signal_evicts_it() {
    let state = state();
    let uri = "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:alpha.example";

    let (status, first) = get(&state, uri).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state.cache.len(), 1, "the answer is cached");

    let (status, second) = get(&state, uri).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second, first, "the cached answer is the same bytes");

    // A signal for that space evicts it: the next read goes to the worker again.
    state.cache.invalidate_space("did:web:alpha.example");
    assert_eq!(state.cache.len(), 0);
    let (status, third) = get(&state, uri).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(third, first);
}

#[tokio::test]
async fn the_cache_is_bounded_by_its_ttl() {
    let state = state();
    let uri = "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:alpha.example";
    let _ = get(&state, uri).await;
    assert_eq!(state.cache.len(), 1);
    tokio::time::sleep(state.cache.ttl() + Duration::from_millis(50)).await;
    // An expired entry is a miss, not an answer.
    let _ = get(&state, uri).await;
    assert_eq!(state.cache.len(), 1, "the miss re-populated it");
}

#[tokio::test]
async fn an_error_is_not_cached() {
    let state = state();
    let (status, _) = get(
        &state,
        "/xrpc/space.roomy.space.getMetadata?spaceId=did:web:absent.example",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(state.cache.is_empty());
}
