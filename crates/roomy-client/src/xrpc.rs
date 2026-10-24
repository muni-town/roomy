//! HTTP queries, `sendEvents`, and the sync socket.

use std::sync::Arc;

use base64::Engine as _;
use roomy_events::{Did, Event, EventBatch};
use serde::{Deserialize, Serialize};

use crate::auth::ServiceAuth;
use crate::error::ClientError;
use crate::transport::{
    call, call_empty, urlencode, HttpMethod, HttpRequest, HttpTransport, SyncSocket, Transport,
};
use crate::MAX_EVENTS_PER_BATCH;

/// A member as `space.roomy.space.getMembers` reports it.
#[derive(Debug, Clone, Deserialize)]
pub struct Member {
    pub did: String,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "isAdmin", default)]
    pub is_admin: bool,
    #[serde(rename = "isBanned", default)]
    pub is_banned: bool,
}

/// An admin who is not a member.
#[derive(Debug, Clone, Deserialize)]
pub struct ExternalAdmin {
    pub did: String,
}

/// The `getMembers` response.
#[derive(Debug, Clone, Deserialize)]
pub struct MembersResponse {
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(rename = "externalAdmins", default)]
    pub external_admins: Vec<ExternalAdmin>,
}

impl MembersResponse {
    /// Whether `did` is an admin of the space, by membership role or by
    /// external-admin grant.
    pub fn is_admin(&self, did: &str) -> bool {
        self.members
            .iter()
            .any(|member| member.did == did && member.is_admin)
            || self.external_admins.iter().any(|admin| admin.did == did)
    }
}

/// One event delivered over the sync socket.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncEvent {
    /// Position in the stream, used as the resume cursor.
    pub idx: i64,
    /// The DID of the sender.
    pub user: String,
    /// The event itself.
    pub payload: serde_json::Value,
}

impl SyncEvent {
    /// Decode the payload into a typed event, when this crate models it.
    pub fn event(&self) -> Result<Event, ClientError> {
        Event::from_json(self.payload.clone()).map_err(|error| ClientError::Decode {
            nsid: "sync.#streamEvents".into(),
            message: error.to_string(),
        })
    }
}

/// A subscribed stream: the socket plus its request envelope.
pub struct SyncSubscription {
    socket: Box<dyn SyncSocket>,
    stream_did: Did,
}

impl SyncSubscription {
    /// The next batch of events, or `None` when the socket closes.
    ///
    /// The sync protocol sends `#streamEvents` frames carrying `{ streamDid,
    /// cursor, hasMore, events }`. Every other frame type (`#messageDiff`,
    /// `#invalidate`, …) is a client-cache concern the bridge does not need, so
    /// it is skipped here rather than surfaced for every caller to ignore.
    pub async fn next_batch(&mut self) -> Option<Result<Vec<SyncEvent>, ClientError>> {
        loop {
            let frame = match self.socket.next_frame().await {
                Ok(Some(frame)) => frame,
                // A closed socket and a failed read both end the stream: the
                // caller reconnects either way.
                Ok(None) | Err(_) => return None,
            };

            // A frame is two concatenated CBOR values: a header object and a
            // body, with the header naming the frame type.
            match decode_frame(&frame) {
                Err(error) => return Some(Err(error)),
                Ok(None) => continue,
                Ok(Some(body)) => {
                    if body.stream_did != self.stream_did.as_str() {
                        continue;
                    }
                    return Some(Ok(body.events));
                }
            }
        }
    }

    /// Subscribe to another stream on the same connection.
    pub async fn subscribe(&mut self, stream_did: &Did, cursor: i64) -> Result<(), ClientError> {
        #[derive(Serialize)]
        struct Sub<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            topic: &'static str,
            id: &'a str,
            cursor: i64,
        }
        let payload = serde_json::to_vec(&Sub {
            kind: "sub",
            topic: "stream",
            id: stream_did.as_str(),
            cursor,
        })
        .expect("subscription serialises");
        let text = String::from_utf8(payload).expect("subscription is UTF-8");
        self.socket
            .send_text(text)
            .await
            .map_err(|error| ClientError::Sync(error.to_string()))
    }
}

