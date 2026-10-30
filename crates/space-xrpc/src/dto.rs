//! Wire DTOs.
//!
//! Field order is part of the contract: the appserver builds each response
//! object in a fixed insertion order, and `JSON.stringify` preserves it. The
//! structs below follow that order so a response is byte-identical, not merely
//! equal after parsing.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;

// ─── Messages ─────────────────────────────────────────────────────────────

/// One reaction group's count, and the caller's own reaction when there is one.
#[derive(Debug, Clone, Serialize)]
pub struct ReactionDto {
    pub emoji: String,
    pub count: usize,
    #[serde(rename = "myReactionId", skip_serializing_if = "Option::is_none")]
    pub my_reaction_id: Option<String>,
}

/// A link attachment's derived view, as the `linkEmbeds` array carries it.
#[derive(Debug, Clone, Serialize)]
pub struct LinkEmbedDto {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed: Option<Box<RawValue>>,
}

/// A media attachment's derived view, as the `media` array carries it.
#[derive(Debug, Clone, Serialize)]
pub struct MediaDto {
    pub url: String,
    #[serde(rename = "type")]
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// One attachment of a message, tagged with its lexicon type.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "$type")]
pub enum Attachment {
    #[serde(rename = "space.roomy.attachment.reply.v0")]
    Reply {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    #[serde(rename = "space.roomy.attachment.forward.v0")]
    Forward {
        #[serde(rename = "messageId")]
        message_id: String,
        name: String,
        #[serde(rename = "roomId")]
        room_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<Box<MessageDto>>,
    },
    #[serde(rename = "space.roomy.attachment.image.v0")]
    Image {
        url: String,
        #[serde(rename = "type")]
        media_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        blurhash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<i64>,
    },
    #[serde(rename = "space.roomy.attachment.video.v0")]
    Video {
        url: String,
        #[serde(rename = "type")]
        media_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        length: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        blurhash: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<i64>,
    },
    #[serde(rename = "space.roomy.attachment.file.v0")]
    File {
        url: String,
        #[serde(rename = "type")]
        media_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<i64>,
    },
    #[serde(rename = "space.roomy.attachment.link.v0")]
    Link {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        embed: Option<Box<RawValue>>,
    },
    #[serde(rename = "space.roomy.attachment.tile.v0")]
    Tile {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Box<RawValue>>,
    },
}

/// Where a forwarded message came from, and the original when it resolved.
#[derive(Debug, Clone, Serialize)]
pub struct ForwardedFrom {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub name: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Box<MessageDto>>,
}

/// A rendered message.
///
/// Field order is fixed at assembly, but the appserver hydrates profiles
/// *after* assembly: a handle or avatar that the per-space join did not supply
/// is assigned onto the finished object, so it serialises at the end. The
/// `*_at_assembly` flags model that split; the custom `Serialize` below is what
/// makes the body byte-identical.
#[derive(Debug, Clone)]
pub struct FullMessage {
    pub id: String,
    pub sort_idx: Option<String>,
    pub content: String,
    pub mime_type: Option<String>,
    pub author_did: String,
    pub author_name: String,
    pub author_handle: Option<String>,
    pub author_avatar: Option<String>,
    pub author_handle_at_assembly: bool,
    pub author_avatar_at_assembly: bool,
    pub system: Option<bool>,
    pub timestamp: String,
    pub last_edit: Option<String>,
    pub attachments: Vec<Attachment>,
    pub reply_to: Option<String>,
    pub forwarded_from: Option<ForwardedFrom>,
    pub reactions: Vec<ReactionDto>,
    pub media: Vec<MediaDto>,
    pub link_embeds: Vec<LinkEmbedDto>,
}

impl Serialize for FullMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let trailing_handle = !self.author_handle_at_assembly && self.author_handle.is_some();
        let trailing_avatar = !self.author_avatar_at_assembly && self.author_avatar.is_some();
        let fields = 9
            + usize::from(self.sort_idx.is_some())
            + usize::from(self.mime_type.is_some())
            + usize::from(self.author_handle_at_assembly && self.author_handle.is_some())
            + usize::from(self.author_avatar_at_assembly && self.author_avatar.is_some())
            + usize::from(self.system.is_some())
            + usize::from(self.last_edit.is_some())
            + usize::from(self.reply_to.is_some())
            + usize::from(self.forwarded_from.is_some())
            + usize::from(trailing_handle)
            + usize::from(trailing_avatar);

