//! Portals: one bridged Matrix room ↔ one Roomy room.

use serde::{Deserialize, Serialize};

use crate::ids::{MatrixDeviceId, MatrixRoomId, PortalId, RoomyRoomId, SpaceDid};
use crate::Millis;

/// Whether the bridge was configured with one room or a whole space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortalKind {
    /// A single Matrix room bridged to one Roomy channel or thread.
    Room,
    /// A Matrix space whose children are bridged.
    Space,
}

/// What a portal is doing right now.
///
/// The distinction the UI needs is "is this moving, and if not, why" — so
/// `Paused` and `Blocked` carry a reason instead of being two more booleans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum PortalState {
    /// Live in both directions.
    Syncing,
    /// Draining history from Matrix into Roomy; live events still flow.
    Backfilling {
        /// Messages written into Roomy so far.
        messages: u64,
    },
    /// Deliberately stopped — an operator disabled it, or the bridge is
    /// shutting down cleanly.
    Paused {
        /// Why the bridge stopped the portal.
        reason: String,
    },
    /// Cannot proceed without operator action — no room key, a refused
    /// hierarchy, a missing permission.
    Blocked {
        /// What an operator has to change before it can proceed.
        reason: String,
    },
}

impl PortalState {
    /// Whether live events flow in both directions right now.
    pub fn is_live(&self) -> bool {
        matches!(self, PortalState::Syncing | PortalState::Backfilling { .. })
    }

    /// The short label the admin API reports.
    pub fn label(&self) -> &'static str {
        match self {
            PortalState::Syncing => "syncing",
            PortalState::Backfilling { .. } => "backfilling",
            PortalState::Paused { .. } => "paused",
            PortalState::Blocked { .. } => "blocked",
        }
    }

    /// Why the portal is not syncing, for the paused and blocked states.
    pub fn reason(&self) -> Option<&str> {
        match self {
            PortalState::Paused { reason } | PortalState::Blocked { reason } => Some(reason),
            _ => None,
        }
    }
}

/// How a portal's Matrix room is encrypted, and whether the bridge can speak to
/// it.
///
/// `Encrypted` carries the device that holds the room key when one exists. A
/// portal known to be encrypted but without a usable device is not `Plain` —
/// sending plaintext into an encrypted room is the failure this type exists to
/// make unrepresentable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "encryption", rename_all = "snake_case")]
pub enum PortalEncryption {
    /// The room carries no `m.room.encryption` state.
    Plain,
    /// The room is encrypted; `device` says whether the bridge can encrypt.
    Encrypted {
        /// Whether the bridge can encrypt for the room.
        #[serde(flatten)]
        device: EncryptionDevice,
    },
}

/// The bridge's ability to encrypt for one room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "device", rename_all = "snake_case")]
pub enum EncryptionDevice {
    /// The bridge device that encrypts for this room is running.
    Ready(MatrixDeviceId),
    /// The room is encrypted and the bridge has no way to encrypt for it.
    Unusable {
        /// What the bridge lacks.
        missing: MissingFeature,
    },
}

/// What an encrypted portal lacks, named so the admin API can say why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissingFeature {
    /// The homeserver does not deliver MSC4203 to-device messages, so room
    /// keys never arrive.
    Msc4203ToDevice,
    /// No crypto device is running at all.
    CryptoDevice,
}

impl MissingFeature {
    /// The kebab-case name the admin API reports.
    pub fn label(self) -> &'static str {
        match self {
            MissingFeature::Msc4203ToDevice => "msc4203-to-device",
            MissingFeature::CryptoDevice => "crypto-device",
        }
    }
}

impl PortalEncryption {
    /// A room with no encryption state.
    pub fn plain() -> Self {
        PortalEncryption::Plain
    }

    /// An encrypted room the bridge can encrypt for.
    pub fn encrypted_with(device: MatrixDeviceId) -> Self {
        PortalEncryption::Encrypted {
            device: EncryptionDevice::Ready(device),
        }
    }

    /// An encrypted room the bridge cannot encrypt for, and why.
    pub fn encrypted_unusable(missing: MissingFeature) -> Self {
        PortalEncryption::Encrypted {
            device: EncryptionDevice::Unusable { missing },
        }
    }

    /// Whether the Matrix room is encrypted, whether or not the bridge can
    /// speak to it.
    pub fn is_encrypted(&self) -> bool {
        matches!(self, PortalEncryption::Encrypted { .. })
    }

