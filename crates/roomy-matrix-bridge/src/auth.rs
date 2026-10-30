//! Service-auth JWT verification for the admin API.
//!
//! The bridge verifies tokens itself rather than trusting the appserver,
//! because the appserver is not in the path: a browser talks to the bridge
//! directly. The rules are ATProto's, and they are checked in this order:
//!
//! * the signature verifies against a key in the issuer's DID document;
//! * `aud` equals the bridge's DID, so a token minted for another service is not
//!   usable here;
//! * `lxm` equals the method being called, so a token minted for a read cannot
//!   be replayed as a write;
//! * `exp` has not passed.
//!
//! Verification is deliberately strict about `aud`. Service-auth tokens are
//! short-lived bearer capabilities; accepting one whose audience is a different
//! service would turn any other service's token into a key to this one.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature as P256Signature, VerifyingKey as P256Key};
use serde::Deserialize;

/// A token was not acceptable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdminError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Transport(String),
}

/// Verifies admin tokens.
pub struct AdminAuth {
    bridge_did: String,
    http: reqwest::Client,
    /// DID documents, cached with a lifetime so a rotated key is picked up
    /// without a restart.
    did_cache: Mutex<HashMap<String, (DidDocument, Instant)>>,
}

/// How long a DID document is trusted before it is refetched.
const DID_CACHE_TTL: Duration = Duration::from_secs(300);

impl AdminAuth {
    /// An authenticator for tokens naming `bridge_did`.
    pub fn new(bridge_did: impl Into<String>) -> Self {
        Self {
            bridge_did: bridge_did.into(),
            http: reqwest::Client::new(),
            did_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Verify a token for `method`.
    pub async fn verify(&self, token: &str, method: &str) -> Result<String, AdminError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(AdminError::Unauthorized("not a JWT".into()));
        }

        let header: Header = decode_json(parts[0])
            .ok_or_else(|| AdminError::Unauthorized("unreadable JWT header".into()))?;
        let claims: Claims = decode_json(parts[1])
            .ok_or_else(|| AdminError::Unauthorized("unreadable JWT payload".into()))?;

        // Audience first: it is a cheap check that rejects the most common
        // wrong token, before any network call.
        let audiences: Vec<&str> = match &claims.aud {
            Some(Audience::One(aud)) => vec![aud.as_str()],
            Some(Audience::Many(list)) => list.iter().map(String::as_str).collect(),
            None => return Err(AdminError::Unauthorized("token has no audience".into())),
        };
        if !audiences.iter().any(|aud| *aud == self.bridge_did) {
            return Err(AdminError::Unauthorized(format!(
                "token audience does not include {}",
                self.bridge_did
            )));
        }

        if let Some(lxm) = &claims.lxm {
            if !lxm_matches(lxm, method) {
                return Err(AdminError::Unauthorized(format!(
                    "token was minted for {lxm}, not {method}"
                )));
            }
        }

        if let Some(exp) = claims.exp {
            if exp <= unix_now() as i64 {
                return Err(AdminError::Unauthorized("token has expired".into()));
            }
        }

        let signer = claims.signer().to_string();
        if header.alg != "ES256" && header.alg != "ES256K" {
            return Err(AdminError::Unauthorized(format!(
                "unsupported signing algorithm {}",
                header.alg
            )));
        }

        let document = self.did_document(&signer).await?;
        let key = document.signing_key(&header.kid).ok_or_else(|| {
            AdminError::Unauthorized("no usable signing key in the DID document".into())
        })?;

        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let signature = decode_base64url(parts[2])
            .ok_or_else(|| AdminError::Unauthorized("unreadable JWT signature".into()))?;

        match header.alg.as_str() {
            "ES256" => verify_es256(&key, signing_input.as_bytes(), &signature)?,
            "ES256K" => verify_es256k(&key, signing_input.as_bytes(), &signature)?,
            _ => unreachable!("algorithm checked above"),
        }

        Ok(claims.caller().to_string())
    }

    /// Resolve a DID document, cached.
    async fn did_document(&self, did: &str) -> Result<DidDocument, AdminError> {
        if let Some((document, fetched_at)) = self.did_cache.lock().get(did).cloned() {
            if fetched_at.elapsed() < DID_CACHE_TTL {
                return Ok(document);
            }
        }

        let document = self.fetch_did_document(did).await?;
        self.did_cache
            .lock()
            .insert(did.to_string(), (document.clone(), Instant::now()));
        Ok(document)
    }

