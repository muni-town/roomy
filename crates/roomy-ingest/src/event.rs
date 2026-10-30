//! The wire form of one event in a `sendEvents` batch.
//!
//! An event is a JSON object whose `$type` names the record it describes and
//! whose `id` is the ULID the sender minted. Everything below the envelope is
//! the type's own payload, which the record adapter reads; the ingress itself
//! only needs the envelope, plus the payload for authorization.
//!
//! Parsing here is deliberately shallow — envelope only. A payload that the
//! adapter cannot describe contributes no change rather than failing the
//! append, so validating payload shape twice would only produce a second answer
//! to the same question.

use serde_json::Value;

use crate::ids::{is_ulid, nsid_of};

/// Every event type the appserver accepts, in the order its schema reports them.
///
/// The order is part of the wire contract: a request whose `$type` names
/// nothing has to be refused with the same sentence the appserver produces,
/// which enumerates this union in full.
pub const EVENT_TYPES: &[&str] = &[
    "space.roomy.federation.remove.v0",
    "space.roomy.federation.request.v0",
    "space.roomy.federation.respond.v0",
    "space.roomy.federation.setReceiverPermission.v0",
    "space.roomy.federation.setRoomPermission.v0",
    "space.roomy.link.createRoomLink.v0",
    "space.roomy.link.removeRoomLink.v0",
    "space.roomy.message.createMessage.v0",
    "space.roomy.message.deleteMessage.v0",
    "space.roomy.message.editMessage.v0",
    "space.roomy.message.forwardMessages.v0",
    "space.roomy.message.moveMessages.v0",
    "space.roomy.message.reorderMessage.v0",
    "space.roomy.openmeet.configure.v0",
    "space.roomy.page.editPage.v0",
    "space.roomy.reaction.addBridgedReaction.v0",
    "space.roomy.reaction.addReaction.v0",
    "space.roomy.reaction.removeBridgedReaction.v0",
    "space.roomy.reaction.removeReaction.v0",
    "space.roomy.role.addMemberRole.v0",
    "space.roomy.role.createRole.v0",
    "space.roomy.role.deleteRole.v0",
    "space.roomy.role.removeMemberRole.v0",
    "space.roomy.role.setRoleRoomPermission.v0",
    "space.roomy.role.updateRole.v0",
    "space.roomy.room.createRoom.v0",
    "space.roomy.room.deleteRoom.v0",
    "space.roomy.room.restoreRoom.v0",
    "space.roomy.room.updateRoom.v0",
    "space.roomy.space.addAdmin.v0",
    "space.roomy.space.banAccount.v0",
    "space.roomy.space.createInvite.v0",
    "space.roomy.space.joinSpace.v0",
    "space.roomy.space.leaveSpace.v0",
    "space.roomy.space.removeAdmin.v0",
    "space.roomy.space.revokeInvite.v0",
    "space.roomy.space.setHandleProvider.v0",
    "space.roomy.space.unbanAccount.v0",
    "space.roomy.space.updateSidebar.v0",
    "space.roomy.space.updateSidebar.v1",
    "space.roomy.space.updateSpaceInfo.v0",
    "space.roomy.state.markRead.v0",
    "space.roomy.user.updateProfile.v0",
    "space.roomy.voice.callEnded.v0",
    "space.roomy.voice.callJoined.v0",
    "space.roomy.voice.callLeft.v0",
    "space.roomy.voice.callStarted.v0",
];

/// The refusal a `$type` outside [`EVENT_TYPES`] earns, worded as the appserver
/// words it: every member quoted, all but the last joined by commas, and the
/// value the request carried at the end.
fn type_union_message(was: &str) -> String {
    let quoted: Vec<String> = EVENT_TYPES
        .iter()
        .map(|kind| format!("\"{kind}\""))
        .collect();
    let (last, rest) = quoted.split_last().expect("the union is not empty");
    format!("$type must be {} or {last} (was {was})", rest.join(", "))
}

/// How the appserver spells the value a missing field carried.
fn was(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => value.to_string(),
    }
}

/// One event, decoded far enough that the ingress can decide about it.
#[derive(Debug, Clone)]
pub struct WireEvent {
    /// The event exactly as it arrived.
    pub raw: Value,
    /// Its `$type`.
    pub nsid: String,
    /// Its id: the ULID the sender minted, which is also the message id for a
    /// `createMessage` and the room id for a `createRoom`.
    pub id: String,
    /// The room it names, when it names one. Absent for space-level events.
    pub room: Option<String>,
}

impl WireEvent {
    /// Decode the envelope. The `Err` is the message a 400 carries.
    pub fn parse(value: &Value) -> Result<Self, String> {
        let Some(object) = value.as_object() else {
            return Err("event is not an object".to_string());
        };
        let Some(nsid) = nsid_of(object.get("$type")) else {
            return Err(type_union_message(&was(object.get("$type"))));
        };
        if !EVENT_TYPES.contains(&nsid.as_str()) {
            return Err(type_union_message(&format!("\"{nsid}\"")));
        }
        let Some(id) = object.get("id").and_then(Value::as_str) else {
            return Err("invalid id: must be a string".to_string());
        };
        if !is_ulid(id) {
            return Err("invalid id: must be a ULID".to_string());
        }
        let room = match object.get("room") {
            None | Some(Value::Null) => None,
            Some(Value::String(room)) if is_ulid(room) => Some(room.clone()),
            Some(_) => return Err("invalid room: must be a ULID".to_string()),
        };
        Ok(Self {
            raw: value.clone(),
            nsid,
            id: id.to_string(),
            room,
        })
    }

    /// The payload field `name`, when it is a string.
    pub fn string(&self, name: &str) -> Option<&str> {
        self.raw.get(name).and_then(Value::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "01JC0000000000000000000C01";

    #[test]
    fn decodes_the_envelope() {
        let event = json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": ID,
            "room": "01JC0000000000000000000R01",
            "content": { "mimeType": "text/markdown", "data": { "$bytes": "aGk=" } }
        });
        let parsed = WireEvent::parse(&event).unwrap();
        assert_eq!(parsed.nsid, "space.roomy.message.createMessage.v0");
        assert_eq!(parsed.id, ID);
        assert_eq!(parsed.room.as_deref(), Some("01JC0000000000000000000R01"));
    }

    #[test]
    fn a_space_level_event_has_no_room() {
        let parsed = WireEvent::parse(&json!({
            "$type": "space.roomy.space.updateSidebar.v0",
            "id": ID
        }))
        .unwrap();
        assert!(parsed.room.is_none());
    }

    #[test]
    fn a_missing_type_is_refused_with_the_whole_union() {
        let error = WireEvent::parse(&json!({ "id": ID })).unwrap_err();
        assert!(error.starts_with("$type must be \"space.roomy.federation.remove.v0\""));
        assert!(error.ends_with("(was undefined)"), "{error}");
    }

    #[test]
    fn an_unknown_type_is_refused_naming_the_value() {
        let error =
            WireEvent::parse(&json!({ "$type": "space.roomy.nope.v0", "id": ID })).unwrap_err();
        assert!(error.ends_with("(was \"space.roomy.nope.v0\")"), "{error}");
    }

    #[test]
    fn a_non_ulid_id_is_refused() {
        let error = WireEvent::parse(&json!({
            "$type": "space.roomy.message.createMessage.v0",
            "id": "not-a-ulid"
        }))
        .unwrap_err();
        assert_eq!(error, "invalid id: must be a ULID");
    }

    #[test]
    fn a_non_object_is_refused() {
        assert!(WireEvent::parse(&json!([1, 2])).is_err());
    }
}
