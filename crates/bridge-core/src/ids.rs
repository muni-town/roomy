//! Identifier types the state machine keys on.
//!
//! These are newtypes rather than `String` because a portal is addressed by
//! four different ids at once (Matrix room, Roomy room, ghost MXID, ghost DID)
//! and using the wrong one is a bug that type checking should catch.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A Roomy event id (a ULID) as the state machine addresses messages.
///
/// Distinct from [`RoomyRoomId`] although both are ULIDs: a room id passed
/// where a message id belongs type-checks today and fails at the appserver.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RoomyEventId(String);

impl RoomyEventId {
    /// Parses a ULID event id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedRoomyEvent`] if `value` is not a ULID.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        roomy_events::Ulid::parse(value.clone()).map_err(|_| IdError::MalformedRoomyEvent)?;
        Ok(RoomyEventId(value))
    }

    /// Mint a new id, for an event the bridge is about to write.
    pub fn new() -> Self {
        RoomyEventId(roomy_events::Ulid::new().as_str().to_string())
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The id as a ULID.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedRoomyEvent`] if the stored text is not a
    /// ULID.
    pub fn to_ulid(&self) -> Result<roomy_events::Ulid, IdError> {
        roomy_events::Ulid::parse(self.0.clone()).map_err(|_| IdError::MalformedRoomyEvent)
    }
}

impl Default for RoomyEventId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RoomyEventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Roomy space DID.
///
/// `roomy_events::Did` validates the DID grammar; this type says *which* DID
/// it is. A space DID and a user DID are both DIDs, and the bridge passes both
/// around, so they must not be interchangeable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SpaceDid(String);

impl SpaceDid {
    /// Parses a DID that names a space.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedDid`] if `value` is not a DID.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        roomy_events::Did::parse(value.clone()).map_err(|_| IdError::MalformedDid)?;
        Ok(SpaceDid(value))
    }

    /// The DID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The DID in the type the appserver client takes.
    pub fn to_did(&self) -> Result<roomy_events::Did, IdError> {
        roomy_events::Did::parse(self.0.clone()).map_err(|_| IdError::MalformedDid)
    }
}

impl fmt::Display for SpaceDid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identifies one portal: the space plus the Matrix room it bridges.
///
/// The stored portals table is keyed by exactly this pair, so a bare pair
/// travelling through the supervisor loses the fact that one half is a space
/// DID and the other a room id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortalId {
    space: SpaceDid,
    matrix_room: MatrixRoomId,
}

impl PortalId {
    /// A portal id from the space it bridges and the Matrix room it bridges.
    pub fn new(space: SpaceDid, matrix_room: MatrixRoomId) -> Self {
        Self { space, matrix_room }
    }

    /// The space the portal bridges.
    pub fn space(&self) -> &SpaceDid {
        &self.space
    }

    /// The Matrix room the portal bridges.
    pub fn matrix_room(&self) -> &MatrixRoomId {
        &self.matrix_room
    }
}

impl fmt::Display for PortalId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.space, self.matrix_room)
    }
}

impl FromStr for PortalId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (space, matrix_room) = value.split_once('/').ok_or(IdError::MalformedPortalId)?;
        Ok(PortalId::new(
            SpaceDid::parse(space)?,
            MatrixRoomId::parse(matrix_room)?,
        ))
    }
}

impl Serialize for PortalId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for PortalId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        PortalId::from_str(&raw).map_err(serde::de::Error::custom)
    }
}

/// A homeserver transaction id, as `PUT /transactions/{txnId}` names it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TxnId(String);

impl TxnId {
    /// Parses a transaction id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedTxnId`] if `value` is empty or contains
    /// whitespace.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        if value.is_empty() || value.contains(char::is_whitespace) {
            return Err(IdError::MalformedTxnId);
        }
        Ok(TxnId(value))
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TxnId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The homeserver's pagination token for a backfill walk.
///
/// Opaque, and distinct from [`SortIdx`]: one addresses Matrix history, the
/// other the Roomy stream, and both are stored side by side.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BackfillCursor(String);

impl BackfillCursor {
    /// Parses a pagination token.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedBackfillCursor`] if `value` is empty.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        if value.is_empty() {
            return Err(IdError::MalformedBackfillCursor);
        }
        Ok(BackfillCursor(value))
    }

    /// The token as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BackfillCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A position in a Roomy space's event stream.
///
/// This is the resume cursor for the sync socket and the value the appserver
/// folds a `timestampOverride` into. Negative positions do not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SortIdx(i64);

impl SortIdx {
    /// A stream position.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedSortIdx`] if `value` is negative.
    pub fn new(value: i64) -> Result<Self, IdError> {
        if value < 0 {
            return Err(IdError::MalformedSortIdx);
        }
        Ok(SortIdx(value))
    }

    /// The position, for a call that still takes a plain `i64` (the sync
    /// socket's frame, the SQLite column).
    pub fn value(self) -> i64 {
        self.0
    }
}

