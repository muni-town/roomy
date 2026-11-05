//! ATProto session verification.
//!
//! A client authenticates by sending the token its PDS minted for this service:
//! a JWT with `iss` the PDS, `sub` the user, `aud` this service's DID and `lxm`
//! the NSID it was minted for. An atproto-proxy token is the same JWT signed by
//! the user's own key, where `iss` is the user and there is no `sub`.
//!
//! The token is accepted when all of this holds:
//!
//!  * the signature is ES256K over `base64url(header) + "." + base64url(payload)`
//!    and verifies against the `#atproto` key in the issuer's DID document;
//!  * `aud` names this service;
//!  * `exp` is in the future;
//!  * `lxm`, when present, is the endpoint being called.
//!
//! Everything else is an **anonymous caller**, not an error: the handlers make
//! the access decision, so a caller who cannot prove who they are is a caller
//! with no DID rather than a rejected request. That is the rule the TypeScript
//! appserver's verifier follows, and this module is checked against it.
//!
//! DID resolution is a cache with a TTL, and a signature that fails is retried
//! once against a freshly fetched document: a PDS that rotated its signing key
//! is honoured by the token that needs it, without waiting out the cache.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use k256::ecdsa::signature::Verifier as _;
use k256::ecdsa::{Signature, VerifyingKey};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;

/// The ATProto signing algorithm every session token uses.
const ALGORITHM: &str = "ES256K";

/// How long a DID document's key is trusted before it is fetched again.
const DID_CACHE_TTL: Duration = Duration::from_secs(300);

/// How long a DID that did not resolve is remembered as unresolved.
///
/// Shorter than the key TTL: one network hiccup must not leave the service
/// anonymous for a whole TTL. A forced refresh ignores it, so a rotated key is
/// still honoured immediately by the token that needs it.
const DID_FAILED_TTL: Duration = Duration::from_secs(30);

/// How long a DID document fetch may take before it is abandoned.
const DID_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// An ATProto signing key, as a DID document publishes it.
#[derive(Debug, Clone)]
pub struct SigningKey(VerifyingKey);

impl SigningKey {
    /// A key from a SEC1-encoded point: compressed, as `did:plc` and `did:web`
    /// documents carry it.
    #[must_use]
    pub fn from_sec1(bytes: &[u8]) -> Option<Self> {
        VerifyingKey::from_sec1_bytes(bytes).ok().map(Self)
    }

    /// Whether `signature` is this key's signature over `message`.
    ///
    /// JWS carries ES256K as the raw 64-byte `r || s` pair — not DER — over the
    /// SHA-256 of the signing input, which is what [`VerifyingKey::verify`]
    /// checks. A high-S signature is normalised rather than rejected: the
    /// curve's rule is the normal form, and either encoding proves the same key.
    fn verifies(&self, message: &[u8], signature: &[u8]) -> bool {
        let Ok(signature) = Signature::from_slice(signature) else {
            return false;
        };
        let signature = signature.normalize_s().unwrap_or(signature);
        self.0.verify(message, &signature).is_ok()
    }
}

/// Where a DID's ATProto signing key comes from.
#[async_trait]
pub trait SigningKeys: Send + Sync {
    /// The key `did` publishes, or `None` when the DID does not resolve or
    /// publishes no ATProto key.
    ///
    /// `force_refresh` skips any cache. It is how verification retries after a
    /// signature mismatch, so a rotated key is picked up by the token that
    /// needs it.
    async fn signing_key(&self, did: &str, force_refresh: bool) -> Option<SigningKey>;
}

/// Verifies ATProto session tokens addressed to one service.
pub struct SessionVerifier {
    server_did: String,
    keys: Arc<dyn SigningKeys>,
}

impl SessionVerifier {
    /// A verifier for tokens whose `aud` is `server_did`, resolving issuers over
    /// the network.
    #[must_use]
    pub fn new(server_did: impl Into<String>) -> Self {
        Self::with_keys(server_did, Arc::new(HttpDidResolver::new()))
    }

    /// A verifier for tokens whose `aud` is `server_did`, resolving issuers
    /// through `keys`.
    #[must_use]
    pub fn with_keys(server_did: impl Into<String>, keys: Arc<dyn SigningKeys>) -> Self {
        Self {
            server_did: server_did.into(),
            keys,
        }
    }

