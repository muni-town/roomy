//! Per-space XRPC read serving for the Roomy space worker.
//!
//! The worker holds one space's materialised database and answers the
//! space-scoped XRPC queries the gateway routes to it. It never owns read
//! state: the caller's watermarks arrive on `x-roomy-read-positions`, and the
//! unread counts the four board/room endpoints need are derived from them
//! against the local `entities` table.
//!
//! ```no_run
//! use std::sync::Arc;
//! use space_xrpc::{router, state::{SpaceDb, XrpcState}, verify::TestMode};
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let db = Arc::new(SpaceDb::open_readonly("data/spaces/example.sqlite")?);
//! let state = XrpcState::new(db, Arc::new(TestMode));
//! let app = router(state);
//! let listener = tokio::net::TcpListener::bind("127.0.0.1:8090").await?;
//! axum::serve(listener, app).await?;
//! # Ok(())
//! # }
//! ```

pub mod access;
pub mod dto;
pub mod error;
pub mod handlers;
pub mod ids;
pub mod params;
pub mod queries;
pub mod read_positions;
pub mod state;
pub mod store;
pub mod time;
pub mod verify;

use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::error::XrpcError;
use crate::handlers::common::context;
use crate::ids::Nsid;
use crate::params::Params;
use crate::state::XrpcState;

/// NSIDs served by the worker. The gateway routes exactly these; anything else
/// is the gateway's business.
pub const ENDPOINTS: &[&str] = &[
    "space.roomy.space.getMetadata",
    "space.roomy.space.getThreads",
    "space.roomy.room.getMetadata",
    "space.roomy.room.getMessages",
    "space.roomy.room.getThreads",
    "space.roomy.room.getLinks",
    "space.roomy.message.getMessage",
    "space.roomy.message.getReactions",
];

pub fn router(state: XrpcState) -> Router {
    Router::new()
        .route("/xrpc/{nsid}", get(dispatch))
        .with_state(state)
}

async fn dispatch(
    State(state): State<XrpcState>,
    Path(nsid): Path<String>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Response, XrpcError> {
    let nsid = Nsid::try_from(nsid.as_str())?;
    let params = Params::parse(query.as_deref());
    let ctx = context(&state, &headers, &nsid).await?;

    match nsid.as_str() {
        "space.roomy.space.getMetadata" => {
            Ok(Json(handlers::space::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getThreads" => {
            Ok(Json(handlers::space::get_threads(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getMetadata" => {
            Ok(Json(handlers::room::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getMessages" => {
            Ok(Json(handlers::room::get_messages(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getThreads" => {
            Ok(Json(handlers::room::get_threads(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getLinks" => {
            Ok(Json(handlers::room::get_links(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.message.getMessage" => {
            Ok(Json(handlers::message::get_message(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.message.getReactions" => {
            Ok(Json(handlers::message::get_reactions(&state, &params, &ctx)?).into_response())
        }
        _ => Err(XrpcError::not_found(format!(
            "Unknown NSID: {}",
            nsid.as_str()
        ))),
    }
}
