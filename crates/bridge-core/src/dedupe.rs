//! Echo suppression.
//!
//! A bidirectional bridge sees its own writes come back. The rule is that a
//! message is "ours" if either
//!
//! * its id is in the id map (the bridge created it and recorded the pairing),
//!   or
//! * its payload carries an origin extension naming the other platform,
//!
//! and never by comparing content. Content comparison is wrong in both
//! directions: an edit changes the body the original mapping was keyed on, and
//! a user may legitimately send the same text twice, which content comparison
//! would silently drop.

use std::collections::{HashMap, HashSet};

use roomy_events::MatrixMessageOrigin;
use serde::{Deserialize, Serialize};

use crate::Millis;

/// What the dedupe layer decides about an inbound event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EchoDecision {
    /// Relay it: the bridge has not seen this event before.
    Relay,
    /// Drop it: the event names the other platform in its origin extension, so
    /// the bridge produced it.
    Echo,
    /// Drop it: the event id is already in the map, so this is a redelivery of
    /// something the bridge applied.
    Duplicate,
}

/// The kind of pairing an id map entry records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MappingKind {
    Message,
    Reaction,
    Room,
    Edit,
    Redaction,
}

/// One id-map entry: a Matrix id and the Roomy id it corresponds to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mapping {
    pub kind: MappingKind,
    pub matrix_id: String,
    pub roomy_id: String,
    pub created_at: Millis,
}

/// The forward and reverse id maps, plus the origin check.
///
/// Kept as one type because every caller that needs one direction eventually
/// needs the other: a redaction names the Matrix id, the Roomy delete names the
/// Roomy id, and both must resolve.
#[derive(Debug, Clone, Default)]
pub struct Dedupe {
    by_matrix: HashMap<(MappingKind, String), Mapping>,
    by_roomy: HashMap<(MappingKind, String), Mapping>,
    /// Every Matrix id the bridge has written, whatever its kind. The echo
    /// check is "did I produce this id", and an edit or a reaction the bridge
    /// sent comes back as its own event, not as a message.
    written: HashSet<String>,
}

impl Dedupe {
    /// Record a pairing. Recording the same pair twice is a no-op, which makes
    /// replay after a restart idempotent.
    pub fn record(&mut self, mapping: Mapping) {
        let matrix_key = (mapping.kind, mapping.matrix_id.clone());
        let roomy_key = (mapping.kind, mapping.roomy_id.clone());
        self.written.insert(mapping.matrix_id.clone());
        self.by_matrix.insert(matrix_key, mapping.clone());
        self.by_roomy.insert(roomy_key, mapping);
    }

    /// The Roomy id for a Matrix id.
    pub fn roomy_id(&self, kind: MappingKind, matrix_id: &str) -> Option<&str> {
        self.by_matrix
            .get(&(kind, matrix_id.to_string()))
            .map(|mapping| mapping.roomy_id.as_str())
    }

    /// The Matrix id for a Roomy id.
    pub fn matrix_id(&self, kind: MappingKind, roomy_id: &str) -> Option<&str> {
        self.by_roomy
            .get(&(kind, roomy_id.to_string()))
            .map(|mapping| mapping.matrix_id.as_str())
    }

    /// Remove a pairing, for a redaction that should stop suppressing.
    pub fn forget(&mut self, kind: MappingKind, matrix_id: &str) -> Option<Mapping> {
        let mapping = self.by_matrix.remove(&(kind, matrix_id.to_string()))?;
        self.written.remove(mapping.matrix_id.as_str());
        self.by_roomy
            .remove(&(mapping.kind, mapping.roomy_id.clone()));
        Some(mapping)
    }

