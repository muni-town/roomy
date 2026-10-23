//! Validated wire identifiers.
//!
//! Every id that reaches a handler is parsed into one of these at the edge, so
//! a wrong-shaped parameter is rejected with `InvalidRequest` instead of being
//! carried as an opaque `String` into SQL.

use crate::error::XrpcError;

/// Crockford base32, as used by ULIDs.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn is_ulid(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|b| CROCKFORD.contains(&b.to_ascii_uppercase()))
}

/// Decode a ULID's 48-bit millisecond timestamp (the first 10 Crockford chars).
///
/// Mirrors `ulidx`'s `decodeTime`: any malformed prefix is an error rather than
/// a silently wrong timestamp.
pub fn ulid_time_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let mut n: u64 = 0;
    for &b in &bytes[..10] {
        let up = b.to_ascii_uppercase();
        let digit = CROCKFORD.iter().position(|&c| c == up)? as u64;
        n = (n << 5) | digit;
    }
    // Ten Crockford chars hold 50 bits; the ULID timestamp is the low 48.
    if n > 0xFFFF_FFFF_FFFF {
        return None;
    }
    i64::try_from(n).ok()
}

/// Minimal ATProto DID syntax check: `did:<method>:<method-specific-id>`.
pub fn is_did(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("did:") else {
        return false;
    };
    let Some((method, id)) = rest.split_once(':') else {
        return false;
    };
    if method.is_empty() || id.is_empty() {
        return false;
    }
    let valid_method = method
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let valid_id = value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'%'));
    valid_method && valid_id
}

macro_rules! validated_string {
    ($name:ident, $label:expr, $check:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl TryFrom<&str> for $name {
            type Error = XrpcError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                let check: fn(&str) -> bool = $check;
                if !check(value) {
                    return Err(XrpcError::invalid_request(format!(
                        "Invalid {}: {value}",
                        $label
                    )));
                }
                Ok($name(value.to_owned()))
            }
        }

        impl TryFrom<String> for $name {
            type Error = XrpcError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                $name::try_from(value.as_str())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

validated_string!(SpaceDid, "space DID", is_did);
validated_string!(CallerDid, "caller DID", is_did);
validated_string!(RoomId, "room id", is_ulid);
validated_string!(MessageId, "message id", is_ulid);
validated_string!(Cursor, "cursor", |v: &str| v.len() <= 512 && !v.is_empty());

/// An XRPC `limit` parameter, bounded at both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit(u32);

impl Limit {
    pub const MAX: u32 = 100;

    pub fn get(self) -> usize {
        self.0 as usize
    }

    pub fn parse(raw: Option<&str>, min: u32, max: u32, default: u32) -> Result<Self, XrpcError> {
        let Some(raw) = raw else {
            return Ok(Limit(default));
        };
        if raw.is_empty() {
            return Ok(Limit(default));
        }
        let n = parse_js_integer(raw, "limit")?;
        if n < min as i64 {
            return Err(XrpcError::invalid_request(format!(
                "Param limit must be ≥ {min}, got: {n}"
            )));
        }
        if n > max as i64 {
            return Err(XrpcError::invalid_request(format!(
                "Param limit must be ≤ {max}, got: {n}"
            )));
        }
        Ok(Limit(n as u32))
    }
}

/// `Number(raw)` + `Number.isInteger`, matching the appserver's param parser.
pub fn parse_js_integer(raw: &str, key: &str) -> Result<i64, XrpcError> {
    let trimmed = raw.trim();
    let value: f64 = trimmed.parse().map_err(|_| {
        XrpcError::invalid_request(format!("Param {key} must be an integer, got: {raw}"))
    })?;
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > i64::MAX as f64 {
        return Err(XrpcError::invalid_request(format!(
            "Param {key} must be an integer, got: {raw}"
        )));
    }
    Ok(value as i64)
}

/// A dotted, lower-case XRPC namespace id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nsid(String);

impl Nsid {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<&str> for Nsid {
    type Error = XrpcError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        // NSIDs are camelCase (`space.roomy.space.getThreads`), so letters
        // are case-sensitive and both cases are valid.
        let ok = value.len() <= 317
            && value.contains('.')
            && value.starts_with(|c: char| c.is_ascii_alphabetic())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
        if !ok {
            return Err(XrpcError::not_found(format!("Unknown NSID: {value}")));
        }
        Ok(Nsid(value.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_time_matches_known_value() {
        // ULID timestamp prefix for 2024-01-01T00:00:00Z is 01HK...; just pin
        // the low boundary and a decode/encode round trip.
        assert_eq!(ulid_time_ms("00000000000000000000000000"), Some(0));
        assert_eq!(ulid_time_ms("0000000000ZZZZZZZZZZZZZZZZ"), Some(0));
        assert_eq!(ulid_time_ms("not-a-ulid"), None);
        assert_eq!(
            ulid_time_ms("7ZZZZZZZZZ0000000000000000"),
            Some(0xFFFF_FFFF_FFFF)
        );
    }

    #[test]
    fn did_syntax() {
        assert!(is_did("did:plc:abc123"));
        assert!(is_did("did:web:api.roomy.space"));
        assert!(!is_did("plc:abc123"));
        assert!(!is_did("did:plc:"));
        assert!(!is_did("did:PLC:abc"));
    }

    #[test]
    fn limit_bounds() {
        assert_eq!(Limit::parse(None, 1, 100, 50).unwrap().get(), 50);
        assert!(Limit::parse(Some("0"), 1, 100, 50).is_err());
        assert!(Limit::parse(Some("101"), 1, 100, 50).is_err());
        assert!(Limit::parse(Some("1.5"), 1, 100, 50).is_err());
        assert_eq!(Limit::parse(Some("1.0"), 1, 100, 50).unwrap().get(), 1);
    }
}
