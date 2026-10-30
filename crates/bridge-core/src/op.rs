//! The op sets, one per direction.
//!
//! An op is a decision the machine made, expressed as a value. Adapters execute
//! it. Two enums rather than one because the two sides share almost no fields:
//! a Roomy op is addressed by ULID and attributed with a ghost DID, a Matrix op
//! by event id and sent as a ghost MXID. One union would be a union of
//! everything that is different.

use serde::{Deserialize, Serialize};

use crate::dedupe::{Mapping, MappingKind};
use crate::ids::{
    BackfillCursor, GhostDid, GhostMxid, MatrixEventId, MatrixRoomId, RoomyEventId, RoomyRoomId,
};
use crate::Millis;

/// Something to do on the Roomy side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Post a message.
    Send {
        /// The Roomy room to post into.
        roomy_room_id: RoomyRoomId,
        /// The DID the message is attributed to, via `authorOverride`.
        author: GhostDid,
        /// The message body, as Markdown.
        body: String,
        /// Media already uploaded to the bridge's PDS as `atblob://` refs.
        attachments: Vec<MediaRef>,
        /// The Roomy message this replies to, when the source was a reply.
        reply_to: Option<RoomyEventId>,
        /// The source's timestamp, sent as `timestampOverride` so backfilled
        /// history sorts where it belongs rather than at the tip.
        timestamp: Millis,
        /// The Matrix event this came from, stamped as
        /// `matrixMessageOrigin.v0` so a re-materialised space still
        /// suppresses the echo.
        origin: Option<MatrixOrigin>,
    },
    /// Replace a message's body with the newest content.
    ///
    /// Matrix keeps the whole edit chain; Roomy keeps only the last body, so
    /// everything but the newest content is dropped by design.
    Edit {
        /// The Roomy room the message is in.
        roomy_room_id: RoomyRoomId,
        /// The Roomy message being edited.
        target: RoomyEventId,
        /// The new message body, as Markdown.
        body: String,
        /// The edit's timestamp, sent as `timestampOverride`.
        timestamp: Millis,
    },
    /// Delete a message.
    Redact {
        /// The Roomy room the message is in.
        roomy_room_id: RoomyRoomId,
        /// The Roomy message being deleted.
        target: RoomyEventId,
        /// The reason to record with the redaction.
        reason: Option<String>,
    },
    /// Add a reaction attributed to `author`.
    React {
        /// The Roomy room the message is in.
        roomy_room_id: RoomyRoomId,
        /// The Roomy message being reacted to.
        target: RoomyEventId,
        /// The reaction key, e.g. an emoji.
        emoji: String,
        /// The ghost DID the reaction is attributed to.
        author: GhostDid,
        /// The Matrix event this came from, stamped so the echo is suppressed.
        origin: Option<MatrixOrigin>,
    },
    /// Remove a reaction.
    Unreact {
        /// The Roomy room the reaction is in.
        roomy_room_id: RoomyRoomId,
        /// The `addBridgedReaction` event id to undo.
        reaction_id: RoomyEventId,
        /// The ghost DID whose reaction is removed.
        author: GhostDid,
    },
    /// Create a Roomy room for a newly discovered Matrix room.
    CreateRoom {
        /// Allocated by the caller's id source, so a later op can address it.
        roomy_room_id: RoomyRoomId,
        /// The Roomy room's name.
        name: String,
        /// Whether the room is a channel, thread or category.
        kind: RoomyRoomKind,
        /// The thread's parent channel, for [`RoomyRoomKind::Thread`].
        parent: Option<RoomyRoomId>,
        /// The Matrix room this came from.
        origin: MatrixOrigin,
    },
    /// Publish a ghost's profile so attribution renders.
    SetProfile {
        /// The ghost whose profile is published.
        did: GhostDid,
        /// The name to publish, or `None` to leave it unset.
        display_name: Option<String>,
        /// The avatar URI to publish, or `None` to leave it unset.
        avatar_uri: Option<String>,
    },
    /// Ask the homeserver for history before `from`.
    Backfill {
        /// The Matrix room to walk history for.
        matrix_room_id: MatrixRoomId,
        /// Where to continue from; `None` starts at the room's live tip.
        from: Option<BackfillCursor>,
        /// How many events to ask for.
        limit: u32,
    },
}

