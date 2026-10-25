//! The cutover edge: proxy while a space is not ours, shadow what is, and roll back.
//!
//! The TypeScript appserver is the oracle. Until a space is cut over it is also
//! the server: this process proxies to it. After the cutover this process answers,
//! and a sampled read is mirrored to the TypeScript appserver so a divergence is
//! recorded before anyone depends on the answer.
//!
//! The rollback is the same table the other way round, and this file exercises it:
//! flip a space back and the very next request is answered by the TypeScript
//! appserver again.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::response::IntoResponse;
use axum::routing::get as route_get;
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::cutover::{MaterialisationOwners, OwnerStore, ShadowConfig, SqliteOwnerStore};
use roomy_gateway::traffic::Traffic;
use roomy_gateway::{router, GatewaySignals, GatewayState};
use space_core::ids::SpaceDid;
use space_xrpc::registry::FixedSpaces;
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SPACE: &str = "did:web:cutover.example";

/// The TypeScript appserver's stand-in: it answers with a marker, and can be told
/// to answer like a server that has drifted.
#[derive(Clone)]
struct StubServer {
    divergent: Arc<AtomicU64>,
}

impl StubServer {
    fn new() -> Self {
        Self {
            divergent: Arc::new(AtomicU64::new(0)),
        }
    }

    async fn serve(
        self,
    ) -> (
        String,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let stub = self;
        let app = Router::new().route(
            "/xrpc/{nsid}",
            route_get(move || {
                let stub = stub.clone();
                async move {
                    if stub.divergent.load(Ordering::Relaxed) == 1 {
                        return axum::Json(serde_json::json!({"served": "drifted"}))
                            .into_response();
                    }
                    axum::Json(serde_json::json!({"served": "typescript"})).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let (shutdown, stop) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stop.await;
                })
                .await;
        });
        (format!("http://{address}"), shutdown, handle)
    }
}

struct Gateway {
    state: Arc<GatewayState>,
    owners: Arc<MaterialisationOwners<Box<dyn OwnerStore>>>,
    handover: std::sync::Mutex<Option<roomy_gateway::cutover::Handover>>,
}

fn gateway(ts_origin: String, shadow_percent: u8) -> Gateway {
    gateway_over(ts_origin, shadow_percent, FixedSpaces::new(Vec::new()))
}

fn gateway_over(ts_origin: String, shadow_percent: u8, spaces: FixedSpaces) -> Gateway {
    let placeholder = Arc::new(SpaceReadDb::from_connection(
        rusqlite::Connection::open_in_memory().expect("placeholder"),
    ));
    let reads = XrpcState::new(placeholder, Arc::new(TestMode)).with_spaces(Arc::new(spaces));
    // One table: the operator flips it, the edge reads it.
    let owners = Arc::new(MaterialisationOwners::new(Box::new(
        SqliteOwnerStore::in_memory().expect("owner store"),
    ) as Box<dyn OwnerStore>));
    let traffic = Traffic::new(
        ts_origin,
        Arc::clone(&owners),
        ShadowConfig {
            sample_percent: shadow_percent,
            seed: 7,
            eligible_nsids: Vec::new(),
            ..ShadowConfig::default()
        },
    );
    let state = GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(b"ticket-secret".to_vec(), "test", 60)),
        Arc::new(TicketVerifier::new(
            b"ticket-secret".to_vec(),
            "test",
            Box::new(InMemoryNonces::new()),
        )),
        GatewaySignals::new(8),
    )
    .with_traffic(traffic);
    Gateway {
        state: Arc::new(state),
        owners,
        handover: std::sync::Mutex::new(None),
    }
}