    /// The caller `token` identifies when it was minted for `nsid`.
    ///
    /// `None` is every failure: no signature, the wrong one, the wrong
    /// audience, an expired token, another endpoint, or an issuer whose DID does
    /// not resolve. The caller is `sub` when the token carries one — a PDS
    /// issued it for a user — and `iss` otherwise, which is the user's own
    /// signature on an atproto-proxy token.
    pub async fn caller(&self, token: &str, nsid: &str) -> Option<String> {
        let token = Token::parse(token)?;

        if !token.claims.addressed_to(&self.server_did) {
            return None;
        }
        if !token.claims.unexpired(now_secs()) {
            return None;
        }
        if let Some(lxm) = &token.claims.lxm {
            if lxm != nsid {
                return None;
            }
        }

        // An issuer may name a key fragment — `<did>#atproto` — but the
        // document is fetched for the DID, and the key inside it is selected
        // there.
        let issuer = token.claims.iss.split('#').next().unwrap_or_default();
        if issuer.is_empty() {
            return None;
        }

        let verified = match self.keys.signing_key(issuer, false).await {
            Some(key) => key.verifies(token.signing_input.as_bytes(), &token.signature),
            None => false,
        };
        let verified = verified
            || match self.keys.signing_key(issuer, true).await {
                Some(key) => key.verifies(token.signing_input.as_bytes(), &token.signature),
                None => false,
            };
        if !verified {
            return None;
        }

        Some(token.claims.subject())
    }
}

/// A parsed session token: the claims, and what the signature is over.
struct Token {
    claims: Claims,
    signature: Vec<u8>,
    /// `base64url(header) + "." + base64url(payload)`: the bytes signed.
    signing_input: String,
}

impl Token {
    /// A token in the JWS compact form this service verifies, or `None` for
    /// anything else.
    fn parse(token: &str) -> Option<Self> {
        let parts: Vec<&str> = token.split('.').collect();
        let [header, payload, signature] = parts.as_slice() else {
            return None;
        };
        let parsed: Header = decode_json(header)?;
        if parsed.alg != ALGORITHM {
            return None;
        }
        Some(Self {
            claims: decode_json(payload)?,
            signature: decode_base64url(signature)?,
            signing_input: format!("{header}.{payload}"),
        })
    }
}

/// The JWT header. Only the algorithm is read: the key comes from the issuer's
/// DID document, never from anything the token itself names.
#[derive(Deserialize)]
struct Header {
    alg: String,
}

/// A session token's claims.
#[derive(Deserialize)]
struct Claims {
    iss: String,
    #[serde(default)]
    sub: Option<String>,
    #[serde(default)]
    aud: Option<Value>,
    #[serde(default)]
    exp: Option<Value>,
    #[serde(default)]
    lxm: Option<String>,
}

impl Claims {
    /// Whether the token names `server_did` as its audience. `aud` is a string
    /// in an ATProto token; a list is accepted because that is what JWS allows.
    fn addressed_to(&self, server_did: &str) -> bool {
        match self.aud.as_ref() {
            Some(Value::String(aud)) => aud == server_did,
            Some(Value::Array(auds)) => auds.iter().any(|aud| aud.as_str() == Some(server_did)),
            _ => false,
        }
    }

    /// Whether the token has not expired. `exp` is required: a token that never
    /// expires cannot be reasoned about, and every PDS sets one.
    fn unexpired(&self, now: i64) -> bool {
        match self.exp.as_ref() {
            Some(Value::Number(exp)) => exp.as_i64().is_some_and(|exp| exp > now),
            _ => false,
        }
    }

    /// The caller this token is from.
    fn subject(&self) -> String {
        self.sub.clone().unwrap_or_else(|| self.iss.clone())
    }
}

/// Resolves DID documents over HTTP and keeps their ATProto keys.
pub struct HttpDidResolver {
    http: reqwest::Client,
    ttl: Duration,
    /// Each DID's last resolution — its key, or the fact that it did not
    /// resolve — and when it happened.
    cache: Mutex<HashMap<String, (Option<SigningKey>, Instant)>>,
}

