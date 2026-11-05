//! ATProto session verification: the tokens a real client sends.
//!
//! Every case here is hermetic — the keys are generated, the JWTs are built by
//! hand, and the issuer's DID document is a map in memory — so the verifier's
//! rules are pinned without a network or a PLC directory.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use axum::http::{header, HeaderMap, HeaderValue};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use k256::ecdsa::signature::Signer as _;
use k256::ecdsa::SigningKey as SecretKey;
use parking_lot::Mutex;
use roomy_auth::session::{SigningKey, SigningKeys};
use serde_json::{json, Value};
use space_xrpc::ids::Nsid;
use space_xrpc::verify::{CallerVerifier, SessionAuth};

const SERVER_DID: &str = "did:web:api.roomy.space";
const PDS_DID: &str = "did:web:pds.example";
const USER_DID: &str = "did:plc:alice";
const NSID: &str = "space.roomy.room.getMessages";

fn nsid() -> Nsid {
    Nsid::try_from(NSID).unwrap()
}

/// A key pair: the secret signs, and the public half is what a DID document
/// publishes.
fn keypair(seed: u8) -> (SecretKey, SigningKey) {
    let secret = SecretKey::from_slice(&[seed; 32]).unwrap();
    let public = secret.verifying_key().to_encoded_point(true);
    (secret, SigningKey::from_sec1(public.as_bytes()).unwrap())
}

