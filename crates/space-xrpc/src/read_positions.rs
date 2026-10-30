//! The caller's read positions, carried on `x-roomy-read-positions`.
//!
//! Read state is owned by the gateway (and, after migration Stage 4, the user's
//! PDS) — the worker never stores it. The gateway sends the watermark for each
//! room the caller has a row for; the worker derives unread counts from those
//! watermarks against its own `entities` table.
//!
//! Wire form: base64url (no padding) of
//! `[{"roomId": "...", "seenUpTo": "..."}]`.
//!
//! `lastActiveAt` is an optional extension used only to decorate the sidebar's
//! active threads (the gateway's `user_thread_activity.last_active_at`). It is
//! absent in the minimal form; without it a thread is still "engaged" for the
//! unread flag, it simply is not offered as an active-thread entry.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;

use crate::error::XrpcError;
use crate::time;

/// The request header carrying the caller's read positions.
pub const HEADER: &str = "x-roomy-read-positions";

#[derive(Debug, Deserialize)]
struct WireEntry {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "seenUpTo")]
    seen_up_to: String,
    #[serde(rename = "lastActiveAt", default)]
    last_active_at: Option<i64>,
}

/// One room's read position.
#[derive(Debug, Clone)]
pub struct Entry {
    /// The sort key of the newest message the caller has read.
    pub seen_up_to: String,
    /// When the caller last acted in the room, in epoch milliseconds.
    pub last_active_at: Option<i64>,
}

/// The caller's read positions, keyed by room id.
#[derive(Debug, Default, Clone)]
pub struct ReadPositions {
    entries: HashMap<String, Entry>,
}

impl ReadPositions {
    /// Decode the header's base64url JSON array; absent or empty is no state.
    pub fn decode(header: Option<&str>) -> Result<Self, XrpcError> {
        let Some(raw) = header else {
            return Ok(Self::default());
        };
        if raw.is_empty() {
            return Ok(Self::default());
        }
        // Accept both unpadded and padded base64url. The gateway emits the
        // former; tolerating the latter costs one branch.
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(raw))
            .map_err(|_| XrpcError::invalid_request(format!("Invalid {HEADER}: not base64url")))?;
        let entries: Vec<WireEntry> = serde_json::from_slice(&bytes)
            .map_err(|err| XrpcError::invalid_request(format!("Invalid {HEADER}: {err}")))?;
        let mut map = HashMap::with_capacity(entries.len());
        for entry in entries {
            map.insert(
                entry.room_id,
                Entry {
                    seen_up_to: entry.seen_up_to,
                    last_active_at: entry.last_active_at,
                },
            );
        }
        Ok(Self { entries: map })
    }

    /// The position for `room_id`, or `None` when the caller has none.
    #[must_use]
    pub fn get(&self, room_id: &str) -> Option<&Entry> {
        self.entries.get(room_id)
    }

    /// The caller is "engaged" with a room when the gateway sent a position for
    /// it: a `read_positions` row is created for the channels and threads the
    /// caller has opened.
    #[must_use]
    pub fn is_engaged(&self, room_id: &str) -> bool {
        self.entries.contains_key(room_id)
    }

    /// Every position, in no particular order.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Entry)> {
        self.entries.iter()
    }

    /// `lastRead` for a room: the ISO time of its watermark, if there is one.
    #[must_use]
    pub fn last_read(&self, room_id: &str) -> Option<String> {
        time::decode_seen_up_to(self.entries.get(room_id).map(|e| e.seen_up_to.as_str()))
    }

    /// The watermark for `room_id`: the sort key read positions are compared to.
    #[must_use]
    pub fn watermark(&self, room_id: &str) -> Option<&str> {
        self.entries.get(room_id).map(|e| e.seen_up_to.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(json: &str) -> String {
        URL_SAFE_NO_PAD.encode(json.as_bytes())
    }

    #[test]
    fn decodes_the_wire_form() {
        let header = encode(r#"[{"roomId":"r1","seenUpTo":"01HK0000000000000000000000"}]"#);
        let positions = ReadPositions::decode(Some(&header)).unwrap();
        assert!(positions.is_engaged("r1"));
        assert_eq!(
            positions.watermark("r1"),
            Some("01HK0000000000000000000000")
        );
    }

    #[test]
    fn absent_header_is_empty() {
        assert!(ReadPositions::decode(None).unwrap().iter().next().is_none());
    }

    #[test]
    fn malformed_header_is_rejected() {
        assert!(ReadPositions::decode(Some("!!!")).is_err());
        assert!(ReadPositions::decode(Some(&encode("{}"))).is_err());
    }

    #[test]
    fn optional_last_active_at() {
        let header = encode(r#"[{"roomId":"r1","seenUpTo":"0","lastActiveAt":1700000000000}]"#);
        let positions = ReadPositions::decode(Some(&header)).unwrap();
        assert_eq!(
            positions.get("r1").unwrap().last_active_at,
            Some(1_700_000_000_000)
        );
    }
}
