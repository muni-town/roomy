//! Identifier newtypes: ULIDs and DIDs.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A Roomy event / room ULID.
///
/// Wrapped rather than aliased so the two uses cannot be swapped by accident in
/// the bridge's state machine, where both appear side by side.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ulid(String);

impl Ulid {
    /// Parse a ULID, rejecting anything that is not 26 Crockford base32 chars.
    pub fn parse(value: impl Into<String>) -> Result<Self, UlidError> {
        let value = value.into();
        ulid::Ulid::from_str(&value)
            .map(|_| Ulid(value))
            .map_err(|_| UlidError)
    }

    /// Generate a new ULID from the current wall clock.
    pub fn new() -> Self {
        Ulid(ulid::Ulid::generate().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The 48-bit millisecond timestamp a ULID carries, used as the fallback
    /// message time when no `timestampOverride` extension is present.
    pub fn timestamp_ms(&self) -> u64 {
        ulid::Ulid::from_str(&self.0)
            .map(|u| u.timestamp_ms())
            .unwrap_or(0)
    }
}

impl Default for Ulid {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for Ulid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A ULID that failed to parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not a ULID")]
pub struct UlidError;

impl Serialize for Ulid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Ulid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ulid::parse(raw).map_err(serde::de::Error::custom)
    }
}

/// An ATProto DID.
///
/// Validation is deliberately shallow — `did:` prefix, a method, and at least
/// one more non-empty segment. It is enough to reject the shapes the bridge
/// mints (Matrix MXIDs, which contain `@` and `:`) without reimplementing the
/// full DID grammar.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Did(String);

impl Did {
    pub fn parse(value: impl Into<String>) -> Result<Self, DidError> {
        let value = value.into();
        let rest = value.strip_prefix("did:").ok_or(DidError)?;
        let (method, id) = rest.split_once(':').ok_or(DidError)?;
        let valid_method = !method.is_empty()
            && method
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        let valid_id = !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'));
        if valid_method && valid_id {
            Ok(Did(value))
        } else {
            Err(DidError)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The DID's method, e.g. `web` for `did:web:example.com`.
    pub fn method(&self) -> &str {
        self.0
            .strip_prefix("did:")
            .and_then(|rest| rest.split_once(':').map(|(method, _)| method))
            .unwrap_or("")
    }
}

impl fmt::Display for Did {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A string that is not a valid DID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not a DID")]
pub struct DidError;

impl Serialize for Did {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Did {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Did::parse(raw).map_err(serde::de::Error::custom)
    }
}

impl FromStr for Did {
    type Err = DidError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Did::parse(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_bare_matrix_mxid() {
        assert!(Did::parse("@alice:example.org").is_err());
        assert!(Did::parse("did:matrix:%40alice%3Aexample.org").is_ok());
    }

    #[test]
    fn parses_the_did_method() {
        let did = Did::parse("did:web:api.roomy.space").unwrap();
        assert_eq!(did.method(), "web");
        assert_eq!(did.to_string(), "did:web:api.roomy.space");
    }

    #[test]
    fn ulid_carries_its_timestamp() {
        let ulid = Ulid::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap();
        assert_eq!(ulid.timestamp_ms(), 1_728_715_223_157);
    }
}
