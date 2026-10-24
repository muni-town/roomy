//! The homeserver's client API, as typed calls.
//!
//! One function per endpoint the bridge uses. Each builds its path, hands the
//! request to the transport and returns the type the caller wants back, so no
//! caller here builds a URL, attaches a token or reads a status.

use std::sync::Arc;

use bridge_core::BackfillCursor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{percent_encode, Body, Exchange, MediaDownload, Method, Transport, TransportError};
use crate::appservice::AsToken;

/// A client for the homeserver's client-server and appservice APIs.
#[derive(Debug, Clone)]
pub struct HomeserverClient {
    transport: Transport,
}

impl HomeserverClient {
    pub fn new(base_url: impl Into<String>, as_token: AsToken) -> Self {
        Self {
            transport: Transport::new(base_url, Some(as_token)),
        }
    }

    /// A client over an arbitrary exchange, which is how a fake homeserver
    /// takes the place of the network.
    pub fn with_exchange(
        base_url: impl Into<String>,
        as_token: AsToken,
        exchange: Arc<dyn Exchange>,
    ) -> Self {
        Self {
            transport: Transport::with_exchange(base_url, Some(as_token), exchange),
        }
    }

    /// The homeserver base URL.
    pub fn base_url(&self) -> &str {
        self.transport.base_url()
    }

    /// The exchange this client sends through, for another origin that should
    /// share its connections.
    pub fn exchange(&self) -> Arc<dyn Exchange> {
        self.transport.exchange()
    }

    /// Create `device_id` for `user_id` if it is not there.
    ///
    /// A crypto device's keys can only be uploaded for a device the homeserver
    /// has: without this, every key upload is refused with `M_UNKNOWN_DEVICE`
    /// and the bridge can neither decrypt nor share a room key.
    pub async fn ensure_device(
        &self,
        user_id: &str,
        device_id: &str,
        display_name: &str,
    ) -> Result<(), TransportError> {
        self.transport
            .put_json::<Value>(
                &format!(
                    "/_matrix/client/v3/devices/{}?user_id={}",
                    percent_encode(device_id),
                    percent_encode(user_id)
                ),
                &json!({ "display_name": display_name }),
            )
            .await
            .map(|_| ())
    }

    /// Remove a device, and with it the keys uploaded for it.
    pub async fn delete_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<(), TransportError> {
        self.transport
            .send(
                Method::Delete,
                &format!(
                    "/_matrix/client/v3/devices/{}?user_id={}",
                    percent_encode(device_id),
                    percent_encode(user_id)
                ),
                Body::None,
            )
            .await
            .map(|_| ())
    }

    /// Make `user_id` exist on the homeserver, and put it in `room_id`.
    ///
    /// An appservice may speak for its namespaced users, but only for users the
    /// homeserver already has: a send as an unregistered ghost is refused with
    /// "Application service has not registered this user". Registering through
    /// `m.login.application_service` is the one path that works when open
    /// registration is disabled, which is every real deployment.
    pub async fn ensure_ghost(&self, user_id: &str, room_id: &str) -> Result<(), TransportError> {
        let localpart = user_id
            .strip_prefix('@')
            .and_then(|rest| rest.split(':').next())
            .unwrap_or(user_id);

        self.register_ghost(localpart).await?;

        self.transport
            .post_json::<Value>(
                &format!(
                    "/_matrix/client/v3/rooms/{}/join?user_id={}",
                    percent_encode(room_id),
                    percent_encode(user_id)
                ),
                &json!({}),
            )
            .await
            .map(|_| ())
    }