    async fn fetch_did_document(&self, did: &str) -> Result<DidDocument, AdminError> {
        if let Some(rest) = did.strip_prefix("did:web:") {
            let (host, path) = match rest.split_once(':') {
                Some((host, path)) => (host.replace("%3A", ":"), path.replace('/', ":")),
                None => (rest.replace("%3A", ":"), String::new()),
            };
            let url = if path.is_empty() {
                format!("https://{host}/.well-known/did.json")
            } else {
                format!("https://{host}/{}/did.json", path.replace(':', "/"))
            };
            return self.fetch_document(&url).await;
        }

        if did.starts_with("did:plc:") {
            let url = format!("https://plc.directory/{did}");
            return self.fetch_document(&url).await;
        }

        Err(AdminError::Unauthorized(format!(
            "cannot resolve {did}: unsupported DID method"
        )))
    }

    async fn fetch_document(&self, url: &str) -> Result<DidDocument, AdminError> {
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| AdminError::Transport(format!("could not fetch {url}: {error}")))?;
        if !response.status().is_success() {
            return Err(AdminError::Transport(format!(
                "{url} answered HTTP {}",
                response.status()
            )));
        }
        response.json::<DidDocument>().await.map_err(|error| {
            AdminError::Transport(format!("{url} returned unreadable JSON: {error}"))
        })
    }
}

/// Whether a token's `lxm` authorizes `method`.
///
/// The admin API's own method namespace is `_roomy.admin.<resource>.<action>`
/// while the HTTP path is `/_roomy/admin/v1/<resource>`. The mapping lives here
/// so the check cannot drift from the route table.
fn lxm_matches(lxm: &str, method: &str) -> bool {
    let expected = match method {
        "get" => "_roomy.admin.bridges.get",
        "create" => "_roomy.admin.bridges.create",
        "patch" => "_roomy.admin.bridges.patch",
        "delete" => "_roomy.admin.bridges.delete",
        other => return lxm == other,
    };
    lxm == expected
}

/// A DID document, with only the fields key resolution needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidDocument {
    #[serde(default)]
    verification_method: Vec<VerificationMethod>,
    #[serde(default)]
    service: Vec<Service>,
}

impl DidDocument {
    /// The key a token names, or the account's first signing key.
    fn signing_key(&self, kid: &Option<String>) -> Option<VerifyingKey> {
        let selected = match kid {
            Some(kid) => {
                let wanted = kid.split('#').nth(1).unwrap_or(kid.as_str());
                self.verification_method.iter().find(|method| {
                    method.id == *kid || method.id.rsplit('#').next() == Some(wanted)
                })
            }
            None => self.verification_method.first(),
        }?;
        parse_key(selected)
    }

