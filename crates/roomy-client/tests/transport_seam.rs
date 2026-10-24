//! The transport seam, driven by a fake transport.
//!
//! Every call the client makes runs through [`Transport`], so this suite
//! exercises the HTTP methods, the ticket handshake and the sync socket
//! without a homeserver, an appserver, a PDS or a network.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;

use ciborium::Value as Cbor;
use roomy_client::{
    AppserverClient, BoxFuture, ClientError, HttpMethod, HttpRequest, HttpResponse, ServiceAuth,
    SessionCredentials, SyncSocket, Transport, TransportError, MAX_EVENTS_PER_BATCH,
};
use roomy_events::{Content, CreateMessage, Did, Event, EventKind, MessageExtensions, Ulid};
use serde_json::{json, Value};

const APPSERVER: &str = "https://api.roomy.space";
const APPSERVER_DID: &str = "did:web:api.roomy.space";
const PDS: &str = "https://pds.example";

const SEND_EVENTS: &str = "space.roomy.space.sendEvents";
const GET_MEMBERS: &str = "space.roomy.space.getMembers";
const CONNECTION_TICKET: &str = "space.roomy.auth.getConnectionTicket";
const UPLOAD_BLOB: &str = "com.atproto.repo.uploadBlob";
const GET_SERVICE_AUTH: &str = "com.atproto.server.getServiceAuth";
const CREATE_SESSION: &str = "com.atproto.server.createSession";

/// What the fake answers one call with.
enum Reply {
    /// A 200 carrying a JSON body.
    Json(Value),
    /// A status the client must reject.
    Status {
        status: u16,
        reason: &'static str,
        body: &'static str,
    },
    /// A call that never reaches a server.
    Fail(&'static str),
}

impl Reply {
    fn json(value: Value) -> Self {
        Reply::Json(value)
    }
}

/// A transport the test drives: it queues answers and records every request.
#[derive(Default)]
struct FakeTransport {
    replies: Mutex<HashMap<&'static str, VecDeque<Reply>>>,
    requests: Mutex<Vec<HttpRequest>>,
    connects: Mutex<Vec<String>>,
    sockets: Mutex<VecDeque<FakeSocket>>,
}

impl std::fmt::Debug for FakeTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FakeTransport")
    }
}

impl FakeTransport {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Queue the answer the next call to `nsid` gets.
    fn reply(&self, nsid: &'static str, reply: Reply) {
        self.replies
            .lock()
            .entry(nsid)
            .or_default()
            .push_back(reply);
    }

    /// Queue the socket the next connection gets.
    fn serve(&self, socket: FakeSocket) {
        self.sockets.lock().push_back(socket);
    }

    fn requests(&self) -> Vec<HttpRequest> {
        self.requests.lock().clone()
    }

    /// Every call made to `nsid`, in order.
    fn calls(&self, nsid: &str) -> Vec<HttpRequest> {
        self.requests()
            .into_iter()
            .filter(|request| request.nsid == nsid)
            .collect()
    }

    fn connects(&self) -> Vec<String> {
        self.connects.lock().clone()
    }
}

impl Transport for FakeTransport {
    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let reply = self
            .replies
            .lock()
            .get_mut(request.nsid)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| panic!("no reply queued for {}", request.nsid));
        self.requests.lock().push(request);

        Box::pin(async move {
            match reply {
                Reply::Json(value) => Ok(HttpResponse {
                    status: 200,
                    reason: Some("OK".to_string()),
                    body: serde_json::to_vec(&value).expect("a JSON reply serialises"),
                }),
                Reply::Status {
                    status,
                    reason,
                    body,
                } => Ok(HttpResponse {
                    status,
                    reason: Some(reason.to_string()),
                    body: body.as_bytes().to_vec(),
                }),
                Reply::Fail(message) => Err(TransportError::new(message)),
            }
        })
    }

    fn connect(&self, url: &str) -> BoxFuture<'_, Result<Box<dyn SyncSocket>, TransportError>> {
        self.connects.lock().push(url.to_string());
        let socket = self
            .sockets
            .lock()
            .pop_front()
            .unwrap_or_else(|| panic!("no socket queued for {url}"));
        Box::pin(async move { Ok(Box::new(socket) as Box<dyn SyncSocket>) })
    }
}

