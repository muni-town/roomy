//! Caller verification.

use axum::http::{HeaderMap, HeaderValue};
use jsonwebtoken::jwk::Jwk;

use space_xrpc::ids::Nsid;
use space_xrpc::verify::{CallerVerifier, GatewayServiceAuth, TestMode};

const PUBLIC_JWK: &str = r#"{"kty":"RSA","n":"AKnjsD40JhhUR7jSzN3GjRewSCUACZnZi8mwCG68m8lRoyMKXkhcNCWtLTyJZEEWY30bJGqwDxttz0T5J9F4BnMa6cymZYtMA-zZLefC2Q9Ml3Z0gIfMzi9UTiRrfic4ZvVBZqXIZFIvlN3McxrQC7P1RUurWbUWtpYO0j-nyHHPznFuf67_81aHWXjH28rLIMLItQiNNpMP84MBo2qE_2GQfPIV84JJXqFznnzIz1D9sltvp_EShWXJ5WRGN_PP3UobbedqaLqjftW8FeiVN-9CXsSK79h7okwJre2Ohu8PvbUU_RvyNeYeKpjJw6tx-onecckVUG5Gco-fbG6kRps","e":"AQAB","alg":"RS256","kid":"test"}"#;

fn nsid() -> Nsid {
    Nsid::try_from("space.roomy.room.getMessages").unwrap()
}

#[tokio::test]
async fn test_mode_reads_the_header_and_defaults_to_anonymous() {
    let verifier = TestMode;
    let mut headers = HeaderMap::new();
    headers.insert("x-test-did", HeaderValue::from_static("did:plc:alice"));
    let caller = verifier.verify(&headers, &nsid()).await.unwrap();
    assert_eq!(caller.did.unwrap().as_str(), "did:plc:alice");

    let caller = verifier.verify(&HeaderMap::new(), &nsid()).await.unwrap();
    assert!(caller.did.is_none());

    headers.insert("x-test-did", HeaderValue::from_static("not-a-did"));
    assert!(verifier.verify(&headers, &nsid()).await.is_err());
}

#[tokio::test]
async fn gateway_requires_a_service_token() {
    let jwk: Jwk = serde_json::from_str(PUBLIC_JWK).unwrap();
    let verifier =
        GatewayServiceAuth::new("did:web:gateway.example", "did:web:worker.example", &jwk).unwrap();

    // No token is anonymous, not an error.
    let caller = verifier.verify(&HeaderMap::new(), &nsid()).await.unwrap();
    assert!(caller.did.is_none());

    // A malformed Authorization header is rejected.
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Basic abc"),
    );
    assert!(verifier.verify(&headers, &nsid()).await.is_err());

    headers.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer not-a-jwt"),
    );
    let error = verifier.verify(&headers, &nsid()).await.unwrap_err();
    assert_eq!(error.status, 401);
    assert_eq!(error.error, "InvalidToken");
}
