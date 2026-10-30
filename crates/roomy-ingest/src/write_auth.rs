//! Per-event write authorization for `space.roomy.space.sendEvents`.
//!
//! Membership is not a grant to send everything. Each event in a batch is
//! decided on its own: by its `$type`, by the sender's standing in the target
//! space, and — for a room-scoped event — by the sender's access to the room it
//! names. The first denied event denies the batch, so one bad event cannot ride
//! along with its neighbours.
//!
//! The checks are reads: the target space's database, plus the gateway's global
//! store for federation grants. Nothing here writes.
//!
//! ## Decision table
//!
//! The service DID is checked before any rule below: when the caller is the
//! configured service DID, `space.roomy.role.addMemberRole.v0` and
//! `space.roomy.role.removeMemberRole.v0` are allowed with no standing in the
//! space. No other type gets that allowance.
//!
//! | `$type` | Rule |
//! |---|---|
//! | `space.roomy.state.markRead.v0` | rejected: 400 `InvalidRequest`, `Event type … is not accepted by this endpoint` (it targets the personal stream; reads are a dedicated XRPC) |
//! | any `$type` not in this table | rejected: 400 `InvalidRequest`, `Unknown event type: …` |
//! | `space.roomy.message.createMessage.v0` | room write; authority extensions need admin; reply targets must be messages |
//! | `space.roomy.message.forwardMessages.v0` | room write |
//! | `space.roomy.reaction.addReaction.v0` | room write |
//! | `space.roomy.reaction.removeReaction.v0` | room write |
//! | `space.roomy.link.createRoomLink.v0` | room write |
//! | `space.roomy.link.removeRoomLink.v0` | room write |
//! | `space.roomy.message.moveMessages.v0` | `room` required; space admin; `toRoomId` required, must exist and be in this space |
//! | `space.roomy.message.reorderMessage.v0` | space admin |
//! | `space.roomy.message.editMessage.v0` | room write; authority extensions need admin; caller is the author or an admin; reply targets must be messages |
//! | `space.roomy.message.deleteMessage.v0` | room write; caller is the author or an admin |
//! | `space.roomy.room.createRoom.v0` | `kind` = `space.roomy.thread`: space member (not banned); any other kind: space admin |
//! | `space.roomy.room.updateRoom.v0` | space admin |
//! | `space.roomy.room.deleteRoom.v0` | space admin |
//! | `space.roomy.room.restoreRoom.v0` | space admin |
//! | `space.roomy.space.updateSpaceInfo.v0` | space admin |
//! | `space.roomy.space.updateSidebar.v0` | space admin |
//! | `space.roomy.space.updateSidebar.v1` | space admin |
//! | `space.roomy.space.setHandleProvider.v0` | space admin |
//! | `space.roomy.space.addAdmin.v0` | space admin |
//! | `space.roomy.space.removeAdmin.v0` | space admin |
//! | `space.roomy.space.banAccount.v0` | space admin |
//! | `space.roomy.space.unbanAccount.v0` | space admin |
//! | `space.roomy.role.createRole.v0` | space admin |
//! | `space.roomy.role.deleteRole.v0` | space admin |
//! | `space.roomy.role.updateRole.v0` | space admin |
//! | `space.roomy.role.addMemberRole.v0` | space admin (except the service DID, above) |
//! | `space.roomy.role.removeMemberRole.v0` | space admin (except the service DID, above) |
//! | `space.roomy.role.setRoleRoomPermission.v0` | space admin |
//! | `space.roomy.space.revokeInvite.v0` | space admin |
//! | `space.roomy.page.editPage.v0` | space admin |
//! | `space.roomy.openmeet.configure.v0` | space admin |
//! | `space.roomy.space.joinSpace.v0` | space is not banned for the caller |
//! | `space.roomy.space.leaveSpace.v0` | space member (not banned) |
//! | `space.roomy.user.updateProfile.v0` | space member (not banned) |
//! | `space.roomy.space.createInvite.v0` | space member (not banned) |
//! | `space.roomy.reaction.addBridgedReaction.v0` | space admin |
//! | `space.roomy.reaction.removeBridgedReaction.v0` | space admin |
//! | `space.roomy.federation.request.v0` | member of this space, then admin of `federatingSpaceDid` — see [`check_federation_request`] |
//! | `space.roomy.federation.respond.v0` | space admin; `federatingSpaceDid` required; the federation must exist and be `pending` |
//! | `space.roomy.federation.remove.v0` | space admin — see [`check_federation_remove`] |
//! | `space.roomy.federation.setRoomPermission.v0` | space admin |
//! | `space.roomy.federation.setReceiverPermission.v0` | space admin; `originSpaceId` and `roomId` required; setting a grant needs an active origin grant on that channel |
//!
//! Every arm above answers with the denial its rule names, and nothing falls
//! through to an allow.