/// The body of a `#streamEvents` frame.
#[derive(Debug, Deserialize)]
struct StreamEventsBody {
    #[serde(rename = "streamDid")]
    stream_did: String,
    #[serde(default)]
    events: Vec<SyncEvent>,
}

/// Decode one WebSocket frame.
///
/// Returns `None` for a frame type the bridge does not consume. `Some(Err)` is
/// a frame that claims to be `#streamEvents` and could not be read, which the
/// caller surfaces rather than silently skipping: a decode failure repeated on
/// every reconnect would otherwise look like an idle stream.
fn decode_frame(frame: &[u8]) -> Result<Option<StreamEventsBody>, ClientError> {
    let mut cursor = frame;
    let header: FrameHeader = ciborium::de::from_reader(&mut cursor)
        .map_err(|error| ClientError::Sync(format!("undecodable frame header: {error}")))?;
    if header.t.as_deref() != Some("#streamEvents") {
        return Ok(None);
    }

    // The body is CBOR, and CBOR carries byte strings natively. Roomy's event
    // types model the JSON encoding, where bytes are `{"$bytes": "<base64>"}`,
    // so the value is converted rather than handed to serde_json directly —
    // a message body is bytes, and every live event contains one.
    let value: ciborium::Value = ciborium::de::from_reader(&mut cursor)
        .map_err(|error| ClientError::Sync(format!("undecodable #streamEvents body: {error}")))?;
    let value = cbor_to_json(value)
        .map_err(|error| ClientError::Sync(format!("undecodable #streamEvents body: {error}")))?;
    let body: StreamEventsBody = serde_json::from_value(value)
        .map_err(|error| ClientError::Sync(format!("undecodable #streamEvents body: {error}")))?;
    Ok(Some(body))
}

