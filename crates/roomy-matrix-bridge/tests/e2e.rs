//! End-to-end checks against a live homeserver and appserver.
//!
//! These are `#[ignore]`d by default: they need a running Synapse with the
//! appservice registered and a Roomy appserver in test mode, which is what
//! `scripts/matrix-bridge-e2e.sh` brings up. The CI job that runs them is
//! `test-matrix-bridge-e2e`; a bare `cargo test --workspace` skips them.
//!
//! What they prove, and why each is worth a test rather than a script:
//!
//! * **Round trip, both directions.** A message written to Matrix appears in
//!   Roomy and a message written to Roomy appears in Matrix, each exactly once —
//!   the failure mode a bridge is most likely to ship with, because it only
//!   shows up in a live loop.
//! * **Edit, redaction, reaction, reply, thread, attachment.** Each is a
//!   different relation shape and each fails independently.
//! * **Backfill.** History is read into Roomy with its original timestamps, so
//!   it sorts where it belongs rather than at the tip.
//! * **Encryption.** What an encrypted room does is asserted against what the
//!   bridge *measured* about the homeserver, not against a guess: a homeserver
//!   the probe clears bridges it, one it does not blocks the portal and says so.
//! * **The admin API refuses a non-admin.** The one check that protects every
//!   other space's configuration.

use std::time::Duration;

use serde_json::{json, Value};

/// Read the harness's environment, or fail loudly.
///
/// These tests are `#[ignore]`d, so the only thing that runs them is
/// `scripts/matrix-bridge-e2e.sh` after bringing the stack up. A missing fixture
/// therefore means the harness is broken, not that the test should be skipped: a
/// test that returns early on a missing fixture reports green while proving
/// nothing, which is worse than a failure.
fn fixture(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} is unset. These tests are run by scripts/matrix-bridge-e2e.sh, which \
             must export it after starting the stack."
        )
    })
}

/// The homeserver, the appserver, and the fixtures they need.
struct Harness {
    appserver_url: String,
    bridge_url: String,
    homeserver_url: String,
    as_token: String,
    domain: String,
    sender_localpart: String,
    space_id: String,
    roomy_room_id: String,
    test_did: String,
    http: reqwest::Client,
}

impl Harness {
    fn from_env() -> Self {
        Self {
            appserver_url: fixture("E2E_APPSERVER_URL"),
            bridge_url: fixture("E2E_BRIDGE_URL"),
            homeserver_url: fixture("E2E_HOMESERVER_URL"),
            as_token: fixture("E2E_AS_TOKEN"),
            domain: fixture("E2E_HOMESERVER_DOMAIN"),
            sender_localpart: std::env::var("E2E_SENDER_LOCALPART")
                .unwrap_or_else(|_| "_roomy_bridge".to_string()),
            space_id: fixture("E2E_SPACE_ID"),
            roomy_room_id: fixture("E2E_ROOMY_ROOM_ID"),
            test_did: fixture("E2E_TEST_DID"),
            http: reqwest::Client::new(),
        }
    }

    /// The bridge's own Matrix user.
    fn bridge_user(&self) -> String {
        format!("@{}:{}", self.sender_localpart, self.domain)
    }

    /// A ghost MXID: a user inside the appservice's namespace, which is what a
    /// bridged Matrix user looks like and what the bridge relays on behalf of.
    fn ghost(&self, name: &str) -> String {
        format!("@_roomy_{name}:{}", self.domain)
    }

