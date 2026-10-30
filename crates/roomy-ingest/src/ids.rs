//! Shapes the ingress checks before anything is written.
//!
//! These are deliberately small: an id that is not a ULID and a `$type` that is
//! not an NSID are the two things a batch can get wrong that the log would
//! carry forever, so they are checked at the edge and nowhere else.

use serde_json::Value;

/// Crockford base32, as used by ULIDs.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A 26-character Crockford id, the shape every event id, message id and room
/// id in the log has.
#[must_use]
pub fn is_ulid(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|byte| CROCKFORD.contains(&byte.to_ascii_uppercase()))
}

/// A `$type` field, when it is a non-empty string.
///
/// An NSID is three-or-more dot-separated segments; the log does not care which
/// they are, only that the field is a name rather than a number or an object.
#[must_use]
pub fn nsid_of(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let segments = text.split('.').count();
    (segments >= 3 && !segments_is_empty(text)).then(|| text.to_string())
}

fn segments_is_empty(text: &str) -> bool {
    text.split('.').any(str::is_empty)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ulid_shape() {
        // Crockford decoding is case-insensitive, so a lower-case id is an id.
        assert!(is_ulid("01JC0000000000000000000C01"));
        assert!(is_ulid("01jc0000000000000000000c01"));
        assert!(!is_ulid("short"));
        // `U` is not in the alphabet: it is excluded so an id cannot be
        // confused with a number written by hand.
        assert!(!is_ulid("01JC0000000000000000000C0U"));
    }

    #[test]
    fn nsids() {
        assert_eq!(
            nsid_of(Some(&json!("space.roomy.message.createMessage.v0"))).as_deref(),
            Some("space.roomy.message.createMessage.v0")
        );
        assert_eq!(nsid_of(Some(&json!("nope"))), None);
        assert_eq!(nsid_of(Some(&json!("a..b"))), None);
        assert_eq!(nsid_of(Some(&json!(7))), None);
        assert_eq!(nsid_of(None), None);
    }
}