/// Convert CBOR into the JSON data model the event types are written against.
///
/// Byte strings become Roomy's `{"$bytes": "<base64>"}` wrapper, tags are
/// dropped (this protocol assigns them no meaning), and a map key that is not
/// text is an error because it cannot be an object key.
fn cbor_to_json(value: ciborium::Value) -> Result<serde_json::Value, String> {
    use ciborium::Value as Cbor;
    use serde_json::Value as Json;

    Ok(match value {
        Cbor::Null => Json::Null,
        Cbor::Bool(flag) => Json::Bool(flag),
        Cbor::Integer(integer) => {
            let integer: i128 = integer.into();
            match i64::try_from(integer) {
                Ok(value) => Json::Number(value.into()),
                Err(_) => match u64::try_from(integer) {
                    Ok(value) => Json::Number(value.into()),
                    Err(_) => return Err(format!("integer {integer} does not fit in JSON")),
                },
            }
        }
        Cbor::Float(value) => serde_json::Number::from_f64(value)
            .map(Json::Number)
            .ok_or_else(|| format!("{value} is not a JSON number"))?,
        Cbor::Text(text) => Json::String(text),
        Cbor::Bytes(bytes) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            Json::Object(
                [("$bytes".to_string(), Json::String(encoded))]
                    .into_iter()
                    .collect(),
            )
        }
        Cbor::Array(items) => Json::Array(
            items
                .into_iter()
                .map(cbor_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Cbor::Map(entries) => {
            let mut object = serde_json::Map::with_capacity(entries.len());
            for (key, value) in entries {
                let Cbor::Text(key) = key else {
                    return Err("a map key is not text".to_string());
                };
                object.insert(key, cbor_to_json(value)?);
            }
            Json::Object(object)
        }
        // A tag names the semantics of the value it wraps; none of the tags in
        // this protocol change the shape a reader needs.
        Cbor::Tag(_, inner) => cbor_to_json(*inner)?,
        other => return Err(format!("unsupported CBOR value: {other:?}")),
    })
}

/// The parts of a sync frame header the bridge reads.
#[derive(Debug, Deserialize)]
struct FrameHeader {
    #[serde(default)]
    t: Option<String>,
}

/// A client for one appserver.
#[derive(Debug, Clone)]
pub struct AppserverClient {
    transport: Arc<dyn Transport>,
    base_url: String,
    did: Did,
    service_auth: Arc<ServiceAuth>,
    access_jwt: String,
    /// When set, requests identify the caller with `X-Test-Did` instead of a
    /// real service-auth JWT.
    ///
    /// This mirrors the appserver's `APPSERVER_TEST_MODE`, where that header is
    /// the whole of authentication. Without it a deployment cannot be exercised
    /// end to end: minting a token needs a PDS session, and a test stack has no
    /// PDS. It is opt-in through configuration and never inferred.
    test_did: Option<String>,
    /// The PDS that hosts the bridge account's blobs. `upload_blob` writes
    /// there, not to the appserver: an `atblob://<did>/<cid>` reference resolves
    /// against the author's PDS, so a blob stored anywhere else is unresolvable.
    pds_url: Option<String>,
}

impl AppserverClient {
    /// Build a client for `base_url` (e.g. `https://api.roomy.space`).
    pub fn new(
        base_url: impl Into<String>,
        did: Did,
        service_auth: Arc<ServiceAuth>,
        access_jwt: impl Into<String>,
    ) -> Self {
        Self::with_transport(
            base_url,
            did,
            service_auth,
            access_jwt,
            Arc::new(HttpTransport::new()),
        )
    }

    /// Call over `transport` instead of a live connection.
    pub fn with_transport(
        base_url: impl Into<String>,
        did: Did,
        service_auth: Arc<ServiceAuth>,
        access_jwt: impl Into<String>,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            transport,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            did,
            service_auth,
            access_jwt: access_jwt.into(),
            test_did: None,
            pds_url: None,
        }
    }

    /// Send blob uploads to `url` (the bridge account's PDS) instead of the
    /// appserver.
    pub fn with_pds_url(mut self, url: impl Into<String>) -> Self {
        self.pds_url = Some(url.into().trim_end_matches('/').to_string());
        self
    }

    /// The appserver DID, which is every token's `aud`.
    pub fn did(&self) -> &Did {
        &self.did
    }

    /// Address the appserver as `did` without a service-auth JWT.
    ///
    /// This is the counterpart of the appserver's `APPSERVER_TEST_MODE`. It is
    /// only meaningful against an appserver started in that mode, which is what
    /// the end-to-end stack runs; anywhere else the requests are refused.
    pub fn with_test_did(mut self, did: impl Into<String>) -> Self {
        self.test_did = Some(did.into());
        self
    }

    /// The identity header a request carries.
    ///
    /// In test mode the caller is named by `X-Test-Did`; otherwise the token is
    /// a bearer credential. Both cannot be sent at once, because a bearer token
    /// that is not a JWT is refused before the header is even read.
    fn auth_header(&self, token: String) -> (&'static str, String) {
        match &self.test_did {
            Some(_) => ("X-Test-Did", token),
            None => ("Authorization", format!("Bearer {token}")),
        }
    }

    /// The identity a request should present: a test DID when configured, or a
    /// minted service-auth token otherwise.
    async fn token_for(&self, method: &str) -> Result<String, ClientError> {
        match &self.test_did {
            Some(did) => Ok(did.clone()),
            None => {
                self.service_auth
                    .token(&self.access_jwt, self.did.as_str(), Some(method))
                    .await
            }
        }
    }

    /// Send a batch of events.
    ///
    /// Splits at the appserver's cap rather than rejecting: a caller that hands
    /// a backfill of 120 messages should get them all written, in order.
    pub async fn send_events(
        &self,
        space_did: &Did,
        events: Vec<Event>,
    ) -> Result<(), ClientError> {
        if events.len() > MAX_EVENTS_PER_BATCH {
            let batch = EventBatch::new(space_did.clone(), events);
            for chunk in batch.events.chunks(MAX_EVENTS_PER_BATCH) {
                let batch = EventBatch::new(space_did.clone(), chunk.to_vec());
                self.post_events(&batch).await?;
            }
            return Ok(());
        }
        self.post_events(&EventBatch::new(space_did.clone(), events))
            .await
    }

    async fn post_events(&self, batch: &EventBatch) -> Result<(), ClientError> {
        const NSID: &str = "space.roomy.space.sendEvents";
        let token = self.token_for(NSID).await?;
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Post,
            url: format!("{}/xrpc/{NSID}", self.base_url),
            headers: vec![
                self.auth_header(token),
                ("content-type", "application/json".to_string()),
            ],
            body: Some(serde_json::to_vec(&batch.to_json()).expect("an event batch serialises")),
        };
        call_empty(self.transport.as_ref(), request).await
    }

    /// Read one space's members, which is how the bridge answers "is this
    /// caller an admin".
    pub async fn get_members(&self, space_did: &Did) -> Result<MembersResponse, ClientError> {
        const NSID: &str = "space.roomy.space.getMembers";
        let token = self.token_for(NSID).await?;
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Get,
            url: format!(
                "{}/xrpc/{NSID}?spaceId={}",
                self.base_url,
                urlencode(space_did.as_str())
            ),
            headers: vec![self.auth_header(token)],
            body: None,
        };
        call(self.transport.as_ref(), request).await
    }

    /// Open the sync socket and subscribe to one stream.
    ///
    /// Authentication is a two-step: an authenticated HTTP call mints a
    /// single-use ticket, and the WebSocket carries it as a query parameter.
    /// The ticket is single-use and short-lived, so it is fetched per
    /// connection rather than cached.
    pub async fn subscribe_stream(
        &self,
        ws_url: &str,
        stream_did: &Did,
        cursor: i64,
    ) -> Result<SyncSubscription, ClientError> {
        let ticket = self.connection_ticket().await?;
        let url = format!(
            "{}/xrpc/space.roomy.sync.subscribe?ticket={}",
            ws_url.trim_end_matches('/'),
            urlencode(&ticket)
        );

        let socket = self
            .transport
            .connect(&url)
            .await
            .map_err(|error| ClientError::Sync(error.to_string()))?;

        let mut subscription = SyncSubscription {
            socket,
            stream_did: stream_did.clone(),
        };
        subscription.subscribe(stream_did, cursor).await?;
        Ok(subscription)
    }

    /// Mint a connection ticket for the sync socket.
    pub async fn connection_ticket(&self) -> Result<String, ClientError> {
        const NSID: &str = "space.roomy.auth.getConnectionTicket";
        let token = self.token_for(NSID).await?;
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Post,
            url: format!("{}/xrpc/{NSID}", self.base_url),
            headers: vec![
                self.auth_header(token),
                ("content-type", "application/json".to_string()),
            ],
            // A procedure, not a query: the appserver answers GET with 405.
            body: Some(b"{}".to_vec()),
        };

        #[derive(Deserialize)]
        struct Ticket {
            ticket: String,
        }
        call::<Ticket>(self.transport.as_ref(), request)
            .await
            .map(|ticket| ticket.ticket)
    }

    /// Upload bytes to the bridge account's PDS and return the `atblob://` ref
    /// a Roomy attachment uses.
    pub async fn upload_blob(
        &self,
        did: &Did,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<String, ClientError> {
        const NSID: &str = "com.atproto.repo.uploadBlob";
        let base = self.pds_url.as_deref().unwrap_or(&self.base_url);
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Post,
            url: format!("{base}/xrpc/{NSID}"),
            headers: vec![
                ("Authorization", format!("Bearer {}", self.access_jwt)),
                ("content-type", content_type.to_string()),
            ],
            body: Some(bytes),
        };

        #[derive(Deserialize)]
        struct BlobResponse {
            blob: BlobRef,
        }
        #[derive(Deserialize)]
        struct BlobRef {
            #[serde(rename = "ref")]
            reference: CidRef,
        }
        #[derive(Deserialize)]
        struct CidRef {
            #[serde(rename = "$link")]
            link: String,
        }

        let blob: BlobResponse = call(self.transport.as_ref(), request).await?;
        Ok(format!(
            "atblob://{}/{}",
            did.as_str(),
            blob.blob.reference.link
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn members() -> MembersResponse {
        serde_json::from_value(serde_json::json!({
            "members": [
                { "did": "did:plc:admin", "isAdmin": true, "isBanned": false },
                { "did": "did:plc:member", "isAdmin": false, "isBanned": false },
            ],
            "externalAdmins": [{ "did": "did:plc:external" }],
        }))
        .unwrap()
    }

    #[test]
    fn admins_are_members_with_the_admin_role_or_external_grants() {
        let members = members();
        assert!(members.is_admin("did:plc:admin"));
        assert!(members.is_admin("did:plc:external"));
        assert!(!members.is_admin("did:plc:member"));
        assert!(!members.is_admin("did:plc:stranger"));
    }

    #[test]
    fn a_stream_event_decodes_its_payload() {
        let event: SyncEvent = serde_json::from_value(serde_json::json!({
            "idx": 7,
            "user": "did:plc:alice",
            "payload": {
                "$type": "space.roomy.message.createMessage.v0",
                "id": "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
                "room": "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD",
                "body": { "mimeType": "text/markdown", "data": { "$bytes": "aGk=" } },
                "extensions": {}
            }
        }))
        .unwrap();
        let decoded = event.event().unwrap();
        assert_eq!(decoded.nsid(), "space.roomy.message.createMessage.v0");
    }

    /// A frame as the appserver writes it: two concatenated CBOR values whose
    /// payload carries a native byte string for the message body.
    fn stream_frame() -> Vec<u8> {
        use ciborium::Value as Cbor;

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

        let header = map(vec![
            ("op", Cbor::Integer(1.into())),
            ("t", text("#streamEvents")),
        ]);
        let payload = map(vec![
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
        ]);
        let event = map(vec![
            ("idx", Cbor::Integer(7.into())),
            ("user", text("did:plc:alice")),
            ("payload", payload),
        ]);
        let body = map(vec![
            ("streamDid", text("did:plc:space")),
            ("cursor", Cbor::Integer(7.into())),
            ("hasMore", Cbor::Bool(false)),
            ("events", Cbor::Array(vec![event])),
        ]);

        let mut frame = Vec::new();
        ciborium::ser::into_writer(&header, &mut frame).unwrap();
        ciborium::ser::into_writer(&body, &mut frame).unwrap();
        frame
    }

    #[test]
    fn a_cbor_frame_yields_events_whose_bodies_are_readable() {
        let body = decode_frame(&stream_frame())
            .expect("the frame decodes")
            .expect("it is a stream frame");
        assert_eq!(body.stream_did, "did:plc:space");
        assert_eq!(body.events.len(), 1);

        let event = body.events[0].event().expect("the payload is an event");
        assert_eq!(event.nsid(), "space.roomy.message.createMessage.v0");
        match &event.kind {
            roomy_events::EventKind::CreateMessage(message) => {
                assert_eq!(message.body.as_text(), Some("hello from Roomy"));
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn another_frame_type_is_skipped_rather_than_failed() {
        let mut frame = Vec::new();
        ciborium::ser::into_writer(&json!({ "op": 1, "t": "#invalidate" }), &mut frame).unwrap();
        ciborium::ser::into_writer(&json!({ "space": "did:plc:space" }), &mut frame).unwrap();
        assert!(decode_frame(&frame).expect("decodes").is_none());
    }
}