    /// The device to encrypt with, or why encryption cannot happen.
    ///
    /// This is the only route to a [`MatrixDeviceId`] for encryption, so an
    /// encrypted send cannot be attempted without one.
    pub fn device(&self) -> Option<&MatrixDeviceId> {
        match self {
            PortalEncryption::Plain => None,
            PortalEncryption::Encrypted {
                device: EncryptionDevice::Ready(device),
            } => Some(device),
            PortalEncryption::Encrypted {
                device: EncryptionDevice::Unusable { .. },
            } => None,
        }
    }

    /// The missing features, when the portal is encrypted but unusable.
    pub fn missing(&self) -> Option<MissingFeature> {
        match self {
            PortalEncryption::Encrypted {
                device: EncryptionDevice::Unusable { missing },
            } => Some(*missing),
            _ => None,
        }
    }
}

/// One bridged room pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Portal {
    /// Which space and Matrix room this portal is. A portal is addressed by
    /// both, and the stored row is keyed by the pair.
    pub id: PortalId,
    /// The Roomy room (channel or thread) it maps to.
    pub roomy_room_id: RoomyRoomId,
    /// Depth of the Matrix room in the space hierarchy. Depth 1 is a channel
    /// directly under the bridged space, depth 2 a thread under that channel,
    /// depth ≥ 3 is flattened into the nearest depth-2 parent.
    pub depth: u32,
    /// The room's name at the time the portal was created, used when a flat
    /// `depth ≥ 3` room needs a name that says where it really came from.
    pub name: Option<String>,
    /// Whether the Matrix room is encrypted and whether the bridge can encrypt
    /// for it. An encrypted room the bridge cannot read is `Blocked` rather
    /// than silently plaintext.
    pub encryption: PortalEncryption,
    /// What the portal is doing right now.
    pub state: PortalState,
    /// When the portal row was created, in wall-clock milliseconds.
    pub created_at: Millis,
}

impl Portal {
    /// The Matrix room this portal bridges.
    pub fn matrix_room_id(&self) -> &MatrixRoomId {
        self.id.matrix_room()
    }

    /// The space this portal bridges into.
    pub fn space(&self) -> &SpaceDid {
        self.id.space()
    }

    /// The prefix a flattened deep room's name gets, so a reader can tell that
    /// a thread is not where the room lives on the Matrix side.
    pub fn flattened_name(&self, parent_name: &str) -> String {
        match &self.name {
            Some(name) => format!("{parent_name} / {name}"),
            None => parent_name.to_string(),
        }
    }

    /// Whether the room is encrypted, whether or not the bridge can speak to it.
    pub fn is_encrypted(&self) -> bool {
        self.encryption.is_encrypted()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_syncing_and_backfilling_are_live() {
        assert!(PortalState::Syncing.is_live());
        assert!(PortalState::Backfilling { messages: 3 }.is_live());
        assert!(!PortalState::Paused { reason: "x".into() }.is_live());
        assert!(!PortalState::Blocked { reason: "x".into() }.is_live());
    }

    #[test]
    fn states_report_their_reason_only_when_there_is_one() {
        assert_eq!(PortalState::Syncing.reason(), None);
        assert_eq!(
            PortalState::Blocked {
                reason: "no room key".into()
            }
            .reason(),
            Some("no room key")
        );
    }

    #[test]
    fn flattened_names_keep_the_original_room() {
        let portal = Portal {
            id: PortalId::new(
                SpaceDid::parse("did:plc:space").unwrap(),
                MatrixRoomId::parse("!deep:example.org").unwrap(),
            ),
            roomy_room_id: RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 3,
            name: Some("design".into()),
            encryption: PortalEncryption::plain(),
            state: PortalState::Syncing,
            created_at: 0,
        };
        assert_eq!(portal.flattened_name("engineering"), "engineering / design");
    }

    #[test]
    fn an_unusable_encrypted_portal_exposes_no_device() {
        let encryption = PortalEncryption::encrypted_unusable(MissingFeature::Msc4203ToDevice);
        assert!(encryption.is_encrypted());
        assert!(encryption.device().is_none());
        assert_eq!(encryption.missing(), Some(MissingFeature::Msc4203ToDevice));
    }

    #[test]
    fn a_ready_encrypted_portal_names_its_device() {
        let device = MatrixDeviceId::parse("ROOMYBRIDGE").unwrap();
        let encryption = PortalEncryption::encrypted_with(device.clone());
        assert_eq!(encryption.device(), Some(&device));
        assert!(encryption.missing().is_none());
    }
}