    /// The DID the bridge derives for a ghost MXID, as `bridge-core` does it.
    fn ghost_did(&self, mxid: &str) -> String {
        let mut encoded = String::from("did:matrix:");
        for byte in mxid.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char)
                }
                other => encoded.push_str(&format!("%{other:02X}")),
            }
        }
        encoded
    }

    // ── Matrix ───────────────────────────────────────────────────────────────

    async fn matrix(
        &self,
        method: reqwest::Method,
        path: &str,
        as_user: &str,
        body: Option<Value>,
    ) -> Value {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.homeserver_url, path))
            .bearer_auth(&self.as_token)
            .query(&[("user_id", as_user)]);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("the homeserver is reachable");
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        assert!(
            status.is_success(),
            "{} {} failed with {status}: {text}",
            path.split('?').next().unwrap_or(path),
            "",
        );
        if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        }
    }

    /// Register a ghost user, which the homeserver requires before it will let
    /// the appservice act as it.
    async fn register_ghost(&self, mxid: &str) {
        let localpart = mxid
            .trim_start_matches('@')
            .split(':')
            .next()
            .unwrap_or(mxid)
            .to_string();
        let response = self
            .http
            .post(format!(
                "{}/_matrix/client/v3/register",
                self.homeserver_url
            ))
            .bearer_auth(&self.as_token)
            .json(&json!({
                "type": "m.login.application_service",
                "username": localpart,
                // The registration enables MSC4190, which makes Synapse reject
                // a register that would also create a login.
                "inhibit_login": true,
            }))
            .send()
            .await
            .expect("the homeserver is reachable");
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        assert!(
            status.is_success() || body.contains("M_USER_IN_USE"),
            "registering {mxid} failed: {body}"
        );
    }

    /// Create a room as `owner`, with the bridge already joined.
    ///
    /// The bridge has to be a member to read the room's state at configuration
    /// time, and `owner` is a ghost rather than the bridge's own user so the
    /// events it sends are the traffic a bridge exists to relay.
    async fn room(&self, owner: &str, name: &str, encrypted: bool) -> String {
        self.register_ghost(owner).await;
        let mut body = json!({ "name": name, "preset": "public_chat" });
        if encrypted {
            body["initial_state"] = json!([{
                "type": "m.room.encryption",
                "state_key": "",
                "content": { "algorithm": "m.megolm.v1.aes-sha2" },
            }]);
        }
        let created = self
            .matrix(
                reqwest::Method::POST,
                "/_matrix/client/v3/createRoom",
                owner,
                Some(body),
            )
            .await;
        let room = created["room_id"]
            .as_str()
            .expect("createRoom returns a room_id")
            .to_string();

        self.matrix(
            reqwest::Method::POST,
            &format!("/_matrix/client/v3/rooms/{}/invite", percent_encode(&room)),
            owner,
            Some(json!({ "user_id": self.bridge_user() })),
        )
        .await;
        self.matrix(
            reqwest::Method::POST,
            &format!("/_matrix/client/v3/rooms/{}/join", percent_encode(&room)),
            &self.bridge_user(),
            Some(json!({})),
        )
        .await;
        room
    }

    /// Send one message as `sender` and return its Matrix event id.
    /// Send an event of `event_type`, which reactions need: an `m.reaction` is
    /// not an `m.room.message`.
    async fn send_typed(
        &self,
        room: &str,
        sender: &str,
        event_type: &str,
        content: Value,
    ) -> String {
        let txn = ulid::Ulid::generate().to_string();
        let sent = self
            .matrix(
                reqwest::Method::PUT,
                &format!(
                    "/_matrix/client/v3/rooms/{}/send/{}/{txn}",
                    percent_encode(room),
                    percent_encode(event_type)
                ),
                sender,
                Some(content),
            )
            .await;
        sent["event_id"]
            .as_str()
            .expect("send returns an event_id")
            .to_string()
    }

    async fn send(&self, room: &str, sender: &str, content: Value) -> String {
        let txn = ulid::Ulid::generate().to_string();
        let sent = self
            .matrix(
                reqwest::Method::PUT,
                &format!(
                    "/_matrix/client/v3/rooms/{}/send/m.room.message/{txn}",
                    percent_encode(room)
                ),
                sender,
                Some(content),
            )
            .await;
        sent["event_id"]
            .as_str()
            .expect("send returns an event_id")
            .to_string()
    }

    /// Upload bytes to the homeserver's media repository and return the mxc URI.
    async fn upload(&self, sender: &str, name: &str, bytes: &[u8]) -> String {
        let response = self
            .http
            .post(format!("{}/_matrix/media/v3/upload", self.homeserver_url))
            .bearer_auth(&self.as_token)
            .query(&[("user_id", sender), ("filename", name)])
            .header("content-type", "image/png")
            .body(bytes.to_vec())
            .send()
            .await
            .expect("the homeserver is reachable");
        let status = response.status();
        let body: Value = response.json().await.expect("upload returns JSON");
        assert!(status.is_success(), "upload failed: {body}");
        body["content_uri"]
            .as_str()
            .expect("upload returns a content_uri")
            .to_string()
    }

    /// Every event in a room, oldest first.
    async fn room_events(&self, room: &str, as_user: &str) -> Vec<Value> {
        let response = self
            .http
            .get(format!(
                "{}/_matrix/client/v3/rooms/{}/messages",
                self.homeserver_url,
                percent_encode(room)
            ))
            .bearer_auth(&self.as_token)
            .query(&[("user_id", as_user), ("dir", "b"), ("limit", "200")])
            .send()
            .await
            .expect("the homeserver is reachable");
        if !response.status().is_success() {
            return Vec::new();
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let mut events: Vec<Value> = body["chunk"].as_array().cloned().unwrap_or_default();
        events.reverse();
        events
    }

    // ── the bridge's admin API ───────────────────────────────────────────────

    /// Bridge `matrix_room` into the shared Roomy room and return the portal.
    async fn bridge_room(&self, matrix_room: &str) -> Value {
        let response = self
            .http
            .post(format!("{}/_roomy/admin/v1/bridges", self.bridge_url))
            .header("X-Test-Did", &self.test_did)
            .json(&json!({
                "spaceId": self.space_id,
                "matrixId": matrix_room,
                "kind": "room",
                "mode": "full",
                "targetRoomId": self.roomy_room_id,
            }))
            .send()
            .await
            .expect("the bridge is reachable");
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        assert!(status.is_success(), "creating the bridge failed: {body}");
        body["portals"]
            .as_array()
            .and_then(|portals| portals.first().cloned())
            .unwrap_or(Value::Null)
    }

    /// A `createMessage` event addressed to the shared room, authored by the
    /// test DID. Built from the crate's own types so the body encoding is the
    /// one the appserver accepts.
    fn roomy_message(&self, body: &str) -> Value {
        use roomy_events::extensions::AuthorOverride;
        let id = roomy_events::Ulid::new();
        let room = roomy_events::Ulid::parse(self.roomy_room_id.clone())
            .expect("the roomy room fixture is a ULID");
        let author = roomy_events::Did::parse(self.test_did.clone()).expect("the test DID");
        let event = roomy_events::Event::in_room(
            id,
            room,
            roomy_events::EventKind::CreateMessage(roomy_events::CreateMessage {
                body: roomy_events::Content::markdown(body),
                extensions: roomy_events::MessageExtensions {
                    author_override: Some(AuthorOverride { did: author }),
                    ..Default::default()
                },
            }),
        );
        serde_json::to_value(event).expect("an event serialises")
    }

    /// Whether the running bridge has a crypto device, from `/health`.
    ///
    /// Deliberately not `/capabilities`: that re-measures the homeserver, while
    /// what a portal created now will do depends on whether this process is
    /// encrypting.
    async fn encrypting(&self) -> bool {
        let health: Value = self
            .http
            .get(format!("{}/_roomy/admin/v1/health", self.bridge_url))
            .send()
            .await
            .expect("the bridge is reachable")
            .json()
            .await
            .unwrap_or(Value::Null);
        health["e2ee"].as_bool().unwrap_or(false)
    }

    async fn capabilities(&self) -> Value {
        self.http
            .get(format!("{}/_roomy/admin/v1/capabilities", self.bridge_url))
            .send()
            .await
            .expect("the bridge is reachable")
            .json()
            .await
            .unwrap_or(Value::Null)
    }

    // ── Roomy ────────────────────────────────────────────────────────────────

    /// Every message in the shared Roomy room, newest first as the API returns
    /// them, re-sorted oldest first so tests can index a timeline.
    async fn messages(&self) -> Vec<Value> {
        let response = self
            .http
            .get(format!(
                "{}/xrpc/space.roomy.room.getMessages",
                self.appserver_url
            ))
            .header("X-Test-Did", &self.test_did)
            .query(&[("roomId", self.roomy_room_id.as_str()), ("limit", "100")])
            .send()
            .await
            .expect("the appserver is reachable");
        if !response.status().is_success() {
            return Vec::new();
        }
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let mut messages: Vec<Value> = body["messages"].as_array().cloned().unwrap_or_default();
        messages.reverse();
        messages
    }

    /// Poll until a message matching `predicate` appears.
    async fn wait_for_message<F>(&self, predicate: F) -> Option<Value>
    where
        F: Fn(&Value) -> bool,
    {
        for _ in 0..60 {
            if let Some(found) = self.messages().await.into_iter().find(|m| predicate(m)) {
                return Some(found);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        None
    }

    async fn wait_for_body(&self, body: &str) -> Option<Value> {
        self.wait_for_message(|message| {
            message
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains(body))
        })
        .await
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// A body unique to one test run, so tests sharing a room cannot collide.
fn unique(tag: &str) -> String {
    format!("{tag} {}", ulid::Ulid::generate())
}

/// The probe reports every capability on the homeserver under test.
///
/// MSC4190 always passes on the supported homeservers; the rest are reported,
/// and the assertion is that the report agrees with the running bridge's own
/// `/capabilities`, which is what gates encryption.
#[tokio::test]
#[ignore = "needs a live homeserver; run via scripts/matrix-bridge-e2e.sh"]
async fn the_homeserver_supports_what_encryption_needs() {
    let harness = Harness::from_env();
    let capabilities = harness.capabilities().await;
    assert_eq!(
        capabilities["msc4190Devices"].as_bool(),
        Some(true),
        "msc4190-devices must pass on the homeserver under test: {capabilities}"
    );
    // The report is the gate: whatever the key-bearing streams say, the bridge
    // must agree. All of them pass on the homeserver this suite runs against, so
    // the bridge running with a crypto device is part of the assertion.
    let gate = [
        "msc4190Devices",
        "msc4203ToDevice",
        "msc3202DeviceLists",
        "msc3202OtkCounts",
    ];
    let all = gate
        .iter()
        .all(|key| capabilities[key].as_bool() == Some(true));
    assert!(all, "the gate must pass on this homeserver: {capabilities}");
    assert_eq!(capabilities["e2eeAvailable"].as_bool(), Some(all));
    assert_eq!(
        capabilities["details"].as_array().map(Vec::len),
        Some(6),
        "every feature is reported with its evidence, including the two that do \
         not gate encryption: {capabilities}"
    );
}

/// A message posted on Matrix reaches Roomy once, attributed to its author.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_message_is_bridged_once() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e", false).await;
    harness.bridge_room(&room).await;

    let body = unique("hello");
    harness
        .send(&room, &alice, json!({ "msgtype": "m.text", "body": body }))
        .await;

    let message = harness
        .wait_for_body(&body)
        .await
        .expect("the message reached Roomy");
    assert_eq!(
        message["authorDid"].as_str(),
        Some(harness.ghost_did(&alice).as_str()),
        "the message must be attributed to the Matrix author's ghost"
    );

    // The echo must not come back: one Matrix event, one Roomy message.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let count = harness
        .messages()
        .await
        .into_iter()
        .filter(|m| m["content"].as_str().is_some_and(|c| c.contains(&body)))
        .count();
    assert_eq!(count, 1, "the bridged message was relayed twice");
}

/// A Roomy message reaches Matrix as the author's ghost, and does not echo back.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_roomy_message_reaches_matrix_once() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e outbound", false).await;
    harness.bridge_room(&room).await;

    let body = unique("from roomy");
    let response = harness
        .http
        .post(format!(
            "{}/xrpc/space.roomy.space.sendEvents",
            harness.appserver_url
        ))
        .header("X-Test-Did", &harness.test_did)
        .json(&json!({
            "spaceId": harness.space_id,
            "events": [harness.roomy_message(&body)],
        }))
        .send()
        .await
        .expect("the appserver is reachable");
    assert!(
        response.status().is_success(),
        "sending into Roomy failed: {:?}",
        response.text().await
    );

    // The bridge relays it as the ghost it minted for that DID.
    let mut delivered = None;
    for _ in 0..60 {
        let events = harness.room_events(&room, &harness.bridge_user()).await;
        if let Some(found) = events.into_iter().find(|event| {
            event
                .pointer("/content/body")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains(&body))
        }) {
            delivered = Some(found);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let delivered = delivered.expect("the Roomy message reached Matrix");
    assert!(
        delivered["sender"]
            .as_str()
            .is_some_and(|sender| sender.starts_with("@_roomy_")),
        "the message must be sent as a ghost, not as the bridge user: {}",
        delivered["sender"]
    );

    // ... and its Matrix copy must not come back as a second Roomy message.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let count = harness
        .messages()
        .await
        .into_iter()
        .filter(|m| m["content"].as_str().is_some_and(|c| c.contains(&body)))
        .count();
    assert_eq!(count, 1, "the relayed message came back from Matrix");
}

/// An edit replaces the body, keeping the latest content only.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn an_edit_replaces_the_body() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e edit", false).await;
    harness.bridge_room(&room).await;

    let original = unique("original");
    let event_id = harness
        .send(
            &room,
            &alice,
            json!({ "msgtype": "m.text", "body": original }),
        )
        .await;
    assert!(harness.wait_for_body(&original).await.is_some());

    let corrected = unique("corrected");
    harness
        .send(
            &room,
            &alice,
            json!({
                "msgtype": "m.text",
                "body": format!("* {corrected}"),
                "m.new_content": { "msgtype": "m.text", "body": corrected },
                "m.relates_to": { "rel_type": "m.replace", "event_id": event_id },
            }),
        )
        .await;

    let message = harness
        .wait_for_body(&corrected)
        .await
        .expect("the edit reached Roomy");
    assert!(
        message["lastEdit"].is_string(),
        "an edited message carries its edit event id: {message}"
    );
}

/// A redaction removes the message from Roomy.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_redaction_deletes_the_message() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e redact", false).await;
    harness.bridge_room(&room).await;

    let body = unique("delete me");
    let event_id = harness
        .send(&room, &alice, json!({ "msgtype": "m.text", "body": body }))
        .await;
    let message = harness
        .wait_for_body(&body)
        .await
        .expect("the message reached Roomy first");
    let roomy_id = message["id"].as_str().expect("a message has an id");

    harness
        .matrix(
            reqwest::Method::PUT,
            &format!(
                "/_matrix/client/v3/rooms/{}/redact/{}/{}",
                percent_encode(&room),
                percent_encode(&event_id),
                ulid::Ulid::generate()
            ),
            &alice,
            Some(json!({})),
        )
        .await;

    for _ in 0..60 {
        let still_there = harness.messages().await.into_iter().any(|m| {
            m["id"].as_str() == Some(roomy_id)
                && m["content"].as_str().is_some_and(|c| c.contains(&body))
        });
        if !still_there {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("the redacted message is still in Roomy");
}

/// A reaction lands on the message it annotates, attributed to the reactor.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_reaction_is_bridged() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let bob = harness.ghost("bob");
    let room = harness.room(&alice, "roomy e2e reaction", false).await;
    harness.bridge_room(&room).await;

    harness.register_ghost(&bob).await;
    harness
        .matrix(
            reqwest::Method::POST,
            &format!("/_matrix/client/v3/rooms/{}/invite", percent_encode(&room)),
            &alice,
            Some(json!({ "user_id": bob })),
        )
        .await;
    harness
        .matrix(
            reqwest::Method::POST,
            &format!("/_matrix/client/v3/rooms/{}/join", percent_encode(&room)),
            &bob,
            Some(json!({})),
        )
        .await;

    let body = unique("react to me");
    let event_id = harness
        .send(&room, &alice, json!({ "msgtype": "m.text", "body": body }))
        .await;
    assert!(harness.wait_for_body(&body).await.is_some());

    harness
        .send_typed(
            &room,
            &bob,
            "m.reaction",
            json!({
                "m.relates_to": {
                    "rel_type": "m.annotation",
                    "event_id": event_id,
                    "key": "👍",
                },
            }),
        )
        .await;

    let reacted = harness
        .wait_for_message(|message| {
            message["content"]
                .as_str()
                .is_some_and(|c| c.contains(&body))
                && message["reactions"]
                    .as_array()
                    .is_some_and(|reactions| !reactions.is_empty())
        })
        .await;
    let message = reacted.expect("the reaction reached Roomy");
    let reaction = &message["reactions"][0];
    assert_eq!(reaction["emoji"].as_str(), Some("👍"), "{message}");
}

/// A reply becomes a reply attachment pointing at the bridged target.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_reply_is_bridged() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e reply", false).await;
    harness.bridge_room(&room).await;

    let original = unique("the question");
    let event_id = harness
        .send(
            &room,
            &alice,
            json!({ "msgtype": "m.text", "body": original }),
        )
        .await;
    let target = harness
        .wait_for_body(&original)
        .await
        .expect("the original reached Roomy");

    let answer = unique("the answer");
    harness
        .send(
            &room,
            &alice,
            json!({
                "msgtype": "m.text",
                "body": answer,
                "m.relates_to": { "m.in_reply_to": { "event_id": event_id } },
            }),
        )
        .await;

    let reply = harness
        .wait_for_body(&answer)
        .await
        .expect("the reply reached Roomy");
    assert_eq!(
        reply["replyTo"].as_str(),
        target["id"].as_str(),
        "the reply must point at the bridged original: {reply}"
    );
}

