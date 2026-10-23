//! The change record: what the materialiser reads, and the shapes each kind
//! carries.
//!
//! `RecordChange` mirrors `materialization/records/recordChange.ts`. The op
//! decides the body — `create` carries the whole record, `update` a patch,
//! `delete` nothing — and a change whose kind and body disagree is a decode
//! error rather than a rule applied to the wrong table. The collection is
//! checked against the kind for the same reason: it is the wire identity of the
//! record and the thing a consumer routes on.

use roomy_events::Did;
use serde::{Deserialize, Deserializer, Serialize};

use crate::ids::{Collection, OrderStamp, Rkey};

/// The sixteen record kinds the event log collapses onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RecordKind {
    Message,
    Reaction,
    Room,
    SpaceInfo,
    SpaceSidebar,
    Membership,
    Ban,
    Invite,
    Role,
    RoleGrant,
    RoomPermission,
    FederationRequest,
    FederationGrant,
    Profile,
    CalendarLink,
    VoiceCall,
}

/// The wire name of each kind, as the feed's `kind` column carries it.
const KIND_NAMES: [(&str, RecordKind); 16] = [
    ("message", RecordKind::Message),
    ("reaction", RecordKind::Reaction),
    ("room", RecordKind::Room),
    ("spaceInfo", RecordKind::SpaceInfo),
    ("spaceSidebar", RecordKind::SpaceSidebar),
    ("membership", RecordKind::Membership),
    ("ban", RecordKind::Ban),
    ("invite", RecordKind::Invite),
    ("role", RecordKind::Role),
    ("roleGrant", RecordKind::RoleGrant),
    ("roomPermission", RecordKind::RoomPermission),
    ("federationRequest", RecordKind::FederationRequest),
    ("federationGrant", RecordKind::FederationGrant),
    ("profile", RecordKind::Profile),
    ("calendarLink", RecordKind::CalendarLink),
    ("voiceCall", RecordKind::VoiceCall),
];

impl RecordKind {
    pub fn parse(name: &str) -> Option<Self> {
        KIND_NAMES
            .iter()
            .find(|(wire, _)| *wire == name)
            .map(|(_, kind)| *kind)
    }

    pub fn name(&self) -> &'static str {
        KIND_NAMES
            .iter()
            .find(|(_, kind)| kind == self)
            .map(|(wire, _)| *wire)
            .expect("every kind is named")
    }

    /// The kind's collection NSID — provisional except `profile`, which exists
    /// as a lexicon.
    pub fn collection(&self) -> &'static str {
        match self {
            RecordKind::Message => "space.roomy.room.message",
            RecordKind::Reaction => "space.roomy.room.reaction",
            RecordKind::Room => "space.roomy.space.room",
            RecordKind::SpaceInfo => "space.roomy.space.info",
            RecordKind::SpaceSidebar => "space.roomy.space.sidebar",
            RecordKind::Membership => "space.roomy.space.membership",
            RecordKind::Ban => "space.roomy.space.ban",
            RecordKind::Invite => "space.roomy.space.invite",
            RecordKind::Role => "space.roomy.space.role",
            RecordKind::RoleGrant => "space.roomy.space.roleGrant",
            RecordKind::RoomPermission => "space.roomy.space.roomPermission",
            RecordKind::FederationRequest => "space.roomy.federation.request",
            RecordKind::FederationGrant => "space.roomy.federation.grant",
            RecordKind::Profile => "space.roomy.user.profile",
            RecordKind::CalendarLink => "space.roomy.space.calendarLink",
            RecordKind::VoiceCall => "space.roomy.voice.call",
        }
    }
}

/// The fields every change carries, whatever its op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeBase {
    pub kind: RecordKind,
    /// The repo that owns the record — derived at ingest, never the log's
    /// stream DID.
    pub repo: Did,
    pub collection: Collection,
    pub rkey: Rkey,
    /// Assigned at ingest; sorts the log and nothing else.
    pub order_stamp: OrderStamp,
}

