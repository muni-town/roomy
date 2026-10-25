//! `space.roomy.federation.getRequests`, `getIncoming`, `getOutgoing`,
//! `getGrants`.
//!
//! All four are admin reads of one space's view of the gateway's federation
//! registry: the pending requests it has received, the federations into and out
//! of it, and the channel grants on either side. Nothing here touches the
//! space's own rows except for an admin check and the counterpart space's
//! display name, which lives in the counterpart's `comp_info`.

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::access::require_space_access;
use crate::error::XrpcError;
use crate::handlers::common::Context;
use crate::params::Params;
use crate::state::XrpcState;
use crate::store::{FederationOrder, FederationView};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationRequestRow {
    pub federating_space_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub federating_space_name: Option<String>,
    pub requested_by_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by_handle: Option<String>,
    pub requested_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetRequestsResult {
    pub requests: Vec<FederationRequestRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationIncomingRow {
    pub origin_space_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_space_name: Option<String>,
    pub status: String,
    pub requested_by_did: String,
    pub requested_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by_did: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetIncomingResult {
    pub federations: Vec<FederationIncomingRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FederationOutgoingRow {
    pub federating_space_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub federating_space_name: Option<String>,
    pub status: String,
    pub requested_by_did: String,
    pub requested_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by_did: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetOutgoingResult {
    pub federations: Vec<FederationOutgoingRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginGrantRow {
    pub federating_space_did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub federating_space_name: Option<String>,
    pub room_id: String,
    pub permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverGrantRow {
    pub origin_space_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_space_name: Option<String>,
    pub room_id: String,
    pub grantee: String,
    pub kind: String,
    pub permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetGrantsResult {
    pub origin_grants: Vec<OriginGrantRow>,
    pub receiver_grants: Vec<ReceiverGrantRow>,
}

/// The admin gate the federation reads share: an authenticated caller who
/// administers `spaceId`. `view_label` names the data in the 403 message.
fn require_federation_admin(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
    view_label: &str,
) -> Result<String, XrpcError> {
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let space_id = params.require_string("spaceId")?;
    state.db.with(|conn| {
        // `requireSpaceAccess`, not the read gate: a public space's open join
        // does not make every caller an admin.
        let access = require_space_access(conn, &space_id, Some(did))?;
        if !access.is_admin {
            return Err(XrpcError::forbidden(format!(
                "Only space admins can view {view_label}"
            )));
        }
        Ok(())
    })?;
    Ok(space_id)
}

/// A counterpart space's `comp_info.name`.
///
/// A space can be joined before its own stream materialises a `comp_info` row,
/// and a space this worker does not serve has no name here at all; both read as
/// absent so a list never fails over a display name.
fn resolve_space_name(state: &XrpcState, space_did: &str) -> Option<String> {
    let db = state.spaces.resolve_space(space_did)?;
    let name = db
        .with(|conn| {
            Ok(conn
                .query_row(
                    "select name from comp_info where entity = ?",
                    [space_did],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?)
        })
        .ok()
        .flatten()
        .flatten()?;
    // An empty name is not a name.
    (!name.is_empty()).then_some(name)
}

/// A string that is present in the response only when it has content.
fn present(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

pub fn get_requests(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetRequestsResult, XrpcError> {
    let space_id = require_federation_admin(state, params, ctx, "federation requests")?;
    let rows = state.stores.federations(
        FederationView::Origin(&space_id),
        Some("pending"),
        FederationOrder::RequestedAtAscending,
    );

    let requests = rows
        .into_iter()
        .map(|row| {
            let federating_space_name = resolve_space_name(state, &row.federating_space_did);
            let (requested_by_name, requested_by_handle) =
                match state.stores.profile(&row.requested_by_did) {
                    Some(profile) => (present(profile.name), present(profile.handle)),
                    None => (None, None),
                };
            FederationRequestRow {
                federating_space_did: row.federating_space_did,
                federating_space_name,
                requested_by_did: row.requested_by_did,
                requested_by_name,
                requested_by_handle,
                requested_at: row.requested_at,
                message: present(row.message),
            }
        })
        .collect();

    Ok(GetRequestsResult { requests })
}

pub fn get_incoming(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetIncomingResult, XrpcError> {
    let space_id = require_federation_admin(state, params, ctx, "incoming federations")?;
    let rows = state.stores.federations(
        FederationView::Receiver(&space_id),
        None,
        FederationOrder::RequestedAtDescending,
    );

    let federations = rows
        .into_iter()
        .map(|row| {
            let origin_space_name = resolve_space_name(state, &row.space_id);
            FederationIncomingRow {
                origin_space_did: row.space_id,
                origin_space_name,
                status: row.status,
                requested_by_did: row.requested_by_did,
                requested_at: row.requested_at,
                decided_by_did: present(row.decided_by_did),
                decided_at: row.decided_at,
            }
        })
        .collect();

    Ok(GetIncomingResult { federations })
}

pub fn get_outgoing(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetOutgoingResult, XrpcError> {
    let space_id = require_federation_admin(state, params, ctx, "outgoing federations")?;
    let rows = state.stores.federations(
        FederationView::Origin(&space_id),
        None,
        FederationOrder::RequestedAtDescending,
    );

    let federations = rows
        .into_iter()
        .map(|row| {
            let federating_space_name = resolve_space_name(state, &row.federating_space_did);
            FederationOutgoingRow {
                federating_space_did: row.federating_space_did,
                federating_space_name,
                status: row.status,
                requested_by_did: row.requested_by_did,
                requested_at: row.requested_at,
                decided_by_did: present(row.decided_by_did),
                decided_at: row.decided_at,
                message: present(row.message),
            }
        })
        .collect();

    Ok(GetOutgoingResult { federations })
}

pub fn get_grants(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetGrantsResult, XrpcError> {
    let space_id = require_federation_admin(state, params, ctx, "federation grants")?;

    let origin_grants = state
        .stores
        .federation_origin_grants(&space_id)
        .into_iter()
        .map(|grant| {
            let federating_space_name = resolve_space_name(state, &grant.federating_space_did);
            OriginGrantRow {
                federating_space_did: grant.federating_space_did,
                federating_space_name,
                room_id: grant.room_id,
                permission: grant.permission,
            }
        })
        .collect();

    let receiver_grants = state
        .stores
        .federation_receiver_grants(&space_id)
        .into_iter()
        .map(|grant| {
            let origin_space_name = resolve_space_name(state, &grant.space_id);
            ReceiverGrantRow {
                origin_space_id: grant.space_id,
                origin_space_name,
                room_id: grant.room_id,
                grantee: grant.grantee,
                kind: grant.kind,
                permission: grant.permission,
            }
        })
        .collect();

    Ok(GetGrantsResult {
        origin_grants,
        receiver_grants,
    })
}