/// A JWT in the shape a PDS issues: ES256K over the two encoded segments, with
/// the signature as the raw 64-byte `r || s` pair.
fn jwt(secret: &SecretKey, claims: &Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256K","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
    let signing_input = format!("{header}.{payload}");
    let signature: k256::ecdsa::Signature = secret.sign(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    format!("{signing_input}.{signature}")
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// The claims of a PDS-issued token for one user and endpoint.
fn claims() -> Value {
    json!({
        "iss": PDS_DID,
        "sub": USER_DID,
        "aud": SERVER_DID,
        "lxm": NSID,
        "exp": now() + 300,
        "iat": now(),
    })
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers
}

/// A key source that answers from memory: the first resolution returns `first`,
/// a forced refresh returns `refresh`, and every call is recorded.
struct FakeKeys {
    first: Option<SigningKey>,
    refresh: Option<SigningKey>,
    calls: Mutex<Vec<(String, bool)>>,
}

impl FakeKeys {
    fn new(first: Option<SigningKey>) -> Self {
        Self {
            refresh: first.clone(),
            first,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn rotating(first: Option<SigningKey>, refresh: SigningKey) -> Self {
        Self {
            first,
            refresh: Some(refresh),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(String, bool)> {
        self.calls.lock().clone()
    }
}

#[async_trait]
impl SigningKeys for FakeKeys {
    async fn signing_key(&self, did: &str, force_refresh: bool) -> Option<SigningKey> {
        self.calls.lock().push((did.to_owned(), force_refresh));
        if force_refresh {
            self.refresh.clone()
        } else {
            self.first.clone()
        }
    }
}

/// A verifier answering from `keys`.
fn verifier(keys: FakeKeys) -> (SessionAuth, Arc<FakeKeys>) {
    let keys = Arc::new(keys);
    let auth = SessionAuth::with_keys(SERVER_DID, Arc::clone(&keys) as Arc<dyn SigningKeys>);
    (auth, keys)
}

async fn caller(auth: &SessionAuth, headers: &HeaderMap) -> Option<String> {
    let caller = auth.verify(headers, &nsid()).await.unwrap();
    caller.did.map(|did| did.into_inner())
}

#[tokio::test]
async fn a_token_from_a_pds_identifies_the_user_in_sub() {
    let (secret, public) = keypair(1);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    let caller = caller(&auth, &bearer(&jwt(&secret, &claims()))).await;

    assert_eq!(caller.as_deref(), Some(USER_DID));
    assert_eq!(keys.calls(), vec![(PDS_DID.to_owned(), false)]);
}

#[tokio::test]
async fn an_atproto_proxy_token_identifies_the_issuer() {
    let (secret, public) = keypair(2);
    let (auth, _keys) = verifier(FakeKeys::new(Some(public)));

    let mut claims = claims();
    claims["iss"] = json!(USER_DID);
    claims.as_object_mut().unwrap().remove("sub");

    let caller = caller(&auth, &bearer(&jwt(&secret, &claims))).await;

    assert_eq!(caller.as_deref(), Some(USER_DID));
}

#[tokio::test]
async fn an_issuer_fragment_resolves_the_base_did() {
    let (secret, public) = keypair(3);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    let mut claims = claims();
    claims["iss"] = json!(format!("{PDS_DID}#atproto"));

    let caller = caller(&auth, &bearer(&jwt(&secret, &claims))).await;

    // The document is fetched for the DID, not for the fragment, and the user
    // in `sub` is still the caller.
    assert_eq!(caller.as_deref(), Some(USER_DID));
    assert_eq!(keys.calls().first().unwrap().0, PDS_DID);
}

#[tokio::test]
async fn a_token_for_another_audience_is_anonymous() {
    let (secret, public) = keypair(4);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    let mut claims = claims();
    claims["aud"] = json!("did:web:another.example");

    assert!(caller(&auth, &bearer(&jwt(&secret, &claims)))
        .await
        .is_none());
    // A token minted for another service never reaches the network.
    assert!(keys.calls().is_empty());
}

#[tokio::test]
async fn a_token_minted_for_another_endpoint_is_anonymous() {
    let (secret, public) = keypair(5);
    let (auth, _keys) = verifier(FakeKeys::new(Some(public)));

    let mut claims = claims();
    claims["lxm"] = json!("space.roomy.space.getSpaces");

    assert!(caller(&auth, &bearer(&jwt(&secret, &claims)))
        .await
        .is_none());
}

#[tokio::test]
async fn an_expired_token_is_anonymous() {
    let (secret, public) = keypair(6);
    let (auth, _keys) = verifier(FakeKeys::new(Some(public)));

    let mut claims = claims();
    claims["exp"] = json!(now() - 1);

    assert!(caller(&auth, &bearer(&jwt(&secret, &claims)))
        .await
        .is_none());
}

#[tokio::test]
async fn a_tampered_token_is_anonymous() {
    let (secret, public) = keypair(7);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    // The payload says one thing; the signature is over another.
    let tampered = jwt(&secret, &claims());
    let mut claims = claims();
    claims["sub"] = json!("did:plc:mallory");
    let mut parts: Vec<&str> = tampered.split('.').collect();
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    parts[1] = &payload;
    let tampered = parts.join(".");

    assert!(caller(&auth, &bearer(&tampered)).await.is_none());
    // A signature that does not verify is retried once against a refreshed
    // document, in case the key rotated.
    assert_eq!(
        keys.calls(),
        vec![(PDS_DID.to_owned(), false), (PDS_DID.to_owned(), true)]
    );
}

#[tokio::test]
async fn an_unresolvable_issuer_is_anonymous() {
    let (secret, _public) = keypair(8);
    let (auth, keys) = verifier(FakeKeys::new(None));

    assert!(caller(&auth, &bearer(&jwt(&secret, &claims())))
        .await
        .is_none());
    // Unresolved once, then retried once with a refresh.
    assert_eq!(
        keys.calls(),
        vec![(PDS_DID.to_owned(), false), (PDS_DID.to_owned(), true)]
    );
}

#[tokio::test]
async fn a_request_without_credentials_is_anonymous() {
    let (_secret, public) = keypair(9);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    assert!(caller(&auth, &HeaderMap::new()).await.is_none());

    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Basic dXNlcjpwYXNz"),
    );
    assert!(caller(&auth, &headers).await.is_none());
    assert!(keys.calls().is_empty());
}

#[tokio::test]
async fn a_bearer_token_that_is_not_a_jwt_is_anonymous() {
    let (_secret, public) = keypair(10);
    let (auth, keys) = verifier(FakeKeys::new(Some(public)));

    assert!(caller(&auth, &bearer("not-a-jwt")).await.is_none());
    assert!(caller(&auth, &bearer("a.b.c")).await.is_none());
    assert!(keys.calls().is_empty());
}

#[tokio::test]
async fn a_rotated_key_verifies_after_a_refresh() {
    // The cached document still names key A; the PDS now signs with key B.
    let (_old_secret, old_public) = keypair(11);
    let (new_secret, new_public) = keypair(12);
    let (auth, keys) = verifier(FakeKeys::rotating(Some(old_public), new_public));

    let caller = caller(&auth, &bearer(&jwt(&new_secret, &claims()))).await;

    assert_eq!(caller.as_deref(), Some(USER_DID));
    assert_eq!(
        keys.calls(),
        vec![(PDS_DID.to_owned(), false), (PDS_DID.to_owned(), true)]
    );
}

#[tokio::test]
async fn a_token_signed_by_no_published_key_is_anonymous() {
    let (_published, published) = keypair(13);
    let (impostor, _impostor_public) = keypair(14);
    let (auth, _keys) = verifier(FakeKeys::new(Some(published)));

    assert!(caller(&auth, &bearer(&jwt(&impostor, &claims())))
        .await
        .is_none());
}
