//! `PUT /_matrix/app/v1/transactions/{txnId}`: what the homeserver pushes.
//!
//! A transaction is a batch of PDUs plus EDUs. The bridge cares about
//! `m.room.message`, `m.room.encrypted`, `m.room.redaction` and `m.reaction`
//! PDUs, and — when E2EE is on — the `m.direct_to_device` EDU stream, because
//! that is how room keys arrive.
//!
//! Transaction ids are used for idempotency: the homeserver retries a
//! transaction it believes failed, and a retried batch must not post the same
//! messages twice.

use std::collections::HashSet;

use bridge_core::{
    Body, FormattedBody, GhostMxid, IncomingEvent, IncomingKind, IncomingMedia, MatrixEventId,
    MatrixRoomId, Msgtype, TxnId,
};
use serde::Deserialize;

use crate::media::MxcUri;

/// A transaction as the homeserver sends it.
///
/// `to_device` arrives under one of two names: an unstable homeserver (Synapse)
/// sends `de.sorunome.msc2409.to_device`, a stabilised one `to_device`. Both are
/// read, because a bridge that only knew one spelling would silently drop every
/// room key from the other.
#[derive(Debug, Clone, Deserialize)]
pub struct Transaction {
    /// The PDUs in the transaction.
    #[serde(default)]
    pub events: Vec<Pdu>,
    /// The EDUs in the transaction.
    #[serde(default)]
    pub edus: Vec<Edu>,
    /// The to-device stream: room keys and verification traffic.
    #[serde(rename = "de.sorunome.msc2409.to_device", alias = "to_device", default)]
    pub to_device: Vec<ToDeviceMessage>,
}

/// One PDU in a transaction.
#[derive(Debug, Clone, Deserialize)]
pub struct Pdu {
    /// The event type, e.g. `m.room.message`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The Matrix event id.
    #[serde(rename = "event_id")]
    pub event_id: String,
    /// The room the event happened in.
    pub room_id: String,
    /// The Matrix user that sent the event.
    pub sender: String,
    /// The state key; absent for message events.
    #[serde(default)]
    pub state_key: Option<String>,
    /// The event's origin timestamp, in milliseconds.
    #[serde(rename = "origin_server_ts", default)]
    pub origin_server_ts: i64,
    /// The event content, still platform-shaped.
    #[serde(default)]
    pub content: serde_json::Value,
    /// Present when the homeserver has already decrypted the event for this
    /// appservice (MSC3202), which is the only case the bridge gets plaintext
    /// without holding the room key itself.
    #[serde(default)]
    pub unsigned: Option<serde_json::Value>,
}

/// One EDU in a transaction.
#[derive(Debug, Clone, Deserialize)]
pub struct Edu {
    /// The EDU type, e.g. `m.typing`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The EDU content.
    #[serde(default)]
    pub content: serde_json::Value,
}

/// Turns transactions into [`IncomingEvent`]s, remembering transaction ids it
/// has already handled.
#[derive(Debug, Default)]
pub struct TransactionHandler {
    seen: HashSet<String>,
}

impl TransactionHandler {
    /// A handler that has seen no transactions.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether this transaction is a retry of one already applied.
    ///
    /// A retry is acknowledged and discarded. Processing it again would
    /// double-post every message in the batch, and the homeserver retries
    /// precisely the transactions whose acknowledgement it did not see.
    #[must_use]
    pub fn is_replay(&mut self, txn_id: &TxnId) -> bool {
        !self.seen.insert(txn_id.as_str().to_string())
    }

    /// Forget a transaction id, for a test or a manual requeue.
    pub fn forget(&mut self, txn_id: &TxnId) {
        self.seen.remove(txn_id.as_str());
    }

    /// The events in a transaction that the bridge relays.
    ///
    /// State events are skipped: membership is mirrored by ghost joins, and
    /// room metadata is read from `/state` when a portal is created, so
    /// forwarding every `m.room.member` as an event would duplicate both.
    pub fn incoming(&self, transaction: &Transaction) -> Vec<IncomingEvent> {
        transaction
            .events
            .iter()
            .filter(|pdu| pdu.state_key.is_none())
            .filter_map(translate_pdu)
            .collect()
    }