        let mut state = serializer.serialize_struct("FullMessage", fields)?;
        state.serialize_field("id", &self.id)?;
        if let Some(sort_idx) = &self.sort_idx {
            state.serialize_field("sort_idx", sort_idx)?;
        }
        state.serialize_field("content", &self.content)?;
        if let Some(mime_type) = &self.mime_type {
            state.serialize_field("mimeType", mime_type)?;
        }
        state.serialize_field("authorDid", &self.author_did)?;
        state.serialize_field("authorName", &self.author_name)?;
        if self.author_handle_at_assembly {
            if let Some(handle) = &self.author_handle {
                state.serialize_field("authorHandle", handle)?;
            }
        }
        if self.author_avatar_at_assembly {
            if let Some(avatar) = &self.author_avatar {
                state.serialize_field("authorAvatar", avatar)?;
            }
        }
        if let Some(system) = &self.system {
            state.serialize_field("system", system)?;
        }
        state.serialize_field("timestamp", &self.timestamp)?;
        if let Some(last_edit) = &self.last_edit {
            state.serialize_field("lastEdit", last_edit)?;
        }
        state.serialize_field("attachments", &self.attachments)?;
        if let Some(reply_to) = &self.reply_to {
            state.serialize_field("replyTo", reply_to)?;
        }
        if let Some(forwarded_from) = &self.forwarded_from {
            state.serialize_field("forwardedFrom", forwarded_from)?;
        }
        state.serialize_field("reactions", &self.reactions)?;
        state.serialize_field("media", &self.media)?;
        state.serialize_field("linkEmbeds", &self.link_embeds)?;
        if trailing_handle {
            state.serialize_field("authorHandle", &self.author_handle)?;
        }
        if trailing_avatar {
            state.serialize_field("authorAvatar", &self.author_avatar)?;
        }
        state.end()
    }
}

/// `blockedTombstone`: identity and ordering kept, body and attachments gone.
#[derive(Debug, Clone, Serialize)]
pub struct BlockedMessage {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_idx: Option<String>,
    pub content: String,
    #[serde(rename = "authorDid")]
    pub author_did: String,
    #[serde(rename = "authorName")]
    pub author_name: String,
    pub blocked: bool,
    pub timestamp: String,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<ReactionDto>,
    pub media: Vec<MediaDto>,
    #[serde(rename = "linkEmbeds")]
    pub link_embeds: Vec<LinkEmbedDto>,
}

/// A message as a response carries it: rendered, or a blocked tombstone.
#[derive(Debug, Clone)]
pub enum MessageDto {
    Full(FullMessage),
    Blocked(BlockedMessage),
}

impl MessageDto {
    /// The message's id.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            MessageDto::Full(m) => &m.id,
            MessageDto::Blocked(m) => &m.id,
        }
    }

    /// The message's ordering key and its id, as `(key, id)`.
    #[must_use]
    pub fn key(&self) -> (&str, &str) {
        match self {
            MessageDto::Full(m) => (m.sort_idx.as_deref().unwrap_or(&m.id), &m.id),
            MessageDto::Blocked(m) => (m.sort_idx.as_deref().unwrap_or(&m.id), &m.id),
        }
    }

    /// The DID that wrote the message.
    #[must_use]
    pub fn author_did(&self) -> &str {
        match self {
            MessageDto::Full(m) => &m.author_did,
            MessageDto::Blocked(m) => &m.author_did,
        }
    }
}

impl Serialize for MessageDto {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MessageDto::Full(m) => m.serialize(serializer),
            MessageDto::Blocked(m) => m.serialize(serializer),
        }
    }
}

// ─── Threads and rooms ────────────────────────────────────────────────────

/// One participant quoted by a room activity row.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadMember {
    pub did: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
}

/// A message quoted as a thread's latest.
#[derive(Debug, Clone, Serialize)]
pub struct ThreadMessage {
    pub id: String,
    pub content: String,
    pub author: ThreadMember,
    pub timestamp: Option<String>,
}

/// One room's activity, as the boards emit it.
///
/// `latestMembers` is always present; `latestTimestamp` and `latestMessage` are
/// assigned after it in the appserver, so they follow in that order.
#[derive(Debug, Clone, Serialize)]
pub struct RoomActivityDto {
    #[serde(rename = "latestMembers")]
    pub latest_members: Vec<ThreadMember>,
    #[serde(rename = "latestTimestamp", skip_serializing_if = "Option::is_none")]
    pub latest_timestamp: Option<String>,
    #[serde(rename = "latestMessage", skip_serializing_if = "Option::is_none")]
    pub latest_message: Option<ThreadMessage>,
}

/// A row on the space index board (`space.getThreads`).
#[derive(Debug, Clone, Serialize)]
pub struct SpaceThreadRow {
    pub id: String,
    pub kind: String,
    pub activity: RoomActivityDto,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    pub unread: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(rename = "channelName", skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

/// A row on a channel's thread list (`room.getThreads`).
#[derive(Debug, Clone, Serialize)]
pub struct RoomThreadRow {
    pub id: String,
    pub activity: RoomActivityDto,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    pub unread: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "canonicalParent", skip_serializing_if = "Option::is_none")]
    pub canonical_parent: Option<String>,
}

// ─── Sidebar (space.getMetadata) ──────────────────────────────────────────

/// An engaged thread the sidebar offers as active.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveSidebarThread {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub activity: ActiveThreadActivity,
    #[serde(rename = "canRead")]
    pub can_read: bool,
    #[serde(rename = "canWrite")]
    pub can_write: bool,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    #[serde(rename = "lastRead")]
    pub last_read: Option<String>,
}