    /// Register a namespaced user, treating "already registered" as success.
    pub async fn register_ghost(&self, localpart: &str) -> Result<(), TransportError> {
        let registered = self
            .transport
            .post_json::<Value>(
                "/_matrix/client/v3/register",
                &json!({
                    "type": "m.login.application_service",
                    "username": localpart,
                    // A homeserver with MSC4190 requires this: the ghost never
                    // logs in, it only exists to be an author.
                    "inhibit_login": true,
                }),
            )
            .await;

        match registered {
            Ok(_) => Ok(()),
            // `M_USER_IN_USE` is the already-registered case, which is success
            // here.
            Err(TransportError::Rejected { body, .. }) if body.contains("M_USER_IN_USE") => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Resolve a room alias to a room id.
    pub async fn resolve_alias(&self, alias: &str) -> Result<String, TransportError> {
        #[derive(Deserialize)]
        struct Resolved {
            #[serde(rename = "room_id")]
            room_id: String,
        }
        self.transport
            .get_json::<Resolved>(&format!(
                "/_matrix/client/v3/directory/room/{}",
                percent_encode(alias)
            ))
            .await
            .map(|resolved| resolved.room_id)
    }

    /// Read a room's `m.space.child` edges, which is what the hierarchy derives
    /// from.
    pub async fn space_children(
        &self,
        room_id: &str,
    ) -> Result<Vec<(String, SpaceChildContent)>, TransportError> {
        let state = self.room_state(room_id).await?;
        Ok(state
            .into_iter()
            .filter(|event| event.kind == "m.space.child")
            .filter_map(|event| {
                let content: SpaceChildContent =
                    serde_json::from_value(event.content.clone()).ok()?;
                // A child with no `via` cannot be joined, so it is not part of
                // the hierarchy — `via` is required by the spec for exactly
                // that reason.
                if content.via.is_empty() {
                    return None;
                }
                Some((event.state_key, content))
            })
            .collect())
    }

    /// Read the room's name and encryption state.
    pub async fn room_summary(&self, room_id: &str) -> Result<RoomSummary, TransportError> {
        let state = self.room_state(room_id).await?;

        let name = state
            .iter()
            .find(|event| event.kind == "m.room.name")
            .and_then(|event| event.content.get("name"))
            .and_then(|name| name.as_str())
            .map(str::to_string);

        let encryption_algorithm = state
            .iter()
            .find(|event| event.kind == "m.room.encryption")
            .and_then(|event| event.content.get("algorithm"))
            .and_then(|algorithm| algorithm.as_str())
            .map(str::to_string);

        let join_rule = state
            .iter()
            .find(|event| event.kind == "m.room.join_rules")
            .and_then(|event| event.content.get("join_rule"))
            .and_then(|rule| rule.as_str())
            .map(str::to_string);

        Ok(RoomSummary {
            room_id: room_id.to_string(),
            name,
            encrypted: encryption_algorithm.is_some(),
            encryption_algorithm,
            join_rule,
        })
    }

    async fn room_state(&self, room_id: &str) -> Result<Vec<StateEvent>, TransportError> {
        self.transport
            .get_json::<Vec<StateEvent>>(&format!(
                "/_matrix/client/v3/rooms/{}/state",
                percent_encode(room_id)
            ))
            .await
    }

    /// Join a room as a ghost user.
    ///
    /// Ghosts are real Matrix users under the registration's namespace, so this
    /// is an ordinary join made with the appservice's token — no password, no
    /// login dance.
    pub async fn join_as(&self, room_id: &str, mxid: &str) -> Result<(), TransportError> {
        self.transport
            .post_json::<Value>(
                &format!(
                    "/_matrix/client/v3/join/{}?user_id={}",
                    percent_encode(room_id),
                    percent_encode(mxid)
                ),
                &json!({}),
            )
            .await
            .map(|_| ())
    }

    /// Create a room, as the appservice's own user.
    pub async fn create_room(&self, request: &CreateRoomRequest) -> Result<String, TransportError> {
        self.create_room_as(
            None,
            &serde_json::to_value(request).expect("a createRoom body serialises"),
        )
        .await
    }

    /// Create a room on behalf of `user_id`, returning its id.
    ///
    /// Naming the user is what makes the room the ghost's rather than the
    /// bridge's.
    pub async fn create_room_as(
        &self,
        user_id: Option<&str>,
        body: &Value,
    ) -> Result<String, TransportError> {
        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "room_id")]
            room_id: String,
        }
        let path = match user_id {
            Some(user) => format!(
                "/_matrix/client/v3/createRoom?user_id={}",
                percent_encode(user)
            ),
            None => "/_matrix/client/v3/createRoom".to_string(),
        };
        self.transport
            .post_json::<Created>(&path, body)
            .await
            .map(|created| created.room_id)
    }

    /// Relay a typing notification for `user_id`.
    pub async fn typing(
        &self,
        room_id: &str,
        user_id: &str,
        typing: bool,
    ) -> Result<(), TransportError> {
        self.transport
            .put_json::<Value>(
                &format!(
                    "/_matrix/client/v3/rooms/{}/typing/{}?user_id={}",
                    percent_encode(room_id),
                    percent_encode(user_id),
                    percent_encode(user_id)
                ),
                &json!({ "typing": typing, "timeout": 20_000 }),
            )
            .await
            .map(|_| ())
    }

    /// Send one event into a room, optionally as a ghost user.
    ///
    /// `txn_id` makes the send idempotent: the homeserver deduplicates on
    /// `(user, txn_id)`, so a retried send does not post a duplicate message.
    pub async fn send_event(
        &self,
        room_id: &str,
        as_user: Option<&str>,
        event_type: &str,
        content: &Value,
        txn_id: &str,
    ) -> Result<String, TransportError> {
        let path = send_path(room_id, as_user, event_type, content, txn_id)?;

        #[derive(Deserialize)]
        struct Sent {
            #[serde(rename = "event_id")]
            event_id: String,
        }
        // Both endpoints are `PUT`: `POST /send/…` answers `M_UNRECOGNIZED`,
        // which is what an outbound message looked like before this was right.
        self.transport
            .put_json::<Sent>(&path, content)
            .await
            .map(|sent| sent.event_id)
    }

    /// Fetch a page of a room's history, newest first.
    ///
    /// `/messages` walks backwards from `from`, which is what a backfill wants:
    /// the recent window is the first page, and each subsequent page is older.
    /// Returns the page's events and the token for the next, older page — `None`
    /// when the start of the room has been reached.
    pub async fn backfill(
        &self,
        room_id: &str,
        from: Option<&BackfillCursor>,
        limit: u32,
    ) -> Result<(Vec<Value>, Option<BackfillCursor>), TransportError> {
        let mut path = format!(
            "/_matrix/client/v3/rooms/{}/messages?dir=b&limit={}",
            percent_encode(room_id),
            limit
        );
        match from {
            Some(token) => path.push_str(&format!("&from={}", percent_encode(token.as_str()))),
            // With no token the homeserver starts at the room's live edge,
            // which is the correct place for the first page of a recent window.
            None => path.push_str("&from="),
        }

        #[derive(Deserialize)]
        struct Page {
            #[serde(default)]
            chunk: Vec<Value>,
            #[serde(default)]
            end: Option<String>,
        }
        let page = self.transport.get_json::<Page>(&path).await?;

        // `/messages` answers in reverse-chronological order. Roomy's history
        // has to be written oldest-first or the backfilled messages land in the
        // wrong order within the batch.
        let mut events = page.chunk;
        events.reverse();
        // An unreadable token ends the walk: the next page cannot be addressed,
        // and pretending the history is complete would silently drop it.
        let next = page.end.as_deref().and_then(|end| {
            BackfillCursor::parse(end)
                .inspect_err(|_| tracing::warn!(token = %end, "unreadable backfill token"))
                .ok()
        });
        Ok((events, next))
    }

    /// Whether a room is encrypted, from its `m.room.encryption` state event.
    ///
    /// Read from the room's state rather than remembered at portal creation: a
    /// room can be turned on mid-life, and an admin-created portal is not the
    /// only writer of that event.
    pub async fn room_encrypted(&self, room_id: &str) -> Result<bool, TransportError> {
        let path = format!(
            "/_matrix/client/v3/rooms/{}/state/m.room.encryption",
            percent_encode(room_id)
        );
        match self.transport.get_json::<Value>(&path).await {
            Ok(state) => Ok(state
                .get("algorithm")
                .and_then(|algorithm| algorithm.as_str())
                .is_some()),
            // A room with no encryption state answers 404, which is "not
            // encrypted" rather than a failure to find out.
            Err(TransportError::Rejected { .. }) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// A room's joined members, which the crypto layer needs to share a key.
    pub async fn joined_members(&self, room_id: &str) -> Result<Vec<String>, TransportError> {
        #[derive(Deserialize)]
        struct Joined {
            #[serde(default)]
            joined: std::collections::BTreeMap<String, Value>,
        }
        self.transport
            .get_json::<Joined>(&format!(
                "/_matrix/client/v3/rooms/{}/joined_members",
                percent_encode(room_id)
            ))
            .await
            .map(|joined| joined.joined.into_keys().collect())
    }

    /// What the homeserver reports at `/versions`.
    pub async fn versions(&self) -> Result<Value, TransportError> {
        self.transport
            .get_json::<Value>("/_matrix/client/versions")
            .await
    }

    /// Download a Matrix media item.
    ///
    /// Authenticated media (MSC3916) is the only path a current Synapse serves;
    /// the unauthenticated v3 path answers 404.
    pub async fn download_media(
        &self,
        server: &str,
        media_id: &str,
    ) -> Result<MediaDownload, TransportError> {
        let response = self
            .transport
            .get(&format!(
                "/_matrix/client/v1/media/download/{}/{}?allow_redirects=true",
                percent_encode(server),
                percent_encode(media_id)
            ))
            .await?;
        Ok(MediaDownload {
            content_type: response.content_type,
            content_disposition: response.content_disposition,
            data: response.body,
        })
    }

    /// Upload bytes and return the `mxc://` URI the homeserver minted.
    pub async fn upload_media(
        &self,
        content_type: &str,
        data: &[u8],
    ) -> Result<String, TransportError> {
        #[derive(Deserialize)]
        struct Uploaded {
            #[serde(rename = "content_uri")]
            content_uri: String,
        }
        let response = self
            .transport
            .send(
                Method::Post,
                "/_matrix/media/v3/upload",
                Body::Bytes {
                    content_type: content_type.to_string(),
                    data: data.to_vec(),
                },
            )
            .await?;
        response
            .decode::<Uploaded>(|| format!("{}/_matrix/media/v3/upload", self.base_url()))
            .map(|uploaded| uploaded.content_uri)
    }

    /// Upload device, one-time and fallback keys.
    pub async fn upload_keys(
        &self,
        user_id: &str,
        device_id: &str,
        body: &Value,
    ) -> Result<ruma::api::client::keys::upload_keys::v3::Response, TransportError> {
        // `user_id` is not optional here: an appservice that names only a
        // device makes Synapse resolve the device for the wrong user and answer
        // 500. Naming both is the form the client API documents for appservice
        // device auth.
        self.transport
            .call_ruma(
                Method::Post,
                &format!(
                    "/_matrix/client/v3/keys/upload?user_id={}&device_id={}",
                    percent_encode(user_id),
                    percent_encode(device_id)
                ),
                body,
            )
            .await
    }

    /// Ask for the device keys of the users a room key must reach.
    pub async fn query_keys(
        &self,
        body: &Value,
    ) -> Result<ruma::api::client::keys::get_keys::v3::Response, TransportError> {
        self.transport
            .call_ruma(Method::Post, "/_matrix/client/v3/keys/query", body)
            .await
    }

    /// Claim one-time keys for the devices a session is being shared with.
    pub async fn claim_keys(
        &self,
        body: &Value,
    ) -> Result<ruma::api::client::keys::claim_keys::v3::Response, TransportError> {
        self.transport
            .call_ruma(Method::Post, "/_matrix/client/v3/keys/claim", body)
            .await
    }

    /// Send to-device messages — room keys travel this way.
    pub async fn send_to_device(
        &self,
        event_type: &str,
        txn_id: &str,
        messages: &Value,
    ) -> Result<ruma::api::client::to_device::send_event_to_device::v3::Response, TransportError>
    {
        self.transport
            .call_ruma(
                Method::Put,
                &format!(
                    "/_matrix/client/v3/sendToDevice/{}/{}",
                    percent_encode(event_type),
                    percent_encode(txn_id)
                ),
                &json!({ "messages": messages }),
            )
            .await
    }
}

/// The path a send goes to.
///
/// A redaction is its own endpoint: `PUT /rooms/{room}/redact/{event}`. Posting
/// it through `/send/m.room.redaction/` is refused with `M_UNRECOGNIZED`, so
/// routing it as an ordinary event type silently breaks every delete.
fn send_path(
    room_id: &str,
    as_user: Option<&str>,
    event_type: &str,
    content: &Value,
    txn_id: &str,
) -> Result<String, TransportError> {
    let mut path = match event_type {
        "m.room.redaction" => {
            let target = content
                .get("redacts")
                .and_then(|value| value.as_str())
                .ok_or_else(|| TransportError::Invalid {
                    url: format!("m.room.redaction for room {room_id}"),
                    reason: "a redaction names no event".to_string(),
                })?;
            format!(
                "/_matrix/client/v3/rooms/{}/redact/{}/{}",
                percent_encode(room_id),
                percent_encode(target),
                percent_encode(txn_id)
            )
        }
        event_type => format!(
            "/_matrix/client/v3/rooms/{}/send/{}/{}",
            percent_encode(room_id),
            percent_encode(event_type),
            percent_encode(txn_id)
        ),
    };
    if let Some(user) = as_user {
        path.push_str(&format!("?user_id={}", percent_encode(user)));
    }
    Ok(path)
}

/// A state event as `/state` returns it.
#[derive(Debug, Clone, Deserialize)]
struct StateEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "state_key", default)]
    state_key: String,
    #[serde(default)]
    content: Value,
}

