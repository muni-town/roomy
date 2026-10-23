//! Sending to Matrix, and reading a room's history.
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

use bridge_core::BackfillCursor;
use parking_lot::Mutex;

use serde_json::{json, Value};

use crate::appservice::{HomeserverClient, HomeserverError};

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

impl From<HomeserverError> for MatrixSendError {
    fn from(error: HomeserverError) -> Self {
        match &error {
            // A 4xx names the event as the problem. 429 is the exception: the
            // homeserver is asking for a later attempt, not refusing the event.
            HomeserverError::Rejected { status, .. }
                if (400..500).contains(status) && *status != 429 =>
            {
                MatrixSendError::Rejected(error.to_string())
            }
            _ => MatrixSendError::Transient(error.to_string()),
        }
    }
}

/// The URL a send goes to.
///
/// A redaction is its own endpoint: `PUT /rooms/{room}/redact/{event}`. Posting
/// it through `/send/m.room.redaction/` is refused with `M_UNRECOGNIZED`, so
/// routing it as an ordinary event type silently breaks every delete.
fn send_url(
    base_url: &str,
    room_id: &str,
    as_user: Option<&str>,
    content: &OutgoingContent,
    txn_id: &str,
) -> Result<String, HomeserverError> {
    let mut url = match content.event_type.as_str() {
        "m.room.redaction" => {
            let target = content
                .content
                .get("redacts")
                .and_then(|value| value.as_str())
                .ok_or_else(|| HomeserverError::Rejected {
                    url: format!("m.room.redaction for room {room_id}"),
                    status: 0,
                    body: "a redaction names no event".to_string(),
                })?;
            format!(
                "{}/_matrix/client/v3/rooms/{}/redact/{}/{}",
                base_url,
                percent_encode(room_id),
                percent_encode(target),
                percent_encode(txn_id)
            )
        }
        event_type => format!(
            "{}/_matrix/client/v3/rooms/{}/send/{}/{}",
            base_url,
            percent_encode(room_id),
            percent_encode(event_type),
            percent_encode(txn_id)
        ),
    };
    if let Some(user) = as_user {
        url.push_str(&format!("?user_id={}", percent_encode(user)));
    }
    Ok(url)
}

impl HomeserverClient {
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
    ) -> Result<String, HomeserverError> {
        let url = send_url(
            self.base_url(),
            room_id,
            as_user,
            &OutgoingContent {
                event_type: event_type.to_string(),
                content: content.clone(),
            },
            txn_id,
        )?;

        #[derive(serde::Deserialize)]
        struct Sent {
            #[serde(rename = "event_id")]
            event_id: String,
        }
        // Both endpoints are `PUT`: `POST /send/…` answers `M_UNRECOGNIZED`,
        // which is what an outbound message looked like before this was right.
        self.put_json::<Sent>(&url, content)
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
    ) -> Result<(Vec<Value>, Option<BackfillCursor>), HomeserverError> {
        let mut url = format!(
            "{}/_matrix/client/v3/rooms/{}/messages?dir=b&limit={}",
            self.base_url(),
            percent_encode(room_id),
            limit
        );
        match from {
            Some(token) => url.push_str(&format!("&from={}", percent_encode(token.as_str()))),
            // With no token the homeserver starts at the room's live edge,
            // which is the correct place for the first page of a recent window.
            None => url.push_str("&from="),
        }

        #[derive(serde::Deserialize)]
        struct Page {
            #[serde(default)]
            chunk: Vec<Value>,
            #[serde(default)]
            end: Option<String>,
        }
        let page = self.get_json::<Page>(&url).await?;

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
    pub async fn room_encrypted(&self, room_id: &str) -> Result<bool, HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/state/m.room.encryption",
            self.base_url(),
            percent_encode(room_id)
        );
        match self.get_json::<Value>(&url).await {
            Ok(state) => Ok(state
                .get("algorithm")
                .and_then(|algorithm| algorithm.as_str())
                .is_some()),
            // A room with no encryption state answers 404, which is "not
            // encrypted" rather than a failure to find out.
            Err(HomeserverError::Rejected { .. }) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// A room's joined members, which the crypto layer needs to share a key.
    pub async fn joined_members(&self, room_id: &str) -> Result<Vec<String>, HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/joined_members",
            self.base_url(),
            percent_encode(room_id)
        );
        #[derive(serde::Deserialize)]
        struct Joined {
            #[serde(default)]
            joined: std::collections::BTreeMap<String, Value>,
        }
        self.get_json::<Joined>(&url)
            .await
            .map(|joined| joined.joined.into_keys().collect())
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

/// Percent-encode a path segment.
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
    fn a_redaction_targets_the_redact_endpoint() {
        // `/send/m.room.redaction/` answers M_UNRECOGNIZED, which is how every
        // delete was silently dropped before this was routed correctly.
        let url = send_url(
            "http://hs:8008",
            "!room:example.org",
            None,
            &redaction_content("$target", None),
            "txn",
        )
        .expect("the redaction names its target");
        assert_eq!(
            url,
            "http://hs:8008/_matrix/client/v3/rooms/%21room%3Aexample.org/redact/%24target/txn",
            "a redaction goes to /redact/<event>, not /send/<type>"
        );
    }

    #[test]
    fn an_ordinary_message_targets_the_send_endpoint() {
        let url = send_url(
            "http://hs:8008",
            "!room:example.org",
            Some("@alice:example.org"),
            &text_content("hi"),
            "txn",
        )
        .expect("a message needs no target");
        assert_eq!(
            url,
            "http://hs:8008/_matrix/client/v3/rooms/%21room%3Aexample.org/send/m.room.message/txn\
             ?user_id=%40alice%3Aexample.org"
        );
    }

    #[test]
    fn a_redaction_without_a_target_is_refused() {
        let broken = OutgoingContent {
            event_type: "m.room.redaction".into(),
            content: json!({}),
        };
        assert!(send_url("http://hs:8008", "!room:example.org", None, &broken, "txn").is_err());
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