use std::fmt;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use space_xrpc::access::{resolve_room, room_access, SpaceAccess};
use space_xrpc::error::XrpcError;
use space_xrpc::store::{FederationOrder, FederationView, GlobalStores};

use crate::event::WireEvent;

/// The `kind` a thread room declares, which only needs membership to create.
const ROOM_KIND_THREAD: &str = "space.roomy.thread";

/// Extensions that change what a message means rather than how it renders.
const AUTHORITY_EXTENSIONS: [&str; 2] = [
    "space.roomy.extension.authorOverride.v0",
    "space.roomy.extension.timestampOverride.v0",
];

/// The extension map that carries `attachments`.
const ATTACHMENTS_EXTENSION: &str = "space.roomy.extension.attachments.v0";

/// Every event type this module names, grouped by the record they write.
const MARK_READ: &str = "space.roomy.state.markRead.v0";

const CREATE_MESSAGE: &str = "space.roomy.message.createMessage.v0";
const EDIT_MESSAGE: &str = "space.roomy.message.editMessage.v0";
const DELETE_MESSAGE: &str = "space.roomy.message.deleteMessage.v0";
const MOVE_MESSAGES: &str = "space.roomy.message.moveMessages.v0";
const REORDER_MESSAGE: &str = "space.roomy.message.reorderMessage.v0";
const FORWARD_MESSAGES: &str = "space.roomy.message.forwardMessages.v0";

const ADD_REACTION: &str = "space.roomy.reaction.addReaction.v0";
const REMOVE_REACTION: &str = "space.roomy.reaction.removeReaction.v0";
const ADD_BRIDGED_REACTION: &str = "space.roomy.reaction.addBridgedReaction.v0";
const REMOVE_BRIDGED_REACTION: &str = "space.roomy.reaction.removeBridgedReaction.v0";

const CREATE_ROOM_LINK: &str = "space.roomy.link.createRoomLink.v0";
const REMOVE_ROOM_LINK: &str = "space.roomy.link.removeRoomLink.v0";

const CREATE_ROOM: &str = "space.roomy.room.createRoom.v0";
const UPDATE_ROOM: &str = "space.roomy.room.updateRoom.v0";
const DELETE_ROOM: &str = "space.roomy.room.deleteRoom.v0";
const RESTORE_ROOM: &str = "space.roomy.room.restoreRoom.v0";

const UPDATE_SPACE_INFO: &str = "space.roomy.space.updateSpaceInfo.v0";
const UPDATE_SIDEBAR_V0: &str = "space.roomy.space.updateSidebar.v0";
const UPDATE_SIDEBAR_V1: &str = "space.roomy.space.updateSidebar.v1";
const SET_HANDLE_PROVIDER: &str = "space.roomy.space.setHandleProvider.v0";
const ADD_ADMIN: &str = "space.roomy.space.addAdmin.v0";
const REMOVE_ADMIN: &str = "space.roomy.space.removeAdmin.v0";
const BAN_ACCOUNT: &str = "space.roomy.space.banAccount.v0";
const UNBAN_ACCOUNT: &str = "space.roomy.space.unbanAccount.v0";
const REVOKE_INVITE: &str = "space.roomy.space.revokeInvite.v0";

const CREATE_ROLE: &str = "space.roomy.role.createRole.v0";
const DELETE_ROLE: &str = "space.roomy.role.deleteRole.v0";
const UPDATE_ROLE: &str = "space.roomy.role.updateRole.v0";
const ADD_MEMBER_ROLE: &str = "space.roomy.role.addMemberRole.v0";
const REMOVE_MEMBER_ROLE: &str = "space.roomy.role.removeMemberRole.v0";
const SET_ROLE_ROOM_PERMISSION: &str = "space.roomy.role.setRoleRoomPermission.v0";

const EDIT_PAGE: &str = "space.roomy.page.editPage.v0";
const CONFIGURE_OPENMEET: &str = "space.roomy.openmeet.configure.v0";

const JOIN_SPACE: &str = "space.roomy.space.joinSpace.v0";
const LEAVE_SPACE: &str = "space.roomy.space.leaveSpace.v0";
const UPDATE_PROFILE: &str = "space.roomy.user.updateProfile.v0";
const CREATE_INVITE: &str = "space.roomy.space.createInvite.v0";

const FEDERATION_REQUEST: &str = "space.roomy.federation.request.v0";
const FEDERATION_RESPOND: &str = "space.roomy.federation.respond.v0";
const FEDERATION_REMOVE: &str = "space.roomy.federation.remove.v0";
const SET_ROOM_PERMISSION: &str = "space.roomy.federation.setRoomPermission.v0";
const SET_RECEIVER_PERMISSION: &str = "space.roomy.federation.setReceiverPermission.v0";

