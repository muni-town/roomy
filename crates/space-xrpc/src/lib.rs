//! Per-space XRPC read serving for the Roomy space worker.
//!
//! One process serves many spaces: [`registry::SpaceResolver`] turns a request's
//! `spaceId` — or the room or message it names — into the database that answers
//! it, and keeps a bounded set of them open. The crate never owns read state:
//! the caller's watermarks arrive on `x-roomy-read-positions`, and the unread
//! counts the four board/room endpoints need are derived from them against the
//! local `entities` table.
//!
//! ```no_run
//! use std::sync::Arc;
//! use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
//! use space_xrpc::state::XrpcState;
//! use space_xrpc::verify::TestMode;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let spaces = SpaceRegistry::new("data/spaces", Some("data/global.sqlite".into()), 256);
//! let first = spaces.resolve_space("did:web:example").ok_or("no such space")?;
//! let state = XrpcState::new(first, Arc::new(TestMode))
//!     .with_spaces(Arc::new(spaces) as Arc<dyn SpaceResolver>);
//! let app = space_xrpc::router(state);
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
pub mod registry;
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
use crate::state::{SpaceReadDb, XrpcState};

/// Which parameter names the entity a per-space read is about, and what to call
/// it when it cannot be resolved.
///
/// `spaceId` names a space directly. Everything else names an entity inside one
/// — a room, a message, or a thread — and resolves through the registry's
/// entity→space index. A `None` key is an endpoint whose space id is required
/// but which names nothing else.
fn names_entity(nsid: &str) -> Option<(&'static str, &'static str)> {
    match nsid {
        "space.roomy.room.getMessages"
        | "space.roomy.room.getThreads"
        | "space.roomy.room.getLinks"
        | "space.roomy.room.getMetadata"
        | "space.roomy.room.getRoomSummary"
        | "space.roomy.voice.getParticipants"
        | "space.roomy.voice.getToken" => Some(("roomId", "Room")),
        "space.roomy.message.getMessage" | "space.roomy.message.getReactions" => {
            Some(("messageId", "Message"))
        }
        _ => None,
    }
}

/// The space database this request is answered from.
///
/// `spaceId` names a space directly. The other per-space NSIDs name a room, a
/// message or a thread, and resolve through the registry's entity→space index.
fn resolve_space(
    state: &XrpcState,
    params: &Params,
    nsid: &Nsid,
) -> Result<std::sync::Arc<SpaceReadDb>, XrpcError> {
    let entity = names_entity(nsid.as_str());
    if let Some(space_id) = params.optional_string("spaceId") {
        // A space this process does not hold is answered from an empty one: the
        // access checks then decide, exactly as they do for a space whose
        // member edges are absent. Endpoints that read the space's own record
        // report it missing; the rest answer "not a member", or the empty list
        // a public space gives.
        return Ok(state
            .spaces
            .resolve_space(&space_id)
            .unwrap_or_else(|| std::sync::Arc::clone(&crate::state::ABSENT_SPACE)));
    }
    // The remaining endpoints name an entity; `validate_params` has already
    // rejected a request without one.
    let Some((entity_key, what)) = entity else {
        unreachable!("{} is neither space- nor entity-addressed", nsid.as_str());
    };
    let entity_id = params
        .optional_string(entity_key)
        .expect("a required param was validated");
    state
        .spaces
        .resolve_entity(&entity_id)
        .ok_or_else(|| XrpcError::not_found(format!("{what} not found: {entity_id}")))
}

/// The params a request must carry, in the order the appserver's schema reports
/// them: its lexicon's `required` list.
fn required_params(nsid: &str) -> Vec<&'static str> {
    match nsid {
        "space.roomy.search.rooms" => vec!["q", "spaceId"],
        "space.roomy.space.getUserAccess" => vec!["spaceId", "userDid"],
        _ => match names_entity(nsid) {
            Some((entity_key, _)) => vec![entity_key],
            None => vec!["spaceId"],
        },
    }
}

/// Reject a request that is missing a required param, with the message the
/// appserver's params schema produces: one line per missing param, in the
/// order the lexicon declares them.
fn validate_params(params: &Params, nsid: &Nsid) -> Result<(), XrpcError> {
    let missing: Vec<String> = required_params(nsid.as_str())
        .into_iter()
        .filter(|key| params.raw(key).is_none())
        .map(|key| format!("{key} must be a string (was missing)"))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(XrpcError::invalid_request(format!(
        "{} params validation failed: {}",
        nsid.as_str(),
        missing.join("\n")
    )))
}

