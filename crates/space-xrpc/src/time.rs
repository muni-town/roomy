//! JavaScript-compatible timestamp formatting.
//!
//! The read path emits `new Date(ms).toISOString()` verbatim, so this must
//! produce the same fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` string, including
//! the three fractional digits and the proleptic Gregorian calendar.

use crate::ids;

/// `new Date(ms).toISOString()`: the fixed-width UTC form, to the millisecond.
#[must_use]
pub fn iso_from_ms(ms: i64) -> String {
    let (days, ms_of_day) = div_rem(ms, 86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hours = ms_of_day / 3_600_000;
    let minutes = (ms_of_day / 60_000) % 60;
    let seconds = (ms_of_day / 1_000) % 60;
    let millis = ms_of_day % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

fn div_rem(a: i64, b: i64) -> (i64, i64) {
    let q = a.div_euclid(b);
    (q, a.rem_euclid(b))
}

/// Howard Hinnant's `civil_from_days`, for days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

/// `decodeSeenUpTo`: the ISO time encoded in a `seen_up_to` sort key, or `None`
/// when the value is the `'0'` placeholder (or otherwise not a ULID).
#[must_use]
pub fn decode_seen_up_to(seen: Option<&str>) -> Option<String> {
    let seen = seen?;
    ids::ulid_time_ms(seen).map(iso_from_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_the_javascript_way() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn placeholder_is_not_a_watermark() {
        assert_eq!(decode_seen_up_to(Some("0")), None);
        assert_eq!(decode_seen_up_to(None), None);
        assert_eq!(
            decode_seen_up_to(Some("01HK0000000000000000000000")).map(|s| s.len()),
            Some(24)
        );
    }
}
