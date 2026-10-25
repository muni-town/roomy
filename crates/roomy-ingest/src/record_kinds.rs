//! The record model: the sixteen kinds the event log collapses onto.
//!
//! A kind is a thing the projection stores, not an event that happened. Several
//! events write one kind (`createRoom`, `updateRoom`, the soft delete/restore
//! pair and both link events all write `room`), and two events write two kinds
//! (`createRoomLink` writes a room and a message, `federation.remove` deletes a
//! request and a grant). For each kind this module names its collection NSID;
//! for each event NSID it names the kinds that event writes, in emission order.
//!
//! The kinds and their collections are [`space_core::change::RecordKind`]'s:
//! the projection has one vocabulary for the records it applies, and the write
//! side re-uses it rather than keeping a table that can drift. What this module
//! adds is the event → kinds table, which only the adapter needs.
//!
//! The NSIDs are provisional except `space.roomy.user.profile`, which exists as
//! a lexicon. Nothing outside the materialiser and the feed consumes them, so
//! they can be settled once the record lexicon does.
//!
//! Three shapes are fixed by the record model: a room is soft-deleted, so
//! `op: delete` is never used for one; a room link is a `parent` field on the
//! linked room rather than a kind of its own; and a room permission with a null
//! level is a delete.

use std::fmt;

pub use space_core::change::RecordKind;

/// One kind's collection NSID — the wire identity of the records a change
/// writes, and what a consumer routes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RecordCollection(&'static str);