/// `m.space.child` content.
#[derive(Debug, Clone, Deserialize)]
pub struct SpaceChildContent {
    /// Servers to try when joining.
    #[serde(default)]
    pub via: Vec<String>,
    /// Display order, when the sender set one.
    #[serde(default)]
    pub order: Option<String>,
    /// `true` marks the child as removed.
    #[serde(default)]
    pub deleted: Option<bool>,
}

/// A room's identity and policy, from its state events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    pub encrypted: bool,
    pub encryption_algorithm: Option<String>,
    pub join_rule: Option<String>,
}

/// The body of a `createRoom` call.
#[derive(Debug, Clone, Serialize)]
pub struct CreateRoomRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(rename = "preset", skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// When set, the room is created inside this space.
    #[serde(rename = "space_parent", skip_serializing_if = "Option::is_none")]
    pub space_parent: Option<String>,
    #[serde(default)]
    pub creation_content: Value,
    #[serde(default)]
    pub initial_state: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbound::MatrixSendError;
    use crate::transport::{fake_client, FakeHomeserver, FakeResponse};

    #[tokio::test]
    async fn a_refused_ghost_join_is_permanent() {
        // The ghost-join refusal a 4xx names: retrying sends the same join and
        // earns the same answer, so the outbox must report it rather than spend
        // its attempts on it.
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/register",
            FakeResponse::ok(json!({ "user_id": "@ghost:hs.test" })),
        );
        fake.route(
            Method::Post,
            "/join?user_id=",
            FakeResponse::refusing(403, "M_FORBIDDEN"),
        );

        let error = fake_client(&fake)
            .ensure_ghost("@ghost:hs.test", "!room:hs.test")
            .await
            .expect_err("a 403 refuses the join");

        assert_eq!(
            error.status(),
            Some(403),
            "the refusal carries the status the homeserver answered with"
        );
        assert!(
            MatrixSendError::from(error).is_permanent(),
            "a 4xx refusal cannot succeed on a retry"
        );
    }

    #[tokio::test]
    async fn a_ghost_join_the_homeserver_asked_to_retry_stays_transient() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/register",
            FakeResponse::ok(json!({ "user_id": "@ghost:hs.test" })),
        );
        fake.route(
            Method::Post,
            "/join?user_id=",
            FakeResponse::refusing(429, "M_LIMIT_EXCEEDED"),
        );

        let error = fake_client(&fake)
            .ensure_ghost("@ghost:hs.test", "!room:hs.test")
            .await
            .expect_err("a 429 defers the join");

        assert!(!MatrixSendError::from(error).is_permanent());
    }

    #[tokio::test]
    async fn an_unreachable_homeserver_is_transient() {
        // No route: the fake fails the exchange the way the network would.
        let fake = FakeHomeserver::new();
        let error = fake_client(&fake)
            .ensure_ghost("@ghost:hs.test", "!room:hs.test")
            .await
            .expect_err("nothing answers");

        assert_eq!(error.status(), None);
        assert!(!MatrixSendError::from(error).is_permanent());
    }

    #[tokio::test]
    async fn an_already_registered_ghost_still_joins() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/register",
            FakeResponse::refusing(400, "M_USER_IN_USE"),
        );
        fake.route(
            Method::Post,
            "/join?user_id=",
            FakeResponse::ok(json!({ "room_id": "!room:hs.test" })),
        );

        fake_client(&fake)
            .ensure_ghost("@ghost:hs.test", "!room:hs.test")
            .await
            .expect("a ghost that already exists is joined");

        assert_eq!(fake.requests().len(), 2);
    }

    #[test]
    fn a_redaction_targets_the_redact_endpoint() {
        // `/send/m.room.redaction/` answers M_UNRECOGNIZED, which is how every
        // delete was silently dropped before this was routed correctly.
        let path = send_path(
            "!room:example.org",
            None,
            "m.room.redaction",
            &json!({ "redacts": "$target" }),
            "txn",
        )
        .expect("the redaction names its target");
        assert_eq!(
            path, "/_matrix/client/v3/rooms/%21room%3Aexample.org/redact/%24target/txn",
            "a redaction goes to /redact/<event>, not /send/<type>"
        );
    }

    #[test]
    fn an_ordinary_message_targets_the_send_endpoint() {
        let path = send_path(
            "!room:example.org",
            Some("@alice:example.org"),
            "m.room.message",
            &json!({ "body": "hi" }),
            "txn",
        )
        .expect("a message needs no target");
        assert_eq!(
            path,
            "/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.message/txn\
             ?user_id=%40alice%3Aexample.org"
        );
    }

    #[test]
    fn a_redaction_without_a_target_is_refused_rather_than_sent() {
        let error = send_path(
            "!room:example.org",
            None,
            "m.room.redaction",
            &json!({}),
            "txn",
        )
        .expect_err("a redaction names its target");
        // Not a homeserver refusal: no status, and no retry that could work.
        assert_eq!(error.status(), None);
        assert!(error.is_permanent());
    }

    #[test]
    fn the_base_url_keeps_no_trailing_slash() {
        let client = HomeserverClient::new(
            "http://hs:8008/",
            crate::appservice::AsToken::parse("as").unwrap(),
        );
        assert_eq!(client.base_url(), "http://hs:8008");
    }
}
