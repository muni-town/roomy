//! The two injected capabilities: a clock and a store.
//!
//! Both exist so the machine is testable without a real time source or disk.
//! `VirtualClock` is the one tests use; `SystemClock` is what the binary wires
//! in.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};

use crate::dedupe::Mapping;
use crate::ids::{MatrixRoomId, RoomyRoomId};
use crate::Millis;

/// A source of wall-clock time.
pub trait Clock: Send + Sync {
    /// Milliseconds since the unix epoch.
    fn now_ms(&self) -> Millis;
}

/// The real clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> Millis {
        let elapsed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        elapsed.as_millis() as Millis
    }
}

/// A clock that only moves when a test moves it.
#[derive(Debug, Default)]
pub struct VirtualClock {
    now: AtomicI64,
}

impl VirtualClock {
    /// A clock reading `start` milliseconds.
    pub fn new(start: Millis) -> Self {
        Self {
            now: AtomicI64::new(start),
        }
    }

    /// Move the clock forward by `millis`.
    pub fn advance(&self, millis: Millis) {
        self.now.fetch_add(millis, Ordering::SeqCst);
    }

    /// Move the clock to `millis`, in either direction.
    pub fn set(&self, millis: Millis) {
        self.now.store(millis, Ordering::SeqCst);
    }
}

impl Clock for VirtualClock {
    fn now_ms(&self) -> Millis {
        self.now.load(Ordering::SeqCst)
    }
}

/// A message the bridge has already relayed, as the store keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredMessage {
    /// The Matrix event id the message was bridged from.
    pub matrix_event_id: String,
    /// The Roomy event id the bridge wrote.
    pub roomy_event_id: String,
    /// The Matrix room the message came from.
    pub matrix_room_id: MatrixRoomId,
    /// The Roomy room the message went to.
    pub roomy_room_id: RoomyRoomId,
    /// The author's ghost DID, so an edit or redaction can be checked against
    /// the original sender.
    pub author: String,
    /// The source timestamp, in wall-clock milliseconds.
    pub timestamp: Millis,
}

/// What the bridge must persist between restarts.
///
/// Deliberately a small surface: mappings and the per-room cursor. Everything
/// else the machine can rebuild from the appserver's event log.
pub trait Storage: Send + Sync {
    /// Persist a new id pairing.
    fn put_mapping(&mut self, mapping: Mapping) -> Result<(), StorageError>;

    /// Every mapping of one kind, to warm the in-memory index at startup.
    fn mappings(&self) -> Result<Vec<Mapping>, StorageError>;

    /// The stream position the bridge last processed for a Roomy room.
    fn cursor(&self, space_did: &str, roomy_room_id: &str) -> Result<Option<String>, StorageError>;

    /// Advance the cursor.
    fn set_cursor(
        &mut self,
        space_did: &str,
        roomy_room_id: &str,
        matrix_stream_pos: Option<String>,
        roomy_cursor: Option<i64>,
    ) -> Result<(), StorageError>;
}

/// A storage failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("storage error: {0}")]
pub struct StorageError(pub String);

/// A store that keeps everything in memory. Used by tests and by the binary's
/// dry-run mode; it does not survive a restart, which is the point.
#[derive(Debug, Default)]
pub struct InMemoryStorage {
    mappings: Vec<Mapping>,
    cursors: BTreeMap<(String, String), (Option<String>, Option<i64>)>,
}

impl InMemoryStorage {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl Storage for InMemoryStorage {
    fn put_mapping(&mut self, mapping: Mapping) -> Result<(), StorageError> {
        let exists = self.mappings.iter().any(|existing| {
            existing.kind == mapping.kind && existing.matrix_id == mapping.matrix_id
        });
        if !exists {
            self.mappings.push(mapping);
        }
        Ok(())
    }

    fn mappings(&self) -> Result<Vec<Mapping>, StorageError> {
        Ok(self.mappings.clone())
    }

    fn cursor(&self, space_did: &str, roomy_room_id: &str) -> Result<Option<String>, StorageError> {
        Ok(self
            .cursors
            .get(&(space_did.to_string(), roomy_room_id.to_string()))
            .and_then(|(position, _)| position.clone()))
    }

    fn set_cursor(
        &mut self,
        space_did: &str,
        roomy_room_id: &str,
        matrix_stream_pos: Option<String>,
        roomy_cursor: Option<i64>,
    ) -> Result<(), StorageError> {
        self.cursors.insert(
            (space_did.to_string(), roomy_room_id.to_string()),
            (matrix_stream_pos, roomy_cursor),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedupe::MappingKind;

    #[test]
    fn the_virtual_clock_only_moves_when_told_to() {
        let clock = VirtualClock::new(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(500);
        assert_eq!(clock.now_ms(), 1_500);
        clock.set(0);
        assert_eq!(clock.now_ms(), 0);
    }

    #[test]
    fn the_system_clock_is_after_the_epoch() {
        assert!(SystemClock.now_ms() > 1_600_000_000_000);
    }

    #[test]
    fn a_mapping_is_stored_once() {
        let mut storage = InMemoryStorage::new();
        let mapping = Mapping {
            kind: MappingKind::Message,
            matrix_id: "$evt".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB".into(),
            created_at: 0,
        };
        storage.put_mapping(mapping.clone()).unwrap();
        storage.put_mapping(mapping).unwrap();
        assert_eq!(storage.mappings().unwrap().len(), 1);
    }

    #[test]
    fn cursors_round_trip() {
        let mut storage = InMemoryStorage::new();
        assert_eq!(storage.cursor("did:plc:space", "room").unwrap(), None);
        storage
            .set_cursor("did:plc:space", "room", Some("t42".into()), Some(42))
            .unwrap();
        assert_eq!(
            storage.cursor("did:plc:space", "room").unwrap(),
            Some("t42".to_string())
        );
    }
}
