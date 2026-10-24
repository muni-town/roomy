//! End-to-bridge encryption.
//!
//! The model is one Matrix device for the bridge, not one per ghost.
//! `matrix-sdk-crypto`'s `OlmMachine` is per `(user_id, device_id)`, and mautrix
//! — the other large Matrix bridge — runs exactly one for the bridge bot and
//! encrypts ghost messages with it. Per-ghost devices need MSC4190 (device
//! creation) and MSC4326 (device masquerading); neither changes *who can read*
//! the plaintext, because the bridge reads it either way, so they buy no
//! confidentiality and cost a device plus a key upload per puppet.
//!
//! What this module provides:
//!
//! * one `OlmMachine` with a SQLite crypto store, persisted so a restart does
//!   not lose the device identity — losing it means losing every room key;
//! * decryption of inbound `m.room.encrypted` events;
//! * encryption of outbound messages, sharing the room key when no session
//!   exists yet.
//!
//! There is no key-backup import, so history from before the bridge joined an
//! encrypted room is unreadable. That is a property of the design, stated in the
//! operator docs and in the app-lite encryption notice rather than papered over.

use std::path::Path;
use std::sync::Arc;

use matrix_sdk_crypto::types::requests::AnyIncomingResponse;
use matrix_sdk_crypto::{
    types::events::room::encrypted::EncryptedEvent, types::requests::ToDeviceRequest,
    DecryptionSettings, EncryptionSettings, EncryptionSyncChanges, OlmMachine, OlmMachineBuilder,
    RoomEventDecryptionResult, TrustRequirement,
};
use ruma::events::{AnyMessageLikeEventContent, AnyToDeviceEvent};
use ruma::serde::Raw;
use ruma::{DeviceId, OwnedDeviceId, OwnedRoomId, OwnedUserId, TransactionId};
use serde_json::Value;
use std::collections::BTreeMap;

/// The crypto machine and the device identity it holds.
pub struct CryptoMachine {
    machine: OlmMachine,
}