/// Message types that can carry a reply attachment.
const REPLY_TARGET_TYPES: [&str; 2] = [CREATE_MESSAGE, EDIT_MESSAGE];

/// Message types whose extensions this endpoint reads.
const EXTENSION_BEARING_TYPES: [&str; 2] = [CREATE_MESSAGE, EDIT_MESSAGE];

/// Event types allowed to be authored by the service DID without standing.
const SERVICE_SELF_WRITE_TYPES: [&str; 2] = [ADD_MEMBER_ROLE, REMOVE_MEMBER_ROLE];

/// An answer of "no": the status and XRPC error envelope the client sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteDenial {
    /// The HTTP status the envelope carries.
    pub status: u16,
    /// The XRPC error name, e.g. `InvalidRequest`.
    pub error: String,
    /// The sentence the client reads.
    pub message: String,
}

impl WriteDenial {
    /// A denial with an explicit status and XRPC error name.
    pub fn new(status: u16, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            message: message.into(),
        }
    }

    /// A malformed request: 400 `InvalidRequest`.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(400, "InvalidRequest", message)
    }

    /// A named room, message or federation that does not exist: 404.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NotFound", message)
    }

    /// A caller who may not write what they sent: 403.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "Forbidden", message)
    }

    /// A failure this server is responsible for: 500.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "InternalServerError", message)
    }

    /// A write that contradicts the state it reads: 409.
    fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "Conflict", message)
    }
}

impl fmt::Display for WriteDenial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.error, self.message)
    }
}

impl std::error::Error for WriteDenial {}

impl From<XrpcError> for WriteDenial {
    fn from(error: XrpcError) -> Self {
        Self {
            status: error.status,
            error: error.error,
            message: error.message,
        }
    }
}

/// Everything one batch's authorization needs.
///
/// The room-scoped checks read the target space's database directly; only the
/// federation grants come from `stores`.
pub struct WriteAuth<'a> {
    /// The space the batch was sent to.
    pub space_id: &'a str,
    /// The DID that sent the batch.
    pub caller_did: &'a str,
    /// The caller's standing in `space_id`, resolved once for the batch.
    pub access: SpaceAccess,
    /// The service's own DID, which is exempt from standing for the types it
    /// may author.
    pub service_did: Option<&'a str>,
    /// The federation grants, which only the gateway's global store holds.
    pub stores: &'a dyn GlobalStores,
}

/// `Ok(())` when this event is allowed; `Err(denial)` when it is not.
///
/// # Errors
///
/// The denial names the rule that refused the event: a malformed event is a
/// 400, an event that names something absent is a 404, a caller without the
/// standing the type needs is a 403, and a write that contradicts the state it
/// reads is a 409.
pub fn check_write_auth(
    conn: &Connection,
    event: &WireEvent,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    let type_name = event.nsid.as_str();

    if type_name == MARK_READ {
        return Err(WriteDenial::invalid_request(format!(
            "Event type {type_name} is not accepted by this endpoint"
        )));
    }

    // The service is the authority these rules are evaluated by, so it does not
    // need standing in the space it authors into. The allowance is exactly the
    // listed types and nothing else.
    if is_service_self_write(type_name, auth) {
        return Ok(());
    }

    match type_name {
        CREATE_MESSAGE | FORWARD_MESSAGES | ADD_REACTION | REMOVE_REACTION | CREATE_ROOM_LINK
        | REMOVE_ROOM_LINK => room_write(conn, event, auth),

        MOVE_MESSAGES => {
            required_room(event)?;
            check_move_messages(conn, event, auth)
        }

        REORDER_MESSAGE => require_space_admin(auth),

        EDIT_MESSAGE | DELETE_MESSAGE => message_author_write(conn, event, auth),

        CREATE_ROOM => {
            if event.string("kind") == Some(ROOM_KIND_THREAD) {
                require_membership(auth)
            } else {
                require_space_admin(auth)
            }
        }

        UPDATE_ROOM | DELETE_ROOM | RESTORE_ROOM => require_space_admin(auth),

        UPDATE_SPACE_INFO
        | UPDATE_SIDEBAR_V0
        | UPDATE_SIDEBAR_V1
        | SET_HANDLE_PROVIDER
        | ADD_ADMIN
        | REMOVE_ADMIN
        | BAN_ACCOUNT
        | UNBAN_ACCOUNT
        | CREATE_ROLE
        | DELETE_ROLE
        | UPDATE_ROLE
        | ADD_MEMBER_ROLE
        | REMOVE_MEMBER_ROLE
        | SET_ROLE_ROOM_PERMISSION
        | REVOKE_INVITE
        | EDIT_PAGE
        | CONFIGURE_OPENMEET => require_space_admin(auth),

        JOIN_SPACE => require_not_banned(auth),
        LEAVE_SPACE | UPDATE_PROFILE | CREATE_INVITE => require_membership(auth),

        ADD_BRIDGED_REACTION | REMOVE_BRIDGED_REACTION => require_space_admin(auth),

        FEDERATION_REQUEST => check_federation_request(event, auth),
        FEDERATION_RESPOND => check_federation_respond(event, auth),
        FEDERATION_REMOVE => check_federation_remove(auth),
        SET_RECEIVER_PERMISSION => check_set_receiver_permission(event, auth),
        SET_ROOM_PERMISSION => require_space_admin(auth),

        _ => Err(WriteDenial::invalid_request(format!(
            "Unknown event type: {type_name}"
        ))),
    }
}

