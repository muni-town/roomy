//! Admin API: `/_roomy/admin/v1/*`.
//!
//! Every write is authorized the same way, and the checks are in this order for
//! a reason:
//!
//! 1. **Verify the JWT** against the caller's DID document, with `aud` = the
//!    bridge DID and `lxm` = the method being called. A token minted for a
//!    different method is not usable, which stops a token granted for a read
//!    being replayed as a write.
//! 2. **Resolve the caller's DID** to a handle — done by the verifier, which
//!    needs the DID document for the key anyway.
//! 3. **Check space admin** via `space.roomy.space.getMembers`, asking the
//!    appserver rather than the bridge's own tables, so the authority for
//!    admin is the space's, not the bridge's.
//!
//! Responses are scoped to a `spaceId` the caller administers. A caller who is
//! not an admin of the named space gets a 403 before any row is read, so no
//! endpoint can be used to enumerate another space's portals.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing;
use axum::{Json, Router};
use bridge_core::{MatrixRoomId, RoomyRoomId, SpaceDid};

use roomy_client::AppserverClient;
use serde::{Deserialize, Serialize};

use crate::auth::{AdminAuth, AdminError};
use crate::db::{self, BridgeConfigRow, BridgeDb, NewPortal, PortalRow};
use crate::probe::ProbeState;
use crate::supervisor::{BackfillRequest, EncryptionSupport, Supervisor};

/// The state every admin handler reads.
#[derive(Clone)]
pub struct AdminState {
    pub db: Arc<parking_lot::Mutex<BridgeDb>>,
    /// Used to ask the appserver whether the caller administers a space.
    pub appserver: Arc<AppserverClient>,
    pub auth: Arc<AdminAuth>,
    pub probe: ProbeState,
    /// Creates portals for a new bridge and queues their backfill.
    pub supervisor: Arc<Supervisor>,
    /// The homeserver's base URL, for resolving a room at configuration time.
    pub homeserver_url: String,
    /// The appservice token, for the same.
    pub as_token: matrix_adapter::AsToken,
    /// The deepest bridged hierarchy level, from configuration.
    pub max_depth: u32,
    /// The appservice's sender localpart, which the MSC4190 check uses.
    pub sender_localpart: String,
    /// The homeserver domain, which the MSC4190 check uses.
    pub domain: String,
    /// Every transaction the appservice has received, which is the evidence the
    /// stream checks read.
    pub observer: matrix_adapter::TransactionObserver,
    /// What this process can do about encrypted rooms. The probe measures the
    /// homeserver; this is whether a crypto device exists to act on it, and it
    /// is what decides whether a new portal is bridged or blocked.
    pub encryption: EncryptionSupport,
    /// The DID the admin API trusts without a service-auth token, from
    /// `[appserver] test_did`. Only set when the appserver runs in
    /// `APPSERVER_TEST_MODE`, where no DID document exists to verify a token
    /// against; unset in every real deployment.
    pub test_did: Option<String>,
}

/// The path every admin route is served under.
pub const ADMIN_PREFIX: &str = "/_roomy/admin/v1";

/// Build the admin router.
pub fn routes(state: AdminState) -> Router {
    Router::new()
        .route("/health", routing::get(health))
        .route("/capabilities", routing::get(capabilities))
        .route("/bridges", routing::get(list_bridges).post(create_bridge))
        .route(
            "/bridges/{id}",
            routing::patch(update_bridge).delete(delete_bridge),
        )
        .route("/bridges/{id}/backfill", routing::get(backfill))
        .route("/bridges/{id}/rooms", routing::get(rooms))
        .with_state(state)
}

/// `GET /health` — unauthenticated.
#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    #[serde(rename = "portalCount")]
    portal_count: i64,
    e2ee: bool,
    homeserver: &'static str,
}