/// The activity of a thread listed under its channel.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveThreadActivity {
    #[serde(rename = "latestTimestamp")]
    pub latest_timestamp: Option<String>,
    #[serde(rename = "latestMembers")]
    pub latest_members: Vec<ThreadMember>,
}

/// One channel or voice room on the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct SidebarChannel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "defaultAccess")]
    pub default_access: String,
    #[serde(rename = "canRead")]
    pub can_read: bool,
    #[serde(rename = "canWrite")]
    pub can_write: bool,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    #[serde(rename = "lastRead", skip_serializing_if = "Option::is_none")]
    pub last_read: Option<String>,
    #[serde(rename = "activeThreads", skip_serializing_if = "Option::is_none")]
    pub active_threads: Option<Vec<ActiveSidebarThread>>,
}

/// One sidebar category and its channels, in config order.
#[derive(Debug, Clone, Serialize)]
pub struct SidebarCategory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub position: usize,
    pub channels: Vec<SidebarChannel>,
}

/// A space's sidebar: its categories, in config order, and the channels no
/// category lists.
#[derive(Debug, Clone, Serialize)]
pub struct Sidebar {
    pub categories: Vec<SidebarCategory>,
    pub orphans: Vec<SidebarChannel>,
}

/// A space's join policy.
#[derive(Debug, Clone, Serialize)]
pub struct JoinPolicy {
    #[serde(rename = "allowPublicJoin")]
    pub allow_public_join: bool,
    #[serde(rename = "allowMemberInvites")]
    pub allow_member_invites: bool,
}

/// A deleted channel, listed only when `includeDeleted` is set.
#[derive(Debug, Clone, Serialize)]
pub struct DeletedRoom {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `space.getMetadata`: the space's fields, the caller's standing and sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct SpaceMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(rename = "joinPolicy")]
    pub join_policy: JoinPolicy,
    #[serde(rename = "suggestToOthers", skip_serializing_if = "Option::is_none")]
    pub suggest_to_others: Option<bool>,
    #[serde(rename = "isMember")]
    pub is_member: bool,
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    #[serde(rename = "unreadRoomCount")]
    pub unread_room_count: i64,
    #[serde(rename = "unreadThreadCount")]
    pub unread_thread_count: i64,
    pub sidebar: Sidebar,
    #[serde(rename = "voiceRooms")]
    pub voice_rooms: Vec<SidebarChannel>,
    #[serde(rename = "deletedRooms", skip_serializing_if = "Option::is_none")]
    pub deleted_rooms: Option<Vec<DeletedRoom>>,
}

// ─── Responses ────────────────────────────────────────────────────────────

/// `room.getMessages`: one page of messages and the cursor for the next.
#[derive(Debug, Clone, Serialize)]
pub struct GetMessagesResult {
    pub messages: Vec<MessageDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// `space.getThreads`: one page of the space's channels and threads.
#[derive(Debug, Clone, Serialize)]
pub struct GetSpaceThreadsResult {
    pub rooms: Vec<SpaceThreadRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// `room.getThreads`: one page of a channel's threads.
#[derive(Debug, Clone, Serialize)]
pub struct GetRoomThreadsResult {
    pub threads: Vec<RoomThreadRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One row of a link index: the link, the message that carried it, and its card.
#[derive(Debug, Clone, Serialize)]
pub struct LinkRow {
    pub url: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed: Option<Box<RawValue>>,
}

/// `room.getLinks` and `space.getLinks`: one page of link rows.
#[derive(Debug, Clone, Serialize)]
pub struct GetLinksResult {
    pub links: Vec<LinkRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// One participant of a reaction, with the profile fields the store supplied.
#[derive(Debug, Clone, Serialize)]
pub struct ReactorInfo {
    pub did: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

/// One emoji and everyone who reacted with it, in reaction order.
#[derive(Debug, Clone, Serialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub reactors: Vec<ReactorInfo>,
}

/// `message.getReactions`: every reaction on the message, grouped by emoji.
#[derive(Debug, Clone, Serialize)]
pub struct GetReactionsResult {
    pub reactions: Vec<ReactionGroup>,
}

/// `room.getMetadata`: the room's identity, kind and the caller's access.
#[derive(Debug, Clone, Serialize)]
pub struct RoomMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: String,
    #[serde(rename = "spaceId")]
    pub space_id: String,
    #[serde(rename = "parentChannelId", skip_serializing_if = "Option::is_none")]
    pub parent_channel_id: Option<String>,
    #[serde(rename = "defaultAccess")]
    pub default_access: String,
    #[serde(rename = "canRead")]
    pub can_read: bool,
    #[serde(rename = "canWrite")]
    pub can_write: bool,
    #[serde(rename = "lastRead", skip_serializing_if = "Option::is_none")]
    pub last_read: Option<String>,
    #[serde(rename = "unreadCount")]
    pub unread_count: i64,
    #[serde(rename = "unreadThreadCount")]
    pub unread_thread_count: i64,
}
