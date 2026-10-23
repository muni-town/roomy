//! The one entry point of the state machine.
//!
//! Everything `bridge-core` decides is reachable from [`step`]: give it the
//! machine's memory and one input, get back either the ops to apply or the
//! reason nothing is applied. The alternative — a dozen free functions each
//! carrying a slice of the state — lets a caller skip a decision (an echo, a
//! redelivery, a stale edit) without the compiler noticing, which is exactly
//! the class of bug a bidirectional bridge cannot afford.

use crate::dedupe::{Dedupe, Mapping, MappingKind};
use crate::ids::GhostDid;
use crate::op::Op;
use crate::portal::Portal;
use crate::translate::{translate, EditOrder, IncomingEvent};

/// The whole memory of the machine.
///
/// Holds the id map and the edit-ordering watermark; both are rebuilt from the
/// database on start and written back as ops are accepted, so the machine
/// itself does no I/O.
#[derive(Debug, Clone, Default)]
pub struct BridgeState {
    dedupe: Dedupe,
    edits: EditOrder,
}

impl BridgeState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a pairing, in both directions.
    pub fn record_mapping(&mut self, mapping: Mapping) {
        self.dedupe.record(mapping);
    }

    /// The Roomy id a Matrix id maps to.
    pub fn roomy_id(&self, kind: MappingKind, matrix_id: &str) -> Option<&str> {
        self.dedupe.roomy_id(kind, matrix_id)
    }

    /// The Matrix id a Roomy id maps to.
    pub fn matrix_id(&self, kind: MappingKind, roomy_id: &str) -> Option<&str> {
        self.dedupe.matrix_id(kind, roomy_id)
    }

    /// Forget a pairing, for a redaction that should stop suppressing.
    pub fn forget_mapping(&mut self, kind: MappingKind, matrix_id: &str) -> Option<Mapping> {
        self.dedupe.forget(kind, matrix_id)
    }
}

/// One thing the machine can be asked to decide.
///
/// An enum rather than positional arguments so a later input kind (a rooomy
/// event, a clock tick) is added without changing every call site's shape.
#[derive(Debug, Clone, Copy)]
pub enum Input<'a> {
    /// An event the homeserver delivered, with the portal it belongs to and
    /// the ghost DID its author maps to.
    Matrix {
        event: &'a IncomingEvent,
        portal: &'a Portal,
        ghost: &'a GhostDid,
    },
}

/// The result of applying one input.
///
/// `Rejected` carries why, so a caller cannot silently drop an event: the only
/// way to read ops is to match `Accepted`, and the rejection reason is what the
/// logs and the admin API report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Apply these ops in order.
    Accepted(Vec<Op>),
    /// Apply nothing.
    Rejected(Rejection),
}

impl Step {
    /// The ops, when the input was accepted.
    pub fn accepted(&self) -> Option<&[Op]> {
        match self {
            Step::Accepted(ops) => Some(ops),
            Step::Rejected(_) => None,
        }
    }
}

/// Why an input produced no ops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The event names this bridge in its origin extension.
    Echo,
    /// The event id is already in the id map: a redelivered transaction.
    Duplicate,
    /// A later edit of the same message has already been applied.
    Superseded,
    /// The target of this edit, redaction or reaction has no Roomy event.
    NotBridged,
}

impl Rejection {
    pub fn label(self) -> &'static str {
        match self {
            Rejection::Echo => "echo",
            Rejection::Duplicate => "duplicate",
            Rejection::Superseded => "superseded",
            Rejection::NotBridged => "not bridged",
        }
    }
}

/// Apply one input to the machine.
pub fn step(state: &mut BridgeState, input: Input<'_>) -> Step {
    match input {
        Input::Matrix {
            event,
            portal,
            ghost,
        } => translate(event, portal, ghost, &state.dedupe, &mut state.edits),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{MatrixEventId, MatrixRoomId, RoomyRoomId};
    use crate::portal::{PortalEncryption, PortalState};
    use crate::translate::{Body, IncomingKind, IncomingMedia};

    fn portal() -> Portal {
        Portal {
            id: crate::ids::PortalId::new(
                crate::ids::SpaceDid::parse("did:plc:space").unwrap(),
                MatrixRoomId::parse("!room:example.org").unwrap(),
            ),
            roomy_room_id: RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: None,
            encryption: PortalEncryption::plain(),
            state: PortalState::Syncing,
            created_at: 0,
        }
    }

    fn ghost() -> GhostDid {
        GhostDid::parse("did:matrix:%40alice%3Aexample.org").unwrap()
    }

    fn message(event_id: &str) -> IncomingEvent {
        IncomingEvent {
            event_id: MatrixEventId::parse(event_id).unwrap(),
            room_id: MatrixRoomId::parse("!room:example.org").unwrap(),
            sender: crate::ids::GhostMxid::parse("@alice:example.org").unwrap(),
            origin_server_ts: 1,
            kind: IncomingKind::Message {
                body: Body::plain("hello"),
                media: Vec::<IncomingMedia>::new(),
                reply_to: None,
                thread_root: None,
            },
            encrypted: false,
        }
    }

    fn step_message(state: &mut BridgeState, event: &IncomingEvent) -> Step {
        step(
            state,
            Input::Matrix {
                event,
                portal: &portal(),
                ghost: &ghost(),
            },
        )
    }

    #[test]
    fn a_new_event_is_accepted() {
        let mut state = BridgeState::new();
        match step_message(&mut state, &message("$one")) {
            Step::Accepted(ops) => {
                assert_eq!(ops.len(), 1);
                assert!(matches!(ops[0], Op::Send { .. }));
            }
            Step::Rejected(reason) => panic!("unexpected rejection: {reason:?}"),
        }
    }

    #[test]
    fn a_redelivered_event_is_rejected_as_a_duplicate() {
        let mut state = BridgeState::new();
        state.record_mapping(Mapping {
            kind: MappingKind::Message,
            matrix_id: "$one".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD".into(),
            created_at: 0,
        });
        assert_eq!(
            step_message(&mut state, &message("$one")),
            Step::Rejected(Rejection::Duplicate)
        );
    }

    #[test]
    fn an_edit_of_an_unbridged_message_is_rejected() {
        let mut state = BridgeState::new();
        let event = IncomingEvent {
            kind: IncomingKind::Edit {
                target: MatrixEventId::parse("$missing").unwrap(),
                body: Body::plain("changed"),
            },
            ..message("$edit")
        };
        assert_eq!(
            step_message(&mut state, &event),
            Step::Rejected(Rejection::NotBridged)
        );
    }
}
