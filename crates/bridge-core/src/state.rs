//! The one entry point of the state machine.
//!
//! Everything `bridge-core` decides is reachable from [`step`]: give it the
//! machine's memory and one input, get back either the writes to apply or the
//! reason nothing is applied. The alternative — a dozen free functions each
//! carrying a slice of the state — lets a caller skip a decision (an echo, a
//! redelivery, a stale edit) without the compiler noticing, which is exactly
//! the class of bug a bidirectional bridge cannot afford.

use crate::dedupe::{Dedupe, Mapping, MappingKind};
use crate::ids::{GhostDid, RoomyEventId};
use crate::op::Op;
use crate::portal::Portal;
use crate::translate::{self, EditOrder, IncomingEvent};
use crate::Millis;

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
    /// An empty machine, with no pairings recorded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adopt a pairing the store already holds.
    ///
    /// This is the warm-start path: the id map is rebuilt from the database so
    /// a restart still recognises the events the bridge wrote before it
    /// stopped. Pairings for accepted inputs are recorded by [`step`], not
    /// here.
    pub fn record_mapping(&mut self, mapping: Mapping) {
        self.dedupe.record(mapping);
    }

    /// The Matrix id a Roomy id maps to.
    pub fn matrix_id(&self, kind: MappingKind, roomy_id: &str) -> Option<&str> {
        self.dedupe.matrix_id(kind, roomy_id)
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
        /// The event the homeserver delivered.
        event: &'a IncomingEvent,
        /// The portal the event belongs to.
        portal: &'a Portal,
        /// The DID the event's author maps to.
        ghost: &'a GhostDid,
    },
}

/// One write the machine decided on.
///
/// Carries the op, the Roomy event id it must be written under, and the id
/// pairing recording it. Minting the id and recording the pairing are the
/// machine's, so a caller that forwards ops cannot leave a write unpaired: a
/// bridge that did would relay its own write back forever. The only thing left
/// outside [`step`] is persisting [`mapping`](Self::mapping) so the pairing
/// survives a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecidedWrite {
    op: Op,
    id: RoomyEventId,
    mapping: Mapping,
}

impl DecidedWrite {
    /// The op to apply.
    pub fn op(&self) -> &Op {
        &self.op
    }

    /// The Roomy event id the op must be written under.
    pub fn id(&self) -> &RoomyEventId {
        &self.id
    }

    /// The pairing this write establishes, already recorded in the machine's
    /// id map.
    pub fn mapping(&self) -> &Mapping {
        &self.mapping
    }
}

/// The result of applying one input.
///
/// `Rejected` carries why, so a caller cannot silently drop an event: the only
/// way to read writes is to match `Accepted`, and the rejection reason is what
/// the logs and the admin API report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Apply these writes in order.
    Accepted(Vec<DecidedWrite>),
    /// Apply nothing.
    Rejected(Rejection),
}

impl Step {
    /// The writes, when the input was accepted.
    pub fn accepted(&self) -> Option<&[DecidedWrite]> {
        match self {
            Step::Accepted(writes) => Some(writes),
            Step::Rejected(_) => None,
        }
    }
}

/// Why an input produced no writes.
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
    /// The stable label the logs and the admin API report.
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
///
/// `now` stamps the pairings an accepted input records; it is the caller's
/// clock because the machine has none.
#[must_use]
pub fn step(state: &mut BridgeState, input: Input<'_>, now: Millis) -> Step {
    let Input::Matrix {
        event,
        portal,
        ghost,
    } = input;

    let decisions =
        match translate::translate(event, portal, ghost, &state.dedupe, &mut state.edits) {
            Ok(decisions) => decisions,
            Err(rejection) => return Step::Rejected(rejection),
        };

    // The write is decided; these are the two things every decision needs
    // before a caller can see it: an id to be written under, and the pairing
    // that makes the resulting Matrix event recognisable as the bridge's own.
    // Recording it here rather than leaving it to the caller is what makes a
    // redelivery of this event a `Duplicate` without the caller doing anything.
    let mut writes = Vec::with_capacity(decisions.len());
    for decision in decisions {
        let id = RoomyEventId::new();
        let mapping = Mapping {
            kind: decision.kind,
            matrix_id: event.event_id.as_str().to_string(),
            roomy_id: id.as_str().to_string(),
            created_at: now,
        };
        state.dedupe.record(mapping.clone());
        writes.push(DecidedWrite {
            op: decision.op,
            id,
            mapping,
        });
    }

    Step::Accepted(writes)
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
            1_700_000_000_000,
        )
    }

    #[test]
    fn a_new_event_is_accepted() {
        let mut state = BridgeState::new();
        match step_message(&mut state, &message("$one")) {
            Step::Accepted(writes) => {
                assert_eq!(writes.len(), 1);
                assert!(matches!(writes[0].op(), Op::Send { .. }));
            }
            Step::Rejected(reason) => panic!("unexpected rejection: {reason:?}"),
        }
    }

    #[test]
    fn an_accepted_op_arrives_paired_exactly_once() {
        let mut state = BridgeState::new();
        let Step::Accepted(writes) = step_message(&mut state, &message("$one")) else {
            panic!("a new event is accepted");
        };
        let write = &writes[0];

        // One write, one pairing, naming the op's own id and the Matrix event
        // it answers — not a second one the caller had to invent.
        assert_eq!(writes.len(), 1);
        assert_eq!(
            write.mapping(),
            &Mapping {
                kind: MappingKind::Message,
                matrix_id: "$one".into(),
                roomy_id: write.id().as_str().to_string(),
                created_at: 1_700_000_000_000,
            }
        );
        // And the machine's id map holds it in the reverse direction, which is
        // what an edit or a reaction resolves through.
        assert_eq!(
            state.matrix_id(MappingKind::Message, write.id().as_str()),
            Some("$one")
        );
    }

    #[test]
    fn a_redelivery_of_an_accepted_event_is_a_duplicate() {
        // No hand-recorded mapping: the caller only steps and forwards.
        let mut state = BridgeState::new();
        assert!(matches!(
            step_message(&mut state, &message("$one")),
            Step::Accepted(_)
        ));
        assert_eq!(
            step_message(&mut state, &message("$one")),
            Step::Rejected(Rejection::Duplicate)
        );
    }

    #[test]
    fn an_accepted_message_can_be_edited_without_the_caller_recording_anything() {
        // The pairing an accepted write records is the one a later edit
        // resolves through, so a caller that only forwards ops keeps the id
        // map the machine's decisions depend on.
        let mut state = BridgeState::new();
        let Step::Accepted(writes) = step_message(&mut state, &message("$one")) else {
            panic!("a new event is accepted");
        };
        let sent = writes[0].id().as_str().to_string();

        let edit = IncomingEvent {
            kind: IncomingKind::Edit {
                target: MatrixEventId::parse("$one").unwrap(),
                body: Body::plain("changed"),
            },
            ..message("$two")
        };
        match step_message(&mut state, &edit) {
            Step::Accepted(writes) => match writes[0].op() {
                Op::Edit { target, .. } => assert_eq!(target.as_str(), sent),
                other => panic!("expected an edit, got {other:?}"),
            },
            Step::Rejected(reason) => panic!("unexpected rejection: {reason:?}"),
        }
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
