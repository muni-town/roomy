//! Roomy extension objects and the maps that carry them.
//!
//! Extensions are the only way the protocol attaches bridge metadata to an
//! event, so this module is where the origin stamps live. Two facts shape it:
//!
//! * The wire form is a **map keyed by `$type`** (`{"space.roomy.extension.
//!   authorOverride.v0": {...}}`), not a list, and the SDK validates it with a
//!   strict union of known keys. Unknown keys are therefore not representable
//!   in the typed form; [`ExtensionBag`] exists for the events that declare
//!   `extensions: Record<string, unknown>` (the bridged reactions), where the
//!   set is open.
//! * `authorOverride` and `timestampOverride` are how a bridge attributes a
//!   message to someone who is not the sender. Both are only accepted from a
//!   space admin, which is why the bridge account must be one.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{Did, Ulid};
use crate::ATTACHMENT_REPLY;

/// `space.roomy.extension.authorOverride.v0` — attribute the message to `did`
/// instead of the sending account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorOverride {
    pub did: Did,
}

/// `space.roomy.extension.timestampOverride.v0` — set the message's canonical
/// time, which the appserver folds into `sort_idx` so backfilled history lands
/// chronologically instead of at the tip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimestampOverride {
    /// Milliseconds since the unix epoch.
    pub timestamp: i64,
}

/// `space.roomy.extension.matrixOrigin.v0` — the Matrix room a Roomy room was
/// bridged from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixOrigin {
    /// The Matrix room id, e.g. `!abc:example.org`.
    #[serde(rename = "roomId")]
    pub room_id: String,
    /// The Matrix event that created the room, when known.
    #[serde(rename = "eventId", skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    /// The Matrix `origin_server_ts` of that event, when known.
    #[serde(rename = "originServerTs", skip_serializing_if = "Option::is_none")]
    pub origin_server_ts: Option<i64>,
}

/// `space.roomy.extension.matrixMessageOrigin.v0` — the Matrix event a Roomy
/// message was bridged from.
///
/// This is what makes echo suppression survive a bridge database loss: a
/// re-materialised space still carries the origin, so the bridge recognises its
/// own messages instead of relaying them back to Matrix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixMessageOrigin {
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "eventId", skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(rename = "originServerTs", skip_serializing_if = "Option::is_none")]
    pub origin_server_ts: Option<i64>,
}

/// Keys of the extensions this crate knows by name.
pub mod key {
    /// `space.roomy.extension.authorOverride.v0`.
    pub const AUTHOR_OVERRIDE: &str = "space.roomy.extension.authorOverride.v0";
    /// `space.roomy.extension.timestampOverride.v0`.
    pub const TIMESTAMP_OVERRIDE: &str = "space.roomy.extension.timestampOverride.v0";
    /// `space.roomy.extension.attachments.v0`.
    pub const ATTACHMENTS: &str = "space.roomy.extension.attachments.v0";
    /// `space.roomy.extension.matrixOrigin.v0`.
    pub const MATRIX_ORIGIN: &str = "space.roomy.extension.matrixOrigin.v0";
    /// `space.roomy.extension.matrixMessageOrigin.v0`.
    pub const MATRIX_MESSAGE_ORIGIN: &str = "space.roomy.extension.matrixMessageOrigin.v0";
}

/// A reply attachment: `space.roomy.attachment.reply.v0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    /// The message being replied to.
    pub target: Ulid,
}

/// An image attachment: `space.roomy.attachment.image.v0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// A video attachment: `space.roomy.attachment.video.v0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoAttachment {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// A generic file attachment: `space.roomy.attachment.file.v0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileAttachment {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// One entry of an `attachments` extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "$type")]
pub enum Attachment {
    #[serde(rename = "space.roomy.attachment.reply.v0")]
    Reply(Reply),
    #[serde(rename = "space.roomy.attachment.image.v0")]
    Image(ImageAttachment),
    #[serde(rename = "space.roomy.attachment.video.v0")]
    Video(VideoAttachment),
    #[serde(rename = "space.roomy.attachment.file.v0")]
    File(FileAttachment),
}