/// A socket the test feeds frame by frame, recording what the client sends.
struct FakeSocket {
    incoming: VecDeque<Result<Option<Vec<u8>>, &'static str>>,
    sent: Arc<Mutex<Vec<String>>>,
}

impl FakeSocket {
    fn new(
        frames: impl IntoIterator<Item = Result<Option<Vec<u8>>, &'static str>>,
    ) -> (Self, Arc<Mutex<Vec<String>>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                incoming: frames.into_iter().collect(),
                sent: Arc::clone(&sent),
            },
            sent,
        )
    }
}

impl SyncSocket for FakeSocket {
    fn next_frame(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let frame = self.incoming.pop_front().unwrap_or(Ok(None));
        Box::pin(async move {
            match frame {
                Ok(frame) => Ok(frame),
                Err(message) => Err(TransportError::new(message)),
            }
        })
    }

    fn send_text(&mut self, text: String) -> BoxFuture<'_, Result<(), TransportError>> {
        self.sent.lock().push(text);
        Box::pin(async { Ok(()) })
    }
}

fn did(value: &str) -> Did {
    Did::parse(value).expect("a valid DID")
}

fn space() -> Did {
    did("did:plc:space")
}

fn ulid(seed: u8) -> Ulid {
    Ulid::parse(format!("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0{seed:02}")).expect("a valid ULID")
}

fn message(seed: u8) -> Event {
    Event::in_room(
        ulid(seed),
        ulid(90),
        EventKind::CreateMessage(CreateMessage {
            body: Content::markdown("hello from the seam"),
            extensions: MessageExtensions::default(),
        }),
    )
}

fn client(fake: &Arc<FakeTransport>) -> AppserverClient {
    let transport: Arc<dyn Transport> = fake.clone();
    let service_auth = Arc::new(ServiceAuth::with_transport(PDS, Arc::clone(&transport)));
    AppserverClient::with_transport(
        APPSERVER,
        did(APPSERVER_DID),
        service_auth,
        "access-jwt",
        transport,
    )
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn body_json(request: &HttpRequest) -> Value {
    let body = request.body.as_ref().expect("a body");
    serde_json::from_slice(body).expect("a JSON body")
}

fn text(value: &str) -> Cbor {
    Cbor::Text(value.to_string())
}

fn map(entries: Vec<(&str, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(key, value)| (text(key), value))
            .collect(),
    )
}

/// A `#streamEvents` frame carrying one `createMessage`, as the appserver
/// writes it: two concatenated CBOR values, the body a native byte string.
fn stream_frame(stream_did: &str, idx: i64, payload: Cbor) -> Vec<u8> {
    let header = map(vec![
        ("op", Cbor::Integer(1.into())),
        ("t", text("#streamEvents")),
    ]);
    let event = map(vec![
        ("idx", Cbor::Integer(idx.into())),
        ("user", text("did:plc:alice")),
        ("payload", payload),
    ]);
    let body = map(vec![
        ("streamDid", text(stream_did)),
        ("cursor", Cbor::Integer(idx.into())),
        ("hasMore", Cbor::Bool(false)),
        ("events", Cbor::Array(vec![event])),
    ]);

    let mut frame = Vec::new();
    ciborium::ser::into_writer(&header, &mut frame).expect("the header encodes");
    ciborium::ser::into_writer(&body, &mut frame).expect("the body encodes");
    frame
}

fn message_payload() -> Cbor {
    map(vec![
        ("$type", text("space.roomy.message.createMessage.v0")),
        ("id", text("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB")),
        ("room", text("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD")),
        (
            "body",
            map(vec![
                ("mimeType", text("text/markdown")),
                ("data", Cbor::Bytes(b"hello from Roomy".to_vec())),
            ]),
        ),
        ("extensions", Cbor::Map(Vec::new())),
    ])
}