/// The three ops. `create` and `update` are both upserts to the projection;
/// they are distinguished by what the body holds.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordChange {
    Create {
        base: ChangeBase,
        record: RecordBody,
    },
    Update {
        base: ChangeBase,
        patch: RecordPatch,
    },
    Delete {
        base: ChangeBase,
    },
}

impl RecordChange {
    pub fn base(&self) -> &ChangeBase {
        match self {
            RecordChange::Create { base, .. }
            | RecordChange::Update { base, .. }
            | RecordChange::Delete { base } => base,
        }
    }

    pub fn kind(&self) -> RecordKind {
        self.base().kind
    }
}

/// One row of the feed, as the table holds it.
#[derive(Debug, Clone, Deserialize)]
pub struct FeedRow {
    #[serde(rename = "streamId")]
    pub stream_id: String,
    pub idx: i64,
    pub ord: i64,
    pub kind: String,
    pub repo: String,
    pub collection: String,
    pub rkey: String,
    pub op: String,
    #[serde(rename = "orderStamp")]
    pub order_stamp: String,
    pub actor: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    pub body: Option<String>,
}

/// A row that is not a change this crate can apply.
#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("unknown record kind {0}")]
    UnknownKind(String),
    #[error("unknown op {0}")]
    UnknownOp(String),
    #[error("{kind} row has collection {got}, the kind's is {expected}")]
    CollectionMismatch {
        kind: String,
        got: String,
        expected: String,
    },
    #[error("{op} row carries no body")]
    MissingBody { op: String },
    #[error("delete row carries a body")]
    UnexpectedBody,
    #[error("body is not the shape {0} carries")]
    BodyShape(String),
    #[error("not a key: {0}")]
    Key(#[from] crate::ids::KeyError),
    #[error("not a DID")]
    Did,
    #[error("body is not valid JSON: {0}")]
    Json(String),
}

/// Decode one feed row into the change it was written from.
///
/// Everything the feed asserts about itself is checked here: the kind exists,
/// the collection is the kind's, the op is one of the three, and the body is
/// present exactly when the op carries one.
pub fn decode_row(row: &FeedRow) -> Result<RecordChange, DecodeError> {
    let kind =
        RecordKind::parse(&row.kind).ok_or_else(|| DecodeError::UnknownKind(row.kind.clone()))?;
    let collection = Collection::parse(row.collection.clone())?;
    let expected = kind.collection();
    if collection.as_str() != expected {
        return Err(DecodeError::CollectionMismatch {
            kind: row.kind.clone(),
            got: collection.as_str().to_string(),
            expected: expected.to_string(),
        });
    }

    let base = ChangeBase {
        kind,
        repo: Did::parse(row.repo.clone()).map_err(|_| DecodeError::Did)?,
        collection,
        rkey: Rkey::parse(row.rkey.clone())?,
        order_stamp: serde_json::from_value(serde_json::Value::String(row.order_stamp.clone()))
            .map_err(|_| DecodeError::Key(crate::ids::KeyError::Rkey))?,
    };

    match row.op.as_str() {
        "create" => {
            let body = parse_body(
                kind,
                row.body
                    .as_deref()
                    .ok_or_else(|| DecodeError::MissingBody { op: row.op.clone() })?,
            )?;
            Ok(RecordChange::Create { base, record: body })
        }
        "update" => {
            let body = parse_patch(
                kind,
                row.body
                    .as_deref()
                    .ok_or_else(|| DecodeError::MissingBody { op: row.op.clone() })?,
            )?;
            Ok(RecordChange::Update { base, patch: body })
        }
        "delete" => {
            if row.body.is_some() {
                return Err(DecodeError::UnexpectedBody);
            }
            Ok(RecordChange::Delete { base })
        }
        other => Err(DecodeError::UnknownOp(other.to_string())),
    }
}