impl Attachment {
    /// The attachment's `$type`.
    #[must_use]
    pub fn nsid(&self) -> &'static str {
        match self {
            Attachment::Reply(_) => ATTACHMENT_REPLY,
            Attachment::Image(_) => "space.roomy.attachment.image.v0",
            Attachment::Video(_) => "space.roomy.attachment.video.v0",
            Attachment::File(_) => "space.roomy.attachment.file.v0",
        }
    }
}

impl From<Reply> for Attachment {
    fn from(value: Reply) -> Self {
        Attachment::Reply(value)
    }
}

impl From<ImageAttachment> for Attachment {
    fn from(value: ImageAttachment) -> Self {
        Attachment::Image(value)
    }
}

impl From<VideoAttachment> for Attachment {
    fn from(value: VideoAttachment) -> Self {
        Attachment::Video(value)
    }
}

impl From<FileAttachment> for Attachment {
    fn from(value: FileAttachment) -> Self {
        Attachment::File(value)
    }
}

/// The extension map of a message event.
///
/// Fields are `Option` because an absent key means "no such extension"; serde
/// writes only the ones that are set, under their wire key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageExtensions {
    #[serde(
        rename = "space.roomy.extension.authorOverride.v0",
        skip_serializing_if = "Option::is_none"
    )]
    pub author_override: Option<AuthorOverride>,
    #[serde(
        rename = "space.roomy.extension.timestampOverride.v0",
        skip_serializing_if = "Option::is_none"
    )]
    pub timestamp_override: Option<TimestampOverride>,
    #[serde(
        rename = "space.roomy.extension.attachments.v0",
        skip_serializing_if = "Option::is_none"
    )]
    pub attachments: Option<AttachmentsExtension>,
    #[serde(
        rename = "space.roomy.extension.matrixMessageOrigin.v0",
        skip_serializing_if = "Option::is_none"
    )]
    pub matrix_message_origin: Option<MatrixMessageOrigin>,
}

impl MessageExtensions {
    /// The Matrix origin stamped on this message, if any.
    pub fn matrix_origin(&self) -> Option<&MatrixMessageOrigin> {
        self.matrix_message_origin.as_ref()
    }

    /// True when the event carries an author override pointing at `did`.
    #[must_use]
    pub fn authored_by(&self, did: &Did) -> bool {
        self.author_override.as_ref().is_some_and(|a| &a.did == did)
    }
}

/// The `attachments` extension: `{ $type, attachments: [...] }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentsExtension {
    #[serde(rename = "$type")]
    pub type_: String,
    pub attachments: Vec<Attachment>,
}

impl AttachmentsExtension {
    /// An attachments extension holding `attachments`.
    #[must_use]
    pub fn new(attachments: Vec<Attachment>) -> Self {
        Self {
            type_: key::ATTACHMENTS.to_string(),
            attachments,
        }
    }

    /// Every `atblob://` or `http(s)://` ref this extension carries, paired
    /// with its mime type — what the bridge downloads to send as Matrix media.
    #[must_use]
    pub fn media_refs(&self) -> Vec<(&str, &str)> {
        self.attachments
            .iter()
            .filter_map(|attachment| match attachment {
                Attachment::Image(i) => Some((i.uri.as_str(), i.mime_type.as_str())),
                Attachment::Video(v) => Some((v.uri.as_str(), v.mime_type.as_str())),
                Attachment::File(f) => Some((f.uri.as_str(), f.mime_type.as_str())),
                Attachment::Reply(_) => None,
            })
            .collect()
    }

    /// The reply target, if the message is a reply.
    pub fn reply_target(&self) -> Option<&Ulid> {
        self.attachments
            .iter()
            .find_map(|attachment| match attachment {
                Attachment::Reply(reply) => Some(&reply.target),
                _ => None,
            })
    }
}

