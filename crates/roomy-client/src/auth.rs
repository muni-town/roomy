//! Service-auth tokens.
//!
//! The bridge holds an ordinary ATProto session (identifier + app password) and
//! mints short-lived JWTs from its PDS on demand. The appserver verifies each
//! token against the issuer's DID document and checks `aud` and `lxm`, so a
//! token minted for one method is not usable for another — which is why the
//! cache is keyed by both.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::error::ClientError;

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
    #[serde(rename = "accessJwt")]
    pub access_jwt: String,
    #[serde(rename = "refreshJwt")]
    pub refresh_jwt: String,
    pub did: String,
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
    http: reqwest::Client,
    /// The PDS base URL, e.g. `https://bsky.social`.
    pds_url: String,
    cache: Mutex<HashMap<(String, Option<String>), CachedToken>>,
}

impl ServiceAuth {
    pub fn new(pds_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            pds_url: pds_url.into().trim_end_matches('/').to_string(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Log in and return the session, so the caller learns its own DID.
    pub async fn create_session(
        &self,
        credentials: &SessionCredentials,
    ) -> Result<Session, ClientError> {
        #[derive(Serialize)]
        struct Body<'a> {
            identifier: &'a str,
            password: &'a str,
        }

        let url = format!("{}/xrpc/com.atproto.server.createSession", self.pds_url);
        let response = self
            .http
            .post(&url)
            .json(&Body {
                identifier: &credentials.identifier,
                password: &credentials.app_password,
            })
            .send()
            .await
            .map_err(|source| ClientError::Transport {
                method: "com.atproto.server.createSession".into(),
                source,
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ClientError::Xrpc {
                nsid: "com.atproto.server.createSession".into(),
                error: status.to_string(),
                message: body,
            });
        }

        response
            .json::<Session>()
            .await
            .map_err(|source| ClientError::Transport {
                method: "com.atproto.server.createSession".into(),
                source,
            })
    }

    /// Mint a token for `aud`, optionally scoped to one method.
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

        let response = self
            .http
            .get(&url)
            .bearer_auth(access_jwt)
            .send()
            .await
            .map_err(|source| ClientError::Transport {
                method: "com.atproto.server.getServiceAuth".into(),
                source,
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(ClientError::ServiceAuth {
                aud: aud.to_string(),
                reason: format!("PDS answered {status}: {body}"),
            });
        }

        #[derive(Deserialize)]
        struct Minted {
            token: String,
        }
        let minted = response
            .json::<Minted>()
            .await
            .map_err(|source| ClientError::Transport {
                method: "com.atproto.server.getServiceAuth".into(),
                source,
            })?;

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

/// Percent-encode a query value.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
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

    #[test]
    fn query_values_are_percent_encoded() {
        assert_eq!(
            urlencode("did:web:api.roomy.space"),
            "did%3Aweb%3Aapi.roomy.space"
        );
    }
}