impl RecordCollection {
    /// The collection `kind` lives in.
    ///
    /// The table itself is [`RecordKind::collection`], so a kind and its
    /// collection cannot disagree; this type is how the adapter names the
    /// column it writes.
    pub fn of(kind: RecordKind) -> Self {
        Self(kind.collection())
    }

    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for RecordCollection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// Every event NSID and the record kinds it writes, in emission order.
///
/// An empty list is an event that deliberately writes no record:
///
///  * `setHandleProvider` is retired — space handles are DID- and DNS-derived.
///  * `editPage` is retired — pages have no client support and no reader.
///  * `reorderMessage` carries a key derived from its neighbours, which a
///    record cannot determine on its own.
///  * `markRead` is rejected at the write path; read receipts stay gateway-side.
///
/// An NSID absent from this table is an event the ingress does not map at all.
pub const RECORD_KINDS_FOR_EVENT: &[(&str, &[RecordKind])] = &[
    // message
    (
        "space.roomy.message.createMessage.v0",
        &[RecordKind::Message],
    ),
    ("space.roomy.message.editMessage.v0", &[RecordKind::Message]),
    (
        "space.roomy.message.deleteMessage.v0",
        &[RecordKind::Message],
    ),
    (
        "space.roomy.message.moveMessages.v0",
        &[RecordKind::Message],
    ),
    ("space.roomy.message.reorderMessage.v0", &[]),
    (
        "space.roomy.message.forwardMessages.v0",
        &[RecordKind::Message],
    ),
    // room
    ("space.roomy.room.createRoom.v0", &[RecordKind::Room]),
    ("space.roomy.room.updateRoom.v0", &[RecordKind::Room]),
    ("space.roomy.room.deleteRoom.v0", &[RecordKind::Room]),
    ("space.roomy.room.restoreRoom.v0", &[RecordKind::Room]),
    // reaction
    (
        "space.roomy.reaction.addReaction.v0",
        &[RecordKind::Reaction],
    ),
    (
        "space.roomy.reaction.removeReaction.v0",
        &[RecordKind::Reaction],
    ),
    (
        "space.roomy.reaction.addBridgedReaction.v0",
        &[RecordKind::Reaction],
    ),
    (
        "space.roomy.reaction.removeBridgedReaction.v0",
        &[RecordKind::Reaction],
    ),
    // membership
    ("space.roomy.space.joinSpace.v0", &[RecordKind::Membership]),
    ("space.roomy.space.leaveSpace.v0", &[RecordKind::Membership]),
    ("space.roomy.space.addAdmin.v0", &[RecordKind::Membership]),
    (
        "space.roomy.space.removeAdmin.v0",
        &[RecordKind::Membership],
    ),
    // space config
    (
        "space.roomy.space.updateSpaceInfo.v0",
        &[RecordKind::SpaceInfo],
    ),
    (
        "space.roomy.space.updateSidebar.v0",
        &[RecordKind::SpaceSidebar],
    ),
    (
        "space.roomy.space.updateSidebar.v1",
        &[RecordKind::SpaceSidebar],
    ),
    ("space.roomy.space.setHandleProvider.v0", &[]),
    ("space.roomy.page.editPage.v0", &[]),
    // profile
    ("space.roomy.user.updateProfile.v0", &[RecordKind::Profile]),
    // room links
    (
        "space.roomy.link.createRoomLink.v0",
        &[RecordKind::Room, RecordKind::Message],
    ),
    ("space.roomy.link.removeRoomLink.v0", &[RecordKind::Room]),
    // integrations
    (
        "space.roomy.openmeet.configure.v0",
        &[RecordKind::CalendarLink],
    ),
    // read state
    ("space.roomy.state.markRead.v0", &[]),
    // ban and invite
    ("space.roomy.space.banAccount.v0", &[RecordKind::Ban]),
    ("space.roomy.space.unbanAccount.v0", &[RecordKind::Ban]),
    ("space.roomy.space.createInvite.v0", &[RecordKind::Invite]),
    ("space.roomy.space.revokeInvite.v0", &[RecordKind::Invite]),
    // roles and permissions
    ("space.roomy.role.createRole.v0", &[RecordKind::Role]),
    ("space.roomy.role.deleteRole.v0", &[RecordKind::Role]),
    ("space.roomy.role.updateRole.v0", &[RecordKind::Role]),
    (
        "space.roomy.role.addMemberRole.v0",
        &[RecordKind::RoleGrant],
    ),
    (
        "space.roomy.role.removeMemberRole.v0",
        &[RecordKind::RoleGrant],
    ),
    (
        "space.roomy.role.setRoleRoomPermission.v0",
        &[RecordKind::RoomPermission],
    ),
    // federation
    (
        "space.roomy.federation.request.v0",
        &[RecordKind::FederationRequest],
    ),
    (
        "space.roomy.federation.respond.v0",
        &[RecordKind::FederationRequest],
    ),
    (
        "space.roomy.federation.remove.v0",
        &[RecordKind::FederationRequest, RecordKind::FederationGrant],
    ),
    (
        "space.roomy.federation.setRoomPermission.v0",
        &[RecordKind::FederationGrant],
    ),
    (
        "space.roomy.federation.setReceiverPermission.v0",
        &[RecordKind::FederationGrant],
    ),
    // voice
    ("space.roomy.voice.callStarted.v0", &[RecordKind::VoiceCall]),
    ("space.roomy.voice.callJoined.v0", &[RecordKind::VoiceCall]),
    ("space.roomy.voice.callLeft.v0", &[RecordKind::VoiceCall]),
    ("space.roomy.voice.callEnded.v0", &[RecordKind::VoiceCall]),
];

/// The kinds whose producer exists: every kind the adapter in
/// [`crate::record_change`] can emit.
///
/// The list is explicit rather than assumed from the kind enum so that a kind
/// the projection can apply but the log cannot produce is visibly absent: the
/// ingress routes an event to the feed only when all of its kinds are here.
pub const CONVERTED_KINDS: &[RecordKind] = &[
    RecordKind::Message,
    RecordKind::Reaction,
    RecordKind::Room,
    RecordKind::SpaceInfo,
    RecordKind::SpaceSidebar,
    RecordKind::Membership,
    RecordKind::Ban,
    RecordKind::Invite,
    RecordKind::Role,
    RecordKind::RoleGrant,
    RecordKind::RoomPermission,
    RecordKind::FederationRequest,
    RecordKind::FederationGrant,
    RecordKind::Profile,
    RecordKind::CalendarLink,
    RecordKind::VoiceCall,
];

/// Whether a producer exists for `kind`.
pub fn is_converted(kind: RecordKind) -> bool {
    CONVERTED_KINDS.contains(&kind)
}

/// The kinds `nsid` writes, in emission order; `None` when the event is not in
/// the model at all.
pub fn kinds_for_event(nsid: &str) -> Option<&'static [RecordKind]> {
    RECORD_KINDS_FOR_EVENT
        .iter()
        .find(|(declared, _)| *declared == nsid)
        .map(|(_, kinds)| *kinds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_event_table_names_kinds_in_emission_order() {
        assert_eq!(
            kinds_for_event("space.roomy.link.createRoomLink.v0"),
            Some(&[RecordKind::Room, RecordKind::Message][..])
        );
        assert_eq!(
            kinds_for_event("space.roomy.federation.remove.v0"),
            Some(&[RecordKind::FederationRequest, RecordKind::FederationGrant][..])
        );
        assert_eq!(
            kinds_for_event("space.roomy.state.markRead.v0"),
            Some(&[] as &[RecordKind])
        );
        assert_eq!(kinds_for_event("space.roomy.nope.v0"), None);
    }

    #[test]
    fn every_mapped_kind_has_a_producer() {
        for (nsid, kinds) in RECORD_KINDS_FOR_EVENT {
            assert!(
                kinds.iter().all(|kind| is_converted(*kind)),
                "{nsid} names a kind with no producer"
            );
        }
    }

    #[test]
    fn a_kinds_collection_is_the_nsid_the_lexicon_names() {
        assert_eq!(
            RecordCollection::of(RecordKind::Message).as_str(),
            "space.roomy.room.message"
        );
        assert_eq!(
            RecordCollection::of(RecordKind::Profile).as_str(),
            "space.roomy.user.profile"
        );
        assert_eq!(
            RecordCollection::of(RecordKind::VoiceCall).as_str(),
            "space.roomy.voice.call"
        );
    }
}