impl fmt::Display for SortIdx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The bridge's own crypto device id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MatrixDeviceId(String);

impl MatrixDeviceId {
    /// Parses a device id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedDeviceId`] if `value` is empty or contains
    /// whitespace.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        if value.is_empty() || value.contains(char::is_whitespace) {
            return Err(IdError::MalformedDeviceId);
        }
        Ok(MatrixDeviceId(value))
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MatrixDeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Matrix room id, e.g. `!abc:example.org`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MatrixRoomId(String);

impl MatrixRoomId {
    /// Accept a room id (`!…`, `!…:server`) or a room alias (`#…:server`).
    ///
    /// The server part is optional because room version 12 mints server-less
    /// room ids (`!opaque`), and a bridge that rejected those could not be
    /// pointed at any modern room. Aliases are stored unresolved: the portal is
    /// created before the homeserver answers, and resolution is the adapter's
    /// job.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        let valid = (value.starts_with('!') || value.starts_with('#'))
            && value.len() > 1
            && !value.contains(char::is_whitespace);
        if valid {
            Ok(MatrixRoomId(value))
        } else {
            Err(IdError::MalformedMatrixRoom)
        }
    }

    /// The room id or alias as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this is a room alias (`#…`) rather than a room id (`!…`).
    pub fn is_alias(&self) -> bool {
        self.0.starts_with('#')
    }
}

impl fmt::Display for MatrixRoomId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Matrix event id, e.g. `$abc`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MatrixEventId(String);

impl MatrixEventId {
    /// Parses an event id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedMatrixEvent`] if `value` does not start with
    /// `$` or has no id after it.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        if value.starts_with('$') && value.len() > 1 {
            Ok(MatrixEventId(value))
        } else {
            Err(IdError::MalformedMatrixEvent)
        }
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MatrixEventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Roomy room id (a ULID).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RoomyRoomId(String);

impl RoomyRoomId {
    /// Parses a ULID room id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedRoomyRoom`] if `value` is not a ULID.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        roomy_events::Ulid::parse(value.clone()).map_err(|_| IdError::MalformedRoomyRoom)?;
        Ok(RoomyRoomId(value))
    }

    /// The id as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RoomyRoomId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A Matrix user id, e.g. `@alice:example.org`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GhostMxid(String);

impl GhostMxid {
    /// Parses a Matrix user id.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedMxid`] if `value` lacks the leading `@`, the
    /// `:` before the server part, or contains whitespace.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        let valid =
            value.starts_with('@') && value.contains(':') && !value.contains(char::is_whitespace);
        if valid {
            Ok(GhostMxid(value))
        } else {
            Err(IdError::MalformedMxid)
        }
    }

    /// The MXID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The localpart, without the leading `@` and the trailing `:server`.
    pub fn localpart(&self) -> &str {
        self.0
            .trim_start_matches('@')
            .split_once(':')
            .map(|(localpart, _)| localpart)
            .unwrap_or("")
    }

    /// The server part.
    pub fn server(&self) -> &str {
        self.0
            .split_once(':')
            .map(|(_, server)| server)
            .unwrap_or("")
    }
}

impl fmt::Display for GhostMxid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The DID a ghost's messages are attributed to on the Roomy side.
///
/// A bare MXID is not a valid DID (`@` and `:` are outside the DID character
/// set), so the MXID is percent-encoded behind a `did:matrix:` method. The
/// transform is reversible and the UI decodes it for display.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GhostDid(String);

impl GhostDid {
    /// Parses a `did:matrix:` ghost DID.
    ///
    /// # Errors
    ///
    /// Returns [`IdError::MalformedDid`] if `value` is not a DID, and
    /// [`IdError::NotMatrixGhostDid`] if it names another DID method.
    pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
        let value = value.into();
        roomy_events::Did::parse(value.clone()).map_err(|_| IdError::MalformedDid)?;
        if !value.starts_with("did:matrix:") {
            return Err(IdError::NotMatrixGhostDid);
        }
        Ok(GhostDid(value))
    }

    /// The DID as a string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Recover the MXID a ghost DID was minted from.
    pub fn to_mxid(&self) -> Result<GhostMxid, IdError> {
        let encoded = self
            .0
            .strip_prefix("did:matrix:")
            .ok_or(IdError::NotMatrixGhostDid)?;
        GhostMxid::parse(percent_decode(encoded)?)
    }
}

impl From<&GhostMxid> for GhostDid {
    fn from(mxid: &GhostMxid) -> Self {
        GhostDid(format!("did:matrix:{}", percent_encode(mxid.as_str())))
    }
}

impl fmt::Display for GhostDid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for GhostDid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for GhostDid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        GhostDid::parse(raw).map_err(serde::de::Error::custom)
    }
}

