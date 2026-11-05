//! Caller verification.
//!
//! Three implementations, selected by configuration and nothing else:
//!
//! - [`TestMode`] reads `X-Test-Did`, mirroring the appserver's test verifier.
//! - [`GatewayServiceAuth`] verifies a service JWT minted by the gateway.
//! - [`SessionAuth`] verifies the ATProto session token a client obtained from
//!   its PDS, which is what a real client sends.
//!
//! With none configured the router cannot be built — there is no implicit
//! trust mode. Missing credentials are anonymous, exactly as in the appserver;
//! the handlers' access checks decide what that may read.

use std::env;
use std::sync::Arc;

use async_trait::async_trait;
use axum::http::header;
use axum::http::HeaderMap;
use jsonwebtoken::jwk::{Jwk, KeyAlgorithm};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::Value;

use crate::error::XrpcError;
use crate::ids::{CallerDid, Nsid};

/// The caller a request's credentials identify, if any.
#[derive(Debug)]
pub struct Caller {
    /// The caller's DID, absent on an unauthenticated request.
    pub did: Option<CallerDid>,
}

/// Decides who a request is from.
#[async_trait]
pub trait CallerVerifier: Send + Sync {
    /// The caller `headers` identify for `nsid`, or an anonymous caller.
    ///
    /// # Errors
    ///
    /// Returns an `InvalidToken` error when credentials are present but cannot
    /// be verified.
    async fn verify(&self, headers: &HeaderMap, nsid: &Nsid) -> Result<Caller, XrpcError>;
}

/// `X-Test-Did`, enabled only by `SPACE_WORKER_TEST_MODE=true`.
pub struct TestMode;

#[async_trait]
impl CallerVerifier for TestMode {
    async fn verify(&self, headers: &HeaderMap, _nsid: &Nsid) -> Result<Caller, XrpcError> {
        match headers.get("x-test-did").and_then(|v| v.to_str().ok()) {
            Some(did) if !did.is_empty() => Ok(Caller {
                did: Some(CallerDid::try_from(did)?),
            }),
            _ => Ok(Caller { did: None }),
        }
    }
}

/// Service auth from the gateway: `iss` = gateway DID, `aud` = worker DID,
/// `sub` = caller DID, `lxm` = the requested NSID.
pub struct GatewayServiceAuth {
    gateway_did: String,
    worker_did: String,
    key: DecodingKey,
    algorithm: Algorithm,
}

impl GatewayServiceAuth {
    /// A verifier for tokens the gateway at `gateway_did` mints for
    /// `worker_did`, checked against `jwk`.
    ///
    /// # Errors
    ///
    /// Returns an error when the JWK's algorithm is unsupported or the key is
    /// not usable for verification.
    pub fn new(
        gateway_did: impl Into<String>,
        worker_did: impl Into<String>,
        jwk: &Jwk,
    ) -> Result<Self, XrpcError> {
        let algorithm = match jwk.common.key_algorithm {
            Some(KeyAlgorithm::RS256) | None => Algorithm::RS256,
            Some(KeyAlgorithm::RS384) => Algorithm::RS384,
            Some(KeyAlgorithm::RS512) => Algorithm::RS512,
            Some(KeyAlgorithm::ES256) => Algorithm::ES256,
            Some(KeyAlgorithm::ES384) => Algorithm::ES384,
            Some(other) => {
                return Err(XrpcError::internal(format!(
                    "unsupported gateway JWK algorithm: {other:?}"
                )))
            }
        };
        let key = DecodingKey::from_jwk(jwk)
            .map_err(|err| XrpcError::internal(format!("invalid gateway JWK: {err}")))?;
        Ok(Self {
            gateway_did: gateway_did.into(),
            worker_did: worker_did.into(),
            key,
            algorithm,
        })
    }
}

