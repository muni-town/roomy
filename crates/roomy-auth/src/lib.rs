//! Tickets and the gateway's auth decisions.
//!
//! A connection ticket is what a client presents to open a WebSocket. It has to
//! be verifiable by **any** gateway, because the client that asks for one and
//! the gateway that upgrades the socket need not be the same process — the
//! appserver's in-memory ticket map was the single-node assumption this
//! replaces.
//!
//! Three properties, and what each costs:
//!
//!  * **Self-contained.** The ticket is a signed JWT (HS256, shared secret): the
//!    claims travel with it, so verification is one HMAC and a clock read.
//!  * **Short-lived and audience-bound.** `exp` is seconds, and `aud` names the
//!    gateway set the ticket is for; a ticket for the reads API is not a ticket
//!    for the socket plane.
//!  * **One-shot.** `nonce` is unique per issue. A [`NonceStore`] records the
//!    nonces it has seen; verification fails for one it already holds. The
//!    in-memory store makes that guarantee per process, which is exact for a
//!    single gateway and a best-effort narrowing for a fleet. A shared store is
//!    the same trait.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// What a ticket asserts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TicketClaims {
    /// The caller's DID.
    pub sub: String,
    /// The gateway set the ticket is for.
    pub aud: String,
    /// Expiry, in epoch seconds.
    pub exp: u64,
    /// Issue instant, in epoch seconds.
    pub iat: u64,
    /// Unique per issue; a replay is refused by the nonce store.
    pub nonce: String,
    /// The spaces the caller may subscribe to. Empty means none: a ticket that
    /// names no space is a ticket for the reads API only.
    #[serde(default)]
    pub spaces: Vec<String>,
}

/// A ticket that could not be issued or verified.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TicketError {
    #[error("{0}")]
    Invalid(String),
    #[error("the ticket expired")]
    Expired,
    #[error("the ticket is for another audience: {0}")]
    WrongAudience(String),
    #[error("the ticket has already been used")]
    Replayed,
}

/// Records the tickets that have been presented.
pub trait NonceStore: Send + Sync {
    /// Record `nonce` until `expires_at`. Returns false when it was already
    /// recorded — the ticket is a replay.
    fn claim(&self, nonce: &str, expires_at: u64) -> bool;
}

/// The tickets presented to this process.
#[derive(Debug, Default)]
pub struct InMemoryNonces {
    seen: Mutex<HashMap<String, u64>>,
}

impl InMemoryNonces {
    pub fn new() -> Self {
        Self::default()
    }
}

impl NonceStore for InMemoryNonces {
    fn claim(&self, nonce: &str, expires_at: u64) -> bool {
        let Ok(mut seen) = self.seen.lock() else {
            return false;
        };
        let now = now_secs();
        // Drop what has expired: a nonce only has to be remembered for as long
        // as the ticket that carries it could still verify.
        seen.retain(|_, expiry| *expiry > now);
        if seen.contains_key(nonce) {
            return false;
        }
        seen.insert(nonce.to_string(), expires_at);
        true
    }
}

/// A store that remembers nothing: every ticket verifies once per process
/// anyway, because an unwatched nonce cannot be replayed into a decision.
#[derive(Debug, Default)]
pub struct NoNonces;

impl NonceStore for NoNonces {
    fn claim(&self, _nonce: &str, _expires_at: u64) -> bool {
        true
    }
}

/// Mints tickets for one audience.
pub struct TicketIssuer {
    secret: Vec<u8>,
    audience: String,
    ttl_secs: u64,
}

impl TicketIssuer {
    pub fn new(secret: impl Into<Vec<u8>>, audience: impl Into<String>, ttl_secs: u64) -> Self {
        Self {
            secret: secret.into(),
            audience: audience.into(),
            ttl_secs,
        }
    }

    /// A ticket for `did`, allowed to subscribe to `spaces`.
    pub fn issue(&self, did: &str, spaces: Vec<String>) -> Result<String, TicketError> {
        let iat = now_secs();
        let claims = TicketClaims {
            sub: did.to_string(),
            aud: self.audience.clone(),
            exp: iat + self.ttl_secs,
            iat,
            nonce: new_nonce(iat),
            spaces,
        };
        let key = jsonwebtoken::EncodingKey::from_secret(&self.secret);
        jsonwebtoken::encode(&jsonwebtoken::Header::default(), &claims, &key)
            .map_err(|error| TicketError::Invalid(error.to_string()))
    }
}