#[tokio::test]
async fn send_events_posts_the_batch_with_a_minted_token() {
    let fake = FakeTransport::new();
    fake.reply(
        GET_SERVICE_AUTH,
        Reply::json(json!({ "token": "minted-jwt" })),
    );
    fake.reply(SEND_EVENTS, Reply::json(json!({})));
    let client = client(&fake);

    client
        .send_events(&space(), vec![message(1)])
        .await
        .expect("the appserver accepts the batch");

    let requests = fake.requests();
    assert_eq!(requests.len(), 2, "one mint, one send");

    let mint = &requests[0];
    assert_eq!(mint.method, HttpMethod::Get);
    assert_eq!(header(mint, "Authorization"), Some("Bearer access-jwt"));
    let mint_url = mint.url.as_str();
    assert!(
        mint_url.starts_with(&format!(
            "{PDS}/xrpc/{GET_SERVICE_AUTH}?aud=did%3Aweb%3Aapi.roomy.space&exp="
        )),
        "the audience is the appserver DID, encoded: {mint_url}"
    );
    assert!(
        mint_url.contains(&format!("&lxm={SEND_EVENTS}")),
        "the token is scoped to the method: {mint_url}"
    );

    let send = &requests[1];
    assert_eq!(send.method, HttpMethod::Post);
    assert_eq!(send.url, format!("{APPSERVER}/xrpc/{SEND_EVENTS}"));
    assert_eq!(header(send, "Authorization"), Some("Bearer minted-jwt"));
    assert_eq!(header(send, "content-type"), Some("application/json"));

    let body = body_json(send);
    assert_eq!(body["spaceId"], "did:plc:space");
    let events = body["events"].as_array().expect("an event array");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["$type"], "space.roomy.message.createMessage.v0");
    assert_eq!(events[0]["id"], "01J9ZQ9W3N7Q4Z6ZC0W4Y4T001");
}

