//! Ordering keys: encoding, decoding and the one key computed between
//! neighbours.
//!
//! A message's ordering key is `materialization/sortIdx.ts`'s: ten characters
//! of ordering time (Crockford base32, the ULID width) followed by sixteen of
//! log position, so the key sorts by time and breaks ties by where in the log
//! the change sits. Both halves are fixed width, which is what makes
//! lexicographic order the numeric order.

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Characters a Crockford base32 value may hold.
pub fn is_crockford(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| CROCKFORD.contains(&b.to_ascii_uppercase()))
}

/// Characters a CID's base32 multihash may hold (RFC 4648, lower case).
pub fn is_base32(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| BASE32.contains(&b))
}

/// The time half of a ULID-shaped value, in epoch milliseconds.
pub fn ulid_time_ms(value: &str) -> Option<i64> {
    if value.len() < 10 {
        return None;
    }
    let mut ms: u64 = 0;
    for byte in value.as_bytes()[..10].iter() {
        let digit = CROCKFORD
            .iter()
            .position(|c| *c == byte.to_ascii_uppercase())? as u64;
        ms = ms * 32 + digit;
    }
    Some(ms as i64)
}

/// A 10-character Crockford encoding of an epoch-millisecond instant.
pub fn encode_time(ms: u64) -> String {
    encode_base32(ms, 10)
}

/// A 16-character Crockford encoding of a log position.
pub fn encode_position(position: u64) -> String {
    encode_base32(position, 16)
}

/// The ordering key of a change: ordering time plus log position.
pub fn order_key(ms: u64, position: u64) -> String {
    format!("{}{}", encode_time(ms), encode_position(position))
}

fn encode_base32(mut value: u64, len: usize) -> String {
    let mut out = vec![b'0'; len];
    for i in (0..len).rev() {
        out[i] = CROCKFORD[(value % 32) as usize];
        value /= 32;
    }
    String::from_utf8(out).expect("the alphabet is ASCII")
}

/// A position half strictly between `lower` and `upper`, without decoding
/// either: the first character they disagree on decides it.
fn between_base32(lower: &str, upper: &str) -> Option<String> {
    let lower = lower.as_bytes();
    let upper = upper.as_bytes();
    for i in 0..lower.len() {
        if lower[i] != upper[i] {
            let mut out = Vec::with_capacity(lower.len());
            out.extend_from_slice(&lower[..=i]);
            out.extend(std::iter::repeat_n(b'0', lower.len() - i - 1));
            return String::from_utf8(out).ok();
        }
    }
    None
}

/// A key lexicographically between two ordering keys.
///
/// Different milliseconds average their time halves and zero the position half
/// (nothing in the gap needs a tie-break); within one millisecond the position
/// halves are split. A missing `later` places the key ten milliseconds after
/// `earlier`. Deterministic, so replaying a reorder lands the same key.
pub fn midpoint_sort_key(earlier: &str, later: Option<&str>) -> Result<String, OrderKeyError> {
    let earlier_ms = ulid_time_ms(earlier).ok_or(OrderKeyError::Malformed)?;
    let Some(later) = later else {
        return Ok(order_key((earlier_ms + 10) as u64, 0));
    };
    let later_ms = ulid_time_ms(later).ok_or(OrderKeyError::Malformed)?;
    if earlier_ms != later_ms {
        let mid = (earlier_ms + later_ms) / 2;
        return Ok(order_key(mid as u64, 0));
    }
    if earlier.len() < 10 || later.len() < 10 {
        return Err(OrderKeyError::Malformed);
    }
    let earlier_position = &earlier[10..];
    let later_position = &later[10..];
    if earlier_position == later_position {
        return Err(OrderKeyError::Equal);
    }
    between_base32(earlier_position, later_position)
        .map(|suffix| format!("{}{}", &earlier[..10], suffix))
        .ok_or(OrderKeyError::Equal)
}

/// An ordering key that could not be computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OrderKeyError {
    #[error("not an ordering key")]
    Malformed,
    #[error("the two keys are equal")]
    Equal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_carries_its_time_and_position() {
        let key = order_key(1_700_000_000_000, 7);
        assert_eq!(key.len(), 26);
        assert_eq!(ulid_time_ms(&key), Some(1_700_000_000_000));
        assert!(key.ends_with("0000000000000007"));
    }

    #[test]
    fn a_key_sorts_between_its_bounds() {
        // Neighbours in different milliseconds: the time halves are averaged
        // and the position half zeroed, the case every real gap takes.
        let lower = order_key(1_700_000_000_000, 0);
        let upper = order_key(1_700_000_000_010, 0);
        let mid = midpoint_sort_key(&lower, Some(&upper)).unwrap();
        assert_eq!(mid, order_key(1_700_000_000_005, 0));
        assert!(mid > lower && mid < upper);
    }

    #[test]
    fn a_key_past_the_last_entry_is_later_still() {
        let earlier = order_key(1_700_000_000_000, 0);
        let later = midpoint_sort_key(&earlier, None).unwrap();
        assert_eq!(ulid_time_ms(&later), Some(1_700_000_000_010));
    }

    #[test]
    fn equal_keys_are_an_error() {
        let key = order_key(1_700_000_000_000, 3);
        assert_eq!(
            midpoint_sort_key(&key, Some(&key)),
            Err(OrderKeyError::Equal)
        );
    }
}