impl CryptoMachine {
    /// Open (or create) the bridge device's crypto store.
    ///
    /// The store *is* the device identity: `OlmMachine` reuses the account the
    /// store already holds, so opening an existing file on restart keeps every
    /// room key the bridge has received.
    pub async fn open(
        user_id: &OwnedUserId,
        device_id: &DeviceId,
        store_path: impl AsRef<Path>,
    ) -> Result<Self, CryptoError> {
        let store = matrix_sdk_sqlite::SqliteCryptoStore::open(store_path.as_ref(), None)
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))?;

        let machine = OlmMachineBuilder::new(user_id, device_id)
            .with_crypto_store(store)
            .build()
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))?;

        Ok(Self { machine })
    }

    /// The machine, for the to-device and device-list plumbing the supervisor
    /// owns.
    pub fn machine(&self) -> &OlmMachine {
        &self.machine
    }

    /// The device id this machine runs as.
    pub fn device_id(&self) -> &DeviceId {
        self.machine.device_id()
    }

    /// The user id this machine runs as.
    pub fn user_id(&self) -> &ruma::UserId {
        self.machine.user_id()
    }

    /// Hand the machine the to-device stream from one transaction.
    ///
    /// This is where room keys arrive: a Megolm key is delivered as a to-device
    /// message, and nothing can be decrypted until the machine has ingested it.
    /// `changed_devices` and `one_time_keys_counts` are empty because an
    /// appservice transaction carries the to-device stream alone — the bridge
    /// has no `/sync`, so there is no device-list delta to report here.
    pub async fn receive_to_device(&self, messages: &[Value]) -> Result<usize, CryptoError> {
        if messages.is_empty() {
            return Ok(0);
        }

        let raw: Vec<Raw<AnyToDeviceEvent>> = messages
            .iter()
            .filter_map(|message| Raw::from_json_string(serde_json::to_string(message).ok()?).ok())
            .collect();

        let changed_devices = ruma::api::client::sync::sync_events::DeviceLists::default();
        let one_time_keys_counts = BTreeMap::new();
        let changes = EncryptionSyncChanges {
            to_device_events: raw,
            changed_devices: &changed_devices,
            one_time_keys_counts: &one_time_keys_counts,
            unused_fallback_keys: None,
            next_batch_token: None,
        };

        let settings = DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::Untrusted,
        };
        let (processed, room_keys) = self
            .machine
            .receive_sync_changes(changes, &settings)
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))?;

        if !room_keys.is_empty() {
            tracing::debug!(keys = room_keys.len(), "ingested room keys");
        }
        Ok(processed.len())
    }

    /// The device's Curve25519 identity key, which identifies the bridge device
    /// to the room's other devices.
    pub fn identity_key(&self) -> String {
        self.machine.identity_keys().curve25519.to_base64()
    }

    /// The requests the machine wants sent: its own device-key upload, the
    /// device queries its key-sharing needs, and the to-device messages that
    /// hand a room key to the room's other devices.
    ///
    /// The machine is sans-io, so nothing leaves it until a caller takes these
    /// and performs them. Skipping this is what makes a bridge encrypt messages
    /// no recipient can decrypt: the Megolm session exists locally but its key
    /// was never shared.
    pub async fn outgoing_requests(
        &self,
    ) -> Result<Vec<matrix_sdk_crypto::types::requests::OutgoingRequest>, CryptoError> {
        self.machine
            .outgoing_requests()
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))
    }

    /// Tell the machine that a request it asked for has been performed, so it
    /// records the result and stops asking.
    pub async fn mark_request_as_sent(
        &self,
        request_id: &TransactionId,
        response: impl Into<AnyIncomingResponse<'_>>,
    ) -> Result<(), CryptoError> {
        self.machine
            .mark_request_as_sent(request_id, response)
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))
    }

    /// Decrypt a room event, or report it unreadable.
    ///
    /// A missing room key is `Ok(None)`: history from before the bridge joined
    /// an encrypted room is expected to be unreadable, and treating that as a
    /// fault would mark every portal blocked on its first backfill.
    pub async fn try_decrypt(
        &self,
        event_content: &Value,
        room_id: &OwnedRoomId,
    ) -> Result<Option<Value>, CryptoError> {
        let event: EncryptedEvent = serde_json::from_value(event_content.clone())
            .map_err(|error| CryptoError::Decode(error.to_string()))?;
        let raw = Raw::new(&event)
            .map_err(|error| CryptoError::Decode(error.to_string()))?
            .cast_unchecked();

        // Bridge traffic is decrypted regardless of device trust. Requiring
        // cross-signing would refuse messages from every device that has not
        // been verified, which in a bridged room is most of them. Trust is not
        // what this device needs: it is not protecting a human's conversation
        // from impersonation, it is relaying content the room has already
        // agreed the bridge may read.
        let settings = DecryptionSettings {
            sender_device_trust_requirement: TrustRequirement::Untrusted,
        };

        match self
            .machine
            .try_decrypt_room_event(&raw, room_id.as_ref(), &settings)
            .await
        {
            Ok(RoomEventDecryptionResult::Decrypted(decrypted)) => {
                serde_json::from_str(decrypted.event.json().get())
                    .map(Some)
                    .map_err(|error| CryptoError::Decode(error.to_string()))
            }
            Ok(RoomEventDecryptionResult::UnableToDecrypt(info)) => {
                tracing::debug!(reason = ?info.reason, "room event could not be decrypted");
                Ok(None)
            }
            Err(error) => Err(CryptoError::Store(error.to_string())),
        }
    }

    /// Encrypt a message for a room.
    ///
    /// A message cannot be encrypted before a Megolm session exists, and a
    /// session exists only once its key has been shared. When the machine
    /// reports the session as not shared, the key is shared with `members` and
    /// the encryption retried once — the same recovery mautrix performs.
    ///
    /// Returns the ciphertext content and any to-device requests the caller
    /// must deliver, because the crypto machine is sans-io and has no transport.
    pub async fn encrypt(
        &self,
        room_id: &OwnedRoomId,
        content: &Value,
        members: &[OwnedUserId],
    ) -> Result<EncryptedContent, CryptoError> {
        match self.encrypt_inner(room_id, content).await {
            Ok(ciphertext) => Ok(EncryptedContent {
                content: ciphertext,
                key_sharing: Vec::new(),
            }),
            Err(CryptoError::SessionNotShared) => {
                let requests = self.share_room_key(room_id, members).await?;
                let ciphertext = self.encrypt_inner(room_id, content).await?;
                Ok(EncryptedContent {
                    content: ciphertext,
                    key_sharing: requests,
                })
            }
            Err(error) => Err(error),
        }
    }

    async fn encrypt_inner(
        &self,
        room_id: &OwnedRoomId,
        content: &Value,
    ) -> Result<Value, CryptoError> {
        let raw: Raw<AnyMessageLikeEventContent> = Raw::from_json(
            serde_json::value::to_raw_value(content)
                .map_err(|error| CryptoError::Decode(error.to_string()))?,
        );

        let result = self
            .machine
            .encrypt_room_event_raw(room_id.as_ref(), "m.room.message", &raw)
            .await
            .map_err(|error| {
                let message = error.to_string();
                if message.contains("session") {
                    CryptoError::SessionNotShared
                } else {
                    CryptoError::Encrypt(message)
                }
            })?;

        serde_json::from_str(result.content.json().get())
            .map_err(|error| CryptoError::Decode(error.to_string()))
    }

    /// Share the room key for `room_id` with `members`.
    ///
    /// The returned requests are the caller's to deliver to the homeserver; the
    /// crypto machine holds no transport.
    pub async fn share_room_key(
        &self,
        room_id: &OwnedRoomId,
        members: &[OwnedUserId],
    ) -> Result<Vec<Arc<ToDeviceRequest>>, CryptoError> {
        self.machine
            .share_room_key(
                room_id.as_ref(),
                members.iter().map(|member| member.as_ref()),
                EncryptionSettings::default(),
            )
            .await
            .map_err(|error| CryptoError::Encrypt(error.to_string()))
    }

    /// Whether an encrypted event from `room_id` could be decrypted with the
    /// keys the bridge currently holds.
    ///
    /// `is_room_key_available` takes the event it is being asked about — there
    /// is no room-wide session query — so this offers the given content and
    /// reports what the machine says.
    pub async fn can_decrypt(
        &self,
        event_content: &Value,
        room_id: &OwnedRoomId,
    ) -> Result<bool, CryptoError> {
        let event: EncryptedEvent = serde_json::from_value(event_content.clone())
            .map_err(|error| CryptoError::Decode(error.to_string()))?;
        let raw = Raw::new(&event)
            .map_err(|error| CryptoError::Decode(error.to_string()))?
            .cast_unchecked();
        self.machine
            .is_room_key_available(&raw, room_id.as_ref())
            .await
            .map_err(|error| CryptoError::Store(error.to_string()))
    }
}

