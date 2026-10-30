//! Identifiers and key types the change feed carries.
//!
//! Every one of these is a newtype over a validated string with a private
//! field, so a value that reached a rule is one the decoder accepted: a record
//! key cannot hold a `/`, an ordering stamp cannot be invented, and a
//! collection cannot be a record kind that does not exist.

use std::fmt;

use roomy_events::Did;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A space (stream) DID. Distinct from any other DID: a space id is what the
/// worker is configured with and what every rule's statements target.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SpaceDid(Did);

impl SpaceDid {
    /// Parse a DID string into a space id.
    ///
    /// Returns [`KeyError::Did`] when `value` is not a DID.
    pub fn parse(value: impl Into<String>) -> Result<Self, KeyError> {
        Did::parse(value).map(Self).map_err(|_| KeyError::Did)
    }

    /// The id's text, as the feed's `stream_id` column carries it.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// The validated DID underneath.
    pub fn did(&self) -> &Did {
        &self.0
    }
}

impl fmt::Display for SpaceDid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.as_str())
    }
}

impl Serialize for SpaceDid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> Deserialize<'de> for SpaceDid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        SpaceDid::parse(raw).map_err(serde::de::Error::custom)
    }
}

/// A collection NSID: three or more dot-separated segments, at least one of
/// which ends the name (the lexicon's `v0`-less form).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Collection(String);

impl Collection {
    /// Parse a collection NSID.
    ///
    /// Returns [`KeyError::Collection`] unless `value` has three or more
    /// non-empty dot-separated segments drawn from the NSID alphabet.
    pub fn parse(value: impl Into<String>) -> Result<Self, KeyError> {
        let value = value.into();
        let segments: Vec<&str> = value.split('.').collect();
        if segments.len() < 3 || segments.iter().any(|s| s.is_empty()) {
            return Err(KeyError::Collection);
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return Err(KeyError::Collection);
        }
        Ok(Self(value))
    }

    /// The NSID's text, as the feed's `collection` column carries it.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Collection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A record key: ATProto's record-key syntax, `^[A-Za-z0-9._~:-]{1,512}$`, with
/// `"."` and `".."` excluded.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Rkey(String);

impl Rkey {
    /// The longest record key the syntax allows.
    pub const MAX_LEN: usize = 512;

    /// Parse a record key.
    ///
    /// Returns [`KeyError::Rkey`] when `value` is empty, longer than
    /// [`Rkey::MAX_LEN`], `.` or `..`, or outside the record-key alphabet.
    pub fn parse(value: impl Into<String>) -> Result<Self, KeyError> {
        let value = value.into();
        if value.is_empty() || value.len() > Self::MAX_LEN {
            return Err(KeyError::Rkey);
        }
        if value == "." || value == ".." {
            return Err(KeyError::Rkey);
        }
        if !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | ':' | '-'))
        {
            return Err(KeyError::Rkey);
        }
        Ok(Self(value))
    }

    /// A composite key: the parts joined with `~`, which appears in no DID or
    /// ULID and is in the record-key alphabet.
    ///
    /// Returns [`KeyError::Rkey`] when the joined key does not validate.
    pub fn composite(parts: &[&str]) -> Result<Self, KeyError> {
        Self::parse(parts.join("~"))
    }

    /// The key's text, as the feed's `rkey` column carries it.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The parts of a composite key, in the order they were joined.
    pub fn parts(&self) -> Vec<&str> {
        self.0.split('~').collect()
    }

    /// The two parts of a `(a, b)` composite key. A key with fewer parts yields
    /// empty strings, mirroring the TypeScript rule's destructuring.
    pub fn pair(&self) -> (String, String) {
        let parts = self.parts();
        (
            parts.first().unwrap_or(&"").to_string(),
            parts.get(1).unwrap_or(&"").to_string(),
        )
    }
}

impl fmt::Display for Rkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for Rkey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Rkey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Rkey::parse(raw).map_err(serde::de::Error::custom)
    }
}

