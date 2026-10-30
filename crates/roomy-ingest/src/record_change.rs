//! The event log → record-change adapter.
//!
//! A log entry is an event; the projection consumes records. This module is
//! where one becomes the other: it decides which record kinds an event writes,
//! derives each record's repo and key, and stamps every change from that entry
//! with the entry's ordering key. Its output is written next to the log entry at
//! ingest, and a worker reads rows rather than events.
//!
//! Four rules hold for every row:
//!
//!  * **`repo` is derived, never copied.** The log is per-space and a record is
//!    per-repo, so the repo comes from what the event says: the author DID for
//!    member content, the space DID for collective records, the subject for a
//!    profile, the reacting user for a bridged reaction, and the origin space
//!    for a receiver grant.
//!  * **`order_stamp` is lifted from the entry.** It is the 26-character key
//!    built from the entry's ordering time and log position, so every row from
//!    one entry shares it and a worker sorting by it reproduces the log's order
//!    without reading the log again.
//!  * **`ord` is the emission order.** One entry can write several records —
//!    `createRoomLink` writes a room and a message — and `(idx, ord)` orders
//!    them the way this adapter emitted them.
//!  * **A delete carries no body.** `create` carries the whole record, `update`
//!    carries a patch, `delete` carries nothing.
//!
//! The adapter is stateless: it sees one entry, so it cannot tell whether the
//! record it describes already exists. Writes that are both created and updated
//! by one event (`addAdmin` → membership, `setRoleRoomPermission` →
//! roomPermission) therefore emit `update`, and the projection's rules are
//! set-like upserts, so an update to an absent record creates it.
//!
//! An event with no record mapping, an event whose kinds have no producer, or
//! an entry whose payload cannot be described contributes no rows. The feed is
//! written on the write path, so one unreadable event must not fail the append
//! that produced it; the same entry is reported again wherever it is replayed.

use roomy_events::extensions::key::{AUTHOR_OVERRIDE, TIMESTAMP_OVERRIDE};
use serde_json::{Map, Value};

use crate::record_kinds::{is_converted, kinds_for_event, RecordCollection, RecordKind};

/// The extension key a bridged room names its Discord origin under.
const DISCORD_ORIGIN: &str = "space.roomy.extension.discordOrigin.v0";
/// The extension key the Discord bridge sets a user's handle under.
const DISCORD_USER_ORIGIN: &str = "space.roomy.extension.discordUserOrigin.v0";

/// The key of a singleton record — one per repo.
const SINGLETON_RKEY: &str = "self";

/// One row of the change feed, as the table holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordChangeRow {
    /// The space whose log the entry landed on.
    pub stream_id: String,
    /// The entry's log position.
    pub idx: i64,
    /// Emission order within the entry.
    pub ord: i64,
    /// The record kind, named as the projection knows it.
    pub kind: String,
    /// The repo the record belongs to: the DID whose collection holds it.
    pub repo: String,
    /// The record's collection NSID.
    pub collection: String,
    /// The record key within the collection.
    pub rkey: String,
    /// `create`, `update` or `delete`.
    pub op: String,
    /// The entry's ordering key, shared by every row from that entry.
    pub order_stamp: String,
    /// Who sent the entry. Keyed by some rules: a membership announcement is
    /// keyed by the join event, and a call fact's `joined_at` decodes the event.
    pub actor: String,
    /// The entry's event id, which two rules key rows by.
    pub event_id: String,
    /// The encoded record or patch; `None` for a delete.
    pub body: Option<String>,
}

/// The entry-level facts every row from one log entry carries.
#[derive(Debug, Clone, Copy)]
pub struct EntryFacts<'a> {
    /// The space the log belongs to.
    pub stream_id: &'a str,
    /// The entry's log position: the tie-break of its ordering key.
    pub idx: i64,
    /// The entry's sender.
    pub actor: &'a str,
    /// When this server accepted the entry, in epoch milliseconds: the ordering
    /// time unless a bridged message overrides it.
    pub received_at: i64,
}

/// The rows one log entry contributes, in emission order.
#[must_use]
pub fn feed_rows(event: &Value, facts: &EntryFacts<'_>) -> Vec<RecordChangeRow> {
    let Some(nsid) = event.get("$type").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(declared) = kinds_for_event(nsid) else {
        return Vec::new();
    };
    // An event that writes nothing, or that writes a kind without a producer,
    // keeps its own materialiser instead: deriving rows for it would stamp
    // changes no rule applies.
    if declared.is_empty() || !declared.iter().all(|kind| is_converted(*kind)) {
        return Vec::new();
    }
    let Some(event_id) = event.get("id").and_then(Value::as_str) else {
        return Vec::new();
    };

    let stamp = match order_stamp(event, facts) {
        Ok(stamp) => stamp,
        Err(error) => {
            log_unreadable(nsid, event_id, &error);
            return Vec::new();
        }
    };
    let changes = match changes_for(event, event_id, facts) {
        Ok(changes) => changes,
        Err(error) => {
            log_unreadable(nsid, event_id, &error);
            return Vec::new();
        }
    };
    if !changes.iter().all(|change| is_converted(change.kind)) {
        return Vec::new();
    }

    let mut rows = Vec::with_capacity(changes.len());
    for (ord, change) in changes.iter().enumerate() {
        match change.row(facts, event_id, &stamp, ord as i64) {
            Ok(row) => rows.push(row),
            Err(error) => {
                log_unreadable(nsid, event_id, &error);
                return Vec::new();
            }
        }
    }
    rows
}

