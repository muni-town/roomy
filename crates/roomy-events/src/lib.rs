//! Typed construction and encoding of Roomy events.
//!
//! Roomy events travel in two encodings and this crate exists so the bridge
//! builds them once and emits both:
//!
//! * **JSON** — `space.roomy.space.sendEvents` takes a JSON body, so every
//!   event the bridge sends to the appserver is `serde_json`-shaped.
//! * **CBOR** — the sync socket frames (`#streamEvents`) carry DRISL, so the
//!   events the bridge consumes are decoded from CBOR. Content payloads are
//!   byte strings there and `{"$bytes": "<base64>"}` in JSON; [`Bytes`]
//!   serialises to whichever the target format wants.
//!
//! There is no I/O here on purpose: everything is a value plus an encoder.

mod content;
pub mod extensions;
mod ids;

pub use content::{Bytes, Content};
pub use extensions::{
    key, Attachment, AttachmentsExtension, AuthorOverride, ExtensionBag, FileAttachment,
    ImageAttachment, MatrixMessageOrigin, MatrixOrigin, MessageExtensions, Reply, RoomExtensions,
    TimestampOverride, VideoAttachment,
};
pub use ids::{Did, Ulid};

use serde::{Deserialize, Serialize};

/// The `$type` of an event, as it appears on the wire.
pub mod nsid {
    /// A message was created.
    pub const CREATE_MESSAGE: &str = "space.roomy.message.createMessage.v0";
    /// A message's body was replaced.
    pub const EDIT_MESSAGE: &str = "space.roomy.message.editMessage.v0";
    /// A message was deleted.
    pub const DELETE_MESSAGE: &str = "space.roomy.message.deleteMessage.v0";
    /// A reaction attributed to a bridged user was added.
    pub const ADD_BRIDGED_REACTION: &str = "space.roomy.reaction.addBridgedReaction.v0";
    /// A bridged reaction was removed.
    pub const REMOVE_BRIDGED_REACTION: &str = "space.roomy.reaction.removeBridgedReaction.v0";
    /// A room was created.
    pub const CREATE_ROOM: &str = "space.roomy.room.createRoom.v0";
    /// A room's name, avatar or description changed.
    pub const UPDATE_ROOM: &str = "space.roomy.room.updateRoom.v0";
    /// A user's profile changed.
    pub const UPDATE_PROFILE: &str = "space.roomy.user.updateProfile.v0";
    /// A user joined the space.
    pub const JOIN_SPACE: &str = "space.roomy.space.joinSpace.v0";
}

/// Marks a message as a reply to another message.
pub const ATTACHMENT_REPLY: &str = "space.roomy.attachment.reply.v0";

/// The room kinds a `createRoom` event can declare.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoomKind {
    #[serde(rename = "space.roomy.channel")]
    Channel,
    #[serde(rename = "space.roomy.category")]
    Category,
    #[serde(rename = "space.roomy.thread")]
    Thread,
    #[serde(rename = "space.roomy.page")]
    Page,
    #[serde(rename = "space.roomy.voice")]
    Voice,
}

/// The default access a room grants members that have no explicit role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DefaultAccess {
    #[serde(rename = "readwrite")]
    ReadWrite,
    #[serde(rename = "read")]
    Read,
    #[serde(rename = "none")]
    None,
}

/// `space.roomy.message.createMessage.v0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateMessage {
    pub body: Content,
    pub extensions: MessageExtensions,
}

/// `space.roomy.message.editMessage.v0`. Roomy keeps only the latest content;
/// the bridge therefore sends one edit per Matrix `m.replace` with the newest
/// body and no `previous` link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditMessage {
    #[serde(rename = "messageId")]
    pub message_id: Ulid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<Ulid>,
    pub body: Content,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<MessageExtensions>,
}

/// `space.roomy.message.deleteMessage.v0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeleteMessage {
    #[serde(rename = "messageId")]
    pub message_id: Ulid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `space.roomy.reaction.addBridgedReaction.v0`. The bridged variant exists so
/// a reaction can be attributed to a DID other than the event's sender.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AddBridgedReaction {
    #[serde(rename = "reactionTo")]
    pub reaction_to: Ulid,
    pub reaction: String,
    #[serde(rename = "reactingUser")]
    pub reacting_user: Did,
    pub extensions: ExtensionBag,
}

/// `space.roomy.reaction.removeBridgedReaction.v0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoveBridgedReaction {
    #[serde(rename = "reactionId")]
    pub reaction_id: Ulid,
    #[serde(rename = "reactingUser")]
    pub reacting_user: Did,
    pub extensions: ExtensionBag,
}

/// `space.roomy.room.createRoom.v0`. The event's own ULID becomes the room id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateRoom {
    pub kind: RoomKind,
    #[serde(rename = "defaultAccess", skip_serializing_if = "Option::is_none")]
    pub default_access: Option<DefaultAccess>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<RoomExtensions>,
}

/// `space.roomy.room.updateRoom.v0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateRoom {
    #[serde(rename = "roomId")]
    pub room_id: Ulid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `space.roomy.user.updateProfile.v0`. Used to publish a bridged user's
/// profile under their ghost DID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateProfile {
    pub did: Did,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<ExtensionBag>,
}

