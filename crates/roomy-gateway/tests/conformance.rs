//! Connection conformance: subscribe, deny, reconnect, backfill, ticket expiry.
//!
//! The session core's decisions are unit-tested without a socket
//! (`roomy_sync`). This file is the other half of the M2 gate: the same
//! behaviours through the axum adapter, over a real loopback WebSocket, against
//! a real ticket verifier.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::{router, GatewaySignals, GatewayState};
use roomy_space_worker::signal::SpaceSignal;
use space_core::ids::SpaceDid;
use space_xrpc::registry::FixedSpaces;
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SPACE: &str = "did:web:space.example";
const OTHER: &str = "did:web:other.example";

struct Gateway {
    url: String,
    state: Arc<GatewayState>,
    issuer: TicketIssuer,
    shutdown: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

async fn start_gateway(ttl_secs: u64) -> Gateway {
    let db = Arc::new(SpaceReadDb::from_connection(
        rusqlite::Connection::open_in_memory().expect("in-memory space db"),
    ));
    let spaces = FixedSpaces::new([(SPACE.to_string(), db)]);
    let reads = XrpcState::new(
        Arc::new(SpaceReadDb::from_connection(
            rusqlite::Connection::open_in_memory().expect("placeholder"),
        )),
        Arc::new(TestMode),
    )
    .with_spaces(Arc::new(spaces));

    let secret = b"conformance-secret".to_vec();
    let issuer = TicketIssuer::new(secret.clone(), "gateway.test", ttl_secs);
    let verifier = TicketVerifier::new(secret, "gateway.test", Box::new(InMemoryNonces::new()));
    let state = Arc::new(GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(
            b"conformance-secret".to_vec(),
            "gateway.test",
            ttl_secs,
        )),
        Arc::new(verifier),
        GatewaySignals::new(64),
    ));

    let app = router(Arc::clone(&state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("local addr");
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    Gateway {
        url: format!("ws://{address}/xrpc/space.roomy.sync.subscribe"),
        state,
        issuer,
        shutdown,
        handle,
    }
}

impl Gateway {
    async fn connect(
        &self,
        ticket: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!("{}?ticket={ticket}", self.url);
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("the socket upgrades");
        socket
    }

    async fn stop(self) {
        let _ = self.shutdown.send(());
        let _ = self.handle.await;
    }
}

async fn next_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Option<Value> {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a frame arrives")
            .expect("the socket is open")
            .expect("the frame is valid");
        match message {
            Message::Text(text) => return Some(serde_json::from_str(&text).expect("json")),
            Message::Close(frame) => {
                return Some(serde_json::json!({
                    "close": frame.map(|frame| frame.code).map(u16::from),
                }))
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn a_ticket_opens_a_socket_and_a_subscription_hears_a_signal() {
    let gateway = start_gateway(60).await;
    let ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let mut socket = gateway.connect(&ticket).await;

    let ready = next_json(&mut socket).await.expect("ready");
    assert_eq!(ready["kind"], "ready");
    assert_eq!(ready["seq"], 1);

    socket
        .send(Message::Text(
            serde_json::json!({ "type": "subscribe", "topic": SPACE })
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let subscribed = next_json(&mut socket).await.expect("subscribed");
    assert_eq!(subscribed["kind"], "subscribed");
    assert_eq!(subscribed["seq"], 2);

    // A worker's signal reaches the subscriber as one `changed` frame.
    gateway.state.signals.publish(SpaceSignal {
        space: SpaceDid::parse(SPACE.to_string()).expect("space"),
        cursor: (7, 0),
        entries: 3,
    });
    let changed = next_json(&mut socket).await.expect("changed");
    assert_eq!(changed["kind"], "changed");
    assert_eq!(changed["seq"], 3);
    assert_eq!(changed["data"]["cursor"]["idx"], 7);

    drop(socket);
    gateway.stop().await;
}

#[tokio::test]
async fn subscribing_to_a_space_the_ticket_does_not_name_closes_the_socket() {
    let gateway = start_gateway(60).await;
    let ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let mut socket = gateway.connect(&ticket).await;
    let _ready = next_json(&mut socket).await.expect("ready");

    socket
        .send(Message::Text(
            serde_json::json!({ "type": "subscribe", "topic": OTHER })
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let closed = next_json(&mut socket).await.expect("a close frame");
    assert_eq!(closed["close"], 4403);
    gateway.stop().await;
}

#[tokio::test]
async fn a_reconnect_is_a_new_session_with_its_own_sequence() {
    let gateway = start_gateway(60).await;
    let first_ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let mut first = gateway.connect(&first_ticket).await;
    let _ready = next_json(&mut first).await.expect("ready");
    first
        .send(Message::Text(
            serde_json::json!({ "type": "subscribe", "topic": SPACE })
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let _subscribed = next_json(&mut first).await.expect("subscribed");
    drop(first);

    // A new ticket — a reconnecting client asks for one — and a new session:
    // the sequence restarts, and nothing is carried across.
    let second_ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let mut second = gateway.connect(&second_ticket).await;
    let ready = next_json(&mut second).await.expect("ready");
    assert_eq!(ready["seq"], 1);
    second
        .send(Message::Text(
            serde_json::json!({ "type": "subscribe", "topic": SPACE })
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let subscribed = next_json(&mut second).await.expect("subscribed");
    assert_eq!(subscribed["seq"], 2);
    assert_eq!(subscribed["data"]["cursor"]["idx"], 0);

    drop(second);
    gateway.stop().await;
}

#[tokio::test]
async fn a_backfill_answers_with_the_cursor_pair_to_read() {
    let gateway = start_gateway(60).await;
    let ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let mut socket = gateway.connect(&ticket).await;
    let _ready = next_json(&mut socket).await.expect("ready");
    socket
        .send(Message::Text(
            serde_json::json!({ "type": "subscribe", "topic": SPACE })
                .to_string()
                .into(),
        ))
        .await
        .expect("subscribe");
    let _subscribed = next_json(&mut socket).await.expect("subscribed");
    gateway.state.signals.publish(SpaceSignal {
        space: SpaceDid::parse(SPACE.to_string()).expect("space"),
        cursor: (12, 0),
        entries: 1,
    });
    let _changed = next_json(&mut socket).await.expect("changed");

    socket
        .send(Message::Text(
            serde_json::json!({
                "type": "backfill",
                "topic": SPACE,
                "from": { "idx": 5, "ord": 2 },
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("backfill");
    let backfill = next_json(&mut socket).await.expect("backfill frame");
    assert_eq!(backfill["kind"], "backfill");
    assert_eq!(backfill["data"]["from"]["idx"], 5);
    assert_eq!(backfill["data"]["to"]["idx"], 12);

    drop(socket);
    gateway.stop().await;
}

#[tokio::test]
async fn an_expired_ticket_never_reaches_the_socket() {
    let gateway = start_gateway(0).await;
    let ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let url = format!("{}?ticket={ticket}", gateway.url);
    let error = tokio_tungstenite::connect_async(url)
        .await
        .expect_err("the upgrade is refused");
    let status = match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => Some(response.status()),
        other => panic!("expected an HTTP refusal, got {other:?}"),
    };
    assert_eq!(status.map(|status| status.as_u16()), Some(401));
    gateway.stop().await;
}

#[tokio::test]
async fn a_ticket_is_not_replayable_onto_a_second_socket() {
    let gateway = start_gateway(60).await;
    let ticket = gateway
        .issuer
        .issue("did:plc:alice", vec![SPACE.to_string()])
        .expect("issued");
    let first = gateway.connect(&ticket).await;
    drop(first);

    let url = format!("{}?ticket={ticket}", gateway.url);
    let error = tokio_tungstenite::connect_async(url)
        .await
        .expect_err("the second upgrade is refused");
    assert!(matches!(
        error,
        tokio_tungstenite::tungstenite::Error::Http(_)
    ));
    gateway.stop().await;
}