/// The extension map of a room event.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RoomExtensions {
    #[serde(
        rename = "space.roomy.extension.matrixOrigin.v0",
        skip_serializing_if = "Option::is_none"
    )]
    pub matrix_origin: Option<MatrixOrigin>,
}

impl RoomExtensions {
    /// Stamp a room with its Matrix origin.
    #[must_use]
    pub fn with_matrix_origin(origin: MatrixOrigin) -> Self {
        Self {
            matrix_origin: Some(origin),
        }
    }
}

/// An open extension map, for the event types that declare
/// `extensions: Record<string, unknown>`.
///
/// The bridged-reaction events use this shape because a platform may attach
/// arbitrary correlation data. Keys are ordered so two bags with the same
/// content encode identically, which keeps golden comparisons stable.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExtensionBag(BTreeMap<String, Value>);

impl ExtensionBag {
    /// An empty bag.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// `value` under `key`, replacing whatever was there.
    #[must_use]
    pub fn insert(mut self, key: impl Into<String>, value: Value) -> Self {
        self.0.insert(key.into(), value);
        self
    }

    /// Stamp the Matrix message origin into the bag.
    #[must_use]
    pub fn with_matrix_message_origin(self, origin: &MatrixMessageOrigin) -> Self {
        self.insert(
            key::MATRIX_MESSAGE_ORIGIN,
            serde_json::to_value(origin).expect("origin serialises"),
        )
    }

    /// The value stored under `key`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// The Matrix origin this bag carries, if the value is shaped like one.
    #[must_use]
    pub fn matrix_origin(&self) -> Option<MatrixMessageOrigin> {
        self.0
            .get(key::MATRIX_MESSAGE_ORIGIN)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    }

    /// Whether the bag carries no extensions.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The bag's entries, ordered by key.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_extensions_serialise_under_their_wire_keys() {
        let extensions = MessageExtensions {
            author_override: Some(AuthorOverride {
                did: Did::parse("did:matrix:%40bob%3Aexample.org").unwrap(),
            }),
            timestamp_override: Some(TimestampOverride {
                timestamp: 1_700_000_000_000,
            }),
            attachments: Some(AttachmentsExtension::new(vec![Reply {
                target: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            }
            .into()])),
            matrix_message_origin: Some(MatrixMessageOrigin {
                room_id: "!room:example.org".into(),
                event_id: Some("$evt".into()),
                origin_server_ts: Some(1_700_000_000_000),
            }),
        };

        let json = serde_json::to_value(&extensions).unwrap();
        assert!(json.get(key::AUTHOR_OVERRIDE).is_some());
        assert!(json.get(key::TIMESTAMP_OVERRIDE).is_some());
        assert!(json.get(key::ATTACHMENTS).is_some());
        assert_eq!(
            json[key::MATRIX_MESSAGE_ORIGIN]["roomId"],
            "!room:example.org"
        );
    }

    #[test]
    fn unset_extensions_are_omitted() {
        let json = serde_json::to_value(MessageExtensions::default()).unwrap();
        assert_eq!(json, serde_json::json!({}));
    }

    #[test]
    fn matrix_origin_round_trips_through_the_bag() {
        let origin = MatrixMessageOrigin {
            room_id: "!room:example.org".into(),
            event_id: None,
            origin_server_ts: Some(42),
        };
        let bag = ExtensionBag::new().with_matrix_message_origin(&origin);
        assert_eq!(bag.matrix_origin(), Some(origin));
    }

    #[test]
    fn media_refs_skip_the_reply_attachment() {
        let attachments = AttachmentsExtension::new(vec![
            Reply {
                target: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            }
            .into(),
            ImageAttachment {
                uri: "atblob://did:plc:x/cid".into(),
                mime_type: "image/png".into(),
                alt: None,
                height: None,
                width: None,
                size: None,
            }
            .into(),
        ]);
        assert_eq!(
            attachments.media_refs(),
            vec![("atblob://did:plc:x/cid", "image/png")]
        );
    }
}