impl HttpDidResolver {
    /// A resolver that trusts a document for [`DID_CACHE_TTL`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_ttl(DID_CACHE_TTL)
    }

    /// A resolver that trusts a document for `ttl`.
    #[must_use]
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            http: reqwest::Client::new(),
            ttl,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The key `url` publishes, or `None` when it is unreachable or carries
    /// none.
    async fn fetch(&self, url: &str) -> Option<SigningKey> {
        let response = self
            .http
            .get(url)
            .timeout(DID_FETCH_TIMEOUT)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<DidDocument>().await.ok()?.atproto_key()
    }
}

impl Default for HttpDidResolver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SigningKeys for HttpDidResolver {
    async fn signing_key(&self, did: &str, force_refresh: bool) -> Option<SigningKey> {
        // The lock covers the read only: a DID being fetched must not hold up
        // another DID's cache lookup.
        if let Some((key, fetched_at)) = self.cache.lock().get(did).cloned() {
            let age = fetched_at.elapsed();
            let fresh = match key {
                Some(_) => age < self.ttl,
                None => age < DID_FAILED_TTL,
            };
            if fresh && !force_refresh {
                return key;
            }
        }

        let key = match did_document_url(did) {
            Some(url) => self.fetch(&url).await,
            None => None,
        };
        self.cache
            .lock()
            .insert(did.to_owned(), (key.clone(), Instant::now()));
        key
    }
}

/// A DID document, with only the fields key resolution reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidDocument {
    #[serde(default)]
    verification_method: Vec<VerificationMethod>,
}

impl DidDocument {
    /// The `#atproto` verification method's key.
    fn atproto_key(&self) -> Option<SigningKey> {
        let method = self.verification_method.iter().find(|method| {
            method
                .id
                .rsplit_once('#')
                .is_some_and(|(_, fragment)| fragment == "atproto")
        })?;
        parse_multibase(method.public_key_multibase.as_deref()?)
    }
}

/// One key a DID document publishes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationMethod {
    #[serde(default)]
    id: String,
    #[serde(default)]
    public_key_multibase: Option<String>,
}

/// Parse a `publicKeyMultibase`: base58btc (the `z` prefix) of a secp256k1
/// point.
///
/// ATProto publishes the compressed point itself. The did:key form prefixes it
/// with the multicodec `0xe7 0x01`, which is the same point and is accepted.
fn parse_multibase(multibase: &str) -> Option<SigningKey> {
    let encoded = multibase.strip_prefix('z')?;
    let bytes = bs58::decode(encoded).into_vec().ok()?;
    let point = match bytes.as_slice() {
        [0xe7, 0x01, ..] => &bytes[2..],
        _ => &bytes[..],
    };
    SigningKey::from_sec1(point)
}

/// The URL a DID's document is served from.
///
/// `did:plc:<id>` lives at the PLC directory. `did:web` follows the standard
/// rule: the method-specific id's first segment is the host — with any port's
/// colon percent-encoded — and its further segments are path separators.
///
/// A host carrying URL syntax (a user info `@`, a path `/`, a query or a
/// fragment) does not name a host and is refused: the issuer of a token is not
/// yet trusted when its document is fetched, so the URL it produces is the one
/// thing an unknown caller controls.
#[must_use]
pub fn did_document_url(did: &str) -> Option<String> {
    if let Some(id) = did.strip_prefix("did:plc:") {
        return (!id.is_empty()).then(|| format!("https://plc.directory/{did}"));
    }

    let rest = did.strip_prefix("did:web:")?;
    let mut segments = rest.split(':');
    let host = percent_decode(segments.next()?)?;
    if host.is_empty() || host.contains(['/', '@', '?', '#', '\\']) {
        return None;
    }
    let path: Vec<&str> = segments.collect();
    if path.is_empty() {
        return Some(format!("https://{host}/.well-known/did.json"));
    }
    Some(format!("https://{host}/{}/did.json", path.join("/")))
}