    /// The events in a transaction, with encrypted PDUs decrypted.
    ///
    /// This is the async twin of [`Self::incoming`], and the only path a live
    /// bridge uses: an `m.room.encrypted` PDU carries ciphertext, and the
    /// bridge's own `OlmMachine` is the only thing that can read it. A PDU the
    /// homeserver already decrypted is left alone.
    ///
    /// An event that cannot be decrypted is skipped rather than guessed at.
    /// That is expected for history from before the bridge joined a room — it
    /// has no key for it and never will, since there is no key-backup import.
    #[cfg(feature = "e2ee")]
    pub async fn incoming_decrypted(
        &self,
        transaction: &Transaction,
        crypto: &crate::e2ee::CryptoMachine,
    ) -> Vec<IncomingEvent> {
        let mut events = Vec::with_capacity(transaction.events.len());
        for pdu in &transaction.events {
            if pdu.state_key.is_some() {
                continue;
            }
            let Some(event) = self.decrypt_pdu(pdu, crypto).await else {
                continue;
            };
            events.push(event);
        }
        events
    }

    /// Translate one PDU, decrypting it first when it is ciphertext.
    #[cfg(feature = "e2ee")]
    async fn decrypt_pdu(
        &self,
        pdu: &Pdu,
        crypto: &crate::e2ee::CryptoMachine,
    ) -> Option<IncomingEvent> {
        if pdu.kind != "m.room.encrypted" {
            return translate_pdu(pdu);
        }

        // A PDU the homeserver already decrypted needs no work.
        if decrypted_content(pdu).is_some() {
            return translate_pdu(pdu);
        }

        let room_id = ruma::OwnedRoomId::try_from(pdu.room_id.clone()).ok()?;
        let plaintext = match crypto.try_decrypt(&pdu.content, &room_id).await {
            Ok(Some(plaintext)) => plaintext,
            Ok(None) => {
                tracing::debug!(
                    room_id = %pdu.room_id,
                    event_id = %pdu.event_id,
                    "an encrypted event has no room key; skipping it"
                );
                return None;
            }
            Err(error) => {
                tracing::warn!(%error, event_id = %pdu.event_id, "could not decrypt an event");
                return None;
            }
        };

        // The plaintext replaces the ciphertext, so the rest of the translation
        // runs unchanged on an ordinary message.
        let mut decrypted = pdu.clone();
        decrypted.kind = plaintext
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("m.room.message")
            .to_string();
        decrypted.content = plaintext
            .get("content")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        translate_pdu(&decrypted)
    }

    /// The to-device messages a transaction carries.
    ///
    /// MSC2409 puts them in the transaction's `to_device` array; some
    /// homeservers also (or instead) carry them as an `m.direct_to_device` EDU,
    /// so both are collected.
    pub fn to_device(&self, transaction: &Transaction) -> Vec<ToDeviceMessage> {
        let from_edus = transaction
            .edus
            .iter()
            .filter(|edu| edu.kind == "m.direct_to_device")
            .filter_map(|edu| serde_json::from_value::<ToDeviceMessage>(edu.content.clone()).ok());
        transaction
            .to_device
            .iter()
            .cloned()
            .chain(from_edus)
            .collect()
    }
}

/// One to-device message, as MSC2409 delivers it.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct ToDeviceMessage {
    /// The to-device message type, e.g. `m.room_key`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The Matrix user that sent the message.
    pub sender: String,
    /// The message content, still platform-shaped.
    #[serde(default)]
    pub content: serde_json::Value,
}

/// Translate one PDU into an [`IncomingEvent`], or `None` when it is not
/// something Roomy represents.
fn translate_pdu(pdu: &Pdu) -> Option<IncomingEvent> {
    let event_id = MatrixEventId::parse(pdu.event_id.clone()).ok()?;
    let room_id = MatrixRoomId::parse(pdu.room_id.clone()).ok()?;
    let sender = GhostMxid::parse(pdu.sender.clone()).ok()?;

    let (kind, encrypted) = match pdu.kind.as_str() {
        // A reaction arrives as `m.reaction`, or — from older clients and some
        // bridges — as `m.room.message` whose `msgtype` is `m.reaction`. Both
        // carry the same `m.annotation` relation, and a bridge that only knew
        // one would silently relay the other as a chat message.
        "m.reaction" => (reaction_kind(&pdu.content)?, false),
        "m.room.message" if is_legacy_reaction(&pdu.content) => {
            (reaction_kind(&pdu.content)?, false)
        }
        "m.room.message" | "m.room.encrypted" => {
            let encrypted = pdu.kind == "m.room.encrypted";
            // An encrypted PDU the homeserver did not decrypt is not readable
            // here; the bridge's own `OlmMachine` is the other path, and until
            // that has run the event is skipped rather than guessed at.
            let content = if encrypted {
                decrypted_content(pdu)?
            } else {
                pdu.content.clone()
            };
            (translate_message(&content)?, encrypted)
        }
        "m.room.redaction" => (
            IncomingKind::Redaction {
                target: MatrixEventId::parse(
                    pdu.content
                        .get("redacts")
                        .and_then(|value| value.as_str())
                        .or_else(|| {
                            pdu.unsigned
                                .as_ref()
                                .and_then(|u| u.get("redacts"))
                                .and_then(|v| v.as_str())
                        })
                        .unwrap_or_default()
                        .to_string(),
                )
                .ok()?,
                reason: pdu
                    .content
                    .get("reason")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            },
            false,
        ),
        _ => return None,
    };

    Some(IncomingEvent {
        event_id,
        room_id,
        sender,
        origin_server_ts: pdu.origin_server_ts,
        kind,
        encrypted,
    })
}