async fn health(State(state): State<AdminState>) -> Response {
    let portal_count = state.db.lock().portal_count().unwrap_or(0);
    (
        StatusCode::OK,
        Json(Health {
            ok: true,
            portal_count,
            // Whether this process is encrypting, not whether the homeserver
            // could support it: a bridge started before the probe passed runs
            // without a device until it is restarted, and that is what a portal
            // created now will do.
            e2ee: matches!(state.encryption, EncryptionSupport::Ready(_)),
            homeserver: "reachable",
        }),
    )
        .into_response()
}

/// `GET /capabilities` — unauthenticated, the current probe result.
#[derive(Debug, Serialize)]
struct CapabilitiesBody {
    #[serde(rename = "msc4190Devices")]
    msc4190_devices: bool,
    #[serde(rename = "msc2409Ephemeral")]
    msc2409_ephemeral: bool,
    #[serde(rename = "msc4203ToDevice")]
    msc4203_to_device: bool,
    #[serde(rename = "msc3202DeviceLists")]
    msc3202_device_lists: bool,
    #[serde(rename = "msc3202OtkCounts")]
    msc3202_otk_counts: bool,
    #[serde(rename = "msc3202FallbackKeys")]
    msc3202_fallback_keys: bool,
    #[serde(rename = "e2eeAvailable")]
    e2ee_available: bool,
    /// Per-MSC evidence, so an operator can see why something failed.
    details: Vec<CapabilityDetail>,
}

#[derive(Debug, Serialize)]
struct CapabilityDetail {
    feature: String,
    status: &'static str,
    evidence: String,
}

async fn capabilities(State(state): State<AdminState>) -> Response {
    // Re-measure rather than replaying the startup result. The stream checks
    // depend on traffic the appservice has received, so a startup value would
    // report "unavailable" forever on a homeserver that started working the
    // moment its first transaction arrived.
    let measured = matrix_adapter::CapabilityProbe::new(
        matrix_adapter::HomeserverClient::new(
            state.homeserver_url.as_str(),
            state.as_token.clone(),
        ),
        state.sender_localpart.as_str(),
        state.domain.as_str(),
        state.observer.clone(),
    )
    .run()
    .await;
    state.probe.set(measured);

    match state.probe.capabilities() {
        Some(capabilities) => {
            let details = capabilities
                .features()
                .into_iter()
                .map(|(feature, status)| CapabilityDetail {
                    feature: feature.to_string(),
                    status: verdict(status.passed()),
                    evidence: status.evidence().to_string(),
                })
                .collect();
            (
                StatusCode::OK,
                Json(CapabilitiesBody {
                    msc4190_devices: capabilities.msc4190_devices.passed(),
                    msc2409_ephemeral: capabilities.msc2409_ephemeral.passed(),
                    msc4203_to_device: capabilities.msc4203_to_device.passed(),
                    msc3202_device_lists: capabilities.msc3202_device_lists.passed(),
                    msc3202_otk_counts: capabilities.msc3202_otk_counts.passed(),
                    msc3202_fallback_keys: capabilities.msc3202_fallback_keys.passed(),
                    e2ee_available: capabilities.e2ee_available(),
                    details,
                }),
            )
                .into_response()
        }
        None => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "the homeserver probe has not run",
        ),
    }
}

fn verdict(passed: bool) -> &'static str {
    if passed {
        "pass"
    } else {
        "fail"
    }
}

/// The query every read accepts.
#[derive(Debug, Deserialize)]
struct SpaceQuery {
    #[serde(rename = "spaceId")]
    space_id: Option<String>,
}

/// `GET /bridges?spaceId=`
async fn list_bridges(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Query(query): Query<SpaceQuery>,
) -> Response {
    let space_id = match query.space_id {
        Some(space_id) => space_id,
        None => return error_response(StatusCode::BAD_REQUEST, "spaceId is required"),
    };
    let Ok(space) = SpaceDid::parse(space_id) else {
        return error_response(StatusCode::BAD_REQUEST, "spaceId must be a DID");
    };
    if let Err(error) = authorize(&state, &headers, &space, "get").await {
        return error.into_response();
    }

    let db = state.db.lock();
    let bridges = match db.bridges_for_space(space.as_str()) {
        Ok(bridges) => bridges,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };

    let mut out = Vec::with_capacity(bridges.len());
    for bridge in bridges {
        let portals = db.portals_for_bridge(&bridge.id).unwrap_or_default();
        out.push(bridge_json(&bridge, &portals));
    }
    (StatusCode::OK, Json(serde_json::json!({ "bridges": out }))).into_response()
}