/// Verifies tickets and consumes their nonces.
pub struct TicketVerifier {
    secret: Vec<u8>,
    audience: String,
    nonces: Box<dyn NonceStore>,
}

impl TicketVerifier {
    pub fn new(
        secret: impl Into<Vec<u8>>,
        audience: impl Into<String>,
        nonces: Box<dyn NonceStore>,
    ) -> Self {
        Self {
            secret: secret.into(),
            audience: audience.into(),
            nonces,
        }
    }

    /// Verify `token` for this gateway set, consuming its nonce.
    pub fn verify(&self, token: &str) -> Result<TicketClaims, TicketError> {
        let key = jsonwebtoken::DecodingKey::from_secret(&self.secret);
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.set_audience(&[self.audience.as_str()]);
        validation.set_required_spec_claims(&["exp", "aud", "sub", "iat"]);
        // Expiry is checked below against our own clock, so the comparison is
        // one rule in one place.
        validation.validate_exp = false;
        validation.validate_aud = false;

        let data = jsonwebtoken::decode::<TicketClaims>(token, &key, &validation)
            .map_err(|error| TicketError::Invalid(error.to_string()))?;
        let claims = data.claims;

        if claims.aud != self.audience {
            return Err(TicketError::WrongAudience(claims.aud));
        }
        if claims.exp <= now_secs() {
            return Err(TicketError::Expired);
        }
        if !self.nonces.claim(&claims.nonce, claims.exp) {
            return Err(TicketError::Replayed);
        }
        Ok(claims)
    }
}

/// A ticket's decision about one space.
pub fn ticket_allows_space(claims: &TicketClaims, space: &str) -> bool {
    claims.spaces.iter().any(|allowed| allowed == space)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// A nonce that cannot collide within one process: the issue instant plus a
/// counter and the process id.
fn new_nonce(iat: u64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{iat}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issuer() -> TicketIssuer {
        TicketIssuer::new(b"secret".to_vec(), "gateway.example", 60)
    }

    fn verifier(nonces: Box<dyn NonceStore>) -> TicketVerifier {
        TicketVerifier::new(b"secret".to_vec(), "gateway.example", nonces)
    }

    #[test]
    fn a_ticket_verifies_wherever_the_secret_is_shared() {
        let token = issuer()
            .issue("did:plc:alice", vec!["did:web:space.example".into()])
            .expect("issued");
        // A different process: nothing but the secret and the audience.
        let claims = verifier(Box::new(NoNonces))
            .verify(&token)
            .expect("verifies");
        assert_eq!(claims.sub, "did:plc:alice");
        assert!(ticket_allows_space(&claims, "did:web:space.example"));
        assert!(!ticket_allows_space(&claims, "did:web:other.example"));
    }

    #[test]
    fn a_ticket_is_for_one_audience() {
        let token = issuer().issue("did:plc:alice", Vec::new()).expect("issued");
        let other = TicketVerifier::new(b"secret".to_vec(), "other.example", Box::new(NoNonces));
        assert_eq!(
            other.verify(&token),
            Err(TicketError::WrongAudience("gateway.example".into()))
        );
    }

    #[test]
    fn a_forged_signature_is_refused() {
        let token = issuer().issue("did:plc:alice", Vec::new()).expect("issued");
        let forged = format!("{}x", &token[..token.len() - 2]);
        assert!(matches!(
            verifier(Box::new(NoNonces)).verify(&forged),
            Err(TicketError::Invalid(_))
        ));
    }

    #[test]
    fn an_expired_ticket_is_refused() {
        let expired = TicketIssuer::new(b"secret".to_vec(), "gateway.example", 0);
        let token = expired.issue("did:plc:alice", Vec::new()).expect("issued");
        // `exp == iat` for a zero ttl: already expired.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert_eq!(
            verifier(Box::new(NoNonces)).verify(&token),
            Err(TicketError::Expired)
        );
    }

    #[test]
    fn a_ticket_is_one_shot() {
        let token = issuer().issue("did:plc:alice", Vec::new()).expect("issued");
        let verifier = verifier(Box::new(InMemoryNonces::new()));
        assert!(verifier.verify(&token).is_ok());
        assert_eq!(verifier.verify(&token), Err(TicketError::Replayed));
    }
}