fn parse_body(kind: RecordKind, body: &str) -> Result<RecordBody, DecodeError> {
    // The feed row names the kind, so the body is read as that shape: a row
    // cannot carry one kind's name and another kind's fields.
    let shape = |err: serde_json::Error| DecodeError::Json(err.to_string());
    Ok(match kind {
        RecordKind::Message => RecordBody::Message(serde_json::from_str(body).map_err(shape)?),
        RecordKind::Reaction => RecordBody::Reaction(serde_json::from_str(body).map_err(shape)?),
        RecordKind::Room => RecordBody::Room(serde_json::from_str(body).map_err(shape)?),
        RecordKind::SpaceInfo => RecordBody::SpaceInfo(serde_json::from_str(body).map_err(shape)?),
        RecordKind::SpaceSidebar => {
            RecordBody::SpaceSidebar(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Membership => {
            RecordBody::Membership(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Ban => RecordBody::Ban(serde_json::from_str(body).map_err(shape)?),
        RecordKind::Invite => RecordBody::Invite(serde_json::from_str(body).map_err(shape)?),
        RecordKind::Role => RecordBody::Role(serde_json::from_str(body).map_err(shape)?),
        RecordKind::RoleGrant => RecordBody::RoleGrant(serde_json::from_str(body).map_err(shape)?),
        RecordKind::RoomPermission => {
            RecordBody::RoomPermission(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::FederationRequest => {
            RecordBody::FederationRequest(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::FederationGrant => {
            RecordBody::FederationGrant(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Profile => RecordBody::Profile(serde_json::from_str(body).map_err(shape)?),
        RecordKind::CalendarLink => {
            RecordBody::CalendarLink(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::VoiceCall => RecordBody::VoiceCall(serde_json::from_str(body).map_err(shape)?),
    })
}

fn parse_patch(kind: RecordKind, body: &str) -> Result<RecordPatch, DecodeError> {
    let shape = |err: serde_json::Error| DecodeError::Json(err.to_string());
    Ok(match kind {
        RecordKind::Message => RecordPatch::Message(serde_json::from_str(body).map_err(shape)?),
        RecordKind::Room => RecordPatch::Room(serde_json::from_str(body).map_err(shape)?),
        RecordKind::SpaceInfo => RecordPatch::SpaceInfo(serde_json::from_str(body).map_err(shape)?),
        RecordKind::SpaceSidebar => {
            RecordPatch::SpaceSidebar(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Membership => {
            RecordPatch::Membership(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Role => RecordPatch::Role(serde_json::from_str(body).map_err(shape)?),
        RecordKind::RoomPermission => {
            RecordPatch::RoomPermission(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::FederationRequest => {
            RecordPatch::FederationRequest(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::FederationGrant => {
            RecordPatch::FederationGrant(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::Profile => RecordPatch::Profile(serde_json::from_str(body).map_err(shape)?),
        RecordKind::CalendarLink => {
            RecordPatch::CalendarLink(serde_json::from_str(body).map_err(shape)?)
        }
        RecordKind::VoiceCall => RecordPatch::VoiceCall(serde_json::from_str(body).map_err(shape)?),
        // A kind whose patch body is `never`: an update to it cannot exist.
        RecordKind::Reaction | RecordKind::Ban | RecordKind::Invite | RecordKind::RoleGrant => {
            return Err(DecodeError::BodyShape(format!(
                "{} has no update",
                kind.name()
            )));
        }
    })
}

// ── Bodies ───────────────────────────────────────────────────────────────

/// The full body of each kind.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordBody {
    Message(MessageRecord),
    Reaction(ReactionRecord),
    Room(RoomRecord),
    SpaceInfo(SpaceInfoRecord),
    SpaceSidebar(SpaceSidebarRecord),
    Membership(MembershipRecord),
    Ban(BanRecord),
    Invite(InviteRecord),
    Role(RoleRecord),
    RoleGrant(RoleGrantRecord),
    RoomPermission(RoomPermissionRecord),
    FederationRequest(FederationRequestRecord),
    FederationGrant(FederationGrantRecord),
    Profile(ProfileRecord),
    CalendarLink(CalendarLinkRecord),
    VoiceCall(VoiceCallRecord),
}

impl RecordBody {
    pub fn kind(&self) -> RecordKind {
        match self {
            RecordBody::Message(_) => RecordKind::Message,
            RecordBody::Reaction(_) => RecordKind::Reaction,
            RecordBody::Room(_) => RecordKind::Room,
            RecordBody::SpaceInfo(_) => RecordKind::SpaceInfo,
            RecordBody::SpaceSidebar(_) => RecordKind::SpaceSidebar,
            RecordBody::Membership(_) => RecordKind::Membership,
            RecordBody::Ban(_) => RecordKind::Ban,
            RecordBody::Invite(_) => RecordKind::Invite,
            RecordBody::Role(_) => RecordKind::Role,
            RecordBody::RoleGrant(_) => RecordKind::RoleGrant,
            RecordBody::RoomPermission(_) => RecordKind::RoomPermission,
            RecordBody::FederationRequest(_) => RecordKind::FederationRequest,
            RecordBody::FederationGrant(_) => RecordKind::FederationGrant,
            RecordBody::Profile(_) => RecordKind::Profile,
            RecordBody::CalendarLink(_) => RecordKind::CalendarLink,
            RecordBody::VoiceCall(_) => RecordKind::VoiceCall,
        }
    }
}

/// The patch each kind carries on an update.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordPatch {
    Message(MessagePatch),
    Room(RoomPatch),
    SpaceInfo(SpaceInfoPatch),
    SpaceSidebar(SpaceSidebarRecord),
    Membership(MembershipPatch),
    Role(RolePatch),
    RoomPermission(RoomPermissionRecord),
    FederationRequest(FederationRequestPatch),
    FederationGrant(FederationGrantPatch),
    Profile(ProfilePatch),
    CalendarLink(CalendarLinkRecord),
    VoiceCall(VoiceCallPatch),
}

impl RecordPatch {
    pub fn kind(&self) -> RecordKind {
        match self {
            RecordPatch::Message(_) => RecordKind::Message,
            RecordPatch::Room(_) => RecordKind::Room,
            RecordPatch::SpaceInfo(_) => RecordKind::SpaceInfo,
            RecordPatch::SpaceSidebar(_) => RecordKind::SpaceSidebar,
            RecordPatch::Membership(_) => RecordKind::Membership,
            RecordPatch::Role(_) => RecordKind::Role,
            RecordPatch::RoomPermission(_) => RecordKind::RoomPermission,
            RecordPatch::FederationRequest(_) => RecordKind::FederationRequest,
            RecordPatch::FederationGrant(_) => RecordKind::FederationGrant,
            RecordPatch::Profile(_) => RecordKind::Profile,
            RecordPatch::CalendarLink(_) => RecordKind::CalendarLink,
            RecordPatch::VoiceCall(_) => RecordKind::VoiceCall,
        }
    }
}

/// Message content: the mime type and the bytes the event carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageContent {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(with = "blob")]
    pub data: Vec<u8>,
}

/// A message whose text the projection derives: a room-link announcement. The
/// rule renders the markdown from the linked room's current name, and the
/// acting DID is a field rather than something to recover from the mention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSystemRoomLink {
    pub kind: String,
    #[serde(rename = "linkToRoom")]
    pub link_to_room: String,
    #[serde(rename = "isCreationLink")]
    pub is_creation_link: bool,
}

/// Fields every message record carries, whatever produced it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MessageRecord {
    pub room: String,
    pub author: Did,
    pub actor: Option<Did>,
    #[serde(default)]
    pub extensions: Option<serde_json::Value>,
    /// The message's own bytes — absent for a system message and a forward.
    #[serde(default)]
    pub content: Option<MessageContent>,
    #[serde(default)]
    pub system: Option<MessageSystemRoomLink>,
    #[serde(default, rename = "forwardOf")]
    pub forward_of: Option<Vec<String>>,
}

/// The write `editMessage`/`moveMessages` carries against an existing message.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MessagePatch {
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub content: Option<MessageContent>,
    /// Absent leaves the attachments alone; `null` removes them all.
    #[serde(default, deserialize_with = "double_option")]
    pub extensions: Option<Option<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscordOrigin {
    pub snowflake: String,
    #[serde(rename = "guildId")]
    pub guild_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoomRecord {
    pub kind: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "defaultAccess")]
    pub default_access: Option<String>,
    pub deleted: bool,
    pub parent: Option<String>,
    #[serde(default, rename = "discordOrigin")]
    pub discord_origin: Option<DiscordOrigin>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoomPatch {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default, rename = "defaultAccess")]
    pub default_access: Option<String>,
    #[serde(default)]
    pub deleted: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub parent: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SpaceInfoRecord {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    #[serde(rename = "allowPublicJoin")]
    pub allow_public_join: Option<bool>,
    #[serde(rename = "allowMemberInvites")]
    pub allow_member_invites: Option<bool>,
    #[serde(rename = "suggestToOthers")]
    pub suggest_to_others: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SpaceInfoPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(
        default,
        rename = "allowPublicJoin",
        deserialize_with = "double_option"
    )]
    pub allow_public_join: Option<Option<bool>>,
    #[serde(
        default,
        rename = "allowMemberInvites",
        deserialize_with = "double_option"
    )]
    pub allow_member_invites: Option<Option<bool>>,
    #[serde(
        default,
        rename = "suggestToOthers",
        deserialize_with = "double_option"
    )]
    pub suggest_to_others: Option<Option<bool>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarCategory {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub children: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SpaceSidebarRecord {
    pub categories: Vec<SidebarCategory>,
    #[serde(default)]
    pub extensions: Option<serde_json::Value>,
}

/// `reaction` — created by an add, deleted by the matching remove. Keyed by the
/// **add** event's id, which is what `comp_reaction.reaction_id` stores.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReactionRecord {
    /// The message being reacted to.
    pub target: String,
    /// The reacting user — the bridged event's `reactingUser`, not its sender.
    pub user: Did,
    /// The emoji, or a URI describing one.
    pub reaction: String,
    /// Set by the bridged add, which also materialises the reacting user's
    /// entity: a local reaction is sent by a member the space already holds.
    #[serde(default)]
    pub bridged: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MembershipRecord {
    pub user: Did,
    pub can: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MembershipPatch {
    pub can: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BanRecord {
    pub user: Did,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct InviteRecord {
    pub token: String,
    #[serde(rename = "createdBy")]
    pub created_by: Did,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoleRecord {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RolePatch {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoleGrantRecord {
    pub user: Did,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoomPermissionRecord {
    pub role: String,
    pub room: String,
    pub permission: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FederationRequestRecord {
    #[serde(rename = "federatingSpace")]
    pub federating_space: String,
    #[serde(rename = "requestedBy")]
    pub requested_by: Did,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FederationRequestPatch {
    pub status: String,
    #[serde(rename = "decidedBy")]
    pub decided_by: Did,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginGrant {
    pub room: String,
    pub permission: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiverGrant {
    pub room: String,
    pub permission: String,
    pub grantee: String,
    #[serde(rename = "granteeKind")]
    pub grantee_kind: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FederationGrantRecord {
    #[serde(rename = "federatingSpace")]
    pub federating_space: String,
    #[serde(default)]
    pub origin: Vec<OriginGrant>,
    #[serde(default)]
    pub receiver: Vec<ReceiverGrant>,
}

/// One entry changed. A `null` permission clears the entry, so both setter
/// events are updates to this record whichever way they go.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "scope")]
pub enum FederationGrantPatch {
    #[serde(rename = "origin")]
    Origin {
        room: String,
        permission: Option<String>,
    },
    #[serde(rename = "receiver")]
    Receiver {
        room: String,
        grantee: String,
        #[serde(rename = "granteeKind")]
        grantee_kind: String,
        permission: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProfileRecord {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ProfilePatch {
    #[serde(default, deserialize_with = "double_option")]
    pub name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub handle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CalendarLinkRecord {
    #[serde(rename = "groupSlug")]
    pub group_slug: String,
    #[serde(rename = "tenantId")]
    pub tenant_id: String,
    #[serde(rename = "apiUrl")]
    pub api_url: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VoiceCallRecord {
    pub room: String,
    pub source: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
}

/// The fact a call join or leave carries about the call's participant set.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VoiceCallPatch {
    pub source: String,
    #[serde(default)]
    pub joined: Option<Did>,
    #[serde(default)]
    pub left: Option<Did>,
}

// ── Deserialisation of the tagged shapes ─────────────────────────────────

/// `Option<Option<T>>`: absent stays `None`, `null` becomes `Some(None)`, and a
/// value becomes `Some(Some(v))`. The difference between "did not mention it"
/// and "set it to null" is the whole point of a patch.
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A byte string as the feed's JSON carries it: `{"$bytes": "<base64>"}`.
mod blob {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(
            "$bytes",
            &base64::engine::general_purpose::STANDARD.encode(bytes),
        )?;
        map.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        use serde::de::Error as _;
        #[derive(Deserialize)]
        struct Marker {
            #[serde(rename = "$bytes")]
            bytes: String,
        }
        let marker = Marker::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(marker.bytes)
            .map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_json(
        kind: RecordKind,
        op: &str,
        body: Option<&str>,
    ) -> Result<RecordChange, DecodeError> {
        decode_row(&FeedRow {
            stream_id: "did:web:space.example".into(),
            idx: 1,
            ord: 0,
            kind: kind.name().into(),
            repo: "did:web:space.example".into(),
            collection: kind.collection().into(),
            rkey: "abc".into(),
            op: op.into(),
            order_stamp: "01HF7YAT000000000000000001".into(),
            actor: "did:plc:actor".into(),
            event_id: "01HF7YAT00000000000000000A".into(),
            body: body.map(|b| b.to_string()),
        })
    }

    #[test]
    fn a_collection_that_disagrees_with_the_kind_is_an_error() {
        let err = decode_row(&FeedRow {
            stream_id: "did:web:space.example".into(),
            idx: 1,
            ord: 0,
            kind: "room".into(),
            repo: "did:web:space.example".into(),
            collection: "space.roomy.room.message".into(),
            rkey: "abc".into(),
            op: "delete".into(),
            order_stamp: "01HF7YAT000000000000000001".into(),
            actor: "did:plc:actor".into(),
            event_id: "01HF7YAT00000000000000000A".into(),
            body: None,
        })
        .unwrap_err();
        assert!(matches!(err, DecodeError::CollectionMismatch { .. }));
    }

    #[test]
    fn a_delete_carries_no_body() {
        assert!(decode_json(RecordKind::Ban, "delete", None).is_ok());
        assert!(decode_json(RecordKind::Ban, "delete", Some("{}")).is_err());
        assert!(decode_json(RecordKind::Ban, "create", None).is_err());
    }

    #[test]
    fn a_patch_tells_absent_from_null() {
        let change = decode_json(
            RecordKind::Room,
            "update",
            Some(r#"{"name":null,"deleted":true}"#),
        )
        .unwrap();
        let RecordChange::Update { patch, .. } = change else {
            panic!("expected an update")
        };
        let RecordPatch::Room(room) = patch else {
            panic!("expected a room patch")
        };
        assert_eq!(room.name, Some(None));
        assert_eq!(room.avatar, None);
        assert_eq!(room.deleted, Some(true));
    }

    #[test]
    fn message_content_carries_its_bytes() {
        let change = decode_json(
            RecordKind::Message,
            "create",
            Some(
                r#"{"room":"r","author":"did:plc:a","content":{"mimeType":"text/markdown","data":{"$bytes":"aGVsbG8="}}}"#,
            ),
        )
        .unwrap();
        let RecordChange::Create { record, .. } = change else {
            panic!("expected a create")
        };
        let RecordBody::Message(message) = record else {
            panic!("expected a message")
        };
        assert_eq!(message.content.unwrap().data, b"hello");
    }
}