fn is_service_self_write(type_name: &str, auth: &WriteAuth<'_>) -> bool {
    let Some(service_did) = auth.service_did else {
        return false;
    };
    !service_did.is_empty()
        && auth.caller_did == service_did
        && SERVICE_SELF_WRITE_TYPES.contains(&type_name)
}

/// The `room` field every room-scoped event must name.
fn required_room(event: &WireEvent) -> Result<&str, WriteDenial> {
    event
        .room
        .as_deref()
        .ok_or_else(|| WriteDenial::invalid_request("Event is missing required 'room' field"))
}

/// Room-write events: the caller may write in the room, and may carry an
/// authority extension or a reply attachment only on the terms below.
fn room_write(
    conn: &Connection,
    event: &WireEvent,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    let room_id = required_room(event)?;
    require_room_write(conn, room_id, auth)?;
    check_extension_authority(event, auth)?;
    check_reply_targets(conn, event)
}

/// Edit and delete: a room write, plus the caller being the message's author or
/// an admin of the space.
fn message_author_write(
    conn: &Connection,
    event: &WireEvent,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    let room_id = required_room(event)?;
    require_room_write(conn, room_id, auth)?;
    check_extension_authority(event, auth)?;
    let message_id = event.string("messageId").ok_or_else(|| {
        WriteDenial::invalid_request("Event is missing required 'messageId' field")
    })?;
    check_message_author_or_admin(conn, message_id, auth)?;
    check_reply_targets(conn, event)
}

fn require_space_admin(auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if auth.access.is_admin {
        return Ok(());
    }
    Err(WriteDenial::forbidden("Caller is not a space admin"))
}

fn require_membership(auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if auth.access.is_banned {
        return Err(WriteDenial::forbidden("Caller is banned from this space"));
    }
    if !auth.access.is_member && !auth.access.is_admin {
        return Err(WriteDenial::forbidden(
            "Caller is not a member of this space",
        ));
    }
    Ok(())
}

fn require_not_banned(auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if auth.access.is_banned {
        return Err(WriteDenial::forbidden("Caller is banned from this space"));
    }
    Ok(())
}

/// The caller may write in the room natively, or through a federated grant.
fn require_room_write(
    conn: &Connection,
    room_id: &str,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    let access = room_access(conn, room_id, Some(auth.caller_did)).map_err(database)?;
    if !access.exists {
        return Err(WriteDenial::not_found(format!("Room not found: {room_id}")));
    }
    if access.is_banned {
        return Err(WriteDenial::forbidden("Caller is banned from this space"));
    }
    if access.can_write {
        return Ok(());
    }
    if federated_write_access(conn, room_id, auth)? {
        return Ok(());
    }
    Err(WriteDenial::forbidden(
        "Caller does not have write access to this room",
    ))
}