/// Ciphertext for one message, plus any key-sharing the caller must deliver
/// before the message is decryptable.
pub struct EncryptedContent {
    pub content: Value,
    pub key_sharing: Vec<Arc<ToDeviceRequest>>,
}

/// E2EE could not proceed.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("crypto store error: {0}")]
    Store(String),
    /// The homeserver call that carries keys failed.
    #[error(transparent)]
    Transport(#[from] crate::transport::TransportError),
    #[error("no Megolm session for this room yet")]
    SessionNotShared,
    #[error("could not encrypt: {0}")]
    Encrypt(String),
    #[error("malformed crypto payload: {0}")]
    Decode(String),
}

/// Performs the requests a crypto machine asks for and reports their results.
///
/// `matrix-sdk-crypto` is sans-io: it emits `OutgoingRequest`s and needs each
/// one's server response fed back through `mark_request_as_sent`. This type is
/// that pump. Without it a bridge still creates Megolm sessions, but the keys
/// they need are never uploaded or shared, so every message it encrypts is
/// undecryptable by the room — and the failure is silent, which is why the pump
/// belongs on the send path rather than behind an option.
///
/// Each request is sent as the JSON the crypto crate itself serialises, and each
/// response is read back by the transport with ruma's `IncomingResponseExt`.
/// Building the URL through ruma's `OutgoingRequestExt` is not used here: it
/// needs the homeserver's supported-version set up front and refuses the request
/// when an endpoint's version is not advertised, which turns a version
/// disagreement into a bridge that never shares a key. The paths are the stable
/// `/v3` client API.
pub struct CryptoTransport {
    client: crate::transport::HomeserverClient,
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
}

