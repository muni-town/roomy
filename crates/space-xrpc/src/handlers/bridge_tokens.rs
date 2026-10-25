//! `space.roomy.space.getBridgeTokens`: the bridge-token grants a space has
//! received.
//!
//! Grants live in the read-state database, not the per-space database, so the
//! rows are fetched through the read-state store after the per-space access
//! check. Nothing here talks to Polar: live validity is only re-resolved by
//! `space.roomy.admin.getSpaceMembership`.

use serde::Serialize;

use crate::access::space_access;
use crate::error::XrpcError;
use crate::handlers::common::{parse_space, Context};
use crate::params::Params;
use crate::state::XrpcState;

#[derive(Debug, Clone, Serialize)]
pub struct GetBridgeTokensResult {
    pub tokens: Vec<BridgeTokenSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeTokenSummary {
    #[serde(rename = "grantorDid")]
    pub grantor_did: String,
    pub spent: bool,
    #[serde(rename = "capacitySnapshot")]
    pub capacity_snapshot: i64,
}

/// Callers must be members or admins of the space; a public space's
/// `allow_public_join` does not open this endpoint.
pub fn get_bridge_tokens(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetBridgeTokensResult, XrpcError> {
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let space_id = parse_space(params)?;

    state.db.with(|conn| {
        let access = space_access(conn, space_id.as_str(), Some(did))?;
        if access.is_banned {
            return Err(XrpcError::forbidden("Caller is banned from this space"));
        }
        if !access.is_member && !access.is_admin {
            return Err(XrpcError::forbidden(
                "Caller is neither a member nor an admin of this space",
            ));
        }
        Ok(())
    })?;

    let grants = state
        .read_state
        .bridge_tokens(space_id.as_str())
        .map_err(|err| XrpcError::internal(format!("read-state error: {err}")))?;

    let tokens = grants
        .into_iter()
        .map(|grant| {
            let spent = grant.spent();
            BridgeTokenSummary {
                grantor_did: grant.grantor_did,
                spent,
                capacity_snapshot: grant.capacity_snapshot,
            }
        })
        .collect();

    Ok(GetBridgeTokensResult { tokens })
}
