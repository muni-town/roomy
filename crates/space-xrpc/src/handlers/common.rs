//! Request context shared by every endpoint.

use axum::http::HeaderMap;
use rusqlite::Connection;

use crate::error::XrpcError;
use crate::ids::{CallerDid, Nsid};
use crate::read_positions::{ReadPositions, HEADER};
use crate::state::XrpcState;

pub struct Context {
    pub caller: Option<CallerDid>,
    pub positions: ReadPositions,
}

impl Context {
    pub fn did(&self) -> Option<&str> {
        self.caller.as_ref().map(CallerDid::as_str)
    }
}

pub async fn context(
    state: &XrpcState,
    headers: &HeaderMap,
    nsid: &Nsid,
) -> Result<Context, XrpcError> {
    let caller = state.verifier.verify(headers, nsid).await?;
    // Read positions are caller-supplied state and are only honoured on an
    // authenticated request. Test mode reads the same header.
    let positions = if caller.did.is_some() {
        ReadPositions::decode(headers.get(HEADER).and_then(|v| v.to_str().ok()))?
    } else {
        ReadPositions::default()
    };
    Ok(Context {
        caller: caller.did,
        positions,
    })
}

/// `deriveUnreadCounts` for one room: messages after the watermark.
///
/// A room with no stored watermark reads zero — the gateway creates the row
/// anchored at the room's newest message, so "no row" and "anchored at newest"
/// agree.
pub fn unread_count(
    conn: &Connection,
    positions: &ReadPositions,
    room_id: &str,
) -> Result<i64, XrpcError> {
    let Some(watermark) = positions.watermark(room_id) else {
        return Ok(0);
    };
    let count = conn.query_row(
        "select count(*) from entities e where e.room = ? and e.sort_idx > ?",
        (room_id, watermark),
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count)
}

/// The `spaceId` a per-space read names.
///
/// It is an identifier, not a validated DID: the appserver resolves whatever the
/// caller sent, and a space that does not exist is answered from an empty one.
/// Rejecting a malformed id here would answer a 400 the appserver answers 404 or
/// 403.
pub fn parse_space(params: &crate::params::Params) -> Result<String, XrpcError> {
    params.require_string("spaceId")
}