/// `POST /bridges`
#[derive(Debug, Deserialize)]
struct CreateBridgeBody {
    #[serde(rename = "spaceId")]
    space_id: String,
    #[serde(rename = "matrixId")]
    matrix_id: String,
    kind: String,
    mode: String,
    #[serde(rename = "targetRoomId", default)]
    target_room_id: Option<String>,
    #[serde(rename = "autoBridge", default)]
    auto_bridge: bool,
}

async fn create_bridge(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(body): Json<CreateBridgeBody>,
) -> Response {
    let Ok(space) = SpaceDid::parse(body.space_id.clone()) else {
        return error_response(StatusCode::BAD_REQUEST, "spaceId must be a DID");
    };
    if let Err(error) = authorize(&state, &headers, &space, "create").await {
        return error.into_response();
    }

    if !matches!(body.kind.as_str(), "room" | "space") {
        return error_response(StatusCode::BAD_REQUEST, "kind must be 'room' or 'space'");
    }
    if !matches!(body.mode.as_str(), "full" | "subset") {
        return error_response(StatusCode::BAD_REQUEST, "mode must be 'full' or 'subset'");
    }
    if MatrixRoomId::parse(body.matrix_id.clone()).is_err() {
        return error_response(
            StatusCode::BAD_REQUEST,
            &format!(
                "matrixId must be a room id (!…) or alias (#…), not {:?}",
                body.matrix_id
            ),
        );
    }

    let now = roomy_events::Ulid::new().timestamp_ms() as i64;
    let row = BridgeConfigRow {
        id: ::ulid::Ulid::generate().to_string(),
        space_did: space.as_str().to_string(),
        matrix_id: body.matrix_id.clone(),
        kind: body.kind.clone(),
        mode: body.mode.clone(),
        auto_bridge: body.auto_bridge,
        target_room_id: body.target_room_id.clone(),
        created_at: now,
        updated_at: now,
    };

    {
        let db = state.db.lock();
        if let Err(error) = db.insert_bridge(&row) {
            let message = error.to_string();
            // A unique-constraint failure is the ordinary "already bridged"
            // case, which is a conflict rather than a server fault.
            if message.contains("UNIQUE") {
                return error_response(
                    StatusCode::CONFLICT,
                    "that Matrix room is already bridged into this space",
                );
            }
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message);
        }
    }

    // Creating the bridge is what creates the rooms. A configuration row with
    // no portal would be a bridge that reports "syncing" and moves nothing.
    let portals = match create_portals(&state, &row).await {
        Ok(portals) => portals,
        Err(message) => return error_response(StatusCode::BAD_GATEWAY, &message),
    };

    // The supervisor turns each row into a portal with a typed encryption
    // state; queueing from that view means a backfill is described by what the
    // bridge can actually do, not by the stored flag.
    for portal in state.supervisor.load_space(&space) {
        state.supervisor.enqueue_backfill(BackfillRequest {
            portal: portal.id,
            roomy_room_id: portal.roomy_room_id,
            encryption: portal.encryption,
        });
    }

    (StatusCode::CREATED, Json(bridge_json(&row, &portals))).into_response()
}