async fn get(state: &Arc<GatewayState>, uri: &str) -> (u16, String) {
    let app = router(Arc::clone(state));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .header("x-test-did", "did:plc:reader")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("router response");
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn space_did() -> SpaceDid {
    SpaceDid::parse(SPACE.to_string()).expect("space DID")
}

fn handover(gateway: &Gateway, node: &str) {
    let handover = gateway
        .owners
        .handover(&space_did(), node, "test", 1_700_000_000_000)
        .expect("the handover lands");
    *gateway
        .handover
        .lock()
        .expect("the handover is not poisoned") = Some(handover);
}

fn rollback(gateway: &Gateway) {
    let handover = gateway
        .handover
        .lock()
        .expect("the handover is not poisoned")
        .clone()
        .expect("a handover happened");
    gateway
        .owners
        .rollback(&space_did(), &handover, "test", 1_700_000_001_000)
        .expect("the rollback lands");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_space_that_is_not_ours_is_answered_by_the_typescript_appserver() {
    let (origin, shutdown, handle) = StubServer::new().serve().await;
    let gateway = gateway(origin, 0);

    let (status, body) = get(
        &gateway.state,
        &format!("/xrpc/space.roomy.space.getMetadata?spaceId={}", SPACE),
    )
    .await;

    let _ = shutdown.send(());
    let _ = handle.await;

    assert_eq!(status, 200);
    assert!(
        body.contains("typescript"),
        "an unowned space is still the TypeScript appserver's: {body}"
    );
    assert_eq!(
        gateway.state.counters.proxied.load(Ordering::Relaxed),
        1,
        "the proxy is counted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cut_over_space_is_answered_here_and_a_rollback_hands_it_back() {
    let (origin, shutdown, handle) = StubServer::new().serve().await;
    let gateway = gateway(origin, 0);

    // The cutover: one row, and the next request is answered here.
    handover(&gateway, "rust-core");
    let (status, body) = get(
        &gateway.state,
        &format!("/xrpc/space.roomy.space.getMetadata?spaceId={}", SPACE),
    )
    .await;
    assert_ne!(status, 200, "the space is not materialised here: {body}");
    assert!(
        !body.contains("typescript"),
        "the TypeScript appserver no longer answers this space: {body}"
    );

    // The rollback: the same row the other way, and the TypeScript appserver has
    // it back on the very next request.
    rollback(&gateway);
    let (status, body) = get(
        &gateway.state,
        &format!("/xrpc/space.roomy.space.getMetadata?spaceId={}", SPACE),
    )
    .await;

    let _ = shutdown.send(());
    let _ = handle.await;

    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("typescript"),
        "the rollback is exercised, not just recorded: {body}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mirrored_read_records_a_divergence_and_still_answers_locally() {
    let stub = StubServer::new();
    let divergent = Arc::clone(&stub.divergent);
    let (origin, shutdown, handle) = stub.clone().serve().await;
    let gateway = gateway(origin, 100);
    handover(&gateway, "rust-core");

    // The two servers disagree: this one answers, and the comparison says so.
    divergent.store(1, Ordering::Relaxed);
    let (status, body) = get(
        &gateway.state,
        &format!("/xrpc/space.roomy.space.getMetadata?spaceId={}", SPACE),
    )
    .await;

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let nsids = gateway.state.traffic.as_ref().expect("traffic").alerts();
        if !nsids.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let alerts = gateway.state.traffic.as_ref().expect("traffic").alerts();

    let _ = shutdown.send(());
    let _ = handle.await;

    assert_ne!(status, 200, "the answer is this process's: {body}");
    assert!(
        !body.contains("drifted"),
        "the mirror never replaces the answer: {body}"
    );
    assert_eq!(
        alerts,
        vec!["space.roomy.space.getMetadata".to_string()],
        "the divergence is recorded against the NSID that produced it"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sample_of_zero_mirrors_nothing() {
    let stub = StubServer::new();
    let divergent = Arc::clone(&stub.divergent);
    let (origin, shutdown, handle) = stub.clone().serve().await;
    let gateway = gateway(origin, 0);
    handover(&gateway, "rust-core");

    divergent.store(1, Ordering::Relaxed);
    let _ = get(
        &gateway.state,
        &format!("/xrpc/space.roomy.space.getMetadata?spaceId={}", SPACE),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let alerts = gateway.state.traffic.as_ref().expect("traffic").alerts();
    let _ = shutdown.send(());
    let _ = handle.await;
    assert!(
        alerts.is_empty(),
        "a deployment that is not shadowing pays nothing and records nothing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_id_is_resolved_to_its_space_before_the_cutover_decides() {
    let (origin, shutdown, handle) = StubServer::new().serve().await;
    let space = space_did();
    let db = Arc::new(SpaceReadDb::from_connection(
        rusqlite::Connection::open_in_memory().expect("space db"),
    ));
    let spaces = FixedSpaces::new([(space.as_str().to_string(), db)])
        .with_entity("01ROOM000000000000000000AAA", SPACE);
    let gateway = gateway_over(origin, 0, spaces);

    // The space is still the TypeScript appserver's, so the room read is proxied.
    let uri = "/xrpc/space.roomy.room.getMessages?roomId=01ROOM000000000000000000AAA";
    let (_, body) = get(&gateway.state, uri).await;
    assert!(body.contains("typescript"), "{body}");

    // After the cutover the same room read is this process's, because the room
    // resolves to a space that is ours — not because the room id looked like one.
    handover(&gateway, "rust-core");
    let (_, body) = get(&gateway.state, uri).await;

    let _ = shutdown.send(());
    let _ = handle.await;

    assert!(
        !body.contains("typescript"),
        "the room's space decides, not the room id: {body}"
    );
}