/// Which Roomy room kind an op targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomyRoomKind {
    /// A top-level room in a space.
    Channel,
    /// A thread under a channel.
    Thread,
    /// A sidebar category, which groups channels.
    Category,
}

/// Where a message or room came from on the Matrix side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixOrigin {
    /// The Matrix room the event happened in.
    pub room_id: MatrixRoomId,
    /// The Matrix event id, when the source has one; a room has none.
    pub event_id: Option<MatrixEventId>,
    /// The event's origin timestamp, in milliseconds.
    pub origin_server_ts: Option<Millis>,
}

/// Media already uploaded to the bridge's PDS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaRef {
    /// `atblob://<bridge did>/<cid>`.
    pub uri: String,
    /// The media's MIME type.
    pub mime_type: String,
    /// The file name, when the source had one.
    pub name: Option<String>,
    /// The size in bytes, when known.
    pub size: Option<u64>,
}

/// Something to do on the Matrix side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MatrixOp {
    /// Send a message as a ghost.
    Send {
        /// The Matrix room to send into.
        matrix_room_id: MatrixRoomId,
        /// The ghost to send as. `None` means the bridge's own account, used
        /// when a Roomy author has no Matrix counterpart.
        sender: Option<GhostMxid>,
        /// The message body, as Markdown.
        body: String,
        /// Resolved and uploaded by the adapter, as `mxc://` URIs.
        media: Vec<MatrixMedia>,
        /// The Matrix event this replies to.
        reply_to: Option<MatrixEventId>,
    },
    /// Edit a message: `m.replace` with the newest content.
    Edit {
        /// The Matrix room the message is in.
        matrix_room_id: MatrixRoomId,
        /// The Matrix event being edited.
        target: MatrixEventId,
        /// The new message body, as Markdown.
        body: String,
    },
    /// Redact a message.
    Redact {
        /// The Matrix room the message is in.
        matrix_room_id: MatrixRoomId,
        /// The Matrix event being redacted.
        target: MatrixEventId,
        /// The reason to record with the redaction.
        reason: Option<String>,
    },
    /// Add an annotation reaction.
    React {
        /// The Matrix room the message is in.
        matrix_room_id: MatrixRoomId,
        /// The Matrix event being reacted to.
        target: MatrixEventId,
        /// The reaction key, e.g. an emoji.
        key: String,
        /// The ghost that reacted. `None` means the bridge's own account.
        sender: Option<GhostMxid>,
    },
    /// Redact a reaction event.
    Unreact {
        /// The Matrix room the reaction is in.
        matrix_room_id: MatrixRoomId,
        /// The reaction event being redacted.
        target: MatrixEventId,
        /// The ghost that reacted. `None` means the bridge's own account.
        sender: Option<GhostMxid>,
    },
    /// Join a ghost to a room so it can send and appear in the member list.
    JoinAsGhost {
        /// The Matrix room to join.
        matrix_room_id: MatrixRoomId,
        /// The ghost to join.
        mxid: GhostMxid,
        /// The display name to set while joined.
        display_name: Option<String>,
        /// The avatar URL to set while joined.
        avatar_url: Option<String>,
    },
}