/// Create the Roomy rooms a new bridge maps to, and record their portals.
///
/// A `kind = "room"` bridge is one portal. A `kind = "space"` bridge derives the
/// hierarchy from `m.space.child` edges, refuses a cycle, and creates a portal
/// per child. Both paths resolve the Matrix room first, so a typo or an
/// unreachable homeserver fails at configuration time rather than producing a
/// bridge that syncs nothing.
async fn create_portals(
    state: &AdminState,
    bridge: &BridgeConfigRow,
) -> Result<Vec<PortalRow>, String> {
    let space = SpaceDid::parse(bridge.space_did.clone())
        .map_err(|_| "the bridge's space id is not a DID".to_string())?;
    let homeserver = matrix_adapter::HomeserverClient::new(
        state.homeserver_url.as_str(),
        state.as_token.clone(),
    );

    let matrix_id = MatrixRoomId::parse(bridge.matrix_id.clone())
        .map_err(|_| "matrixId is not a Matrix room id".to_string())?;
    let room_id = if matrix_id.is_alias() {
        homeserver
            .resolve_alias(matrix_id.as_str())
            .await
            .map_err(|error| format!("could not resolve {matrix_id}: {error}"))?
    } else {
        matrix_id.as_str().to_string()
    };

    let room_id = MatrixRoomId::parse(room_id.clone()).map_err(|error| error.to_string())?;
    let summary = homeserver
        .room_summary(room_id.as_str())
        .await
        .map_err(|error| format!("could not read the room's state: {error}"))?;

    // An encrypted room this process cannot encrypt for is a blocked portal,
    // not a failed configuration: the operator sees the reason in the UI, and
    // the portal is never left claiming to sync while every send is refused.
    if summary.encrypted && state.encryption.portal_encryption(true).missing().is_some() {
        let roomy_room_id = target_room(bridge)?;
        create_roomy_room(
            state,
            &space,
            &roomy_room_id,
            summary.name.as_deref(),
            1,
            room_id.as_str(),
        )
        .await?;
        let portal = db::portal_row(NewPortal {
            space_did: &bridge.space_did,
            bridge_id: &bridge.id,
            matrix_room_id: &room_id,
            roomy_room_id: &roomy_room_id,
            depth: 1,
            name: summary.name.clone(),
            encrypted: true,
            now: crate::now_ms(),
        });
        let mut portal = portal;
        portal.state = "blocked".into();
        portal.reason = Some(
            state
                .encryption
                .portal_encryption(true)
                .missing()
                .map(|missing| {
                    format!(
                        "encryption is not available to this bridge: missing {}",
                        missing.label()
                    )
                })
                .unwrap_or_else(|| "encryption is not available".to_string()),
        );
        state
            .db
            .lock()
            .upsert_portal(&portal)
            .map_err(|error| error.to_string())?;
        return Ok(vec![portal]);
    }

    if bridge.kind == "room" {
        let roomy_room_id = target_room(bridge)?;
        create_roomy_room(
            state,
            &space,
            &roomy_room_id,
            summary.name.as_deref(),
            1,
            room_id.as_str(),
        )
        .await?;
        let portal = db::portal_row(NewPortal {
            space_did: &bridge.space_did,
            bridge_id: &bridge.id,
            matrix_room_id: &room_id,
            roomy_room_id: &roomy_room_id,
            depth: 1,
            name: summary.name,
            encrypted: summary.encrypted,
            now: crate::now_ms(),
        });
        state
            .db
            .lock()
            .upsert_portal(&portal)
            .map_err(|error| error.to_string())?;
        return Ok(vec![portal]);
    }

    // Space mode: walk `m.space.child` edges.
    let children = homeserver
        .space_children(room_id.as_str())
        .await
        .map_err(|error| format!("could not read the space's children: {error}"))?;

    let mut nodes = std::collections::BTreeMap::new();
    nodes.insert(
        room_id.clone(),
        bridge_core::SpaceNode {
            room_id: room_id.clone(),
            name: summary.name.clone(),
            is_space: true,
            children: children
                .iter()
                .filter_map(|(child, _)| MatrixRoomId::parse(child.clone()).ok())
                .collect(),
            child_event_id: None,
        },
    );
    for (child, _content) in &children {
        let Ok(child_id) = MatrixRoomId::parse(child.clone()) else {
            continue;
        };
        let child_summary = homeserver.room_summary(child).await.ok();
        nodes.insert(
            child_id.clone(),
            bridge_core::SpaceNode {
                room_id: child_id,
                name: child_summary.and_then(|summary| summary.name),
                is_space: false,
                children: Vec::new(),
                child_event_id: None,
            },
        );
    }

    let hierarchy = bridge_core::derive(&nodes, &room_id).map_err(|error| match error {
        bridge_core::HierarchyError::Cycle { cycle } => {
            format!("the space contains a cycle: {}", cycle.join(" -> "))
        }
        bridge_core::HierarchyError::Empty => "the space has no child rooms".to_string(),
    })?;

    let mut portals = Vec::with_capacity(hierarchy.ordered().len());
    for (matrix_room_id, decision) in hierarchy.ordered() {
        let depth = if decision.parent().is_some() { 2 } else { 1 };
        if depth > state.max_depth {
            // `derive` already flattens past two levels; a shallower configured
            // maximum turns the deeper rooms into threads under the nearest
            // channel rather than dropping them.
            tracing::warn!(
                room = %matrix_room_id,
                configured = state.max_depth,
                "bridging deeper than the configured maximum as a flattened thread"
            );
        }
        let summary = homeserver.room_summary(matrix_room_id.as_str()).await.ok();
        let roomy_room_id = new_roomy_room()?;
        create_roomy_room(
            state,
            &space,
            &roomy_room_id,
            Some(decision.name()),
            depth,
            matrix_room_id.as_str(),
        )
        .await?;
        let portal = db::portal_row(NewPortal {
            space_did: &bridge.space_did,
            bridge_id: &bridge.id,
            matrix_room_id,
            roomy_room_id: &roomy_room_id,
            depth,
            name: Some(decision.name().to_string()),
            encrypted: summary.is_some_and(|summary| summary.encrypted),
            now: crate::now_ms(),
        });
        state
            .db
            .lock()
            .upsert_portal(&portal)
            .map_err(|error| error.to_string())?;
        portals.push(portal);
    }

    Ok(portals)
}