/// The plaintext of an encrypted PDU, when the homeserver decrypted it.
///
/// MSC3202 lets a homeserver hand an appservice a decrypted `m.room.message`
/// in place of the ciphertext. When it has not, this is `None` and the event
/// cannot be relayed until the bridge's own `OlmMachine` decrypts it — which is
/// the other path, in [`crate::e2ee`].
fn decrypted_content(pdu: &Pdu) -> Option<serde_json::Value> {
    // Some homeservers replace the content wholesale; others keep the
    // cleartext under `unsigned.ciphertext` metadata. Both appear in the wild,
    // so read whichever is present.
    if pdu.content.get("msgtype").is_some() {
        return Some(pdu.content.clone());
    }
    pdu.unsigned
        .as_ref()
        .and_then(|unsigned| unsigned.get("decrypted"))
        .cloned()
}

/// Translate a message content object.
/// Whether a `m.room.message` is really a reaction.
///
/// Before `m.reaction` was specced, clients sent the annotation relation under
/// `m.room.message` with `msgtype: m.reaction`. Synapse accepts both, so a
/// bridge sees both.
fn is_legacy_reaction(content: &serde_json::Value) -> bool {
    content.get("msgtype").and_then(|value| value.as_str()) == Some("m.reaction")
        && content
            .get("m.relates_to")
            .and_then(|relates| relates.get("rel_type"))
            .and_then(|value| value.as_str())
            == Some("m.annotation")
}

