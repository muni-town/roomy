//! A sender that encrypts for encrypted rooms.
//!
//! The supervisor addresses a room and a content object; whether that content
//! leaves as `m.room.message` or as `m.room.encrypted` is decided here, because
//! it is the only place that knows both the crypto machine and the room.
//!
//! Re-encryption follows the same recovery mautrix uses: a send that fails
//! because the Megolm session has not been shared yet shares the room key with
//! the room's current members and retries once. The key-sharing requests the
//! machine emits are performed immediately, and *before* the message, because a
//! message whose key nobody has is undecryptable for everyone including a reader
//! who joins a second later.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use matrix_adapter::{
    CryptoMachine, CryptoTransport, HomeserverClient, MatrixSendError, MatrixSender,
    OutgoingContent,
};

/// Sends to Matrix, encrypting when the room is encrypted.
pub struct EncryptingSender {
    inner: Arc<dyn MatrixSender>,
    client: Arc<HomeserverClient>,
    crypto: Arc<CryptoMachine>,
    transport: Arc<CryptoTransport>,
}

impl EncryptingSender {
    pub fn new(
        inner: Arc<dyn MatrixSender>,
        client: Arc<HomeserverClient>,
        crypto: Arc<CryptoMachine>,
    ) -> Self {
        let transport = Arc::new(CryptoTransport::new(
            (*client).clone(),
            crypto.user_id(),
            crypto.device_id(),
        ));
        Self {
            inner,
            client,
            crypto,
            transport,
        }
    }

    /// Whether a room is encrypted, as the room's own state event says.
    ///
    /// A failed read is an error, not "plaintext": sending `m.room.message`
    /// into an encrypted room because the state call timed out would leak the
    /// message body to every server in the room.
    async fn is_encrypted(&self, room_id: &str) -> Result<bool, MatrixSendError> {
        self.client.room_encrypted(room_id).await.map_err(|error| {
            MatrixSendError::Transient(format!(
                "could not read whether {room_id} is encrypted: {error}"
            ))
        })
    }

    /// The room's joined members, which key-sharing addresses.
    async fn members(&self, room_id: &str) -> Vec<ruma::OwnedUserId> {
        match self.client.joined_members(room_id).await {
            Ok(members) => members
                .iter()
                .filter_map(|mxid| ruma::OwnedUserId::try_from(mxid.clone()).ok())
                .collect(),
            Err(error) => {
                // Falling back to the bridge's own user would produce a key no
                // one else can use. Better to fail the send and retry.
                tracing::warn!(%error, %room_id, "could not read a room's members");
                Vec::new()
            }
        }
    }
}

impl MatrixSender for EncryptingSender {
    fn send_content<'a>(
        &'a self,
        room_id: &'a str,
        sender_mxid: Option<&'a str>,
        content: OutgoingContent,
    ) -> Pin<Box<dyn Future<Output = Result<String, MatrixSendError>> + Send + 'a>> {
        Box::pin(async move {
            if !self.is_encrypted(room_id).await? {
                return self.inner.send_content(room_id, sender_mxid, content).await;
            }

            let room = ruma::OwnedRoomId::try_from(room_id.to_string())
                .map_err(|error| MatrixSendError::Rejected(format!("bad room id: {error}")))?;
            let members = self.members(room_id).await;
            if members.is_empty() {
                return Err(MatrixSendError::Transient(
                    "an encrypted room with no readable members would produce an unreadable \
                     message"
                        .into(),
                ));
            }

            // Share — and create, when the room has none yet — the outbound
            // session before encrypting. `matrix-sdk-crypto` panics with
            // "Session wasn't created nor shared" when asked to encrypt for a
            // room without one, so the recovery runs first rather than in
            // response to an error that never arrives.
            self.crypto
                .share_room_key(&room, &members)
                .await
                .map_err(|error| {
                    MatrixSendError::Transient(format!("could not share the room key: {error}"))
                })?;

            // The key goes out before the message, so the message is never
            // readable-but-undecryptable on the other side. The same pump
            // performs the device-key uploads and the queries key sharing
            // needs, which is why it runs before encryption.
            if let Err(error) = self.transport.pump(&self.crypto).await {
                tracing::warn!(%error, %room_id, "could not deliver the room key");
            }

            let encrypted = self
                .crypto
                .encrypt(&room, &content.content, &members)
                .await
                .map_err(|error| {
                    MatrixSendError::Transient(format!("could not encrypt: {error}"))
                })?;

            let ciphertext = OutgoingContent {
                event_type: "m.room.encrypted".to_string(),
                content: encrypted.content,
            };
            self.inner
                .send_content(room_id, sender_mxid, ciphertext)
                .await
        })
    }
}