#[tokio::test]
async fn a_batch_over_the_cap_is_sent_in_capped_batches() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    for _ in 0..2 {
        fake.reply(SEND_EVENTS, Reply::json(json!({})));
    }
    let client = client(&fake);

    let events: Vec<Event> = (0..=MAX_EVENTS_PER_BATCH as u8).map(message).collect();
    assert_eq!(events.len(), MAX_EVENTS_PER_BATCH + 1);
    client
        .send_events(&space(), events)
        .await
        .expect("both batches land");

    let sends = fake.calls(SEND_EVENTS);
    assert_eq!(sends.len(), 2);
    assert_eq!(
        body_json(&sends[0])["events"].as_array().unwrap().len(),
        MAX_EVENTS_PER_BATCH
    );
    assert_eq!(body_json(&sends[1])["events"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn get_members_sends_a_get_with_an_encoded_space_id() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(
        GET_MEMBERS,
        Reply::json(json!({
            "members": [{ "did": "did:plc:admin", "isAdmin": true }],
            "externalAdmins": [{ "did": "did:plc:external" }],
        })),
    );
    let client = client(&fake);

    let members = client.get_members(&space()).await.expect("members arrive");

    let request = &fake.calls(GET_MEMBERS)[0];
    assert_eq!(request.method, HttpMethod::Get);
    assert_eq!(
        request.url,
        format!("{APPSERVER}/xrpc/{GET_MEMBERS}?spaceId=did%3Aplc%3Aspace")
    );
    assert_eq!(header(request, "Authorization"), Some("Bearer jwt"));
    assert!(members.is_admin("did:plc:admin"));
    assert!(members.is_admin("did:plc:external"));
    assert!(!members.is_admin("did:plc:member"));
}

#[tokio::test]
async fn a_rejected_call_is_an_xrpc_error_naming_the_status() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(
        GET_MEMBERS,
        Reply::Status {
            status: 429,
            reason: "Too Many Requests",
            body: "rate limited",
        },
    );
    let client = client(&fake);

    match client.get_members(&space()).await {
        Err(ClientError::Xrpc {
            nsid,
            error,
            message,
        }) => {
            assert_eq!(nsid, GET_MEMBERS);
            assert_eq!(error, "429 Too Many Requests");
            assert_eq!(message, "rate limited");
        }
        other => panic!("expected an Xrpc error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_body_of_the_wrong_shape_is_a_decode_error() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(GET_MEMBERS, Reply::json(json!({ "members": "not a list" })));
    let client = client(&fake);

    match client.get_members(&space()).await {
        Err(ClientError::Decode { nsid, .. }) => assert_eq!(nsid, GET_MEMBERS),
        other => panic!("expected a decode error, got {other:?}"),
    }
}

#[tokio::test]
async fn a_call_that_never_completes_names_the_method() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(GET_MEMBERS, Reply::Fail("connection refused"));
    let client = client(&fake);

    match client.get_members(&space()).await {
        Err(ClientError::Transport { method, source }) => {
            assert_eq!(method, GET_MEMBERS);
            assert_eq!(source.to_string(), "connection refused");
        }
        other => panic!("expected a transport error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_did_mode_names_the_caller_without_minting_a_token() {
    let fake = FakeTransport::new();
    fake.reply(GET_MEMBERS, Reply::json(json!({ "members": [] })));
    let client = client(&fake).with_test_did("did:plc:test-caller");

    client.get_members(&space()).await.expect("members arrive");

    let requests = fake.requests();
    assert_eq!(requests.len(), 1, "no token is minted in test mode");
    assert_eq!(
        header(&requests[0], "X-Test-Did"),
        Some("did:plc:test-caller")
    );
    assert_eq!(
        header(&requests[0], "Authorization"),
        None,
        "a test DID is not also sent as a bearer token"
    );
}

#[tokio::test]
async fn a_minted_token_is_reused_across_calls() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    for _ in 0..2 {
        fake.reply(GET_MEMBERS, Reply::json(json!({ "members": [] })));
    }
    let client = client(&fake);

    client.get_members(&space()).await.expect("first call");
    client.get_members(&space()).await.expect("second call");

    assert_eq!(fake.calls(GET_SERVICE_AUTH).len(), 1, "the token is cached");
    assert_eq!(fake.calls(GET_MEMBERS).len(), 2);
}

#[tokio::test]
async fn create_session_posts_the_credentials_to_the_pds() {
    let fake = FakeTransport::new();
    fake.reply(
        CREATE_SESSION,
        Reply::json(json!({
            "accessJwt": "access",
            "refreshJwt": "refresh",
            "did": "did:plc:bridge",
            "handle": "bridge.example",
        })),
    );
    let transport: Arc<dyn Transport> = Arc::clone(&fake) as Arc<dyn Transport>;
    let auth = ServiceAuth::with_transport(PDS, transport);

    let session = auth
        .create_session(&SessionCredentials {
            identifier: "bridge.example".to_string(),
            app_password: "hunter2".to_string(),
        })
        .await
        .expect("the PDS accepts the login");

    let request = &fake.calls(CREATE_SESSION)[0];
    assert_eq!(request.method, HttpMethod::Post);
    assert_eq!(request.url, format!("{PDS}/xrpc/{CREATE_SESSION}"));
    assert_eq!(header(request, "content-type"), Some("application/json"));
    let body = body_json(request);
    assert_eq!(body["identifier"], "bridge.example");
    assert_eq!(body["password"], "hunter2");

    assert_eq!(session.did, "did:plc:bridge");
    assert_eq!(session.access_jwt, "access");
    assert_eq!(session.handle.as_deref(), Some("bridge.example"));
}

#[tokio::test]
async fn a_rejected_mint_is_a_service_auth_error() {
    let fake = FakeTransport::new();
    fake.reply(
        GET_SERVICE_AUTH,
        Reply::Status {
            status: 401,
            reason: "Unauthorized",
            body: "expired session",
        },
    );
    let client = client(&fake);

    match client.get_members(&space()).await {
        Err(ClientError::ServiceAuth { aud, reason }) => {
            assert_eq!(aud, APPSERVER_DID);
            assert_eq!(reason, "PDS answered 401 Unauthorized: expired session");
        }
        other => panic!("expected a service-auth error, got {other:?}"),
    }
}

#[tokio::test]
async fn upload_blob_posts_the_bytes_to_the_pds() {
    let fake = FakeTransport::new();
    fake.reply(
        UPLOAD_BLOB,
        Reply::json(json!({ "blob": { "ref": { "$link": "bafyblob" } } })),
    );
    let client = client(&fake).with_pds_url(PDS);

    let reference = client
        .upload_blob(&did("did:plc:alice"), b"pixels".to_vec(), "image/png")
        .await
        .expect("the PDS stores the blob");

    let request = &fake.calls(UPLOAD_BLOB)[0];
    assert_eq!(request.method, HttpMethod::Post);
    assert_eq!(request.url, format!("{PDS}/xrpc/{UPLOAD_BLOB}"));
    assert_eq!(header(request, "Authorization"), Some("Bearer access-jwt"));
    assert_eq!(header(request, "content-type"), Some("image/png"));
    assert_eq!(request.body.as_deref(), Some(&b"pixels"[..]));
    assert_eq!(reference, "atblob://did:plc:alice/bafyblob");
}

#[tokio::test]
async fn the_ticket_flow_opens_the_socket_and_subscribes() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(
        CONNECTION_TICKET,
        Reply::json(json!({ "ticket": "tk/1 2" })),
    );
    let (socket, sent) = FakeSocket::new([Ok(Some(stream_frame(
        "did:plc:space",
        7,
        message_payload(),
    )))]);
    fake.serve(socket);
    let client = client(&fake);

    let mut subscription = client
        .subscribe_stream("ws://api.roomy.space/", &space(), 42)
        .await
        .expect("the socket opens");

    let ticket_call = &fake.calls(CONNECTION_TICKET)[0];
    assert_eq!(ticket_call.method, HttpMethod::Post);
    assert_eq!(
        ticket_call.url,
        format!("{APPSERVER}/xrpc/{CONNECTION_TICKET}")
    );

    assert_eq!(
        fake.connects(),
        vec!["ws://api.roomy.space/xrpc/space.roomy.sync.subscribe?ticket=tk%2F1%202".to_string()],
        "the single-use ticket travels encoded in the query"
    );

    let subscribed: Value = serde_json::from_str(&sent.lock()[0]).expect("a JSON frame");
    assert_eq!(
        subscribed,
        json!({ "type": "sub", "topic": "stream", "id": "did:plc:space", "cursor": 42 })
    );

    let batch = subscription
        .next_batch()
        .await
        .expect("a batch arrives")
        .expect("the frame decodes");
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].idx, 7);
    assert_eq!(batch[0].user, "did:plc:alice");
    let event = batch[0].event().expect("the payload is an event");
    assert_eq!(event.nsid(), "space.roomy.message.createMessage.v0");
    match &event.kind {
        EventKind::CreateMessage(message) => {
            assert_eq!(message.body.as_text(), Some("hello from Roomy"));
        }
        other => panic!("expected a message, got {other:?}"),
    }
}