impl CryptoTransport {
    pub fn new(
        client: crate::transport::HomeserverClient,
        user_id: &ruma::UserId,
        device_id: &DeviceId,
    ) -> Self {
        Self {
            client,
            user_id: user_id.to_owned(),
            device_id: device_id.to_owned(),
        }
    }

    /// Perform every request the machine is waiting on.
    ///
    /// A request that fails is logged and left queued: the machine re-emits it
    /// on the next pump, so a transient homeserver error costs a retry rather
    /// than the room key. Returns how many succeeded.
    pub async fn pump(&self, machine: &CryptoMachine) -> Result<usize, CryptoError> {
        use matrix_sdk_crypto::types::requests::AnyOutgoingRequest;

        let requests = machine.outgoing_requests().await?;
        let mut sent = 0usize;

        for request in requests {
            let request_id = request.request_id().to_owned();
            let result = match request.request() {
                AnyOutgoingRequest::KeysUpload(body) => {
                    // The keys go out exactly as the crypto machine holds them:
                    // the `Raw` wrappers serialise to the bytes the homeserver
                    // verifies signatures over, so they must not be re-encoded.
                    let payload = serde_json::json!({
                        "device_keys": body.device_keys,
                        "one_time_keys": body.one_time_keys,
                        "fallback_keys": body.fallback_keys,
                    });
                    match self
                        .client
                        .upload_keys(self.user_id.as_str(), self.device_id.as_str(), &payload)
                        .await
                    {
                        Ok(response) => machine.mark_request_as_sent(&request_id, &response).await,
                        Err(error) => Err(error.into()),
                    }
                }
                AnyOutgoingRequest::KeysQuery(body) => {
                    // The crypto crate's query type carries a `Duration`
                    // timeout; the wire format expresses it in milliseconds.
                    let payload = serde_json::json!({
                        "timeout": body.timeout.map(|timeout| timeout.as_millis() as u64),
                        "device_keys": body.device_keys,
                    });
                    match self.client.query_keys(&payload).await {
                        Ok(response) => machine.mark_request_as_sent(&request_id, &response).await,
                        Err(error) => Err(error.into()),
                    }
                }
                AnyOutgoingRequest::KeysClaim(body) => {
                    let payload = serde_json::json!({ "one_time_keys": body.one_time_keys });
                    match self.client.claim_keys(&payload).await {
                        Ok(response) => machine.mark_request_as_sent(&request_id, &response).await,
                        Err(error) => Err(error.into()),
                    }
                }
                AnyOutgoingRequest::ToDeviceRequest(body) => {
                    // The crypto crate's request is what serialises to the wire
                    // format, so its event type and messages are read from it
                    // rather than duplicated here.
                    let encoded = serde_json::to_value(body).map_err(decode_error)?;
                    let event_type = encoded
                        .get("event_type")
                        .and_then(|value| value.as_str())
                        .ok_or_else(|| {
                            CryptoError::Decode("to-device request has no event type".into())
                        })?;
                    let messages = encoded
                        .get("messages")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    match self
                        .client
                        .send_to_device(event_type, body.txn_id.as_str(), &messages)
                        .await
                    {
                        Ok(response) => machine.mark_request_as_sent(&request_id, &response).await,
                        Err(error) => Err(error.into()),
                    }
                }
                // Cross-signing and in-room verification traffic needs a human
                // on the other end. A bridge device has none, so these are
                // dropped rather than retried forever.
                other => {
                    tracing::debug!(
                        request = ?std::mem::discriminant(other),
                        "a crypto request needs a human; not sending it"
                    );
                    Ok(())
                }
            };

            match result {
                Ok(()) => sent += 1,
                Err(error) => {
                    tracing::warn!(%error, "a crypto request failed; it stays queued")
                }
            }
        }

        Ok(sent)
    }
}