/// The federated fallback for a caller the room's own grants deny.
///
/// A member of a receiving space may write to a channel the origin exposed with
/// a `readwrite` origin grant when their receiving space granted them
/// `readwrite` on it. Only active federations appear in the store's grants, and
/// the effective permission is the more restrictive of the origin and receiver
/// grants — so for *write* access the two reduce to "both are `readwrite`".
///
/// Grants are keyed on the canonical parent channel, exactly as native role
/// grants are.
///
/// Two parts of the federation rule are not consulted here: the
/// receiving-space admin override, and receiver grants of kind `role`. Both
/// need the receiving space's per-space database, which this ingress does not
/// hold; a caller reaches a federated room through a direct user grant or the
/// members-wide grant.
fn federated_write_access(
    conn: &Connection,
    room_id: &str,
    auth: &WriteAuth<'_>,
) -> Result<bool, WriteDenial> {
    let (resolved, parent_channel_id) = resolve_room(conn, room_id).map_err(database)?;
    let Some((origin_space, _)) = resolved else {
        return Ok(false);
    };
    let grant_room = parent_channel_id.as_deref().unwrap_or(room_id);

    for origin_grant in auth.stores.federation_origin_grants(&origin_space) {
        if origin_grant.room_id != grant_room || origin_grant.permission != "readwrite" {
            continue;
        }
        let home_space = origin_grant.federating_space_did.as_str();
        let granted = auth
            .stores
            .federation_receiver_grants(home_space)
            .iter()
            .any(|grant| {
                grant.space_id == origin_space
                    && grant.room_id == grant_room
                    && grant.permission == "readwrite"
                    && match grant.kind.as_str() {
                        "members" => grant.grantee == home_space,
                        "user" => grant.grantee == auth.caller_did,
                        _ => false,
                    }
            });
        if granted {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `moveMessages` repositions content another author wrote, so it is a curator
/// action: space admin, and a destination that exists in this space. The write
/// path is the only place the destination can be checked — the materialiser
/// would otherwise point a message at a room that is not in this database.
fn check_move_messages(
    conn: &Connection,
    event: &WireEvent,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    require_space_admin(auth)?;

    let to_room_id = event.string("toRoomId").ok_or_else(|| {
        WriteDenial::invalid_request("Event is missing required 'toRoomId' field")
    })?;
    let destination = room_access(conn, to_room_id, Some(auth.caller_did)).map_err(database)?;
    if !destination.exists {
        return Err(WriteDenial::not_found(format!(
            "Destination room not found: {to_room_id}"
        )));
    }
    if destination.space_id.as_deref() != Some(auth.space_id) {
        return Err(WriteDenial::invalid_request(format!(
            "Destination room {to_room_id} is not in this space"
        )));
    }
    Ok(())
}

/// `authorOverride` and `timestampOverride` change who a message is by and when
/// it sorts, so they are admin-only. The denial names the extension rather than
/// the room, so a client can tell "you may not post here" from "this needs
/// admin".
fn check_extension_authority(event: &WireEvent, auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if !EXTENSION_BEARING_TYPES.contains(&event.nsid.as_str()) {
        return Ok(());
    }
    let Some(extensions) = event.raw.get("extensions").and_then(Value::as_object) else {
        return Ok(());
    };
    let carried: Vec<&str> = AUTHORITY_EXTENSIONS
        .into_iter()
        .filter(|name| extensions.get(*name).is_some_and(|value| !value.is_null()))
        .collect();
    if carried.is_empty() || auth.access.is_admin {
        return Ok(());
    }
    Err(WriteDenial::forbidden(format!(
        "Only a space admin may set {}",
        carried.join(" or ")
    )))
}

/// A reply attachment's `target` must be a message. `getMessage` resolves a
/// target that is not a message — no entity at all, or an entity without a
/// `room` — as a 400, so admitting the edge would create a message whose reply
/// preview can never resolve.
fn check_reply_targets(conn: &Connection, event: &WireEvent) -> Result<(), WriteDenial> {
    if !REPLY_TARGET_TYPES.contains(&event.nsid.as_str()) {
        return Ok(());
    }
    let Some(extensions) = event.raw.get("extensions").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(attachments) = extensions
        .get(ATTACHMENTS_EXTENSION)
        .and_then(Value::as_object)
        .and_then(|extension| extension.get("attachments"))
        .and_then(Value::as_array)
    else {
        return Ok(());
    };

    for attachment in attachments {
        let Some(attachment) = attachment.as_object() else {
            continue;
        };
        if attachment.get("$type").and_then(Value::as_str) != Some(roomy_events::ATTACHMENT_REPLY) {
            continue;
        }
        let target = match attachment.get("target").and_then(Value::as_str) {
            Some(target) if !target.is_empty() => target,
            _ => {
                return Err(WriteDenial::invalid_request(
                    "Reply attachment is missing a 'target' message id",
                ))
            }
        };
        let room: Option<Option<String>> = conn
            .query_row("select room from entities where id = ?", [target], |row| {
                row.get(0)
            })
            .optional()
            .map_err(database)?;
        match room {
            None => {
                return Err(WriteDenial::invalid_request(format!(
                    "Reply target {target} is not a message (no such entity)"
                )))
            }
            Some(None) => {
                return Err(WriteDenial::invalid_request(format!(
                    "Reply target {target} is not a message (no room)"
                )))
            }
            Some(Some(room)) if room.is_empty() => {
                return Err(WriteDenial::invalid_request(format!(
                    "Reply target {target} is not a message (no room)"
                )))
            }
            Some(Some(_)) => {}
        }
    }
    Ok(())
}

fn check_message_author_or_admin(
    conn: &Connection,
    message_id: &str,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    if auth.access.is_admin {
        return Ok(());
    }
    let author: Option<String> = conn
        .query_row(
            "select tail from edges where head = ? and label = 'author' limit 1",
            [message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(database)?;
    if author.as_deref() != Some(auth.caller_did) {
        return Err(WriteDenial::forbidden(
            "Only the message author or a space admin can edit/delete this message",
        ));
    }
    Ok(())
}

/// A federation request is sent on the origin space's stream by an admin of the
/// requesting space. The caller must be a member of the origin space; the
/// admin-of-the-requesting-space half needs that space's database, which this
/// ingress does not hold, so the request is refused rather than admitted on
/// half its rule.
fn check_federation_request(event: &WireEvent, auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if event
        .string("federatingSpaceDid")
        .filter(|did| !did.is_empty())
        .is_none()
    {
        return Err(WriteDenial::invalid_request(
            "Event is missing required 'federatingSpaceDid' field",
        ));
    }
    if auth.access.is_banned {
        return Err(WriteDenial::forbidden("Caller is banned from this space"));
    }
    if !auth.access.is_member && !auth.access.is_admin {
        return Err(WriteDenial::forbidden(
            "Caller is not a member of the target space",
        ));
    }
    Err(WriteDenial::forbidden(
        "Federation request requires a cross-space access check that is not configured",
    ))
}

/// A respond decides a pending request, so it is the origin admin's call and
/// only on a request that is actually awaiting a decision — approving an active
/// federation or rejecting a removed one would orphan grants.
fn check_federation_respond(event: &WireEvent, auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if !auth.access.is_admin {
        return Err(WriteDenial::forbidden(
            "Only an admin of this space can respond to a federation request",
        ));
    }
    let federating_space_did = event
        .string("federatingSpaceDid")
        .filter(|did| !did.is_empty())
        .ok_or_else(|| {
            WriteDenial::invalid_request("Event is missing required 'federatingSpaceDid' field")
        })?;

    let federations = auth.stores.federations(
        FederationView::Origin(auth.space_id),
        None,
        FederationOrder::RequestedAtAscending,
    );
    let Some(federation) = federations
        .iter()
        .find(|row| row.federating_space_did == federating_space_did)
    else {
        return Err(WriteDenial::not_found(
            "No federation request from this space to respond to",
        ));
    };
    if federation.status != "pending" {
        return Err(WriteDenial::conflict(format!(
            "Cannot respond to a federation with status: {}",
            federation.status
        )));
    }
    Ok(())
}

/// Either side may tear a federation down, but the other side's admin standing
/// lives in that space's database, which this ingress does not hold: only an
/// admin of this space can remove it here.
fn check_federation_remove(auth: &WriteAuth<'_>) -> Result<(), WriteDenial> {
    if auth.access.is_admin {
        return Ok(());
    }
    Err(WriteDenial::forbidden(
        "Only an admin of this space or the federated space can remove the federation",
    ))
}

/// A receiver grant is only meaningful inside an active origin grant that
/// exposes the channel to this space. Clearing a grant is always allowed, so a
/// stale row can be cleaned up.
fn check_set_receiver_permission(
    event: &WireEvent,
    auth: &WriteAuth<'_>,
) -> Result<(), WriteDenial> {
    require_space_admin(auth)?;

    let origin_space_id = event
        .string("originSpaceId")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            WriteDenial::invalid_request("Event is missing required 'originSpaceId' field")
        })?;
    let room_id = event
        .string("roomId")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| WriteDenial::invalid_request("Event is missing required 'roomId' field"))?;

    if matches!(event.raw.get("permission"), None | Some(Value::Null)) {
        return Ok(());
    }

    let exposed = auth
        .stores
        .federation_origin_grants(origin_space_id)
        .iter()
        .any(|grant| grant.federating_space_did == auth.space_id && grant.room_id == room_id);
    if !exposed {
        return Err(WriteDenial::conflict(
            "Origin space has not exposed this channel to your space",
        ));
    }
    Ok(())
}

fn database(error: rusqlite::Error) -> WriteDenial {
    WriteDenial::from(XrpcError::from(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use space_xrpc::store::{
        FederationReceiverPermission, FederationRecord, FederationRoomPermission, NoGlobalStores,
    };

    const SPACE: &str = "did:web:space.test";
    const CALLER: &str = "did:plc:caller";
    const OTHER_SPACE: &str = "did:web:other.test";
    const ROOM: &str = "01JC0000000000000000000R01";
    const MESSAGE: &str = "01JC0000000000000000000M01";
    const SERVICE: &str = "did:web:appserver.test";

    const SCHEMA: &str = "
        create table entities (
            id text primary key,
            stream_id text not null,
            room text,
            sort_idx text,
            created_at integer not null default 0,
            updated_at integer not null default 0
        );
        create table edges (
            head text not null,
            tail text not null,
            label text not null,
            payload text,
            primary key (head, tail, label)
        );
        create table comp_space (
            entity text primary key,
            allow_public_join integer
        );
        create table comp_room (
            entity text primary key,
            label text,
            default_access text,
            deleted integer default 0
        );
        create table comp_bans (
            entity text not null,
            user_did text not null,
            primary key (entity, user_did)
        );
        create table roles (
            id text primary key,
            stream_id text not null,
            deleted integer not null default 0
        );
        create table member_roles (
            user_id text not null,
            role_id text not null,
            stream_id text not null,
            primary key (user_id, role_id)
        );
        create table role_rooms (
            role_id text not null,
            room_id text not null,
            stream_id text not null,
            permission text not null,
            primary key (role_id, room_id)
        );
    ";

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "insert into entities (id, stream_id) values (?, ?)",
            (SPACE, SPACE),
        )
        .unwrap();
        conn.execute(
            "insert into comp_space (entity, allow_public_join) values (?, 1)",
            [SPACE],
        )
        .unwrap();
        conn
    }

    fn add_member(conn: &Connection, did: &str) {
        conn.execute(
            "insert into entities (id, stream_id) values (?, ?)",
            (did, SPACE),
        )
        .unwrap();
        conn.execute(
            "insert into edges (head, tail, label) values (?, ?, 'member')",
            (SPACE, did),
        )
        .unwrap();
    }

    fn add_admin(conn: &Connection, did: &str) {
        conn.execute(
            "insert into entities (id, stream_id) values (?, ?)",
            (did, SPACE),
        )
        .unwrap();
        conn.execute(
            "insert into edges (head, tail, label) values (?, ?, 'admin')",
            (SPACE, did),
        )
        .unwrap();
    }

    fn add_room(conn: &Connection, room: &str, access: &str) {
        conn.execute(
            "insert into entities (id, stream_id) values (?, ?)",
            (room, SPACE),
        )
        .unwrap();
        conn.execute(
            "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', ?)",
            params![room, access],
        )
        .unwrap();
    }

    fn auth<'a>(access: SpaceAccess, stores: &'a dyn GlobalStores) -> WriteAuth<'a> {
        WriteAuth {
            space_id: SPACE,
            caller_did: CALLER,
            access,
            service_did: Some(SERVICE),
            stores,
        }
    }

    fn event(raw: Value) -> WireEvent {
        WireEvent::parse(&raw).unwrap()
    }

    fn create_message(room: &str) -> WireEvent {
        event(json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": MESSAGE,
            "room": room,
            "body": { "$type": "space.roomy.richtext.plaintext.v0", "text": "hi" },
        }))
    }

    const MEMBER: SpaceAccess = SpaceAccess {
        is_member: true,
        is_admin: false,
        is_banned: false,
    };
    const ADMIN: SpaceAccess = SpaceAccess {
        is_member: true,
        is_admin: true,
        is_banned: false,
    };

    #[test]
    fn a_member_may_write_in_a_writable_channel() {
        let conn = conn();
        add_member(&conn, CALLER);
        add_room(&conn, ROOM, "readwrite");

        assert_eq!(
            check_write_auth(&conn, &create_message(ROOM), &auth(MEMBER, &NoGlobalStores)),
            Ok(())
        );
    }

    #[test]
    fn a_member_may_not_write_in_a_read_only_channel() {
        let conn = conn();
        add_member(&conn, CALLER);
        add_room(&conn, ROOM, "read");

        assert_eq!(
            check_write_auth(&conn, &create_message(ROOM), &auth(MEMBER, &NoGlobalStores)),
            Err(WriteDenial::forbidden(
                "Caller does not have write access to this room"
            ))
        );
    }

    #[test]
    fn a_member_may_not_create_a_channel() {
        let conn = conn();
        add_member(&conn, CALLER);
        let create_room = event(json!({
            "$type": "space.roomy.room.createRoom.v0",
            "id": ROOM,
            "kind": "space.roomy.channel",
            "name": "general",
        }));

        assert_eq!(
            check_write_auth(&conn, &create_room, &auth(MEMBER, &NoGlobalStores)),
            Err(WriteDenial::forbidden("Caller is not a space admin"))
        );
    }

    #[test]
    fn an_admin_may_create_a_channel() {
        let conn = conn();
        add_admin(&conn, CALLER);
        let create_room = event(json!({
            "$type": "space.roomy.room.createRoom.v0",
            "id": ROOM,
            "kind": "space.roomy.channel",
            "name": "general",
        }));

        assert_eq!(
            check_write_auth(&conn, &create_room, &auth(ADMIN, &NoGlobalStores)),
            Ok(())
        );
    }

    #[test]
    fn a_member_may_create_a_thread() {
        let conn = conn();
        add_member(&conn, CALLER);
        let create_thread = event(json!({
            "$type": "space.roomy.room.createRoom.v0",
            "id": ROOM,
            "kind": "space.roomy.thread",
            "name": "a thread",
        }));

        assert_eq!(
            check_write_auth(&conn, &create_thread, &auth(MEMBER, &NoGlobalStores)),
            Ok(())
        );
    }

    #[test]
    fn the_service_did_gets_no_standing_for_an_ordinary_event() {
        let conn = conn();
        add_room(&conn, ROOM, "readwrite");
        let service = WriteAuth {
            space_id: SPACE,
            caller_did: SERVICE,
            access: SpaceAccess::default(),
            service_did: Some(SERVICE),
            stores: &NoGlobalStores,
        };

        assert_eq!(
            check_write_auth(&conn, &create_message(ROOM), &service),
            Err(WriteDenial::forbidden(
                "Caller does not have write access to this room"
            ))
        );
    }

    #[test]
    fn the_service_did_may_write_the_types_it_authors() {
        let conn = conn();
        let assign_role = event(json!({
            "$type": "space.roomy.role.addMemberRole.v0",
            "id": MESSAGE,
            "roleId": "01JC0000000000000000000L01",
            "userId": CALLER,
        }));
        let service = WriteAuth {
            space_id: SPACE,
            caller_did: SERVICE,
            access: SpaceAccess::default(),
            service_did: Some(SERVICE),
            stores: &NoGlobalStores,
        };

        assert_eq!(check_write_auth(&conn, &assign_role, &service), Ok(()));
    }

    /// A global store holding one active federation from [`SPACE`] to
    /// [`OTHER_SPACE`] with a `readwrite` grant on [`ROOM`].
    struct FederatedStores {
        receiver_grant: FederationReceiverPermission,
    }

    impl GlobalStores for FederatedStores {
        fn profile(&self, _did: &str) -> Option<space_xrpc::store::ProfileFields> {
            None
        }

        fn link_embed_json(&self, _url: &str) -> Option<String> {
            None
        }

        fn space_handle(&self, _space_did: &str) -> Option<String> {
            None
        }

        fn federations(
            &self,
            _view: FederationView<'_>,
            _status: Option<&str>,
            _order: FederationOrder,
        ) -> Vec<FederationRecord> {
            Vec::new()
        }

        fn federation_origin_grants(&self, space_id: &str) -> Vec<FederationRoomPermission> {
            if space_id != SPACE {
                return Vec::new();
            }
            vec![FederationRoomPermission {
                federating_space_did: OTHER_SPACE.to_string(),
                room_id: ROOM.to_string(),
                permission: "readwrite".to_string(),
            }]
        }

        fn federation_receiver_grants(&self, space_id: &str) -> Vec<FederationReceiverPermission> {
            if space_id != OTHER_SPACE {
                return Vec::new();
            }
            vec![self.receiver_grant.clone()]
        }
    }

    #[test]
    fn a_federated_member_may_write_through_their_own_grant() {
        let conn = conn();
        add_room(&conn, ROOM, "read");
        let stores = FederatedStores {
            receiver_grant: FederationReceiverPermission {
                space_id: SPACE.to_string(),
                room_id: ROOM.to_string(),
                grantee: CALLER.to_string(),
                kind: "user".to_string(),
                permission: "readwrite".to_string(),
            },
        };

        assert_eq!(
            check_write_auth(
                &conn,
                &create_message(ROOM),
                &auth(SpaceAccess::default(), &stores)
            ),
            Ok(())
        );
    }

    #[test]
    fn a_federated_member_without_a_receiver_grant_may_not_write() {
        let conn = conn();
        add_room(&conn, ROOM, "read");
        let stores = FederatedStores {
            receiver_grant: FederationReceiverPermission {
                space_id: SPACE.to_string(),
                room_id: ROOM.to_string(),
                grantee: "did:plc:someone-else".to_string(),
                kind: "user".to_string(),
                permission: "readwrite".to_string(),
            },
        };

        assert_eq!(
            check_write_auth(
                &conn,
                &create_message(ROOM),
                &auth(SpaceAccess::default(), &stores)
            ),
            Err(WriteDenial::forbidden(
                "Caller does not have write access to this room"
            ))
        );
    }
}
