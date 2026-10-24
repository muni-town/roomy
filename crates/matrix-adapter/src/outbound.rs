//! Sending to Matrix.
//!
//! Two things make sending non-obvious:
//!
//! * **Ghosts send as themselves.** An op naming a ghost is sent with `user_id`
//!   set to that MXID and the appservice token, which is what makes the event
//!   attributed to the ghost rather than to the bridge. A ghost that has not
//!   joined the room is joined first.
//! * **Encrypted rooms need `m.room.encrypted` content.** The op's plaintext is
//!   assembled here, and the crypto layer decides whether it goes out as
//!   `m.room.message` or as ciphertext.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use parking_lot::Mutex;

use serde_json::{json, Value};

use crate::transport::{HomeserverClient, TransportError};

/// A content object plus how it must be sent.
#[derive(Debug, Clone, PartialEq)]
pub struct OutgoingContent {
    pub event_type: String,
    pub content: Value,
}

/// What the supervisor needs from a transport.
///
/// A trait so the outbound loop can be tested without a homeserver. The future
/// is boxed because the supervisor holds this behind `Arc<dyn MatrixSender>`,
/// and a return-position `impl Trait` in a trait makes it non-dyn-compatible.
pub trait MatrixSender: Send + Sync {
    /// Send one content object, as `sender_mxid` when the content is a ghost's.
    ///
    /// Returns the event id the homeserver assigned, which is what the id map
    /// records for an event the bridge wrote.
    fn send_content<'a>(
        &'a self,
        room_id: &'a str,
        sender_mxid: Option<&'a str>,
        content: OutgoingContent,
    ) -> Pin<Box<dyn Future<Output = Result<String, MatrixSendError>> + Send + 'a>>;
}

/// A sender backed by the homeserver's client API.
///
/// The client carries the appservice token; `user_id` on the send is what makes
/// the event a ghost's rather than the bridge's own.
pub struct HttpSender {
    client: HomeserverClient,
    /// `(ghost, room)` pairs already registered and joined, so the setup cost is
    /// paid once per room rather than once per message.
    ready: Mutex<HashSet<String>>,
}

impl HttpSender {
    pub fn new(client: HomeserverClient) -> Self {
        Self {
            client,
            ready: Mutex::new(HashSet::new()),
        }
    }

    /// Register `ghost` and join it to `room_id`, once.
    async fn prepare(&self, ghost: &str, room_id: &str) -> Result<(), MatrixSendError> {
        let key = format!("{ghost}\x1f{room_id}");
        if self.ready.lock().contains(&key) {
            return Ok(());
        }
        self.client
            .ensure_ghost(ghost, room_id)
            .await
            .map_err(MatrixSendError::from)?;
        self.ready.lock().insert(key);
        Ok(())
    }
}

impl MatrixSender for HttpSender {
    fn send_content<'a>(
        &'a self,
        room_id: &'a str,
        sender_mxid: Option<&'a str>,
        content: OutgoingContent,
    ) -> Pin<Box<dyn Future<Output = Result<String, MatrixSendError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(ghost) = sender_mxid {
                self.prepare(ghost, room_id).await?;
            }
            let txn_id = ulid::Ulid::generate().to_string();
            self.client
                .send_event(
                    room_id,
                    sender_mxid,
                    &content.event_type,
                    &content.content,
                    &txn_id,
                )
                .await
                .map_err(MatrixSendError::from)
        })
    }
}

/// Sending to Matrix failed.
///
/// The two cases are not interchangeable: a rejected event will be rejected
/// again on every retry, while an unreachable homeserver is worth another
/// attempt. A caller that treats them alike either wedges on a poison event or
/// drops messages during an outage.
#[derive(Debug, Clone, thiserror::Error)]
pub enum MatrixSendError {
    /// The homeserver refused the event itself (4xx). Retrying cannot help.
    #[error("the homeserver rejected the event: {0}")]
    Rejected(String),
    /// The homeserver could not be reached, or answered in a way that suggests
    /// a retry might succeed.
    #[error("could not reach the homeserver: {0}")]
    Transient(String),
}

impl MatrixSendError {
    /// Whether another attempt could succeed.
    pub fn is_permanent(&self) -> bool {
        matches!(self, MatrixSendError::Rejected(_))
    }
}

/// The transport's verdict decides: a refusal names the request as the problem
/// and a repeat would earn the same answer, while an unreachable homeserver or
/// an unreadable answer is worth another attempt.
impl From<TransportError> for MatrixSendError {
    fn from(error: TransportError) -> Self {
        let message = error.to_string();
        if error.is_permanent() {
            MatrixSendError::Rejected(message)
        } else {
            MatrixSendError::Transient(message)
        }
    }
}