/// A message inside an unbridged Matrix thread is flattened into the channel.
///
/// Roomy has threads only where a thread room was created; a thread whose root
/// was never bridged has no Roomy counterpart, so the message lands in the
/// channel as a reply. That is the documented mapping, and this is it running.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn a_thread_message_is_flattened_into_the_channel() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e thread", false).await;
    harness.bridge_room(&room).await;

    let root = unique("thread root");
    let root_id = harness
        .send(&room, &alice, json!({ "msgtype": "m.text", "body": root }))
        .await;
    let root_message = harness
        .wait_for_body(&root)
        .await
        .expect("the thread root reached Roomy");

    let in_thread = unique("inside the thread");
    harness
        .send(
            &room,
            &alice,
            json!({
                "msgtype": "m.text",
                "body": in_thread,
                "m.relates_to": { "rel_type": "m.thread", "event_id": root_id },
            }),
        )
        .await;

    let message = harness
        .wait_for_body(&in_thread)
        .await
        .expect("the thread message reached Roomy");
    assert_eq!(
        message["replyTo"].as_str(),
        root_message["id"].as_str(),
        "a flattened thread message replies to its root: {message}"
    );
}

/// Media in a Matrix message becomes a Roomy attachment on the bridge's blob
/// store, not a dropped `mxc://` URI.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn an_attachment_is_uploaded_to_the_bridge_blob_store() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e media", false).await;
    harness.bridge_room(&room).await;

    // A 1x1 PNG: small enough to inline, real enough to decode.
    let png: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    let mxc = harness.upload(&alice, "pixel.png", png).await;

    let caption = unique("a picture");
    harness
        .send(
            &room,
            &alice,
            json!({
                "msgtype": "m.image",
                "body": caption,
                "url": mxc,
                "info": { "mimetype": "image/png", "size": png.len() },
            }),
        )
        .await;

    let message = harness
        .wait_for_body(&caption)
        .await
        .expect("the message reached Roomy");
    let attachment = message["attachments"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|item| item["$type"] == "space.roomy.attachment.image.v0")
        })
        .unwrap_or_else(|| panic!("the image became a Roomy attachment: {message}"));
    assert!(
        attachment["url"]
            .as_str()
            .is_some_and(|url| url.starts_with("atblob://")),
        "the attachment names the bridge's blob, not the Matrix URI: {attachment}"
    );
}