/// The ordering stamp: opaque and sortable, assigned at ingest and compared but
/// never parsed into a key. Deliberately has no public constructor — a value
/// only comes from deserialisation, so no rule can mint one and reorder a room.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrderStamp(String);

impl OrderStamp {
    /// The stamp's time half, in epoch milliseconds, or 0 when the stamp does
    /// not carry a readable time.
    ///
    /// The stamp is the log's 26-character ordering key: ten characters of
    /// ordering time, sixteen of log position. Only the time is ever read — by
    /// the two rules that stamp a row with the ordering instant (a moved
    /// message's feed entry) — and nothing derives a key from a stamp.
    pub fn time_ms(&self) -> i64 {
        crate::time::ulid_time_ms(&self.0).unwrap_or(0)
    }

    /// The stamp's text, as it sorts on the log.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for OrderStamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for OrderStamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw.len() != 26 || !crate::time::is_crockford(&raw) {
            return Err(serde::de::Error::custom("not an ordering stamp"));
        }
        Ok(Self(raw))
    }
}

impl Serialize for OrderStamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// A content identifier, `bafy…`-style base32 CID.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Cid(String);

impl Cid {
    /// Parse a base32 content identifier.
    ///
    /// Returns [`KeyError::Cid`] when `value` has no `b`/`B` multibase prefix
    /// or the text after it is not base32.
    pub fn parse(value: impl Into<String>) -> Result<Self, KeyError> {
        let value = value.into();
        let base32 = value
            .strip_prefix('b')
            .or_else(|| value.strip_prefix('B'))
            .ok_or(KeyError::Cid)?;
        if base32.is_empty() || !crate::time::is_base32(base32) {
            return Err(KeyError::Cid);
        }
        Ok(Self(value))
    }

    /// The identifier's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A TID: ATProto's per-repo clock, 13 Crockford characters. A cursor value
/// only — never a sort key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Tid(String);

impl Tid {
    /// Parse a 13-character Crockford TID.
    ///
    /// Returns [`KeyError::Tid`] when `value` is the wrong length or outside
    /// the Crockford alphabet.
    pub fn parse(value: impl Into<String>) -> Result<Self, KeyError> {
        let value = value.into();
        if value.len() != 13 || !crate::time::is_crockford(&value) {
            return Err(KeyError::Tid);
        }
        Ok(Self(value))
    }

    /// The TID's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A key type that did not validate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("not a DID")]
    Did,
    #[error("not a collection NSID")]
    Collection,
    #[error("not a record key")]
    Rkey,
    #[error("not a content identifier")]
    Cid,
    #[error("not a TID")]
    Tid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_keys_reject_what_the_syntax_forbids() {
        assert!(Rkey::parse("3kabc").is_ok());
        assert!(Rkey::parse("did:plc:abc~role").is_ok());
        assert!(Rkey::parse("a/b").is_err());
        assert!(Rkey::parse("..").is_err());
        assert!(Rkey::parse("").is_err());
        assert!(Rkey::parse("x".repeat(513)).is_err());
    }

    #[test]
    fn composite_keys_round_trip_their_parts() {
        let key = Rkey::composite(&["did:plc:user", "01HF7YAT"]).unwrap();
        assert_eq!(
            key.pair(),
            ("did:plc:user".to_string(), "01HF7YAT".to_string())
        );
    }

    #[test]
    fn an_ordering_stamp_cannot_be_constructed_short() {
        let bad = serde_json::from_str::<OrderStamp>("\"01HF7\"");
        assert!(bad.is_err());
        let good = serde_json::from_str::<OrderStamp>("\"01HF7YAT000000000000000001\"");
        assert!(good.is_ok());
    }

    #[test]
    fn collections_need_three_segments() {
        assert!(Collection::parse("space.roomy.space.room").is_ok());
        assert!(Collection::parse("space.roomy").is_err());
    }
}