/// Replace every byte string in `value` with `{"$bytes": "<base64>"}`,
/// recursively.
///
/// `serde_json` has no byte-string variant. A value decoded from a wire event
/// already carries bytes in that marker — the adapter's bodies are JSON
/// throughout — so this is the identity on them; it is the one spelling of the
/// encoding rule for a caller that holds raw bytes as some other shape.
#[must_use]
pub fn encode_bytes(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(encode_bytes).collect()),
        Value::Object(map) => {
            let mut encoded = Map::new();
            for (key, inner) in map {
                encoded.insert(key.clone(), encode_bytes(inner));
            }
            Value::Object(encoded)
        }
        other => other.clone(),
    }
}

/// One record write, before the entry's facts and its position are attached.
struct Change {
    kind: RecordKind,
    repo: String,
    rkey: String,
    op: Op,
    body: Option<Value>,
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Create,
    Update,
    Delete,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Create => "create",
            Op::Update => "update",
            Op::Delete => "delete",
        }
    }
}

impl Change {
    fn create(kind: RecordKind, repo: &str, rkey: String, body: Value) -> Self {
        Self {
            kind,
            repo: repo.to_string(),
            rkey,
            op: Op::Create,
            body: Some(body),
        }
    }

    fn update(kind: RecordKind, repo: &str, rkey: String, body: Value) -> Self {
        Self {
            kind,
            repo: repo.to_string(),
            rkey,
            op: Op::Update,
            body: Some(body),
        }
    }

    fn delete(kind: RecordKind, repo: &str, rkey: String) -> Self {
        Self {
            kind,
            repo: repo.to_string(),
            rkey,
            op: Op::Delete,
            body: None,
        }
    }

    fn row(
        &self,
        facts: &EntryFacts<'_>,
        event_id: &str,
        stamp: &str,
        ord: i64,
    ) -> Result<RecordChangeRow, String> {
        let body = match &self.body {
            Some(body) => Some(serde_json::to_string(body).map_err(|error| error.to_string())?),
            None => None,
        };
        Ok(RecordChangeRow {
            stream_id: facts.stream_id.to_string(),
            idx: facts.idx,
            ord,
            kind: self.kind.name().to_string(),
            repo: self.repo.clone(),
            collection: RecordCollection::from_kind(self.kind).as_str().to_string(),
            rkey: self.rkey.clone(),
            op: self.op.name().to_string(),
            order_stamp: stamp.to_string(),
            actor: facts.actor.to_string(),
            event_id: event_id.to_string(),
            body,
        })
    }
}

