//! Platform-neutral bridge state machine.
//!
//! Nothing here does I/O and nothing here reads the clock: a bridge needs to be
//! testable as a function of its inputs, and the interesting logic — echo
//! suppression, edit and redaction ordering, cursor resume, retry/park,
//! hierarchy flattening — is exactly the part that is painful to test against a
//! live homeserver. Time and persistence arrive through [`Clock`] and
//! [`Storage`].
//!
//! The vocabulary is deliberately not Matrix-shaped (`Portal`, `Ghost`,
//! `Op`) so the same machine can drive a Discord bridge later; what stays with
//! each adapter is hierarchy derivation, permission translation, media fetch
//! and platform-specific relations.

// The modules are private: [`step`] and the value types it exchanges are the
// crate's interface. Everything else — the id map, the edit watermark, the
// translation rules — is reached through the machine, so a caller cannot apply
// half of a decision.
mod dedupe;
mod hierarchy;
mod ids;
mod op;
mod portal;
mod retry;
mod state;
mod storage;
mod translate;

pub use dedupe::{Mapping, MappingKind};
pub use hierarchy::{derive, Hierarchy, HierarchyDecision, HierarchyError, SpaceNode};
pub use ids::{
    BackfillCursor, GhostDid, GhostMxid, MatrixDeviceId, MatrixEventId, MatrixRoomId, PortalId,
    RoomyEventId, RoomyRoomId, SortIdx, SpaceDid, TxnId,
};
pub use op::{MatrixMedia, MatrixOp, MatrixOrigin, MediaRef, Op, OpBatch, RoomyRoomKind};
pub use portal::{
    EncryptionDevice, MissingFeature, Portal, PortalEncryption, PortalKind, PortalState,
};
pub use retry::{Due, Outbox, Pending, RetryPolicy};
pub use state::{step, BridgeState, DecidedWrite, Input, Rejection, Step};
pub use storage::{
    Clock, InMemoryStorage, Storage, StorageError, StoredMessage, SystemClock, VirtualClock,
};
pub use translate::{Body, FormattedBody, IncomingEvent, IncomingKind, IncomingMedia, Msgtype};

/// Wall-clock milliseconds since the unix epoch, as the bridge stores them.
pub type Millis = i64;