impl MatrixOp {
    /// The id pairing this op's write establishes, given the Roomy event that
    /// caused it and the Matrix event id the homeserver returned.
    ///
    /// The Matrix id only exists once the op has been sent, so this pairing
    /// cannot be decided before the write; what lives here is the other half —
    /// which kind of pairing the op creates. `None` means the op writes no
    /// Matrix event of its own: a ghost join is membership, not conversation,
    /// and recording it would suppress a Matrix event that never existed.
    pub fn pairing(
        &self,
        roomy_id: &str,
        matrix_id: impl Into<String>,
        created_at: Millis,
    ) -> Option<Mapping> {
        let kind = match self {
            MatrixOp::Send { .. } => MappingKind::Message,
            MatrixOp::Edit { .. } => MappingKind::Edit,
            MatrixOp::Redact { .. } => MappingKind::Redaction,
            MatrixOp::React { .. } | MatrixOp::Unreact { .. } => MappingKind::Reaction,
            MatrixOp::JoinAsGhost { .. } => return None,
        };
        Some(Mapping {
            kind,
            matrix_id: matrix_id.into(),
            roomy_id: roomy_id.to_string(),
            created_at,
        })
    }
}

/// Media uploaded to the homeserver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixMedia {
    /// `mxc://server/id`.
    pub mxc_uri: String,
    /// The media's MIME type.
    pub mime_type: String,
    /// The file name, when the source had one.
    pub name: Option<String>,
    /// The size in bytes, when known.
    pub size: Option<u64>,
}

/// A group of Roomy ops sent as one `sendEvents` batch.
///
/// The appserver caps a batch at 50 events and applies them in order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpBatch {
    ops: Vec<Op>,
}

impl OpBatch {
    /// The appserver's per-batch event cap.
    pub const MAX_BATCH: usize = 50;

    /// An empty batch.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one op.
    pub fn push(&mut self, op: Op) {
        self.ops.push(op);
    }

    /// Append every op from `ops`.
    pub fn extend(&mut self, ops: impl IntoIterator<Item = Op>) {
        self.ops.extend(ops);
    }

    /// How many ops the batch holds.
    pub fn len(&self) -> usize {
        self.ops.len()
    }

    /// Whether the batch holds no ops.
    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// The ops, in order.
    pub fn iter(&self) -> impl Iterator<Item = &Op> {
        self.ops.iter()
    }

    /// Split into batches the appserver will accept.
    #[must_use]
    pub fn chunks(self) -> Vec<Vec<Op>> {
        self.ops
            .chunks(Self::MAX_BATCH)
            .map(|chunk| chunk.to_vec())
            .collect()
    }

    /// Consume the batch and return its ops.
    pub fn into_ops(self) -> Vec<Op> {
        self.ops
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(index: usize) -> Op {
        Op::Send {
            roomy_room_id: RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            author: GhostDid::parse("did:matrix:%40a%3Aexample.org").unwrap(),
            body: index.to_string(),
            attachments: vec![],
            reply_to: None,
            timestamp: 0,
            origin: None,
        }
    }

    #[test]
    fn batches_split_at_the_appserver_cap() {
        let mut batch = OpBatch::new();
        for index in 0..51 {
            batch.push(op(index));
        }
        let chunks = batch.chunks();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), OpBatch::MAX_BATCH);
        assert_eq!(chunks[1].len(), 1);
    }

    #[test]
    fn an_empty_batch_produces_no_chunks() {
        assert!(OpBatch::new().chunks().is_empty());
    }

    #[test]
    fn a_matrix_op_names_the_pairing_its_write_creates() {
        let send = MatrixOp::Send {
            matrix_room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
            sender: None,
            body: "hi".into(),
            media: vec![],
            reply_to: None,
        };
        let mapping = send
            .pairing("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB", "$sent", 7)
            .unwrap();
        assert_eq!(mapping.kind, MappingKind::Message);
        assert_eq!(mapping.matrix_id, "$sent");
        assert_eq!(mapping.roomy_id, "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB");
        assert_eq!(mapping.created_at, 7);

        // A ghost join writes membership, not a Matrix event of its own: a
        // pairing here would suppress an event that never existed.
        let join = MatrixOp::JoinAsGhost {
            matrix_room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
            mxid: GhostMxid::parse("@_roomy_alice:example.org").unwrap(),
            display_name: None,
            avatar_url: None,
        };
        assert_eq!(join.pairing("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB", "$join", 7), None);
    }
}