/// The reaction an `m.annotation` relation describes.
fn reaction_kind(content: &serde_json::Value) -> Option<IncomingKind> {
    let relates = content.get("m.relates_to")?;
    Some(IncomingKind::Reaction {
        target: MatrixEventId::parse(
            relates
                .get("event_id")
                .and_then(|value| value.as_str())?
                .to_string(),
        )
        .ok()?,
        key: relates
            .get("key")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Translate a `m.room.message` body into an incoming kind.
fn translate_message(content: &serde_json::Value) -> Option<IncomingKind> {
    let msgtype = content
        .get("msgtype")
        .and_then(|value| value.as_str())
        .unwrap_or("m.text");
    let msgtype = match msgtype {
        "m.text" => Msgtype::Text,
        "m.emote" => Msgtype::Emote,
        "m.notice" => Msgtype::Notice,
        "m.image" => Msgtype::Image,
        "m.video" => Msgtype::Video,
        "m.audio" => Msgtype::Audio,
        "m.file" => Msgtype::File,
        _ => Msgtype::Text,
    };

    let text = content
        .get("body")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();

    let formatted = content
        .get("formatted_body")
        .and_then(|value| value.as_str())
        .map(|body| FormattedBody {
            format: content
                .get("format")
                .and_then(|value| value.as_str())
                .unwrap_or("org.matrix.custom.html")
                .to_string(),
            body: body.to_string(),
        });

    let media = if msgtype.has_media() {
        content
            .get("url")
            .and_then(|value| value.as_str())
            .and_then(|url| MxcUri::parse(url).ok())
            .map(|uri| {
                vec![IncomingMedia {
                    mxc_uri: uri.as_str().to_string(),
                    mime_type: content
                        .get("info")
                        .and_then(|info| info.get("mimetype"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("application/octet-stream")
                        .to_string(),
                    name: content
                        .get("filename")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    size: content
                        .get("info")
                        .and_then(|info| info.get("size"))
                        .and_then(serde_json::Value::as_u64),
                    msgtype,
                }]
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let relates = content.get("m.relates_to");
    let reply_to = relates
        .and_then(|relates| relates.get("m.in_reply_to"))
        .and_then(|reply| reply.get("event_id"))
        .and_then(|value| value.as_str())
        .and_then(|value| MatrixEventId::parse(value.to_string()).ok());
    let thread_root = relates
        .filter(|relates| {
            relates.get("rel_type").and_then(|value| value.as_str()) == Some("m.thread")
        })
        .and_then(|relates| relates.get("event_id"))
        .and_then(|value| value.as_str())
        .and_then(|value| MatrixEventId::parse(value.to_string()).ok());

    // `m.replace` is an edit, not a message: the content's `m.new_content`
    // holds the new body and the outer body is a fallback `* new text`.
    if relates
        .and_then(|relates| relates.get("rel_type"))
        .and_then(|value| value.as_str())
        == Some("m.replace")
    {
        let target = relates
            .and_then(|relates| relates.get("event_id"))
            .and_then(|value| value.as_str())
            .and_then(|value| MatrixEventId::parse(value.to_string()).ok())?;
        let new_content = content
            .get("m.new_content")
            .cloned()
            .unwrap_or_else(|| content.clone());
        let new_body = new_content
            .get("body")
            .and_then(|value| value.as_str())
            .unwrap_or(&text)
            .to_string();
        let new_formatted = new_content
            .get("formatted_body")
            .and_then(|value| value.as_str())
            .map(|body| FormattedBody {
                format: new_content
                    .get("format")
                    .and_then(|value| value.as_str())
                    .unwrap_or("org.matrix.custom.html")
                    .to_string(),
                body: body.to_string(),
            });
        return Some(IncomingKind::Edit {
            target,
            body: Body {
                text: new_body,
                formatted: new_formatted,
            },
        });
    }

    Some(IncomingKind::Message {
        body: Body { text, formatted },
        media,
        reply_to,
        thread_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message_pdu(body: &str) -> Pdu {
        serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$evt:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1_700_000_000_000i64,
            "content": { "msgtype": "m.text", "body": body },
        }))
        .unwrap()
    }

    #[test]
    fn a_text_message_becomes_an_incoming_message() {
        let handler = TransactionHandler::new();
        let transaction = Transaction {
            events: vec![message_pdu("hello")],
            edus: vec![],
            to_device: vec![],
        };
        let incoming = handler.incoming(&transaction);
        match incoming.as_slice() {
            [event] => match &event.kind {
                IncomingKind::Message { body, media, .. } => {
                    assert_eq!(body.text, "hello");
                    assert!(media.is_empty());
                }
                other => panic!("expected a message, got {other:?}"),
            },
            other => panic!("expected one event, got {other:?}"),
        }
    }

    #[test]
    fn a_formatted_body_is_carried_alongside_the_plain_one() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$evt:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "bold",
                "format": "org.matrix.custom.html",
                "formatted_body": "<strong>bold</strong>",
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Message { body, .. } => {
                assert_eq!(body.text, "bold");
                assert_eq!(
                    body.formatted.as_ref().map(|f| f.body.as_str()),
                    Some("<strong>bold</strong>")
                );
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn an_image_message_carries_its_media_reference() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$evt:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.image",
                "body": "photo.png",
                "url": "mxc://media.example.org/abc",
                "info": { "mimetype": "image/png", "size": 123 },
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Message { media, .. } => {
                assert_eq!(media.len(), 1);
                assert_eq!(media[0].mime_type, "image/png");
                assert_eq!(media[0].size, Some(123));
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn an_edit_carries_the_new_content_not_the_fallback_text() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$edit:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 2,
            "content": {
                "msgtype": "m.text",
                "body": "* corrected",
                "m.new_content": { "msgtype": "m.text", "body": "corrected" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original:example.org" },
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Edit { target, body } => {
                assert_eq!(target.as_str(), "$original:example.org");
                assert_eq!(body.text, "corrected");
            }
            other => panic!("expected an edit, got {other:?}"),
        }
    }

    #[test]
    fn a_reply_carries_its_target() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$reply:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "yes",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$root:example.org" } },
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Message { reply_to, .. } => {
                assert_eq!(
                    reply_to.as_ref().map(|id| id.as_str()),
                    Some("$root:example.org")
                );
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn a_thread_relation_carries_its_root() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$threadmsg:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "in a thread",
                "m.relates_to": { "rel_type": "m.thread", "event_id": "$root:example.org" },
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Message { thread_root, .. } => {
                assert_eq!(
                    thread_root.as_ref().map(|id| id.as_str()),
                    Some("$root:example.org")
                );
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn a_redaction_carries_its_target_and_reason() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.redaction",
            "event_id": "$redact:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 3,
            "content": { "redacts": "$target:example.org", "reason": "spam" },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Redaction { target, reason } => {
                assert_eq!(target.as_str(), "$target:example.org");
                assert_eq!(reason.as_deref(), Some("spam"));
            }
            other => panic!("expected a redaction, got {other:?}"),
        }
    }

    #[test]
    fn a_reaction_carries_its_key() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.reaction",
            "event_id": "$reaction:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 4,
            "content": {
                "m.relates_to": { "rel_type": "m.annotation", "event_id": "$msg:example.org", "key": "🎉" }
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Reaction { target, key } => {
                assert_eq!(target.as_str(), "$msg:example.org");
                assert_eq!(key, "🎉");
            }
            other => panic!("expected a reaction, got {other:?}"),
        }
    }

    #[test]
    fn a_legacy_message_shaped_reaction_is_a_reaction() {
        // Clients before `m.reaction` sent the annotation under
        // `m.room.message`; relaying it as chat would post "reacted to a
        // message" into the channel.
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.message",
            "event_id": "$legacy:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 5,
            "content": {
                "msgtype": "m.reaction",
                "body": "🎉 reacted to a message",
                "m.relates_to": { "rel_type": "m.annotation", "event_id": "$msg:example.org", "key": "🎉" }
            },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Reaction { target, key } => {
                assert_eq!(target.as_str(), "$msg:example.org");
                assert_eq!(key, "🎉");
            }
            other => panic!("expected a reaction, got {other:?}"),
        }
    }

    #[test]
    fn state_events_are_not_relayed() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.member",
            "event_id": "$join:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "state_key": "@alice:example.org",
            "origin_server_ts": 5,
            "content": { "membership": "join" },
        }))
        .unwrap();
        assert!(TransactionHandler::new()
            .incoming(&Transaction {
                events: vec![pdu],
                edus: vec![],
                to_device: vec![],
            })
            .is_empty());
    }

    #[test]
    fn an_undecryptable_encrypted_pdu_is_skipped_rather_than_guessed() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.encrypted",
            "event_id": "$enc:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 6,
            "content": { "algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "AwgAEnB..." },
        }))
        .unwrap();
        assert!(TransactionHandler::new()
            .incoming(&Transaction {
                events: vec![pdu],
                edus: vec![],
                to_device: vec![],
            })
            .is_empty());
    }

    #[test]
    fn a_decrypted_encrypted_pdu_is_relayed() {
        let pdu: Pdu = serde_json::from_value(json!({
            "type": "m.room.encrypted",
            "event_id": "$enc:example.org",
            "room_id": "!room:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 7,
            "content": { "msgtype": "m.text", "body": "decrypted by the homeserver" },
        }))
        .unwrap();
        let incoming = TransactionHandler::new().incoming(&Transaction {
            events: vec![pdu],
            edus: vec![],
            to_device: vec![],
        });
        match &incoming[0].kind {
            IncomingKind::Message { body, .. } => {
                assert_eq!(body.text, "decrypted by the homeserver")
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn a_replayed_transaction_is_detected() {
        let mut handler = TransactionHandler::new();
        let first = TxnId::parse("txn1").unwrap();
        let second = TxnId::parse("txn2").unwrap();
        assert!(!handler.is_replay(&first));
        assert!(handler.is_replay(&first));
        assert!(!handler.is_replay(&second));
    }

    #[test]
    fn to_device_messages_are_extracted_from_both_envelopes() {
        let transaction = Transaction {
            events: vec![],
            to_device: vec![ToDeviceMessage {
                kind: "m.room.encrypted".into(),
                sender: "@alice:example.org".into(),
                content: json!({ "algorithm": "m.olm.v1.curve25519-aes-sha2" }),
            }],
            edus: vec![
                Edu {
                    kind: "m.typing".into(),
                    content: json!({}),
                },
                Edu {
                    kind: "m.direct_to_device".into(),
                    content: json!({
                        "type": "m.room.encrypted",
                        "sender": "@alice:example.org",
                        "content": { "algorithm": "m.olm.v1.curve25519-aes-sha2" },
                    }),
                },
            ],
        };
        let messages = TransactionHandler::new().to_device(&transaction);
        // The typing EDU is not a to-device message; the encrypted one and the
        // MSC2409 array entry are.
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().all(|m| m.sender == "@alice:example.org"));
    }
}