/// The payload of an event, discriminated by `$type`.
///
/// This covers the events the bridge produces. Events it only observes are
/// decoded as [`EventKind::Other`] and passed through untouched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "$type")]
pub enum EventKind {
    #[serde(rename = "space.roomy.message.createMessage.v0")]
    CreateMessage(CreateMessage),
    #[serde(rename = "space.roomy.message.editMessage.v0")]
    EditMessage(EditMessage),
    #[serde(rename = "space.roomy.message.deleteMessage.v0")]
    DeleteMessage(DeleteMessage),
    #[serde(rename = "space.roomy.reaction.addBridgedReaction.v0")]
    AddBridgedReaction(AddBridgedReaction),
    #[serde(rename = "space.roomy.reaction.removeBridgedReaction.v0")]
    RemoveBridgedReaction(RemoveBridgedReaction),
    #[serde(rename = "space.roomy.room.createRoom.v0")]
    CreateRoom(CreateRoom),
    #[serde(rename = "space.roomy.room.updateRoom.v0")]
    UpdateRoom(UpdateRoom),
    #[serde(rename = "space.roomy.user.updateProfile.v0")]
    UpdateProfile(UpdateProfile),
    /// Any event type this crate does not model. Carried verbatim so callers
    /// can still read `$type` and the origin extensions.
    #[serde(other)]
    Other,
}

impl EventKind {
    /// The event's `$type`.
    #[must_use]
    pub fn nsid(&self) -> &'static str {
        match self {
            EventKind::CreateMessage(_) => nsid::CREATE_MESSAGE,
            EventKind::EditMessage(_) => nsid::EDIT_MESSAGE,
            EventKind::DeleteMessage(_) => nsid::DELETE_MESSAGE,
            EventKind::AddBridgedReaction(_) => nsid::ADD_BRIDGED_REACTION,
            EventKind::RemoveBridgedReaction(_) => nsid::REMOVE_BRIDGED_REACTION,
            EventKind::CreateRoom(_) => nsid::CREATE_ROOM,
            EventKind::UpdateRoom(_) => nsid::UPDATE_ROOM,
            EventKind::UpdateProfile(_) => nsid::UPDATE_PROFILE,
            EventKind::Other => "space.roomy.unknown",
        }
    }
}

/// A complete Roomy event: the envelope plus its payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// ULID that uniquely identifies the event. It is also the message id and
    /// the room id for `createRoom`.
    pub id: Ulid,
    /// The room the event is scoped to. Absent for events sent at space level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room: Option<Ulid>,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    /// An event scoped to `room`.
    #[must_use]
    pub fn in_room(id: Ulid, room: Ulid, kind: EventKind) -> Self {
        Self {
            id,
            room: Some(room),
            kind,
        }
    }

    /// An event sent at the top level of the space.
    #[must_use]
    pub fn in_space(id: Ulid, kind: EventKind) -> Self {
        Self {
            id,
            room: None,
            kind,
        }
    }

    /// The event's `$type`.
    #[must_use]
    pub fn nsid(&self) -> &'static str {
        self.kind.nsid()
    }

    /// Encode for a `sendEvents` JSON body.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("event serialises to JSON")
    }

    /// Decode from a `sendEvents`-shaped JSON value.
    ///
    /// # Errors
    ///
    /// Returns the `serde` error when the value lacks the envelope's fields or
    /// carries a payload this crate cannot decode.
    pub fn from_json(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }
}

/// A batch of events, in the shape `space.roomy.space.sendEvents` accepts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventBatch {
    #[serde(rename = "spaceId")]
    pub space_id: Did,
    pub events: Vec<Event>,
}

impl EventBatch {
    /// A batch of `events` for `space_id`.
    #[must_use]
    pub fn new(space_id: Did, events: Vec<Event>) -> Self {
        Self { space_id, events }
    }

    /// Encode the procedure body.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("batch serialises to JSON")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_message() -> Event {
        Event::in_room(
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD").unwrap(),
            EventKind::CreateMessage(CreateMessage {
                body: Content::markdown("hello from matrix"),
                extensions: MessageExtensions {
                    author_override: Some(AuthorOverride {
                        did: Did::parse("did:matrix:%40alice%3Aexample.org").unwrap(),
                    }),
                    timestamp_override: Some(TimestampOverride {
                        timestamp: 1_700_000_000_000,
                    }),
                    attachments: Some(AttachmentsExtension::new(vec![Reply {
                        target: Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0EF").unwrap(),
                    }
                    .into()])),
                    ..Default::default()
                },
            }),
        )
    }

    #[test]
    fn create_message_encodes_the_shape_the_appserver_validates() {
        let json = sample_message().to_json();
        assert_eq!(json["$type"], nsid::CREATE_MESSAGE);
        assert_eq!(json["body"]["mimeType"], "text/markdown");
        assert_eq!(json["body"]["data"]["$bytes"], "aGVsbG8gZnJvbSBtYXRyaXg=");
        assert_eq!(
            json["extensions"]["space.roomy.extension.authorOverride.v0"]["did"],
            "did:matrix:%40alice%3Aexample.org"
        );
        assert_eq!(
            json["extensions"]["space.roomy.extension.timestampOverride.v0"]["timestamp"],
            1_700_000_000_000i64
        );
        assert_eq!(
            json["extensions"]["space.roomy.extension.attachments.v0"]["attachments"][0]["$type"],
            ATTACHMENT_REPLY
        );
    }

    #[test]
    fn envelope_round_trips() {
        let event = sample_message();
        let json = event.to_json();
        let back = Event::from_json(json).unwrap();
        assert_eq!(event, back);
    }

    #[test]
    fn unknown_event_types_decode_as_other() {
        let value = serde_json::json!({
            "$type": "space.roomy.message.moveMessages.v0",
            "id": "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
            "room": "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD",
        });
        let event = Event::from_json(value).unwrap();
        assert_eq!(event.kind, EventKind::Other);
        assert_eq!(event.nsid(), "space.roomy.unknown");
    }
}