/// Percent-encode every character outside `[A-Za-z0-9._-]`.
///
/// Percent stays encoded (`%25`) rather than being passed through, so decoding
/// is unambiguous even for an MXID that contains a literal `%`.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(value: &str) -> Result<String, IdError> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value
                .get(index + 1..index + 3)
                .ok_or(IdError::MalformedPercentEncoding)?;
            let byte =
                u8::from_str_radix(hex, 16).map_err(|_| IdError::MalformedPercentEncoding)?;
            out.push(byte);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| IdError::MalformedPercentEncoding)
}

/// A malformed identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    #[error("not a Matrix room id or alias")]
    MalformedMatrixRoom,
    #[error("not a Matrix event id")]
    MalformedMatrixEvent,
    #[error("not a Roomy room id (ULID)")]
    MalformedRoomyRoom,
    #[error("not a Roomy event id (ULID)")]
    MalformedRoomyEvent,
    #[error("not a Matrix user id")]
    MalformedMxid,
    #[error("not a DID")]
    MalformedDid,
    #[error("not a ghost DID (did:matrix:…)")]
    NotMatrixGhostDid,
    #[error("malformed percent-encoding in a ghost DID")]
    MalformedPercentEncoding,
    #[error("not a portal id (<space did>/<matrix room id>)")]
    MalformedPortalId,
    #[error("not a Matrix transaction id")]
    MalformedTxnId,
    #[error("not a backfill cursor")]
    MalformedBackfillCursor,
    #[error("not a Roomy stream position")]
    MalformedSortIdx,
    #[error("not a Matrix device id")]
    MalformedDeviceId,
}

/// Parse at the boundary: the `TryFrom` every caller validates through, so an
/// inner string can only be built from a value that passed.
macro_rules! parse_from_str {
    ($($type:ty),* $(,)?) => {
        $(
            impl TryFrom<&str> for $type {
                type Error = IdError;

                fn try_from(value: &str) -> Result<Self, Self::Error> {
                    Self::parse(value)
                }
            }

            impl TryFrom<String> for $type {
                type Error = IdError;

                fn try_from(value: String) -> Result<Self, Self::Error> {
                    Self::parse(value)
                }
            }
        )*
    };
}

parse_from_str!(
    MatrixRoomId,
    MatrixEventId,
    RoomyRoomId,
    RoomyEventId,
    GhostMxid,
    GhostDid,
    SpaceDid,
    TxnId,
    BackfillCursor,
    MatrixDeviceId,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ghost_did_round_trips_to_its_mxid() {
        let mxid = GhostMxid::parse("@alice:example.org").unwrap();
        let did = GhostDid::from(&mxid);
        assert_eq!(did.as_str(), "did:matrix:%40alice%3Aexample.org");
        assert_eq!(did.to_mxid().unwrap(), mxid);
    }

    #[test]
    fn a_percent_in_an_mxid_round_trips_unambiguously() {
        // A literal `%` must not collide with an escape sequence.
        let original = "%40alice:example.org";
        let encoded = percent_encode(original);
        assert_eq!(encoded, "%2540alice%3Aexample.org");
        assert_eq!(percent_decode(&encoded).unwrap(), original);
    }

    #[test]
    fn a_bare_mxid_is_not_a_ghost_did() {
        assert!(GhostDid::parse("@alice:example.org").is_err());
        assert!(GhostDid::parse("did:plc:abc123").is_err());
    }

    #[test]
    fn mxid_parts_are_split() {
        let mxid = GhostMxid::parse("@_roomy_ab12:matrix.example.org").unwrap();
        assert_eq!(mxid.localpart(), "_roomy_ab12");
        assert_eq!(mxid.server(), "matrix.example.org");
    }

    #[test]
    fn a_portal_id_carries_both_halves() {
        let id = PortalId::new(
            SpaceDid::parse("did:plc:space").unwrap(),
            MatrixRoomId::parse("!room:example.org").unwrap(),
        );
        let rendered = id.to_string();
        assert_eq!(rendered, "did:plc:space/!room:example.org");
        assert_eq!(PortalId::from_str(&rendered).unwrap(), id);
        assert!(PortalId::from_str("did:plc:space").is_err());
    }

    #[test]
    fn a_stream_position_cannot_be_negative() {
        assert_eq!(SortIdx::new(0).unwrap().value(), 0);
        assert!(SortIdx::new(-1).is_err());
    }

    #[test]
    fn a_space_did_is_a_did_and_an_mxid_is_not() {
        assert!(SpaceDid::parse("did:plc:space").is_ok());
        assert!(SpaceDid::parse("@alice:example.org").is_err());
    }

    #[test]
    fn room_aliases_are_accepted_and_marked() {
        assert!(MatrixRoomId::parse("#room:example.org").unwrap().is_alias());
        assert!(!MatrixRoomId::parse("!room:example.org").unwrap().is_alias());
        assert!(MatrixRoomId::parse("room:example.org").is_err());
        // Room version 12 ids carry no server part.
        assert!(MatrixRoomId::parse("!TD64pnpYPMwdUqQOpujPr4HE4rzE67e8g92d2UnQm9g").is_ok());
        assert!(MatrixRoomId::parse("!").is_err());
    }
}