/// Decode the `%XX` escapes in a DID method-specific id segment.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = raw.get(index + 1..index + 3)?;
            out.push(char::from(u8::from_str_radix(hex, 16).ok()?));
            index += 3;
        } else {
            out.push(char::from(bytes[index]));
            index += 1;
        }
    }
    Some(out)
}

/// Decode a base64url segment, padded or not.
fn decode_base64url(raw: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(raw)
        .or_else(|_| URL_SAFE.decode(raw))
        .ok()
}

/// Decode a base64url JSON segment.
fn decode_json<T: for<'de> Deserialize<'de>>(raw: &str) -> Option<T> {
    serde_json::from_slice(&decode_base64url(raw)?).ok()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::signature::Signer as _;

    /// A key pair, published the way a PDS publishes one: the compressed point
    /// in base58btc, optionally prefixed by a multicodec.
    fn published(seed: u8, prefix: Option<&[u8]>) -> (k256::ecdsa::SigningKey, String) {
        let secret = k256::ecdsa::SigningKey::from_slice(&[seed; 32]).unwrap();
        let point = secret.verifying_key().to_encoded_point(true);
        let mut bytes = prefix.map(<[u8]>::to_vec).unwrap_or_default();
        bytes.extend_from_slice(point.as_bytes());
        (secret, format!("z{}", bs58::encode(bytes).into_string()))
    }

    fn document(id: &str, multibase: &str) -> DidDocument {
        serde_json::from_value(serde_json::json!({
            "id": "did:plc:abc",
            "verificationMethod": [{
                "id": id,
                "type": "Multikey",
                "controller": "did:plc:abc",
                "publicKeyMultibase": multibase,
            }]
        }))
        .unwrap()
    }

    #[test]
    fn a_document_publishes_the_key_its_atproto_method_names() {
        let (secret, multibase) = published(20, None);
        let key = document("did:plc:abc#atproto", &multibase)
            .atproto_key()
            .unwrap();

        let signature: k256::ecdsa::Signature = secret.sign(b"signed input");
        assert!(key.verifies(b"signed input", &signature.to_bytes()));
    }

    #[test]
    fn the_did_key_form_of_the_same_point_is_the_same_key() {
        // did:key writes the point behind the secp256k1 multicodec prefix; the
        // key is the same one.
        let (secret, multibase) = published(21, Some(&[0xe7, 0x01]));
        let key = document("did:plc:abc#atproto", &multibase)
            .atproto_key()
            .unwrap();

        let signature: k256::ecdsa::Signature = secret.sign(b"another input");
        assert!(key.verifies(b"another input", &signature.to_bytes()));
    }

    #[test]
    fn a_document_without_an_atproto_method_publishes_no_key() {
        let (_secret, multibase) = published(22, None);
        assert!(document("did:plc:abc#rotation", &multibase)
            .atproto_key()
            .is_none());
        // A verification method that is not secp256k1 is not a signing key at
        // all.
        let key = document("did:plc:abc#atproto", "znot-a-key");
        assert!(key.atproto_key().is_none());
    }

    #[test]
    fn a_plc_did_resolves_at_the_plc_directory() {
        assert_eq!(
            did_document_url("did:plc:abc123").as_deref(),
            Some("https://plc.directory/did:plc:abc123")
        );
    }

    #[test]
    fn a_web_did_renders_its_host_and_path() {
        assert_eq!(
            did_document_url("did:web:example.com").as_deref(),
            Some("https://example.com/.well-known/did.json")
        );
        assert_eq!(
            did_document_url("did:web:example.com:user:alice").as_deref(),
            Some("https://example.com/user/alice/did.json")
        );
        // A port is encoded in the method-specific id; the colons that follow
        // are the path.
        assert_eq!(
            did_document_url("did:web:example.com%3A8443:user:alice").as_deref(),
            Some("https://example.com:8443/user/alice/did.json")
        );
    }

    #[test]
    fn an_unsupported_or_hostile_did_has_no_url() {
        assert!(did_document_url("did:key:z6Mkabc").is_none());
        assert!(did_document_url("did:plc:").is_none());
        assert!(did_document_url("did:web:").is_none());
        assert!(did_document_url("did:web:evil.example@attacker.example").is_none());
        assert!(did_document_url("did:web:example.com/x").is_none());
    }
}