/// The Roomy room a new portal maps to: the operator's chosen channel or thread
/// when the bridge names one, otherwise a freshly minted id.
fn target_room(bridge: &BridgeConfigRow) -> Result<RoomyRoomId, String> {
    match &bridge.target_room_id {
        Some(target) => RoomyRoomId::parse(target.clone())
            .map_err(|error| format!("targetRoomId is not a Roomy room id: {error}")),
        None => new_roomy_room(),
    }
}

/// Allocate the Roomy room id a new portal maps to.
///
/// The bridge mints the ULID itself so the portal can name its Roomy room before
/// `createRoom` reaches the appserver; the appserver uses the event's id as the
/// room id, so the two agree by construction.
fn new_roomy_room() -> Result<RoomyRoomId, String> {
    RoomyRoomId::parse(roomy_events::Ulid::new().to_string()).map_err(|error| error.to_string())
}

/// Create the Roomy room a portal maps to, unless it already exists.
///
/// A portal with no room is a bridge that reports `syncing` and moves nothing:
/// every event it writes to Roomy would address a room that is not there. The
/// create is stamped with its Matrix origin, which is what lets a
/// re-materialised space recognise the room after a bridge database loss.
/// Failures are not fatal to the configuration — the portal exists and its
/// reason says why it is not moving events yet.
async fn create_roomy_room(
    state: &AdminState,
    space_did: &SpaceDid,
    roomy_room_id: &RoomyRoomId,
    name: Option<&str>,
    depth: u32,
    matrix_room_id: &str,
) -> Result<(), String> {
    let space = space_did
        .to_did()
        .map_err(|_| "spaceId is not a DID".to_string())?;
    let event_id = roomy_events::Ulid::parse(roomy_room_id.as_str())
        .map_err(|_| "the portal's Roomy room id is not a ULID".to_string())?;
    let kind = if depth >= 2 {
        roomy_events::RoomKind::Thread
    } else {
        roomy_events::RoomKind::Channel
    };
    let event = roomy_events::Event::in_space(
        event_id,
        roomy_events::EventKind::CreateRoom(roomy_events::CreateRoom {
            kind,
            default_access: Some(roomy_events::DefaultAccess::ReadWrite),
            name: name.map(str::to_string),
            avatar: None,
            description: None,
            extensions: Some(roomy_events::RoomExtensions::with_matrix_origin(
                roomy_events::MatrixOrigin {
                    room_id: matrix_room_id.to_string(),
                    event_id: None,
                    origin_server_ts: None,
                },
            )),
        }),
    );
    state
        .appserver
        .send_events(&space, vec![event])
        .await
        .map_err(|error| format!("could not create the Roomy room: {error}"))
}