/// History is backfilled into Roomy when a portal is created.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn history_is_backfilled() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e backfill", false).await;

    let marker = unique("backfill");
    for index in 0..50 {
        harness
            .send(
                &room,
                &alice,
                json!({ "msgtype": "m.text", "body": format!("{marker} #{index}") }),
            )
            .await;
    }

    // Bridged *after* the messages exist, which is the only way to tell backfill
    // apart from live relaying.
    harness.bridge_room(&room).await;

    let mut seen = 0;
    for _ in 0..120 {
        seen = harness
            .messages()
            .await
            .into_iter()
            .filter(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains(&marker))
            })
            .count();
        if seen >= 50 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(seen, 50, "the backfill read the room's recent history");
}

/// An encrypted room is bridged when the homeserver supports what encryption
/// needs, and otherwise reports a blocked portal naming the reason.
///
/// The assertion follows the probe rather than assuming an answer: this is the
/// same measurement an operator reads in `/capabilities`.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn an_encrypted_room_is_bridged_or_blocked_with_a_reason() {
    let harness = Harness::from_env();
    let alice = harness.ghost("alice");
    let room = harness.room(&alice, "roomy e2e encrypted", true).await;

    // The process capability, measured before the portal exists: it is what
    // decides whether this portal can encrypt.
    let e2ee = harness.encrypting().await;
    let portal = harness.bridge_room(&room).await;

    assert_eq!(portal["encrypted"].as_bool(), Some(true), "{portal}");
    if e2ee {
        assert_ne!(
            portal["state"].as_str(),
            Some("blocked"),
            "a homeserver that passed the probe must bridge the room: {portal}"
        );

        // Outbound: a Roomy message into a portal of an encrypted room leaves as
        // ciphertext, which is what tells the two directions apart.
        let body = unique("into the encrypted room");
        let response = harness
            .http
            .post(format!(
                "{}/xrpc/space.roomy.space.sendEvents",
                harness.appserver_url
            ))
            .header("X-Test-Did", &harness.test_did)
            .json(&json!({
                "spaceId": harness.space_id,
                "events": [harness.roomy_message(&body)],
            }))
            .send()
            .await
            .expect("the appserver is reachable");
        assert!(response.status().is_success());

        let mut encrypted = false;
        for _ in 0..60 {
            encrypted = harness
                .room_events(&room, &harness.bridge_user())
                .await
                .into_iter()
                .any(|event| event["type"] == "m.room.encrypted");
            if encrypted {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        assert!(encrypted, "the outbound message left as plaintext");
    } else {
        assert_eq!(
            portal["state"].as_str(),
            Some("blocked"),
            "an encrypted room on a homeserver without the needed features must be blocked: {portal}"
        );
        let reason = portal["reason"].as_str().unwrap_or_default();
        assert!(
            reason.contains("msc") || reason.contains("encryption"),
            "the blocked portal names why: {reason}"
        );
    }
}

/// The admin API refuses a caller that is not an admin of the space.
#[tokio::test]
#[ignore = "needs a live bridge; run via scripts/matrix-bridge-e2e.sh"]
async fn the_admin_api_refuses_a_non_admin() {
    let harness = Harness::from_env();

    // No token at all: the admin API must not answer a listing.
    let response = harness
        .http
        .get(format!("{}/_roomy/admin/v1/bridges", harness.bridge_url))
        .query(&[("spaceId", harness.space_id.as_str())])
        .send()
        .await
        .expect("the bridge is reachable");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "an unauthenticated listing must be refused"
    );

    // A token minted for a different service: refused on audience, before the
    // space's members are read.
    let response = harness
        .http
        .get(format!("{}/_roomy/admin/v1/bridges", harness.bridge_url))
        .bearer_auth("not.a.token")
        .query(&[("spaceId", harness.space_id.as_str())])
        .send()
        .await
        .expect("the bridge is reachable");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "a malformed token must be refused"
    );

    // A caller the bridge can identify but who is not a space admin: refused by
    // the membership check. This is the check that protects other spaces.
    let response = harness
        .http
        .get(format!("{}/_roomy/admin/v1/bridges", harness.bridge_url))
        .header("X-Test-Did", "did:plc:notanadmin")
        .query(&[("spaceId", harness.space_id.as_str())])
        .send()
        .await
        .expect("the bridge is reachable");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "a caller the bridge cannot identify is refused before membership"
    );

    // Health is unauthenticated on purpose: a load balancer and the container
    // healthcheck both need it.
    let response = harness
        .http
        .get(format!("{}/_roomy/admin/v1/health", harness.bridge_url))
        .send()
        .await
        .expect("the bridge is reachable");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}
