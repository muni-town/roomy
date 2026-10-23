//! The op sets, one per direction.
//!
//! An op is a decision the machine made, expressed as a value. Adapters execute
//! it. Two enums rather than one because the two sides share almost no fields:
//! a Roomy op is addressed by ULID and attributed with a ghost DID, a Matrix op
//! by event id and sent as a ghost MXID. One union would be a union of
//! everything that is different.

use serde::{Deserialize, Serialize};

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
        roomy_room_id: RoomyRoomId,
        /// The DID the message is attributed to, via `authorOverride`.
        author: GhostDid,
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
        roomy_room_id: RoomyRoomId,
        target: RoomyEventId,
        body: String,
        timestamp: Millis,
    },
    /// Delete a message.
    Redact {
        roomy_room_id: RoomyRoomId,
        target: RoomyEventId,
        reason: Option<String>,
    },
    /// Add a reaction attributed to `author`.
    React {
        roomy_room_id: RoomyRoomId,
        target: RoomyEventId,
        emoji: String,
        author: GhostDid,
        origin: Option<MatrixOrigin>,
    },
    /// Remove a reaction.
    Unreact {
        roomy_room_id: RoomyRoomId,
        /// The `addBridgedReaction` event id to undo.
        reaction_id: RoomyEventId,
        author: GhostDid,
    },
    /// Create a Roomy room for a newly discovered Matrix room.
    CreateRoom {
        /// Allocated by the caller's id source, so a later op can address it.
        roomy_room_id: RoomyRoomId,
        name: String,
        kind: RoomyRoomKind,
        /// The thread's parent channel, for [`RoomyRoomKind::Thread`].
        parent: Option<RoomyRoomId>,
        origin: MatrixOrigin,
    },
    /// Publish a ghost's profile so attribution renders.
    SetProfile {
        did: GhostDid,
        display_name: Option<String>,
        avatar_uri: Option<String>,
    },
    /// Ask the homeserver for history before `from`.
    Backfill {
        matrix_room_id: MatrixRoomId,
        from: Option<BackfillCursor>,
        limit: u32,
    },
}

/// Which Roomy room kind an op targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomyRoomKind {
    Channel,
    Thread,
    Category,
}

/// Where a message or room came from on the Matrix side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixOrigin {
    pub room_id: MatrixRoomId,
    pub event_id: Option<MatrixEventId>,
    pub origin_server_ts: Option<Millis>,
}

/// Media already uploaded to the bridge's PDS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaRef {
    /// `atblob://<bridge did>/<cid>`.
    pub uri: String,
    pub mime_type: String,
    pub name: Option<String>,
    pub size: Option<u64>,
}

/// Something to do on the Matrix side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MatrixOp {
    /// Send a message as a ghost.
    Send {
        matrix_room_id: MatrixRoomId,
        /// The ghost to send as. `None` means the bridge's own account, used
        /// when a Roomy author has no Matrix counterpart.
        sender: Option<GhostMxid>,
        body: String,
        /// Resolved and uploaded by the adapter, as `mxc://` URIs.
        media: Vec<MatrixMedia>,
        /// The Matrix event this replies to.
        reply_to: Option<MatrixEventId>,
    },
    /// Edit a message: `m.replace` with the newest content.
    Edit {
        matrix_room_id: MatrixRoomId,
        target: MatrixEventId,
        body: String,
    },
    /// Redact a message.
    Redact {
        matrix_room_id: MatrixRoomId,
        target: MatrixEventId,
        reason: Option<String>,
    },
    /// Add an annotation reaction.
    React {
        matrix_room_id: MatrixRoomId,
        target: MatrixEventId,
        key: String,
        /// The ghost that reacted. `None` means the bridge's own account.
        sender: Option<GhostMxid>,
    },
    /// Redact a reaction event.
    Unreact {
        matrix_room_id: MatrixRoomId,
        target: MatrixEventId,
        /// The ghost that reacted. `None` means the bridge's own account.
        sender: Option<GhostMxid>,
    },
    /// Join a ghost to a room so it can send and appear in the member list.
    JoinAsGhost {
        matrix_room_id: MatrixRoomId,
        mxid: GhostMxid,
        display_name: Option<String>,
        avatar_url: Option<String>,
    },
}

/// Media uploaded to the homeserver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatrixMedia {
    /// `mxc://server/id`.
    pub mxc_uri: String,
    pub mime_type: String,
    pub name: Option<String>,
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

    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, op: Op) {
        self.ops.push(op);
    }

    pub fn extend(&mut self, ops: impl IntoIterator<Item = Op>) {
        self.ops.extend(ops);
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Op> {
        self.ops.iter()
    }

    /// Split into batches the appserver will accept.
    pub fn chunks(self) -> Vec<Vec<Op>> {
        self.ops
            .chunks(Self::MAX_BATCH)
            .map(|chunk| chunk.to_vec())
            .collect()
    }

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
}