/// The `m.room.message` content for a text body.
pub fn text_content(body: &str) -> OutgoingContent {
    OutgoingContent {
        event_type: "m.room.message".into(),
        content: json!({
            "msgtype": "m.text",
            "body": body,
        }),
    }
}

/// The `m.room.message` content for an edit, which is `m.replace` with the new
/// content both inside `m.new_content` and as the fallback body.
pub fn edit_content(target_event_id: &str, body: &str) -> OutgoingContent {
    OutgoingContent {
        event_type: "m.room.message".into(),
        content: json!({
            "msgtype": "m.text",
            "body": format!("* {body}"),
            "m.new_content": {
                "msgtype": "m.text",
                "body": body,
            },
            "m.relates_to": {
                "rel_type": "m.replace",
                "event_id": target_event_id,
            },
        }),
    }
}

/// The `m.room.redaction` content.
pub fn redaction_content(target_event_id: &str, reason: Option<&str>) -> OutgoingContent {
    let mut content = json!({ "redacts": target_event_id });
    if let Some(reason) = reason {
        content["reason"] = json!(reason);
    }
    OutgoingContent {
        event_type: "m.room.redaction".into(),
        content,
    }
}

/// The `m.reaction` content: an `m.annotation` relation.
pub fn reaction_content(target_event_id: &str, key: &str) -> OutgoingContent {
    OutgoingContent {
        event_type: "m.reaction".into(),
        content: json!({
            "m.relates_to": {
                "rel_type": "m.annotation",
                "event_id": target_event_id,
                "key": key,
            },
        }),
    }
}

/// The `m.room.message` content for a reply.
pub fn reply_content(target_event_id: &str, body: &str) -> OutgoingContent {
    OutgoingContent {
        event_type: "m.room.message".into(),
        content: json!({
            "msgtype": "m.text",
            "body": body,
            "m.relates_to": {
                "m.in_reply_to": { "event_id": target_event_id },
            },
        }),
    }
}

/// The `m.room.message` content for an uploaded file.
pub fn media_content(body: &str, mxc_uri: &str, mime_type: &str) -> OutgoingContent {
    // The `msgtype` follows the mime type so a client renders the file inline
    // rather than as a download link.
    let msgtype = if mime_type.starts_with("image/") {
        "m.image"
    } else if mime_type.starts_with("video/") {
        "m.video"
    } else if mime_type.starts_with("audio/") {
        "m.audio"
    } else {
        "m.file"
    };
    OutgoingContent {
        event_type: "m.room.message".into(),
        content: json!({
            "msgtype": msgtype,
            "body": body,
            "url": mxc_uri,
            "info": { "mimetype": mime_type },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_carries_the_new_content_and_the_fallback() {
        let content = edit_content("$original", "corrected");
        assert_eq!(content.content["m.new_content"]["body"], "corrected");
        assert_eq!(content.content["body"], "* corrected");
        assert_eq!(content.content["m.relates_to"]["rel_type"], "m.replace");
        assert_eq!(content.content["m.relates_to"]["event_id"], "$original");
    }

    #[test]
    fn a_redaction_names_its_target_and_reason() {
        let content = redaction_content("$spam", Some("abuse"));
        assert_eq!(content.event_type, "m.room.redaction");
        assert_eq!(content.content["redacts"], "$spam");
        assert_eq!(content.content["reason"], "abuse");
    }

    #[test]
    fn a_reaction_is_an_annotation_relation() {
        let content = reaction_content("$msg", "🎉");
        assert_eq!(content.event_type, "m.reaction");
        assert_eq!(content.content["m.relates_to"]["rel_type"], "m.annotation");
        assert_eq!(content.content["m.relates_to"]["key"], "🎉");
    }

    #[test]
    fn a_reply_names_its_target() {
        let content = reply_content("$root", "yes");
        assert_eq!(
            content.content["m.relates_to"]["m.in_reply_to"]["event_id"],
            "$root"
        );
    }

    #[test]
    fn a_media_message_type_follows_the_mime_type() {
        assert_eq!(
            media_content("a.png", "mxc://x/y", "image/png").content["msgtype"],
            "m.image"
        );
        assert_eq!(
            media_content("a.mov", "mxc://x/y", "video/quicktime").content["msgtype"],
            "m.video"
        );
        assert_eq!(
            media_content("a.zip", "mxc://x/y", "application/zip").content["msgtype"],
            "m.file"
        );
    }
}