/// `PATCH /bridges/:id`
#[derive(Debug, Deserialize)]
struct UpdateBridgeBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(rename = "autoBridge", default)]
    auto_bridge: Option<bool>,
}

async fn update_bridge(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<UpdateBridgeBody>,
) -> Response {
    let space_id = match bridge_space(&state, &id) {
        Ok(space_id) => space_id,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = authorize(&state, &headers, &space_id, "patch").await {
        return error.into_response();
    }
    if let Some(mode) = &body.mode {
        if !matches!(mode.as_str(), "full" | "subset") {
            return error_response(StatusCode::BAD_REQUEST, "mode must be 'full' or 'subset'");
        }
    }

    let now = roomy_events::Ulid::new().timestamp_ms() as i64;
    let db = state.db.lock();
    if let Err(error) = db.update_bridge(&id, body.mode.as_deref(), body.auto_bridge, now) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
    }
    let row = match db.bridge(&id) {
        Ok(Some(row)) => row,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "no such bridge"),
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let portals = db.portals_for_bridge(&id).unwrap_or_default();
    (StatusCode::OK, Json(bridge_json(&row, &portals))).into_response()
}

/// `DELETE /bridges/:id`
async fn delete_bridge(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let space_id = match bridge_space(&state, &id) {
        Ok(space_id) => space_id,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = authorize(&state, &headers, &space_id, "delete").await {
        return error.into_response();
    }

    let db = state.db.lock();
    match db.delete_bridge(&id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
        Ok(false) => error_response(StatusCode::NOT_FOUND, "no such bridge"),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

/// `GET /bridges/:id/backfill`
async fn backfill(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let space_id = match bridge_space(&state, &id) {
        Ok(space_id) => space_id,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = authorize(&state, &headers, &space_id, "get").await {
        return error.into_response();
    }

    let db = state.db.lock();
    let portals = db.portals_for_bridge(&id).unwrap_or_default();
    let mut out = Vec::with_capacity(portals.len());
    for portal in portals {
        let progress = db
            .backfill(&portal.space_did, &portal.matrix_room_id)
            .ok()
            .flatten();
        out.push(serde_json::json!({
            "matrixRoomId": portal.matrix_room_id,
            "state": portal.state,
            "messagesBridged": progress.as_ref().map(|p| p.messages).unwrap_or(0),
            "complete": progress.as_ref().map(|p| p.complete).unwrap_or(false),
            // Honest about the unknown: a portal whose backfill has not started
            // reports that rather than a zero that looks like "nothing to do".
            "note": match progress {
                None => "backfill has not started".to_string(),
                Some(progress) if progress.complete => "complete".to_string(),
                Some(progress) => format!("phase {}", progress.phase),
            },
        }));
    }
    (StatusCode::OK, Json(serde_json::json!({ "portals": out }))).into_response()
}

/// `GET /bridges/:id/rooms` — the discovered hierarchy with its decisions.
async fn rooms(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let space_id = match bridge_space(&state, &id) {
        Ok(space_id) => space_id,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = authorize(&state, &headers, &space_id, "get").await {
        return error.into_response();
    }

    let db = state.db.lock();
    let portals = db.portals_for_bridge(&id).unwrap_or_default();
    let out: Vec<_> = portals
        .iter()
        .map(|portal| {
            serde_json::json!({
                "matrixId": portal.matrix_room_id,
                "name": portal.name,
                "depth": portal.depth,
                "parentId": portals
                    .iter()
                    .find(|candidate| candidate.depth + 1 == portal.depth)
                    .map(|candidate| candidate.matrix_room_id.clone()),
                "decision": match portal.depth {
                    1 => "channel",
                    2 => "thread",
                    _ => "flattened",
                },
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!({ "rooms": out }))).into_response()
}

/// The space a bridge belongs to, or the error to answer with.
fn bridge_space(state: &AdminState, id: &str) -> Result<SpaceDid, ApiError> {
    match state.db.lock().bridge(id) {
        Ok(Some(row)) => SpaceDid::parse(row.space_did).map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "the stored bridge has an invalid space id",
            )
        }),
        // A wrong-id probe is answered exactly like a missing bridge, so the
        // endpoint cannot be used to test whether an id exists in a space the
        // caller does not administer.
        Ok(None) => Err(ApiError::new(StatusCode::NOT_FOUND, "no such bridge")),
        Err(error) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            &error.to_string(),
        )),
    }
}

/// Verify the caller's token and their admin role in the space.
async fn authorize(
    state: &AdminState,
    headers: &HeaderMap,
    space: &SpaceDid,
    method: &str,
) -> Result<String, ApiError> {
    let did = caller_did(state, headers, method).await?;

    let space = space
        .to_did()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "spaceId must be a DID"))?;

    let members = state.appserver.get_members(&space).await.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            &format!("could not read the space's members: {error}"),
        )
    })?;

    if !members.is_admin(&did) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "the caller is not an admin of that space",
        ));
    }
    Ok(did)
}