fn decode_error(error: serde_json::Error) -> CryptoError {
    CryptoError::Decode(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::transport::{fake_client, Body, FakeHomeserver, FakeResponse, Method};

    #[tokio::test]
    async fn the_crypto_wire_goes_through_the_transport() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/keys/upload",
            FakeResponse::ok(json!({ "one_time_key_counts": { "signed_curve25519": 3 } })),
        );
        fake.route(
            Method::Post,
            "/_matrix/client/v3/keys/query",
            FakeResponse::ok(json!({ "device_keys": {}, "failures": {} })),
        );
        fake.route(
            Method::Put,
            "/_matrix/client/v3/sendToDevice/m.room_key/",
            FakeResponse::ok(json!({})),
        );

        let client = fake_client(&fake);

        // The upload names both the user and the device: an appservice that
        // names only a device resolves it for the wrong user.
        let uploaded = client
            .upload_keys(
                "@_roomy_bridge:hs.test",
                "DEVICE",
                &json!({ "device_keys": { "user_id": "@_roomy_bridge:hs.test" } }),
            )
            .await
            .expect("the fake accepts the upload");
        assert_eq!(uploaded.one_time_key_counts.len(), 1);

        client
            .query_keys(&json!({ "device_keys": {} }))
            .await
            .expect("the fake answers the query");
        client
            .send_to_device("m.room_key", "txn-1", &json!({ "@alice:hs.test": {} }))
            .await
            .expect("the fake accepts the to-device message");

        let requests = fake.requests();
        assert_eq!(
            requests[0].url,
            "http://hs.test/_matrix/client/v3/keys/upload?user_id=%40_roomy_bridge%3Ahs.test&device_id=DEVICE"
        );
        assert_eq!(
            requests[2].url,
            "http://hs.test/_matrix/client/v3/sendToDevice/m.room_key/txn-1"
        );
        assert_eq!(
            requests[2].body,
            Body::Json(json!({ "messages": { "@alice:hs.test": {} } })),
            "the transport wraps the messages in the body the endpoint takes"
        );
        assert_eq!(requests[0].token.as_deref(), Some("as-secret"));
    }

    #[tokio::test]
    async fn a_refused_key_upload_is_a_refusal_carrying_its_status() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/keys/upload",
            FakeResponse::refusing(400, "M_UNKNOWN_DEVICE"),
        );

        let error = fake_client(&fake)
            .upload_keys("@_roomy_bridge:hs.test", "DEVICE", &json!({}))
            .await
            .expect_err("the fake refuses the upload");

        assert_eq!(error.status(), Some(400));
        assert!(error.is_permanent());
    }

    #[tokio::test]
    async fn the_pump_sends_the_device_key_upload_the_machine_asks_for() {
        use ruma::OwnedUserId;

        let user = OwnedUserId::try_from("@_roomy_bridge:hs.test").expect("a user id");
        let device = DeviceId::new();
        let store_path =
            std::env::temp_dir().join(format!("roomy-crypto-test-{}", ulid::Ulid::generate()));
        let machine = CryptoMachine::open(&user, &device, &store_path)
            .await
            .expect("a crypto store opens offline");

        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/client/v3/keys/upload",
            FakeResponse::ok(json!({ "one_time_key_counts": {} })),
        );

        let transport =
            CryptoTransport::new(fake_client(&fake), machine.user_id(), machine.device_id());
        let sent = transport.pump(&machine).await.expect("the pump runs");

        assert!(sent >= 1, "a fresh device asks for a key upload");

        let upload = fake
            .requests()
            .into_iter()
            .find(|request| request.url.contains("/_matrix/client/v3/keys/upload"))
            .expect("the pump sent the upload the machine asked for");
        assert!(upload.url.contains("user_id=%40_roomy_bridge%3Ahs.test"));
        assert!(upload
            .url
            .contains(&format!("device_id={}", machine.device_id())));
        let Body::Json(body) = upload.body else {
            panic!("a key upload carries JSON");
        };
        assert!(
            body.get("device_keys").is_some(),
            "the machine's own device keys went out, not a re-encoding of them"
        );

        let _ = std::fs::remove_dir_all(&store_path);
    }
}