    /// The appservice endpoint a bridge announces, if it announces one.
    #[allow(dead_code)]
    fn appservice_endpoint(&self) -> Option<&str> {
        self.service
            .iter()
            .find(|service| service.kind == "RoomyMatrixBridge")
            .and_then(|service| service.endpoint.as_deref())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationMethod {
    #[serde(default)]
    id: String,
    #[serde(default)]
    public_key_multibase: Option<String>,
    #[serde(default)]
    public_key_jwk: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct Service {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    endpoint: Option<String>,
}

/// A key parsed from a DID document, in whichever curve it uses.
#[derive(Debug, Clone)]
enum VerifyingKey {
    P256(Vec<u8>),
    Secp256k1(Vec<u8>),
}

/// Parse a verification method's key material into SEC1 uncompressed bytes.
fn parse_key(method: &VerificationMethod) -> Option<VerifyingKey> {
    if let Some(multibase) = &method.public_key_multibase {
        return parse_multibase(multibase);
    }
    if let Some(jwk) = &method.public_key_jwk {
        let curve = jwk.get("crv")?.as_str()?;
        let x = decode_base64url(jwk.get("x")?.as_str()?)?;
        let y = decode_base64url(jwk.get("y")?.as_str()?)?;
        let mut bytes = Vec::with_capacity(65);
        bytes.push(0x04);
        bytes.extend_from_slice(&x);
        bytes.extend_from_slice(&y);
        return match curve {
            "P-256" => Some(VerifyingKey::P256(bytes)),
            "secp256k1" => Some(VerifyingKey::Secp256k1(bytes)),
            _ => None,
        };
    }
    None
}

/// Parse a `did:key`-style multibase key: base58btc with a multicodec prefix.
///
/// * `0xe7 0x01` — secp256k1 public key.
/// * `0x80 0x24` — P-256 public key.
fn parse_multibase(multibase: &str) -> Option<VerifyingKey> {
    let encoded = multibase.strip_prefix('z')?;
    let bytes = bs58::decode(encoded).into_vec().ok()?;
    if bytes.len() < 3 {
        return None;
    }
    let (prefix, rest) = bytes.split_at(2);
    match prefix {
        [0xe7, 0x01] => Some(VerifyingKey::Secp256k1(rest.to_vec())),
        [0x80, 0x24] => Some(VerifyingKey::P256(rest.to_vec())),
        _ => None,
    }
}

fn verify_es256(key: &VerifyingKey, input: &[u8], signature: &[u8]) -> Result<(), AdminError> {
    let bytes = match key {
        VerifyingKey::P256(bytes) => bytes,
        // An ES256 token signed by a secp256k1 key is a mismatch worth naming,
        // not a silent failure.
        _ => {
            return Err(AdminError::Unauthorized(
                "token says ES256 but the DID key is secp256k1".into(),
            ))
        }
    };
    let verifying_key = P256Key::from_sec1_bytes(bytes)
        .map_err(|_| AdminError::Unauthorized("unusable P-256 public key".into()))?;
    // JWS carries ES256 signatures as the raw 64-byte `r || s` pair; DER is the
    // form non-JWT callers use, so it is the fallback rather than the first try.
    let signature = P256Signature::from_slice(signature)
        .or_else(|_| P256Signature::from_der(signature))
        .map_err(|_| AdminError::Unauthorized("unreadable ES256 signature".into()))?;
    verifying_key
        .verify(input, &signature)
        .map_err(|_| AdminError::Unauthorized("signature does not verify".into()))
}

fn verify_es256k(key: &VerifyingKey, input: &[u8], signature: &[u8]) -> Result<(), AdminError> {
    let bytes = match key {
        VerifyingKey::Secp256k1(bytes) => bytes,
        _ => {
            return Err(AdminError::Unauthorized(
                "token says ES256K but the DID key is P-256".into(),
            ))
        }
    };
    let verifying_key = k256::ecdsa::VerifyingKey::from_sec1_bytes(bytes)
        .map_err(|_| AdminError::Unauthorized("unusable secp256k1 public key".into()))?;
    let signature = k256::ecdsa::Signature::from_slice(signature)
        .or_else(|_| k256::ecdsa::Signature::from_der(signature))
        .map_err(|_| AdminError::Unauthorized("unreadable ES256K signature".into()))?;
    verifying_key
        .verify(input, &signature)
        .map_err(|_| AdminError::Unauthorized("signature does not verify".into()))
}

/// A JWT header.
#[derive(Debug, Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

/// An audience claim: one DID or a list.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Audience {
    One(String),
    Many(Vec<String>),
}

/// The claims the bridge checks.
#[derive(Debug, Deserialize)]
struct Claims {
    iss: String,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    aud: Option<Audience>,
    #[serde(default)]
    lxm: Option<String>,
    #[serde(default)]
    exp: Option<i64>,
}

impl Claims {
    /// The DID whose key signed the token.
    ///
    /// A service-auth token from a PDS has `iss` = the PDS's service DID and
    /// `sub` = the user. The signing key belongs to the *issuer*, so that is
    /// what is resolved. The caller's identity is the `sub`.
    fn signer(&self) -> &str {
        self.iss.split('#').next().unwrap_or(&self.iss)
    }

    /// The DID the call is attributed to.
    ///
    /// A PDS-minted service-auth token has `iss` = the PDS and `sub` = the user;
    /// authorizing `iss` would let any PDS sign for every one of its accounts.
    fn caller(&self) -> &str {
        self.sub.as_deref().unwrap_or_else(|| self.signer())
    }
}

fn decode_json<T: for<'de> Deserialize<'de>>(part: &str) -> Option<T> {
    let bytes = decode_base64url(part)?;
    serde_json::from_slice(&bytes).ok()
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(value))
        .ok()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The SHA-256 of a byte slice, used when minting test tokens.
#[allow(dead_code)]
fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::SigningKey;

    fn token(
        key: &SigningKey,
        aud: &str,
        lxm: Option<&str>,
        exp: i64,
        kid: Option<&str>,
    ) -> String {
        let header = serde_json::json!({
            "alg": "ES256",
            "typ": "JWT",
            "kid": kid,
        });
        let claims = serde_json::json!({
            "iss": "did:plc:pds",
            "sub": "did:plc:alice",
            "aud": aud,
            "lxm": lxm,
            "exp": exp,
            "iat": 1,
        });
        let encode = |value: &serde_json::Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(value).unwrap())
        };
        let signing_input = format!("{}.{}", encode(&header), encode(&claims));
        let signature: p256::ecdsa::Signature = key.sign(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.to_bytes())
        )
    }

    /// A deterministic P-256 signing key, so a test can assert on an exact
    /// token. The scalar is a test constant, not a credential.
    fn signing_key(seed: u8) -> SigningKey {
        let scalar = p256::SecretKey::from_slice(&[seed; 32]).unwrap();
        SigningKey::from(scalar)
    }

    /// The DID document for the fixed key, as a bridge would fetch it.
    fn document_for(key: &SigningKey) -> DidDocument {
        let point = key.verifying_key().to_encoded_point(false);
        let x = point.x().unwrap();
        let y = point.y().unwrap();
        serde_json::from_value(serde_json::json!({
            "id": "did:plc:pds",
            "verificationMethod": [{
                "id": "did:plc:pds#atproto",
                "type": "Multikey",
                "controller": "did:plc:pds",
                "publicKeyJwk": {
                    "kty": "EC",
                    "crv": "P-256",
                    "x": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(x),
                    "y": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(y),
                },
            }],
        }))
        .unwrap()
    }

    fn auth() -> AdminAuth {
        let auth = AdminAuth::new("did:web:bridge.roomy.space");
        auth.did_cache.lock().insert(
            "did:plc:pds".to_string(),
            (document_for(&signing_key(1)), Instant::now()),
        );
        auth
    }

    #[tokio::test]
    async fn a_valid_token_verifies_and_names_the_caller() {
        let key = signing_key(1);
        let token = token(
            &key,
            "did:web:bridge.roomy.space",
            Some("_roomy.admin.bridges.create"),
            9_999_999_999,
            None,
        );
        let did = auth().verify(&token, "create").await.unwrap();
        assert_eq!(did, "did:plc:alice");
    }

    #[tokio::test]
    async fn a_wrong_audience_is_refused() {
        let key = signing_key(1);
        let token = token(
            &key,
            "did:web:other.space",
            Some("_roomy.admin.bridges.create"),
            9_999_999_999,
            None,
        );
        let error = auth().verify(&token, "create").await.unwrap_err();
        assert!(matches!(error, AdminError::Unauthorized(_)));
        assert!(error.to_string().contains("audience"));
    }

    #[tokio::test]
    async fn an_expired_token_is_refused() {
        let key = signing_key(1);
        let token = token(
            &key,
            "did:web:bridge.roomy.space",
            Some("_roomy.admin.bridges.create"),
            1,
            None,
        );
        let error = auth().verify(&token, "create").await.unwrap_err();
        assert!(error.to_string().contains("expired"));
    }

    #[tokio::test]
    async fn a_token_for_another_method_is_refused() {
        let key = signing_key(1);
        let token = token(
            &key,
            "did:web:bridge.roomy.space",
            Some("_roomy.admin.bridges.get"),
            9_999_999_999,
            None,
        );
        let error = auth().verify(&token, "delete").await.unwrap_err();
        assert!(error.to_string().contains("minted for"));
    }

    #[tokio::test]
    async fn a_tampered_payload_does_not_verify() {
        let key = signing_key(1);
        let token = token(
            &key,
            "did:web:bridge.roomy.space",
            Some("_roomy.admin.bridges.create"),
            9_999_999_999,
            None,
        );
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": "did:plc:pds",
                "sub": "did:plc:mallory",
                "aud": "did:web:bridge.roomy.space",
                "lxm": "_roomy.admin.bridges.create",
                "exp": 9_999_999_999i64,
            }))
            .unwrap(),
        );
        parts[1] = &forged;
        let error = auth().verify(&parts.join("."), "create").await.unwrap_err();
        assert!(error.to_string().contains("does not verify"));
    }

    #[tokio::test]
    async fn a_token_signed_by_a_different_key_does_not_verify() {
        let token = token(
            &signing_key(2),
            "did:web:bridge.roomy.space",
            Some("_roomy.admin.bridges.create"),
            9_999_999_999,
            None,
        );
        let error = auth().verify(&token, "create").await.unwrap_err();
        assert!(error.to_string().contains("does not verify"));
    }

    #[tokio::test]
    async fn a_malformed_token_is_refused() {
        let error = auth().verify("not.a.jwt", "create").await.unwrap_err();
        assert!(matches!(error, AdminError::Unauthorized(_)));
    }

    #[test]
    fn lxm_mapping_matches_the_route_names() {
        assert!(lxm_matches("_roomy.admin.bridges.get", "get"));
        assert!(lxm_matches("_roomy.admin.bridges.create", "create"));
        assert!(!lxm_matches("_roomy.admin.bridges.get", "create"));
    }

    #[test]
    fn a_multibase_p256_key_is_parsed() {
        let key = signing_key(1);
        let point = key.verifying_key().to_encoded_point(false);
        let mut bytes = vec![0x80, 0x24];
        bytes.extend_from_slice(point.as_bytes());
        let multibase = format!("z{}", bs58::encode(bytes).into_string());
        let parsed = parse_multibase(&multibase).unwrap();
        assert!(matches!(parsed, VerifyingKey::P256(_)));
    }

    #[test]
    fn a_sha256_digest_is_stable() {
        assert_eq!(sha256(b"bridge").len(), 32);
    }
}
