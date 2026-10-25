//! The reads the gateway answers itself: cross-space fan-out, and the two
//! endpoints that leave the process.
//!
//! These are the reads a space worker cannot serve, because their answer is not
//! in one space's database: an activity feed merges every space the caller
//! joined, mentions come from the global index and are hydrated per space, a
//! profile may need a PDS or an appview, and link metadata is an outbound
//! fetch. They run at the edge, over the same registry and the same read-state
//! store the per-space reads use.
//!
//! Every module exposes the same two items — [`NSID`] and [`handle`] — so the
//! router is a table rather than a set of special cases, and one caller
//! authentication path ([`context`]) applies to all of them.

pub mod activity_feed;
pub mod link_metadata;
pub mod mentions;
pub mod profiles;

use axum::http::HeaderMap;

use space_xrpc::error::XrpcError;
use space_xrpc::handlers::common::Context;
use space_xrpc::ids::Nsid;

use crate::GatewayState;

/// Authenticate the caller of a gateway-owned read, and decode whatever read
/// state they carried.
///
/// One path for every endpoint here: the same verifier the per-space reads use,
/// so there is one way to be authenticated at this edge and not two. Read
/// positions are caller-supplied and honoured only for an authenticated caller.
pub async fn context(
    state: &GatewayState,
    headers: &HeaderMap,
    nsid: &Nsid,
) -> Result<Context, XrpcError> {
    let caller = state.reads.verifier.verify(headers, nsid).await?;
    let positions = if caller.did.is_some() {
        space_xrpc::read_positions::ReadPositions::decode(
            headers
                .get(space_xrpc::read_positions::HEADER)
                .and_then(|value| value.to_str().ok()),
        )?
    } else {
        space_xrpc::read_positions::ReadPositions::default()
    };
    Ok(Context {
        caller: caller.did,
        positions,
    })
}

/// Which endpoint a request is for, when it is one of these.
pub fn nsids() -> [&'static str; 4] {
    [
        activity_feed::NSID,
        mentions::NSID,
        profiles::NSID,
        link_metadata::NSID,
    ]
}