/// Every record change one log entry produces, in emission order.
fn changes_for(
    event: &Value,
    event_id: &str,
    facts: &EntryFacts<'_>,
) -> Result<Vec<Change>, String> {
    let payload = event.as_object().ok_or("event is not an object")?;
    let nsid = payload
        .get("$type")
        .and_then(Value::as_str)
        .ok_or("event has no $type")?;
    let space = facts.stream_id;
    let actor = facts.actor;

    match nsid {
        // ── message ──────────────────────────────────────────────────────────
        "space.roomy.message.createMessage.v0" => {
            let author = message_author(payload, actor);
            let mut record = Map::new();
            put_if_present(&mut record, payload, "room");
            record.insert("author".to_string(), Value::from(author.clone()));
            record.insert("content".to_string(), content(payload)?);
            put_if_present(&mut record, payload, "extensions");
            Ok(vec![Change::create(
                RecordKind::Message,
                &author,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        // An edit, a delete and a move write a message whose author the event
        // does not name, and each is authorized against the current author. The
        // space is the repo: an action by an admin over another author's
        // content cannot live in that author's repo.
        "space.roomy.message.editMessage.v0" => {
            let mut patch = Map::new();
            patch.insert("content".to_string(), content(payload)?);
            // Present means "replace with this set"; absent means "leave the
            // attachments alone", so the value passes through rather than
            // defaulting.
            put_if_present(&mut patch, payload, "extensions");
            Ok(vec![Change::update(
                RecordKind::Message,
                space,
                rkey(&[required(payload, "messageId")?])?,
                Value::Object(patch),
            )])
        }

        "space.roomy.message.deleteMessage.v0" => Ok(vec![Change::delete(
            RecordKind::Message,
            space,
            rkey(&[required(payload, "messageId")?])?,
        )]),

        "space.roomy.message.moveMessages.v0" => {
            let message_ids = payload
                .get("messageIds")
                .and_then(Value::as_array)
                .ok_or("moveMessages carries no messageIds")?;
            let mut changes = Vec::with_capacity(message_ids.len());
            for message_id in message_ids {
                let message_id = message_id.as_str().ok_or("a message id is not a string")?;
                let mut patch = Map::new();
                put_from(&mut patch, payload, "room", "toRoomId");
                changes.push(Change::update(
                    RecordKind::Message,
                    space,
                    rkey(&[message_id])?,
                    Value::Object(patch),
                ));
            }
            Ok(changes)
        }

        // A forward reference is its own entity in the destination room: no
        // content and no author edge. The forwarder is the repo, because the
        // forward is content they created.
        "space.roomy.message.forwardMessages.v0" => {
            let mut record = Map::new();
            put_if_present(&mut record, payload, "room");
            record.insert("author".to_string(), Value::from(actor));
            put_from(&mut record, payload, "forwardOf", "messageIds");
            Ok(vec![Change::create(
                RecordKind::Message,
                actor,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        // ── room ─────────────────────────────────────────────────────────────
        "space.roomy.room.createRoom.v0" => {
            let mut record = Map::new();
            put_if_present(&mut record, payload, "kind");
            record.insert("name".to_string(), or_null(payload.get("name")));
            record.insert("avatar".to_string(), or_null(payload.get("avatar")));
            record.insert(
                "description".to_string(),
                or_null(payload.get("description")),
            );
            // A thread takes its access from its parent, so it carries none.
            record.insert(
                "defaultAccess".to_string(),
                if payload.get("kind").and_then(Value::as_str) == Some("space.roomy.thread") {
                    Value::Null
                } else {
                    match payload.get("defaultAccess") {
                        None | Some(Value::Null) => Value::from("readwrite"),
                        Some(default_access) => default_access.clone(),
                    }
                },
            );
            record.insert("deleted".to_string(), Value::Bool(false));
            record.insert("parent".to_string(), Value::Null);
            if let Some(origin) = payload
                .get("extensions")
                .and_then(|extensions| extensions.get(DISCORD_ORIGIN))
                .and_then(Value::as_object)
            {
                let mut discord = Map::new();
                put_if_present(&mut discord, origin, "snowflake");
                put_if_present(&mut discord, origin, "guildId");
                record.insert("discordOrigin".to_string(), Value::Object(discord));
            }
            Ok(vec![Change::create(
                RecordKind::Room,
                space,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        "space.roomy.room.updateRoom.v0" => {
            let mut patch = Map::new();
            if let Some(kind) = payload.get("kind").filter(|kind| !kind.is_null()) {
                patch.insert("kind".to_string(), kind.clone());
            }
            // An explicit null writes `readwrite`: the record carries the value
            // the projection ends up with.
            if let Some(default_access) = payload.get("defaultAccess") {
                patch.insert(
                    "defaultAccess".to_string(),
                    if default_access.is_null() {
                        Value::from("readwrite")
                    } else {
                        default_access.clone()
                    },
                );
            }
            put_if_present(&mut patch, payload, "name");
            put_if_present(&mut patch, payload, "avatar");
            put_if_present(&mut patch, payload, "description");
            Ok(vec![Change::update(
                RecordKind::Room,
                space,
                rkey(&[required(payload, "roomId")?])?,
                Value::Object(patch),
            )])
        }

        // A soft delete: the record stays in the set carrying `deleted`, which
        // is what the metadata's deleted-room list and the restore modal read.
        // `op: delete` is never used for a room.
        "space.roomy.room.deleteRoom.v0" => Ok(vec![Change::update(
            RecordKind::Room,
            space,
            rkey(&[required(payload, "roomId")?])?,
            body(vec![("deleted", Value::Bool(true))]),
        )]),

        "space.roomy.room.restoreRoom.v0" => Ok(vec![Change::update(
            RecordKind::Room,
            space,
            rkey(&[required(payload, "roomId")?])?,
            body(vec![("deleted", Value::Bool(false))]),
        )]),

        // ── room link: a `parent` on the linked room, plus a system message ──
        "space.roomy.link.createRoomLink.v0" => {
            let link_to_room = required(payload, "linkToRoom")?;
            let mut parent = Map::new();
            put_from(&mut parent, payload, "parent", "room");
            // The system message is real content, owned by the space, whose
            // text the projection renders: it interpolates the linked room's
            // name and mentions the acting DID, so both facts travel
            // structurally rather than as a stored string.
            let system = body(vec![
                ("kind", Value::from("roomLink")),
                ("linkToRoom", Value::from(link_to_room)),
                (
                    "isCreationLink",
                    Value::Bool(
                        payload.get("isCreationLink").and_then(Value::as_bool) == Some(true),
                    ),
                ),
            ]);
            let mut record = Map::new();
            put_if_present(&mut record, payload, "room");
            record.insert("author".to_string(), Value::from(space));
            record.insert("actor".to_string(), Value::from(actor));
            record.insert("system".to_string(), system);
            Ok(vec![
                Change::update(
                    RecordKind::Room,
                    space,
                    rkey(&[link_to_room])?,
                    Value::Object(parent),
                ),
                Change::create(
                    RecordKind::Message,
                    space,
                    rkey(&[event_id])?,
                    Value::Object(record),
                ),
            ])
        }

        // No system message is written for an unlink; the linked room's
        // `parent` is cleared.
        "space.roomy.link.removeRoomLink.v0" => Ok(vec![Change::update(
            RecordKind::Room,
            space,
            rkey(&[required(payload, "linkToRoom")?])?,
            body(vec![("parent", Value::Null)]),
        )]),

        // ── reaction ─────────────────────────────────────────────────────────
        "space.roomy.reaction.addReaction.v0" => {
            let mut record = Map::new();
            put_from(&mut record, payload, "target", "reactionTo");
            record.insert("user".to_string(), Value::from(actor));
            put_if_present(&mut record, payload, "reaction");
            Ok(vec![Change::create(
                RecordKind::Reaction,
                actor,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        // Keyed by the add event's id, which is what the projection stores as
        // the reaction's id, so a removal names the record it removes without
        // naming the user.
        "space.roomy.reaction.removeReaction.v0" => Ok(vec![Change::delete(
            RecordKind::Reaction,
            actor,
            rkey(&[required(payload, "reactionId")?])?,
        )]),

        // The reacting user is the external one, and the projection attributes
        // the reaction to them rather than to the bridge, so that user is the
        // repo.
        "space.roomy.reaction.addBridgedReaction.v0" => {
            let reacting_user = required(payload, "reactingUser")?;
            let mut record = Map::new();
            put_from(&mut record, payload, "target", "reactionTo");
            record.insert("user".to_string(), Value::from(reacting_user));
            put_if_present(&mut record, payload, "reaction");
            record.insert("bridged".to_string(), Value::Bool(true));
            Ok(vec![Change::create(
                RecordKind::Reaction,
                reacting_user,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        "space.roomy.reaction.removeBridgedReaction.v0" => Ok(vec![Change::delete(
            RecordKind::Reaction,
            required(payload, "reactingUser")?,
            rkey(&[required(payload, "reactionId")?])?,
        )]),

        // ── membership ───────────────────────────────────────────────────────
        // One record per (space, user), owned by the space: membership is a
        // collective fact about a user, not content in their repo.
        "space.roomy.space.joinSpace.v0" => Ok(vec![Change::create(
            RecordKind::Membership,
            space,
            rkey(&[actor])?,
            body(vec![
                ("user", Value::from(actor)),
                ("can", Value::from("post")),
            ]),
        )]),

        "space.roomy.space.leaveSpace.v0" => Ok(vec![Change::delete(
            RecordKind::Membership,
            space,
            rkey(&[actor])?,
        )]),

        // `joinSpace` writes `can: "post"` even for an admin rejoining, because
        // the projection's "a rejoin keeps admin" rule reads state the adapter
        // does not have; these two events carry the admin bit.
        "space.roomy.space.addAdmin.v0" => Ok(vec![Change::update(
            RecordKind::Membership,
            space,
            rkey(&[required(payload, "userDid")?])?,
            body(vec![("can", Value::from("admin"))]),
        )]),

        "space.roomy.space.removeAdmin.v0" => Ok(vec![Change::update(
            RecordKind::Membership,
            space,
            rkey(&[required(payload, "userDid")?])?,
            body(vec![("can", Value::from("post"))]),
        )]),

        // ── space config ─────────────────────────────────────────────────────
        "space.roomy.space.updateSpaceInfo.v0" => {
            let mut patch = Map::new();
            for key in [
                "name",
                "avatar",
                "description",
                "allowPublicJoin",
                "allowMemberInvites",
                "suggestToOthers",
            ] {
                put_if_present(&mut patch, payload, key);
            }
            Ok(vec![Change::update(
                RecordKind::SpaceInfo,
                space,
                SINGLETON_RKEY.to_string(),
                Value::Object(patch),
            )])
        }

        // Both sidebar versions overwrite the whole config, so the v1 form is
        // the record shape and v0 is the same record without category ids.
        "space.roomy.space.updateSidebar.v0" => Ok(vec![Change::update(
            RecordKind::SpaceSidebar,
            space,
            SINGLETON_RKEY.to_string(),
            body(vec![("categories", sidebar_categories(payload)?)]),
        )]),

        "space.roomy.space.updateSidebar.v1" => {
            let mut patch = Map::new();
            patch.insert("categories".to_string(), sidebar_categories(payload)?);
            put_if_present(&mut patch, payload, "extensions");
            Ok(vec![Change::update(
                RecordKind::SpaceSidebar,
                space,
                SINGLETON_RKEY.to_string(),
                Value::Object(patch),
            )])
        }

        // ── ban ──────────────────────────────────────────────────────────────
        "space.roomy.space.banAccount.v0" => {
            let user = required(payload, "userDid")?;
            Ok(vec![Change::create(
                RecordKind::Ban,
                space,
                rkey(&[user])?,
                body(vec![("user", Value::from(user))]),
            )])
        }

        "space.roomy.space.unbanAccount.v0" => Ok(vec![Change::delete(
            RecordKind::Ban,
            space,
            rkey(&[required(payload, "userDid")?])?,
        )]),

        // ── invite ───────────────────────────────────────────────────────────
        // Keyed by the token: a revoke names the token and nothing else, so the
        // token is the only key the two events share.
        "space.roomy.space.createInvite.v0" => {
            let token = required(payload, "token")?;
            Ok(vec![Change::create(
                RecordKind::Invite,
                space,
                rkey(&[token])?,
                body(vec![
                    ("token", Value::from(token)),
                    ("createdBy", Value::from(actor)),
                ]),
            )])
        }

        "space.roomy.space.revokeInvite.v0" => Ok(vec![Change::delete(
            RecordKind::Invite,
            space,
            rkey(&[required(payload, "token")?])?,
        )]),

        // ── role ─────────────────────────────────────────────────────────────
        "space.roomy.role.createRole.v0" => {
            let mut record = Map::new();
            record.insert("name".to_string(), or_null(payload.get("name")));
            record.insert("avatar".to_string(), or_null(payload.get("avatar")));
            record.insert(
                "description".to_string(),
                or_null(payload.get("description")),
            );
            Ok(vec![Change::create(
                RecordKind::Role,
                space,
                rkey(&[event_id])?,
                Value::Object(record),
            )])
        }

        "space.roomy.role.updateRole.v0" => {
            let mut patch = Map::new();
            for key in ["name", "avatar", "description"] {
                put_if_present(&mut patch, payload, key);
            }
            Ok(vec![Change::update(
                RecordKind::Role,
                space,
                rkey(&[required(payload, "roleId")?])?,
                Value::Object(patch),
            )])
        }

        // The projection marks the role deleted rather than removing it and
        // every reader filters on that, so removal from the set is the same
        // read result.
        "space.roomy.role.deleteRole.v0" => Ok(vec![Change::delete(
            RecordKind::Role,
            space,
            rkey(&[required(payload, "roleId")?])?,
        )]),

        "space.roomy.role.addMemberRole.v0" => {
            let user = required(payload, "userDid")?;
            let role = required(payload, "roleId")?;
            Ok(vec![Change::create(
                RecordKind::RoleGrant,
                space,
                rkey(&[user, role])?,
                body(vec![
                    ("user", Value::from(user)),
                    ("role", Value::from(role)),
                ]),
            )])
        }

        "space.roomy.role.removeMemberRole.v0" => {
            let user = required(payload, "userDid")?;
            let role = required(payload, "roleId")?;
            Ok(vec![Change::delete(
                RecordKind::RoleGrant,
                space,
                rkey(&[user, role])?,
            )])
        }

        // A null level removes the role's access, which the projection
        // expresses as a delete; a level is an update to the same key.
        "space.roomy.role.setRoleRoomPermission.v0" => {
            let role = required(payload, "roleId")?;
            let room = required(payload, "roomId")?;
            let key = rkey(&[role, room])?;
            if matches!(payload.get("permission"), Some(Value::Null)) {
                return Ok(vec![Change::delete(RecordKind::RoomPermission, space, key)]);
            }
            let mut patch = Map::new();
            patch.insert("role".to_string(), Value::from(role));
            patch.insert("room".to_string(), Value::from(room));
            put_if_present(&mut patch, payload, "permission");
            Ok(vec![Change::update(
                RecordKind::RoomPermission,
                space,
                key,
                Value::Object(patch),
            )])
        }

        // ── federation ───────────────────────────────────────────────────────
        // Both records are keyed by the other space alone, because the one event
        // that removes them names that space and nothing finer.
        "space.roomy.federation.request.v0" => {
            let federating_space = required(payload, "federatingSpaceDid")?;
            let mut record = Map::new();
            record.insert("federatingSpace".to_string(), Value::from(federating_space));
            record.insert("requestedBy".to_string(), Value::from(actor));
            record.insert(
                "message".to_string(),
                payload.get("message").cloned().unwrap_or(Value::Null),
            );
            Ok(vec![Change::create(
                RecordKind::FederationRequest,
                space,
                rkey(&[federating_space])?,
                Value::Object(record),
            )])
        }

        "space.roomy.federation.respond.v0" => {
            let federating_space = required(payload, "federatingSpaceDid")?;
            Ok(vec![Change::update(
                RecordKind::FederationRequest,
                space,
                rkey(&[federating_space])?,
                body(vec![
                    (
                        "status",
                        Value::from(if truthy(payload.get("approve")) {
                            "active"
                        } else {
                            "rejected"
                        }),
                    ),
                    ("decidedBy", Value::from(actor)),
                    (
                        "message",
                        payload.get("message").cloned().unwrap_or(Value::Null),
                    ),
                ]),
            )])
        }

        // One event, two deletes: the relationship and every grant it created.
        "space.roomy.federation.remove.v0" => {
            let federating_space = required(payload, "federatingSpaceDid")?;
            let key = rkey(&[federating_space])?;
            Ok(vec![
                Change::delete(RecordKind::FederationRequest, space, key.clone()),
                Change::delete(RecordKind::FederationGrant, space, key),
            ])
        }

        // A null level clears the origin grant for one channel, so both
        // directions are updates to the grant record: the record is per
        // receiving space because the removing event names that space alone.
        "space.roomy.federation.setRoomPermission.v0" => {
            let federating_space = required(payload, "federatingSpaceDid")?;
            let mut patch = Map::new();
            patch.insert("scope".to_string(), Value::from("origin"));
            put_from(&mut patch, payload, "room", "roomId");
            put_if_present(&mut patch, payload, "permission");
            Ok(vec![Change::update(
                RecordKind::FederationGrant,
                space,
                rkey(&[federating_space])?,
                Value::Object(patch),
            )])
        }

        // Sent on the receiving space's stream, but the grant it writes belongs
        // to the origin space — so the origin is the repo and the stream is part
        // of the key.
        "space.roomy.federation.setReceiverPermission.v0" => {
            let origin_space = required(payload, "originSpaceId")?;
            let mut patch = Map::new();
            patch.insert("scope".to_string(), Value::from("receiver"));
            put_from(&mut patch, payload, "room", "roomId");
            put_if_present(&mut patch, payload, "grantee");
            put_from(&mut patch, payload, "granteeKind", "kind");
            put_if_present(&mut patch, payload, "permission");
            Ok(vec![Change::update(
                RecordKind::FederationGrant,
                origin_space,
                rkey(&[space])?,
                Value::Object(patch),
            )])
        }

        // ── profile, calendar, voice ─────────────────────────────────────────
        // The subject is named by the event and can differ from the sender:
        // this write exists so a bridge or an admin can set a profile the
        // subject did not write. The record is the subject's, so the subject is
        // its repo.
        "space.roomy.user.updateProfile.v0" => {
            let subject = required(payload, "did")?;
            let mut patch = Map::new();
            for key in ["name", "avatar", "description"] {
                put_if_present(&mut patch, payload, key);
            }
            if let Some(handle) = discord_handle(payload) {
                patch.insert("handle".to_string(), Value::from(handle));
            }
            Ok(vec![Change::update(
                RecordKind::Profile,
                subject,
                SINGLETON_RKEY.to_string(),
                Value::Object(patch),
            )])
        }

        "space.roomy.openmeet.configure.v0" => {
            if matches!(payload.get("groupSlug"), Some(Value::Null)) {
                return Ok(vec![Change::delete(
                    RecordKind::CalendarLink,
                    space,
                    SINGLETON_RKEY.to_string(),
                )]);
            }
            let mut patch = Map::new();
            for key in ["groupSlug", "tenantId", "apiUrl"] {
                put_if_present(&mut patch, payload, key);
            }
            Ok(vec![Change::update(
                RecordKind::CalendarLink,
                space,
                SINGLETON_RKEY.to_string(),
                Value::Object(patch),
            )])
        }

        "space.roomy.voice.callStarted.v0" => {
            let call = required(payload, "callId")?;
            let mut record = Map::new();
            put_if_present(&mut record, payload, "room");
            put_if_present(&mut record, payload, "source");
            // The projection's start time is the start event's ULID time, which
            // the log determines rather than a clock read at materialisation.
            record.insert("startedAt".to_string(), Value::from(decode_time(event_id)?));
            Ok(vec![Change::create(
                RecordKind::VoiceCall,
                space,
                rkey(&[call])?,
                Value::Object(record),
            )])
        }

        "space.roomy.voice.callJoined.v0" => {
            let call = required(payload, "callId")?;
            let mut patch = Map::new();
            put_if_present(&mut patch, payload, "source");
            put_from(&mut patch, payload, "joined", "userDid");
            Ok(vec![Change::update(
                RecordKind::VoiceCall,
                space,
                rkey(&[call])?,
                Value::Object(patch),
            )])
        }

        "space.roomy.voice.callLeft.v0" => {
            let call = required(payload, "callId")?;
            let mut patch = Map::new();
            put_if_present(&mut patch, payload, "source");
            put_from(&mut patch, payload, "left", "userDid");
            Ok(vec![Change::update(
                RecordKind::VoiceCall,
                space,
                rkey(&[call])?,
                Value::Object(patch),
            )])
        }

        "space.roomy.voice.callEnded.v0" => Ok(vec![Change::delete(
            RecordKind::VoiceCall,
            space,
            rkey(&[required(payload, "callId")?])?,
        )]),

        // ── no record ────────────────────────────────────────────────────────
        // Each is a deliberate omission: the write path accepts the event and
        // its own materialiser applies it.
        "space.roomy.space.setHandleProvider.v0"
        | "space.roomy.page.editPage.v0"
        | "space.roomy.message.reorderMessage.v0"
        | "space.roomy.state.markRead.v0" => Ok(Vec::new()),

        other => Err(format!("no record mapping for event type: {other}")),
    }
}

/// A body: an object built from the fields it carries, in the order given.
fn body(fields: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// Copy `from[from_key]` into `into[into_key]` when the event carries it.
fn put_from(
    into: &mut Map<String, Value>,
    from: &Map<String, Value>,
    into_key: &str,
    from_key: &str,
) {
    if let Some(value) = from.get(from_key) {
        into.insert(into_key.to_string(), value.clone());
    }
}

/// Copy `event[key]` into the body under the same name when present.
fn put_if_present(into: &mut Map<String, Value>, event: &Map<String, Value>, key: &str) {
    put_from(into, event, key, key);
}

/// The string field `key`, which the event must carry for the key or repo it
/// derives.
fn required<'a>(event: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    event
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("event carries no string {key}"))
}

/// The value a `|| null` read produces: every falsy value becomes `null`.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(Value::Bool(false)) => Value::Null,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => Value::Null,
        Some(other) => other.clone(),
    }
}

/// JavaScript truthiness, which is what a bare `event.approve ?` tests.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// The author a message belongs to: the overridden DID when a bridge set one,
/// otherwise the sender. A bridged message is attributed to the overridden
/// author, so that is whose content it is and whose repo holds it.
fn message_author(event: &Map<String, Value>, actor: &str) -> String {
    event
        .get("extensions")
        .and_then(|extensions| extensions.get(AUTHOR_OVERRIDE))
        .and_then(|author_override| author_override.get("did"))
        .and_then(Value::as_str)
        .unwrap_or(actor)
        .to_string()
}

/// A message body: its mime type and the content bytes.
///
/// A wire event carries those bytes as `{"$bytes": "<base64>"}`, already in the
/// marker form the feed stores, so `encode_bytes` is the identity on this value
/// and it passes through rather than being decoded and re-encoded.
fn content(event: &Map<String, Value>) -> Result<Value, String> {
    let body = event
        .get("body")
        .and_then(Value::as_object)
        .ok_or("event carries no body")?;
    let data = body
        .get("data")
        .and_then(Value::as_object)
        .filter(|data| data.get("$bytes").and_then(Value::as_str).is_some())
        .ok_or("event body carries no $bytes data")?;
    let mut content = Map::new();
    put_if_present(&mut content, body, "mimeType");
    content.insert("data".to_string(), Value::Object(data.clone()));
    Ok(Value::Object(content))
}

/// A category list, with `id` present only when the event sent one.
fn sidebar_categories(event: &Map<String, Value>) -> Result<Value, String> {
    let categories = event
        .get("categories")
        .and_then(Value::as_array)
        .ok_or("event carries no categories")?;
    let mut mapped_categories = Vec::with_capacity(categories.len());
    for category in categories {
        let category = category
            .as_object()
            .ok_or("a sidebar category is not an object")?;
        let mut mapped = Map::new();
        put_if_present(&mut mapped, category, "id");
        put_if_present(&mut mapped, category, "name");
        put_if_present(&mut mapped, category, "children");
        mapped_categories.push(Value::Object(mapped));
    }
    Ok(Value::Array(mapped_categories))
}

/// The handle a bridged profile carries, when the Discord bridge set one.
fn discord_handle(event: &Map<String, Value>) -> Option<String> {
    event
        .get("extensions")
        .and_then(|extensions| extensions.get(DISCORD_USER_ORIGIN))
        .and_then(Value::as_object)
        .and_then(|origin| origin.get("handle"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The ordering key's time width, in Crockford characters — a ULID's time width.
const TIME_LEN: usize = 10;
/// The ordering key's position width — a ULID's random width.
const POSITION_LEN: usize = 16;
/// Crockford base32, the alphabet both halves of an ordering key use.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// The largest instant a 10-character time half encodes: `2^48 - 1` ms.
const TIME_MAX: i64 = (1i64 << 48) - 1;

/// The ordering stamp of an entry: its ordering time, then its log position.
fn order_stamp(event: &Value, facts: &EntryFacts<'_>) -> Result<String, String> {
    order_key(ordering_time(event, facts.received_at)?, facts.idx)
}

/// The instant an entry is ordered by: a bridged message's own timestamp when
/// the producer set one, otherwise the receipt the log stamped at append.
fn ordering_time(event: &Value, received_at: i64) -> Result<i64, String> {
    if event.get("$type").and_then(Value::as_str) == Some("space.roomy.message.createMessage.v0") {
        if let Some(timestamp_override) = event
            .get("extensions")
            .and_then(|extensions| extensions.get(TIMESTAMP_OVERRIDE))
            .and_then(Value::as_object)
        {
            let timestamp = timestamp_override
                .get("timestamp")
                .ok_or("timestampOverride carries no timestamp")?;
            return match timestamp {
                Value::Number(number) => number
                    .as_i64()
                    .ok_or_else(|| "timestampOverride's timestamp is not an integer".to_string()),
                Value::String(text) => text
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| "timestampOverride's timestamp is not an integer".to_string()),
                _ => Err("timestampOverride's timestamp is not an integer".to_string()),
            };
        }
    }
    Ok(received_at)
}

/// Build a 26-character ordering key: 10 characters of ordering time and 16 of
/// log position, both Crockford base32, so lexicographic order is numeric
/// order and `decode_time` still reads the time half.
fn order_key(time_ms: i64, idx: i64) -> Result<String, String> {
    if !(0..=TIME_MAX).contains(&time_ms) {
        return Err(format!("ordering time out of range: {time_ms}"));
    }
    let position = u64::try_from(idx).map_err(|_| format!("log position is negative: {idx}"))?;
    let mut key = base32(time_ms as u64, TIME_LEN);
    key.push_str(&base32(position, POSITION_LEN));
    Ok(key)
}

/// Crockford base32 of a non-negative integer, left-padded to `len`
/// characters.
fn base32(value: u64, len: usize) -> String {
    let mut digits = vec![0u8; len];
    let mut value = value;
    for digit in digits.iter_mut().rev() {
        *digit = (value % 32) as u8;
        value /= 32;
    }
    digits
        .into_iter()
        .map(|digit| CROCKFORD[digit as usize] as char)
        .collect()
}

/// The instant a ULID encodes, in epoch milliseconds: its first 10 Crockford
/// characters.
fn decode_time(id: &str) -> Result<i64, String> {
    let bytes = id.as_bytes();
    if bytes.len() != TIME_LEN + POSITION_LEN {
        return Err(format!("not a ULID: {id}"));
    }
    let mut time = 0i64;
    for byte in &bytes[..TIME_LEN] {
        let digit = CROCKFORD
            .iter()
            .position(|candidate| *candidate == byte.to_ascii_uppercase())
            .ok_or_else(|| format!("not a ULID: {id}"))?;
        time = time * 32 + digit as i64;
    }
    if time > TIME_MAX {
        return Err(format!("ULID time out of range: {id}"));
    }
    Ok(time)
}

/// A record key: the parts joined with `~`, validated against ATProto's
/// record-key syntax.
///
/// `~` rather than `/` (which record keys forbid) or `:` (which every DID
/// contains, so a `<user>:<role>` key would not be decodable) separates the
/// parts; it appears in no DID or ULID, so a part can always be recovered.
fn rkey(parts: &[&str]) -> Result<String, String> {
    let key = parts.join("~");
    let allowed =
        |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b':' | b'-');
    if key.is_empty() || key.len() > 512 || key == "." || key == ".." || !key.bytes().all(allowed) {
        return Err(format!("not a record key: {key}"));
    }
    Ok(key)
}

fn log_unreadable(nsid: &str, event_id: &str, reason: &str) {
    tracing::warn!(nsid, event_id, "no record change for event: {}", reason);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record_kinds::{CONVERTED_KINDS, RECORD_KINDS_FOR_EVENT};
    use serde_json::json;

    const SPACE: &str = "did:web:space.example";
    const ACTOR: &str = "did:plc:actor";
    const MESSAGE_ID: &str = "01HF7YAT00000000000000000N";

    fn facts() -> EntryFacts<'static> {
        EntryFacts {
            stream_id: SPACE,
            idx: 1,
            actor: ACTOR,
            received_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn a_create_message_is_one_message_row() {
        let event = json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": MESSAGE_ID,
            "room": "01HF7YAT000000000000000001",
            "body": { "mimeType": "text/markdown", "data": { "$bytes": "aGVsbG8=" } },
            "extensions": {}
        });

        let rows = feed_rows(&event, &facts());
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.stream_id, SPACE);
        assert_eq!(row.idx, 1);
        assert_eq!(row.ord, 0);
        assert_eq!(row.kind, "message");
        assert_eq!(row.collection, "space.roomy.room.message");
        assert_eq!(row.rkey, MESSAGE_ID);
        assert_eq!(row.repo, ACTOR);
        assert_eq!(row.op, "create");
        assert_eq!(row.order_stamp, "01HF7YAT000000000000000001");
        assert_eq!(row.actor, ACTOR);
        assert_eq!(row.event_id, MESSAGE_ID);

        let body: Value =
            serde_json::from_str(row.body.as_deref().expect("a create carries a body"))
                .expect("the body is JSON");
        assert_eq!(
            body,
            json!({
                "room": "01HF7YAT000000000000000001",
                "author": ACTOR,
                "content": {
                    "mimeType": "text/markdown",
                    "data": { "$bytes": "aGVsbG8=" }
                },
                "extensions": {}
            })
        );
    }

    #[test]
    fn a_delete_carries_no_body_and_belongs_to_the_space() {
        let event = json!({
            "$type": "space.roomy.message.deleteMessage.v0",
            "id": "01HF7YAT00000000000000000P",
            "room": "01HF7YAT000000000000000001",
            "messageId": MESSAGE_ID
        });

        let rows = feed_rows(&event, &facts());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].op, "delete");
        assert_eq!(rows[0].body, None);
        assert_eq!(rows[0].repo, SPACE);
        assert_eq!(rows[0].rkey, MESSAGE_ID);
    }

    #[test]
    fn an_event_that_writes_no_record_contributes_nothing() {
        for event in [
            json!({
                "$type": "space.roomy.state.markRead.v0",
                "id": MESSAGE_ID,
                "room": "01HF7YAT000000000000000001"
            }),
            json!({ "$type": "space.roomy.unknown.event.v0", "id": MESSAGE_ID }),
        ] {
            assert!(feed_rows(&event, &facts()).is_empty(), "{event}");
        }
    }

    #[test]
    fn a_malformed_event_contributes_nothing_rather_than_panicking() {
        // `createMessage` names its content by `body`; without one the adapter
        // cannot describe the record.
        let event = json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": MESSAGE_ID,
            "room": "01HF7YAT000000000000000001"
        });
        assert!(feed_rows(&event, &facts()).is_empty());

        // A key that ATProto cannot express is not a record key.
        let event = json!({
            "$type": "space.roomy.message.deleteMessage.v0",
            "id": MESSAGE_ID,
            "messageId": "not/a/record/key"
        });
        assert!(feed_rows(&event, &facts()).is_empty());
    }

    #[test]
    fn a_room_link_emits_the_room_then_the_system_message() {
        let link_id = "01HF7YAT00000000000000000Q";
        let linked_room = "01HF7YAT000000000000000003";
        let event = json!({
            "$type": "space.roomy.link.createRoomLink.v0",
            "id": link_id,
            "room": "01HF7YAT000000000000000001",
            "linkToRoom": linked_room,
            "isCreationLink": true
        });

        let rows = feed_rows(&event, &facts());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, "room");
        assert_eq!(rows[0].op, "update");
        assert_eq!(rows[0].rkey, linked_room);
        assert_eq!(rows[0].ord, 0);
        assert_eq!(rows[1].kind, "message");
        assert_eq!(rows[1].op, "create");
        assert_eq!(rows[1].rkey, link_id);
        assert_eq!(rows[1].ord, 1);
        assert_eq!(rows[0].order_stamp, rows[1].order_stamp);
        assert_eq!(
            serde_json::from_str::<Value>(rows[1].body.as_deref().unwrap()).unwrap(),
            json!({
                "room": "01HF7YAT000000000000000001",
                "author": SPACE,
                "actor": ACTOR,
                "system": {
                    "kind": "roomLink",
                    "linkToRoom": linked_room,
                    "isCreationLink": true
                }
            })
        );
    }

    #[test]
    fn a_null_room_permission_deletes_the_record() {
        let role = "01HF7YAT000000000000000007";
        let room = "01HF7YAT000000000000000001";
        let event = json!({
            "$type": "space.roomy.role.setRoleRoomPermission.v0",
            "id": MESSAGE_ID,
            "roleId": role,
            "roomId": room,
            "permission": null
        });

        let rows = feed_rows(&event, &facts());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "roomPermission");
        assert_eq!(rows[0].op, "delete");
        assert_eq!(rows[0].body, None);
        assert_eq!(rows[0].rkey, format!("{role}~{room}"));
    }

    #[test]
    fn a_receiver_grant_belongs_to_the_origin_space_and_is_keyed_by_the_stream() {
        let origin = "did:web:origin.example";
        let receiving = "did:web:receiving.example";
        let event = json!({
            "$type": "space.roomy.federation.setReceiverPermission.v0",
            "id": MESSAGE_ID,
            "originSpaceId": origin,
            "roomId": "01HF7YAT000000000000000001",
            "grantee": receiving,
            "kind": "members",
            "permission": "read"
        });

        let rows = feed_rows(&event, &facts());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].repo, origin);
        assert_eq!(rows[0].rkey, SPACE);
    }

    #[test]
    fn the_ordering_key_is_time_then_log_position() {
        assert_eq!(
            order_key(1_700_000_000_000, 26).expect("a representable entry"),
            "01HF7YAT00000000000000000T"
        );
        assert_eq!(
            decode_time("01HF7YAT00000000000000000T").expect("a ULID"),
            1_700_000_000_000
        );
        assert!(order_key(1_700_000_000_000, -1).is_err());
    }

    #[test]
    fn the_event_table_covers_every_kind_this_adapter_emits() {
        assert_eq!(RECORD_KINDS_FOR_EVENT.len(), 47);
        assert_eq!(CONVERTED_KINDS.len(), 16);
    }
}