#[async_trait]
impl CallerVerifier for GatewayServiceAuth {
    async fn verify(&self, headers: &HeaderMap, nsid: &Nsid) -> Result<Caller, XrpcError> {
        let Some(authorization) = headers.get(header::AUTHORIZATION) else {
            return Ok(Caller { did: None });
        };
        let raw = authorization
            .to_str()
            .map_err(|_| XrpcError::new(401, "InvalidToken", "Malformed Authorization header"))?;
        let Some(token) = raw.strip_prefix("Bearer ") else {
            return Err(XrpcError::new(
                401,
                "InvalidToken",
                "Malformed Authorization header",
            ));
        };

        let mut validation = Validation::new(self.algorithm);
        validation.set_issuer(&[self.gateway_did.as_str()]);
        validation.set_audience(&[self.worker_did.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);

        let data = jsonwebtoken::decode::<Value>(token, &self.key, &validation).map_err(|err| {
            XrpcError::new(401, "InvalidToken", format!("Invalid service token: {err}"))
        })?;

        let claims = data.claims;
        let Some(sub) = claims.get("sub").and_then(|v| v.as_str()) else {
            return Err(XrpcError::new(401, "InvalidToken", "Token has no sub"));
        };
        // `lxm` names the endpoint the token was minted for; a token for one
        // query must not open another.
        match claims.get("lxm").and_then(|v| v.as_str()) {
            Some(lxm) if lxm == nsid.as_str() => {}
            _ => {
                return Err(XrpcError::new(
                    401,
                    "InvalidToken",
                    "Token is not valid for this endpoint",
                ))
            }
        }

        Ok(Caller {
            did: Some(CallerDid::try_from(sub)?),
        })
    }
}

/// ATProto session auth: the token a client gets from its PDS via
/// `com.atproto.server.getServiceAuth`, which is what a real client sends.
///
/// Verification itself — the ES256K signature against the issuer's DID
/// document, `aud`, `exp` and `lxm` — lives in [`roomy_auth::session`]. What
/// this adds is the HTTP shape: a bearer token is read from the header, and
/// everything that does not verify is an anonymous caller rather than an error,
/// because the handlers make the access decision.
pub struct SessionAuth {
    session: roomy_auth::session::SessionVerifier,
}

impl SessionAuth {
    /// A verifier for tokens whose `aud` is `server_did`, resolving issuers over
    /// the network.
    #[must_use]
    pub fn new(server_did: impl Into<String>) -> Self {
        Self {
            session: roomy_auth::session::SessionVerifier::new(server_did),
        }
    }

    /// A verifier that resolves issuer keys through `keys`.
    #[must_use]
    pub fn with_keys(
        server_did: impl Into<String>,
        keys: Arc<dyn roomy_auth::session::SigningKeys>,
    ) -> Self {
        Self {
            session: roomy_auth::session::SessionVerifier::with_keys(server_did, keys),
        }
    }
}

#[async_trait]
impl CallerVerifier for SessionAuth {
    async fn verify(&self, headers: &HeaderMap, nsid: &Nsid) -> Result<Caller, XrpcError> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|authorization| authorization.to_str().ok())
            .and_then(|raw| raw.strip_prefix("Bearer "));
        let Some(token) = token else {
            return Ok(Caller { did: None });
        };
        // A caller's DID that does not parse is a token this service has no
        // use for: the handlers only know how to act for a real DID.
        let did = self
            .session
            .caller(token, nsid.as_str())
            .await
            .and_then(|did| CallerDid::try_from(did.as_str()).ok());
        Ok(Caller { did })
    }
}

/// Environment-driven selection for the standalone binary.
///
/// `SPACE_WORKER_TEST_MODE=true` selects [`TestMode`]; otherwise the gateway
/// variables must all be present. Absent both, construction fails.
pub fn verifier_from_env() -> Result<Arc<dyn CallerVerifier>, String> {
    if env::var("SPACE_WORKER_TEST_MODE").as_deref() == Ok("true") {
        return Ok(Arc::new(TestMode));
    }
    let gateway_did = env::var("SPACE_WORKER_GATEWAY_DID")
        .map_err(|_| "SPACE_WORKER_GATEWAY_DID is not set".to_owned())?;
    let worker_did =
        env::var("SPACE_WORKER_DID").map_err(|_| "SPACE_WORKER_DID is not set".to_owned())?;
    let jwk_json = env::var("SPACE_WORKER_GATEWAY_JWK")
        .map_err(|_| "SPACE_WORKER_GATEWAY_JWK is not set".to_owned())?;
    let jwk: Jwk = serde_json::from_str(&jwk_json)
        .map_err(|err| format!("SPACE_WORKER_GATEWAY_JWK is not a JWK: {err}"))?;
    let verifier =
        GatewayServiceAuth::new(gateway_did, worker_did, &jwk).map_err(|err| err.message)?;
    Ok(Arc::new(verifier))
}