/// NSIDs served by the worker. The gateway routes exactly these; anything else
/// is the gateway's business.
pub const ENDPOINTS: &[&str] = &[
    // Spaces.
    "space.roomy.space.getMetadata",
    "space.roomy.space.getSpaceSummary",
    "space.roomy.space.getThreads",
    "space.roomy.space.getLinks",
    "space.roomy.space.getMembers",
    "space.roomy.space.getRoles",
    "space.roomy.space.getInvites",
    "space.roomy.space.getUserAccess",
    "space.roomy.space.getBridgeTokens",
    // Rooms.
    "space.roomy.room.getMetadata",
    "space.roomy.room.getRoomSummary",
    "space.roomy.room.getMessages",
    "space.roomy.room.getThreads",
    "space.roomy.room.getLinks",
    // Messages.
    "space.roomy.message.getMessage",
    "space.roomy.message.getReactions",
    // Federation: per-space-scoped, backed by the gateway's registry replica.
    "space.roomy.federation.getRequests",
    "space.roomy.federation.getIncoming",
    "space.roomy.federation.getOutgoing",
    "space.roomy.federation.getGrants",
    // Voice call state, which the space's own DB projects.
    "space.roomy.voice.getToken",
    "space.roomy.voice.getParticipants",
    "space.roomy.voice.getActiveCalls",
    // Search within one space.
    "space.roomy.search.rooms",
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
    // Authentication first, then the params schema, then resolution: the order
    // the appserver runs them, and the order its errors are raised in.
    let ctx = context(&state, &headers, &nsid).await?;
    validate_params(&params, &nsid)?;
    // One process serves many spaces: the request names its space, or names an
    // entity the gateway's index resolves to one.
    let state = state.for_space(resolve_space(&state, &params, &nsid)?);

    match nsid.as_str() {
        "space.roomy.space.getMetadata" => {
            Ok(Json(handlers::space::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getSpaceSummary" => Ok(Json(handlers::space_info::get_space_summary(
            &state, &params, &ctx,
        )?)
        .into_response()),
        "space.roomy.space.getThreads" => {
            Ok(Json(handlers::space::get_threads(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getLinks" => {
            Ok(Json(handlers::space_info::get_links(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getMembers" => {
            Ok(Json(handlers::membership::get_members(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getRoles" => {
            Ok(Json(handlers::membership::get_roles(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getInvites" => {
            Ok(Json(handlers::membership::get_invites(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.space.getUserAccess" => Ok(Json(handlers::membership::get_user_access(
            &state, &params, &ctx,
        )?)
        .into_response()),
        "space.roomy.space.getBridgeTokens" => Ok(Json(
            handlers::bridge_tokens::get_bridge_tokens(&state, &params, &ctx)?,
        )
        .into_response()),
        "space.roomy.room.getMetadata" => {
            Ok(Json(handlers::room::get_metadata(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.room.getRoomSummary" => Ok(Json(handlers::space_info::get_room_summary(
            &state, &params, &ctx,
        )?)
        .into_response()),
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
        "space.roomy.federation.getRequests" => {
            Ok(Json(handlers::federation::get_requests(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.federation.getIncoming" => {
            Ok(Json(handlers::federation::get_incoming(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.federation.getOutgoing" => {
            Ok(Json(handlers::federation::get_outgoing(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.federation.getGrants" => {
            Ok(Json(handlers::federation::get_grants(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.voice.getToken" => {
            Ok(Json(handlers::voice::get_token(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.voice.getParticipants" => {
            Ok(Json(handlers::voice::get_participants(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.voice.getActiveCalls" => {
            Ok(Json(handlers::voice::get_active_calls(&state, &params, &ctx)?).into_response())
        }
        "space.roomy.search.rooms" => {
            Ok(Json(handlers::search_rooms::search_rooms(&state, &params, &ctx)?).into_response())
        }
        _ => Err(XrpcError::not_found(format!(
            "Unknown NSID: {}",
            nsid.as_str()
        ))),
    }
}