    /// Whether a Matrix event is one the bridge produced.
    ///
    /// Two independent signals, either of which is sufficient. The id map is
    /// the fast path; the origin extension is what still works after the bridge
    /// database is lost and the id map is empty.
    pub fn classify_matrix(
        &self,
        event_id: &str,
        origin: Option<&MatrixMessageOrigin>,
    ) -> EchoDecision {
        if self.written.contains(event_id) {
            return EchoDecision::Duplicate;
        }
        if origin.is_some() {
            return EchoDecision::Echo;
        }
        EchoDecision::Relay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(kind: MappingKind, matrix_id: &str, roomy_id: &str) -> Mapping {
        Mapping {
            kind,
            matrix_id: matrix_id.to_string(),
            roomy_id: roomy_id.to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn a_recorded_pair_is_a_duplicate_for_its_matrix_id() {
        let mut dedupe = Dedupe::default();
        dedupe.record(mapping(
            MappingKind::Message,
            "$evt",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
        ));
        assert_eq!(
            dedupe.classify_matrix("$evt", None),
            EchoDecision::Duplicate
        );
        assert_eq!(
            dedupe.matrix_id(MappingKind::Message, "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB"),
            Some("$evt")
        );
    }

    #[test]
    fn an_edit_or_reaction_the_bridge_sent_is_a_duplicate_too() {
        // An edit comes back as `m.room.message`, a reaction as `m.reaction`:
        // the echo check cannot be keyed on the message kind alone.
        let mut dedupe = Dedupe::default();
        dedupe.record(mapping(
            MappingKind::Edit,
            "$edited",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
        ));
        dedupe.record(mapping(
            MappingKind::Reaction,
            "$reacted",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD",
        ));
        assert_eq!(
            dedupe.classify_matrix("$edited", None),
            EchoDecision::Duplicate
        );
        assert_eq!(
            dedupe.classify_matrix("$reacted", None),
            EchoDecision::Duplicate
        );
    }

    #[test]
    fn an_unknown_event_is_relayed() {
        let dedupe = Dedupe::default();
        assert_eq!(
            dedupe.classify_matrix("$unknown", None),
            EchoDecision::Relay
        );
        assert_eq!(
            dedupe.matrix_id(MappingKind::Message, "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB"),
            None
        );
    }

    #[test]
    fn the_origin_extension_alone_suppresses() {
        // This is the case that survives a database loss: the id map is gone
        // but the event's own payload still says where it came from.
        let dedupe = Dedupe::default();
        let origin = MatrixMessageOrigin {
            room_id: "!room:example.org".into(),
            event_id: Some("$evt".into()),
            origin_server_ts: Some(1),
        };
        assert_eq!(
            dedupe.classify_matrix("$evt", Some(&origin)),
            EchoDecision::Echo
        );
    }

    #[test]
    fn identical_content_is_not_an_echo() {
        // Two different Matrix events carrying the same body are two messages.
        // Only ids decide, so this must relay.
        let mut dedupe = Dedupe::default();
        dedupe.record(mapping(
            MappingKind::Message,
            "$first",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
        ));
        assert_eq!(dedupe.classify_matrix("$second", None), EchoDecision::Relay);
    }

    #[test]
    fn mappings_are_keyed_by_kind() {
        let mut dedupe = Dedupe::default();
        dedupe.record(mapping(
            MappingKind::Message,
            "$evt",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
        ));
        dedupe.record(mapping(
            MappingKind::Reaction,
            "$evt",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD",
        ));
        assert_eq!(
            dedupe.roomy_id(MappingKind::Reaction, "$evt"),
            Some("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0CD")
        );
        assert_eq!(
            dedupe.roomy_id(MappingKind::Message, "$evt"),
            Some("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB")
        );
    }

    #[test]
    fn forgetting_a_pair_clears_both_directions() {
        let mut dedupe = Dedupe::default();
        dedupe.record(mapping(
            MappingKind::Message,
            "$evt",
            "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB",
        ));
        dedupe.forget(MappingKind::Message, "$evt");
        assert_eq!(dedupe.classify_matrix("$evt", None), EchoDecision::Relay);
        assert_eq!(
            dedupe.matrix_id(MappingKind::Message, "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB"),
            None
        );
    }
}