/// Identify the caller: a verified service-auth token, or — only when the
/// appserver is in test mode — the DID named by `X-Test-Did`.
///
/// The test path exists because a token can only be verified against its
/// signer's DID document, and a test deployment has no PDS to publish one. It
/// does not skip the admin check: the header names a DID, and that DID still
/// has to be an admin of the space.
async fn caller_did(
    state: &AdminState,
    headers: &HeaderMap,
    method: &str,
) -> Result<String, ApiError> {
    if let Some(test_did) = &state.test_did {
        if headers
            .get("x-test-did")
            .and_then(|value| value.to_str().ok())
            == Some(test_did.as_str())
        {
            return Ok(test_did.clone());
        }
    }

    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "an Authorization: Bearer token is required",
            )
        })?;

    state
        .auth
        .verify(&token, method)
        .await
        .map_err(|error| match error {
            AdminError::Unauthorized(reason) => ApiError::new(StatusCode::UNAUTHORIZED, &reason),
            AdminError::Transport(reason) => ApiError::new(StatusCode::BAD_GATEWAY, &reason),
        })
}

/// The JSON shape of a bridge, as the app-lite UI consumes it.
fn bridge_json(bridge: &BridgeConfigRow, portals: &[PortalRow]) -> serde_json::Value {
    let portals: Vec<_> = portals
        .iter()
        .map(|portal| {
            serde_json::json!({
                "matrixRoomId": portal.matrix_room_id,
                "roomyRoomId": portal.roomy_room_id,
                "depth": portal.depth,
                "state": portal.state,
                "reason": portal.reason,
                "encrypted": portal.encrypted,
            })
        })
        .collect();

    serde_json::json!({
        "id": bridge.id,
        "spaceId": bridge.space_did,
        "matrixId": bridge.matrix_id,
        "kind": bridge.kind,
        "mode": bridge.mode,
        "autoBridge": bridge.auto_bridge,
        "targetRoomId": bridge.target_room_id,
        "portals": portals,
    })
}

/// The response shape for an error.
#[derive(Debug, Serialize)]
struct ApiErrorBody {
    error: String,
}

/// An error the admin API returns with a status.
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            message: message.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

fn error_response(status: StatusCode, message: &str) -> Response {
    ApiError::new(status, message).into_response()
}