#[tokio::test]
async fn the_stream_loop_skips_frames_it_does_not_consume() {
    let fake = FakeTransport::new();
    fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
    fake.reply(CONNECTION_TICKET, Reply::json(json!({ "ticket": "tk" })));

    let mut invalidate = Vec::new();
    ciborium::ser::into_writer(&json!({ "op": 1, "t": "#invalidate" }), &mut invalidate)
        .expect("the header encodes");
    ciborium::ser::into_writer(&json!({ "space": "did:plc:space" }), &mut invalidate)
        .expect("the body encodes");

    let (socket, _sent) = FakeSocket::new([
        Ok(Some(invalidate)),
        Ok(Some(stream_frame("did:plc:another", 3, message_payload()))),
        Ok(Some(stream_frame("did:plc:space", 9, message_payload()))),
    ]);
    fake.serve(socket);
    let client = client(&fake);

    let mut subscription = client
        .subscribe_stream("ws://api.roomy.space", &space(), 0)
        .await
        .expect("the socket opens");

    let batch = subscription
        .next_batch()
        .await
        .expect("a batch arrives")
        .expect("the frame decodes");
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].idx, 9, "only this stream's frame is surfaced");
}

#[tokio::test]
async fn a_socket_that_closes_or_fails_ends_the_stream() {
    for end in [Ok(None), Err("the connection dropped")] {
        let fake = FakeTransport::new();
        fake.reply(GET_SERVICE_AUTH, Reply::json(json!({ "token": "jwt" })));
        fake.reply(CONNECTION_TICKET, Reply::json(json!({ "ticket": "tk" })));
        let (socket, _sent) = FakeSocket::new([end]);
        fake.serve(socket);
        let client = client(&fake);

        let mut subscription = client
            .subscribe_stream("ws://api.roomy.space", &space(), 0)
            .await
            .expect("the socket opens");

        assert!(
            subscription.next_batch().await.is_none(),
            "a closed or failed socket ends the stream so the caller reconnects"
        );
    }
}
