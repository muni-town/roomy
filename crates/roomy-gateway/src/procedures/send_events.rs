//! `space.roomy.space.sendEvents`: the write ingress, at the edge.
//!
//! The route, the caller check and the response shape live here; the decision
//! and the append are [`roomy_ingest`]'s. Splitting it this way is what keeps
//! one log writer: the gateway owns the handle, and the ingest crate never
//! opens the file itself.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use roomy_ingest::IngestState;
use roomy_ingest::SendEventsBody;
use roomy_ingest::WriteDenial;
use space_xrpc::ids::Nsid;

use crate::GatewayState;

/// The XRPC method this module answers.
pub const NSID: &str = "space.roomy.space.sendEvents";

/// axum handler for `POST /xrpc/space.roomy.space.sendEvents`.
pub async fn http(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(_query): RawQuery,
    body: Bytes,
) -> Response {
    let nsid = match Nsid::try_from(NSID) {
        Ok(nsid) => nsid,
        Err(error) => return error.into_response(),
    };
    let caller = match crate::reads::context(&state, &headers, &nsid).await {
        Ok(context) => context,
        Err(error) => return error.into_response(),
    };
    let Some(did) = caller.caller.as_ref().map(|did| did.as_str().to_string()) else {
        return denied(WriteDenial::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let Some(log) = state.ingest.as_ref() else {
        // A gateway with no log handle is a read-only replica: refusing is the
        // honest answer, because an accepted write it cannot perform would be
        // lost.
        return denied(WriteDenial::internal("this gateway does not accept writes"));
    };
    let body = match SendEventsBody::parse(&body) {
        Ok(body) => body,
        Err(denial) => return denied(denial),
    };
    let Some(space) = state.reads.spaces.resolve_space(&body.space_id) else {
        return denied(WriteDenial::not_found(format!(
            "Space not found: {}",
            body.space_id
        )));
    };
    let ingest = IngestState {
        space,
        stores: Arc::clone(&state.reads.stores),
        service_did: state.service_did.clone(),
    };
    let now = state.clock.now_ms();
    let Ok(mut log) = log.lock() else {
        return denied(WriteDenial::internal("event log lock poisoned"));
    };
    match roomy_ingest::send_events(&mut log, &ingest, &did, &body, now) {
        Ok(_outcome) => {
            // The socket plane learns about the write the same way it learns
            // about any other: from the worker's post-commit signal, not from
            // this handler. The response is the empty 200 the procedure
            // contract declares.
            (StatusCode::OK, "").into_response()
        }
        Err(denial) => denied(denial),
    }
}

fn denied(denial: WriteDenial) -> Response {
    let status = StatusCode::from_u16(denial.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        axum::Json(serde_json::json!({
            "error": denial.error,
            "message": denial.message,
        })),
    )
        .into_response()
}
