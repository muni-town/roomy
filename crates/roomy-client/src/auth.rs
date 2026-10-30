//! Service-auth tokens.
//!
//! The bridge holds an ordinary ATProto session (identifier + app password) and
//! mints short-lived JWTs from its PDS on demand. The appserver verifies each
//! token against the issuer's DID document and checks `aud` and `lxm`, so a
//! token minted for one method is not usable for another — which is why the
//! cache is keyed by both.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::ClientError;
use crate::transport::{call, urlencode, HttpMethod, HttpRequest, HttpTransport, Transport};

/// The credentials the bridge authenticates to its PDS with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCredentials {
    /// Handle or DID.
    pub identifier: String,
    /// App password.
    pub app_password: String,
}

/// The PDS session the bridge holds.
#[derive(Debug, Clone, Deserialize)]
pub struct Session {
    /// The token an authenticated XRPC call carries.
    #[serde(rename = "accessJwt")]
    pub access_jwt: String,
    /// The token that mints a new access token when one expires.
    #[serde(rename = "refreshJwt")]
    pub refresh_jwt: String,
    /// The account's DID, which the bridge learns from the login.
    pub did: String,
    /// The handle the PDS resolved, when it resolved one.
    #[serde(default)]
    pub handle: Option<String>,
}

/// A minted token and when it stops being usable.
#[derive(Debug, Clone)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Refresh a token this long before its stated expiry, so a token that expires
/// between the check and the call is not sent.
const EXPIRY_MARGIN: Duration = Duration::from_secs(30);

/// Requested token lifetime.
const REQUESTED_LIFETIME_SEC: u64 = 300;

/// Mints and caches service-auth tokens.
#[derive(Debug)]
pub struct ServiceAuth {
    transport: Arc<dyn Transport>,
    /// The PDS base URL, e.g. `https://bsky.social`.
    pds_url: String,
    cache: Mutex<HashMap<(String, Option<String>), CachedToken>>,
}

impl ServiceAuth {
    /// Mint tokens over the live HTTP transport, from a PDS at `pds_url`.
    pub fn new(pds_url: impl Into<String>) -> Self {
        Self::new_with_transport(pds_url, Arc::new(HttpTransport::new()))
    }

    /// Mint tokens over `transport` instead of a live connection.
    pub fn new_with_transport(pds_url: impl Into<String>, transport: Arc<dyn Transport>) -> Self {
        Self {
            transport,
            pds_url: pds_url.into().trim_end_matches('/').to_string(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Log in and return the session, so the caller learns its own DID.
    ///
    /// # Errors
    ///
    /// The PDS refusing the credentials, or a response body that is not a
    /// session.
    pub async fn create_session(
        &self,
        credentials: &SessionCredentials,
    ) -> Result<Session, ClientError> {
        #[derive(Serialize)]
        struct Body<'a> {
            identifier: &'a str,
            password: &'a str,
        }

        const NSID: &str = "com.atproto.server.createSession";
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Post,
            url: format!("{}/xrpc/{NSID}", self.pds_url),
            headers: vec![("content-type", "application/json".to_string())],
            body: Some(
                serde_json::to_vec(&Body {
                    identifier: &credentials.identifier,
                    password: &credentials.app_password,
                })
                .expect("credentials serialise"),
            ),
        };
        call(self.transport.as_ref(), request).await
    }

    /// Mint a token for `aud`, optionally scoped to one method.
    ///
    /// # Errors
    ///
    /// [`ClientError::ServiceAuth`] when the PDS refuses the mint — a
    /// credential problem rather than a problem with the call being made.
    pub async fn token(
        &self,
        access_jwt: &str,
        aud: &str,
        lxm: Option<&str>,
    ) -> Result<String, ClientError> {
        let key = (aud.to_string(), lxm.map(str::to_string));
        if let Some(cached) = self.cached(&key) {
            return Ok(cached);
        }

        let exp = unix_now_secs() + REQUESTED_LIFETIME_SEC;
        let mut url = format!(
            "{}/xrpc/com.atproto.server.getServiceAuth?aud={}&exp={exp}",
            self.pds_url,
            urlencode(aud)
        );
        if let Some(lxm) = lxm {
            url.push_str(&format!("&lxm={}", urlencode(lxm)));
        }

        const NSID: &str = "com.atproto.server.getServiceAuth";
        let request = HttpRequest {
            nsid: NSID,
            method: HttpMethod::Get,
            url,
            headers: vec![("Authorization", format!("Bearer {access_jwt}"))],
            body: None,
        };

        #[derive(Deserialize)]
        struct Minted {
            token: String,
        }
        let minted: Minted = match call(self.transport.as_ref(), request).await {
            Ok(minted) => minted,
            // The PDS refusing a mint is a credential problem, not a method
            // problem, so it keeps the variant that says so.
            Err(ClientError::Xrpc {
                error: status,
                message,
                ..
            }) => {
                return Err(ClientError::ServiceAuth {
                    aud: aud.to_string(),
                    reason: format!("PDS answered {status}: {message}"),
                })
            }
            Err(other) => return Err(other),
        };

        let expires_at = Instant::now()
            + decode_lifetime(&minted.token).unwrap_or(Duration::from_secs(REQUESTED_LIFETIME_SEC));
        self.cache.lock().insert(
            key,
            CachedToken {
                token: minted.token.clone(),
                expires_at,
            },
        );
        Ok(minted.token)
    }

    /// Drop every cached token, for a session change.
    pub fn clear(&self) {
        self.cache.lock().clear();
    }

    fn cached(&self, key: &(String, Option<String>)) -> Option<String> {
        let cache = self.cache.lock();
        let entry = cache.get(key)?;
        let remaining = entry.expires_at.saturating_duration_since(Instant::now());
        (remaining > EXPIRY_MARGIN).then(|| entry.token.clone())
    }
}

/// The `exp` claim's remaining lifetime, minus the safety margin.
///
/// Decoding without verifying is correct here: the token was just minted by the
/// PDS over TLS, and the only question is when to stop reusing it. A signature
/// check would need the PDS keys for no benefit.
fn decode_lifetime(token: &str) -> Option<Duration> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload))
        .ok()?;
    #[derive(Deserialize)]
    struct Claims {
        exp: u64,
    }
    let claims: Claims = serde_json::from_slice(&decoded).ok()?;
    let remaining = claims.exp.saturating_sub(unix_now_secs());
    Some(Duration::from_secs(remaining))
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unpadded_jwt_payload_is_decoded() {
        // {"exp": 2000000000}
        let payload =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":2000000000}"#);
        let token = format!("header.{payload}.signature");
        let lifetime = decode_lifetime(&token).unwrap();
        // The claim is a fixed absolute time, so the remaining lifetime is that
        // minus now — a positive, plausible amount rather than a fixed number.
        assert!(lifetime > Duration::from_secs(0));
        assert!(lifetime < Duration::from_secs(2000000000));
    }

    #[test]
    fn a_malformed_token_has_no_lifetime() {
        assert!(decode_lifetime("not-a-jwt").is_none());
        assert!(decode_lifetime("a.b.c").is_none());
    }
}
