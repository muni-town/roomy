//! The appservice HTTP server: what the homeserver calls.
//!
//! Two endpoints matter:
//!
//! * `PUT /_matrix/app/v1/transactions/{txnId}` — the homeserver pushes PDUs and
//!   EDUs here. The `hs_token` in the query string is verified before anything is
//!   read; without that check the endpoint is an open write into Roomy.
//! * `GET /_matrix/app/v1/ping` — the homeserver's registration check.
//!
//! The `/transactions` handler acknowledges *after* the events are accepted for
//! processing, not after they are relayed: a homeserver retries an unacknowledged
//! transaction, and holding the response for a slow appserver round-trip would
//! produce a retry storm. Delivery to Roomy is the durable outbox's job.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use bridge_core::TxnId;
use matrix_adapter::transaction::TransactionHandler;
use parking_lot::Mutex;
use serde::Deserialize;

use crate::admin::{routes as admin_routes, AdminState, ADMIN_PREFIX};

/// Shared state for the appservice server.
#[derive(Clone)]
pub struct ServerState {
    pub admin: AdminState,
    /// The registration this server answers for. Only a started appservice
    /// carries the tokens the transaction check needs, so a server cannot be
    /// built before they exist.
    pub appservice: matrix_adapter::Appservice<matrix_adapter::Running>,
    /// Idempotency for retried transactions.
    pub transactions: Arc<Mutex<TransactionHandler>>,
    /// Where accepted transactions go.
    pub relay: Arc<dyn TransactionRelay>,
    /// Records every transaction body, which is the evidence the capability
    /// probe reports from. A homeserver's `/versions` says nothing about the
    /// MSCs an appservice needs, so the bridge measures what it is actually
    /// sent.
    pub observer: matrix_adapter::TransactionObserver,
    /// The bridge device, when encryption is running. Inbound ciphertext is
    /// decrypted here, before anything is translated.
    #[cfg(feature = "e2ee")]
    pub crypto: Option<Arc<matrix_adapter::CryptoMachine>>,
}

/// What happens to an accepted transaction.
///
/// A trait so the server can be tested without a live appserver, and so the
/// supervisor owns delivery policy rather than the HTTP layer.
pub trait TransactionRelay: Send + Sync {
    /// Accept the events in a transaction for relay.
    fn relay(&self, transaction: matrix_adapter::transaction::Transaction);

    /// Accept the to-device messages in a transaction, which carry room keys.
    fn relay_to_device(&self, messages: Vec<matrix_adapter::transaction::ToDeviceMessage>);

    /// Accept a transaction whose encrypted events are to be decrypted first.
    ///
    /// Boxed rather than `async fn`: the relay is held behind `Arc<dyn …>`, and
    /// a return-position `impl Future` in a trait is not dyn-compatible.
    #[cfg(feature = "e2ee")]
    fn relay_decrypted<'a>(
        &'a self,
        transaction: matrix_adapter::transaction::Transaction,
        crypto: &'a matrix_adapter::CryptoMachine,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;
}

/// A relay that discards everything, for tests that exercise the HTTP layer
/// without a supervisor behind it.
#[cfg(test)]
pub struct NullRelay;

#[cfg(test)]
impl TransactionRelay for NullRelay {
    fn relay(&self, _transaction: matrix_adapter::transaction::Transaction) {}
    fn relay_to_device(&self, _messages: Vec<matrix_adapter::transaction::ToDeviceMessage>) {}
    #[cfg(feature = "e2ee")]
    fn relay_decrypted<'a>(
        &'a self,
        _transaction: matrix_adapter::transaction::Transaction,
        _crypto: &'a matrix_adapter::CryptoMachine,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {})
    }
}

/// Build the full router: the appservice endpoints and the admin API.
///
/// The admin routes are nested under [`ADMIN_PREFIX`], so `/_roomy/admin/v1`
/// is the path a client calls. Merging them at the root — which is what this
/// did — serves `/health` and `/bridges` instead, and every documented URL
/// 404s. Nesting is sound here because the admin router carries its own state
/// (`AdminState`), so the outer router's state never has to be threaded into it.
pub fn router(state: ServerState) -> Router {
    let admin = admin_routes(state.admin.clone());
    Router::new()
        .route("/_matrix/app/v1/transactions/{txn_id}", put(transaction))
        .route("/_matrix/app/v1/ping", get(ping))
        .route("/_matrix/app/v1/users/{user_id}", get(query_user))
        .route("/_matrix/app/v1/rooms/{room_alias}", get(query_room))
        .with_state(state)
        .nest(ADMIN_PREFIX, admin)
}

#[derive(Debug, Deserialize)]
struct HsTokenQuery {
    #[serde(rename = "access_token", default)]
    access_token: Option<String>,
}

/// `PUT /_matrix/app/v1/transactions/{txnId}`
async fn transaction(
    State(state): State<ServerState>,
    Path(txn_id): Path<String>,
    Query(query): Query<HsTokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&state, &query, &headers) {
        return (StatusCode::FORBIDDEN, "bad hs_token").into_response();
    }
    // Parsed at the boundary: an empty or whitespace transaction id cannot be
    // used as an idempotency key, and acknowledging it would let a malformed
    // push bypass replay detection.
    let Ok(txn_id) = TxnId::parse(txn_id) else {
        return (StatusCode::BAD_REQUEST, "unreadable transaction id").into_response();
    };

    // Record the body before parsing it into the typed form: the capability
    // probe reads the raw key set, which the typed struct discards.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
        state.observer.observe(&value);
    }

    let transaction: matrix_adapter::transaction::Transaction = match serde_json::from_slice(&body)
    {
        Ok(transaction) => transaction,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("unreadable transaction: {error}"),
            )
                .into_response()
        }
    };

    // A retry is acknowledged and dropped: the homeserver retries precisely the
    // transactions whose acknowledgement it did not see, and processing one
    // twice would double-post every message in it.
    if state.transactions.lock().is_replay(&txn_id) {
        return (StatusCode::OK, Json(serde_json::json!({}))).into_response();
    }

    let to_device = state.transactions.lock().to_device(&transaction);
    if !to_device.is_empty() {
        state.relay.relay_to_device(to_device);
    }

    // Room keys arrive as to-device messages, so they must be ingested before
    // this transaction's ciphertext is read — the key for an event is often in
    // the same batch that carries the event.
    #[cfg(feature = "e2ee")]
    if let Some(crypto) = &state.crypto {
        let payloads: Vec<serde_json::Value> = to_device_payloads(&transaction);
        match crypto.receive_to_device(&payloads).await {
            Ok(0) => {}
            Ok(count) => tracing::debug!(count, "ingested to-device messages"),
            Err(error) => tracing::warn!(%error, "could not ingest to-device messages"),
        }
        state.relay.relay_decrypted(transaction, crypto).await;
    } else {
        state.relay.relay(transaction);
    }
    #[cfg(not(feature = "e2ee"))]
    state.relay.relay(transaction);

    (StatusCode::OK, Json(serde_json::json!({}))).into_response()
}

/// `GET /_matrix/app/v1/ping`
async fn ping(State(state): State<ServerState>, Query(query): Query<HsTokenQuery>) -> Response {
    if query
        .access_token
        .as_deref()
        .is_none_or(|token| !state.appservice.verifies_hs_token(token))
    {
        return (StatusCode::FORBIDDEN, "bad hs_token").into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({}))).into_response()
}

/// `GET /_matrix/app/v1/users/{userId}` — whether a user exists.
async fn query_user(Path(user_id): Path<String>) -> Response {
    // Every ghost the bridge mints is a real user, and the bridge does not
    // create users it has not minted, so this reports existence only for the
    // namespace it owns. A `404` for anything else is what the spec expects.
    let owned = user_id.starts_with('@') && user_id.contains("_roomy_");
    if owned {
        (StatusCode::OK, Json(serde_json::json!({}))).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({}))).into_response()
    }
}

/// `GET /_matrix/app/v1/rooms/{roomAlias}` — whether an alias resolves here.
async fn query_room(Path(room_alias): Path<String>) -> Response {
    // The bridge publishes no aliases of its own; a room it bridges keeps the
    // alias it had on Matrix.
    let _ = room_alias;
    (StatusCode::NOT_FOUND, Json(serde_json::json!({}))).into_response()
}

/// Whether a request carries an acceptable `hs_token`.
///
/// The token arrives as a query parameter (the spec's form) or as a bearer, and
/// either is accepted. The comparison itself belongs to the registration, which
/// holds a parsed `HsToken` and compares it without an early exit.
fn authorized(state: &ServerState, query: &HsTokenQuery, headers: &HeaderMap) -> bool {
    let from_query = query
        .access_token
        .as_deref()
        .is_some_and(|token| state.appservice.verifies_hs_token(token));
    let from_header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| state.appservice.verifies_hs_token(token));
    from_query || from_header
}

/// The to-device messages of a transaction as raw JSON, which is the form the
/// crypto machine ingests: it parses the event envelope itself, so handing it a
/// partial struct would lose fields it checks.
#[cfg(feature = "e2ee")]
fn to_device_payloads(
    transaction: &matrix_adapter::transaction::Transaction,
) -> Vec<serde_json::Value> {
    transaction
        .to_device
        .iter()
        .filter_map(|message| serde_json::to_value(message).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_token_never_authorizes() {
        let state = state_with_token("secret");
        assert!(!authorized(
            &state,
            &HsTokenQuery { access_token: None },
            &HeaderMap::new()
        ));
    }

    #[test]
    fn a_matching_query_token_authorizes() {
        let state = state_with_token("secret");
        assert!(authorized(
            &state,
            &HsTokenQuery {
                access_token: Some("secret".into())
            },
            &HeaderMap::new()
        ));
        assert!(!authorized(
            &state,
            &HsTokenQuery {
                access_token: Some("wrong".into())
            },
            &HeaderMap::new()
        ));
    }

    fn state_with_token(token: &str) -> ServerState {
        ServerState {
            admin: test_admin_state(),
            appservice: matrix_adapter::Appservice::new(
                "roomy",
                "http://bridge:29331",
                "_roomy_bridge",
                matrix_adapter::Namespaces::default(),
            )
            .register(matrix_adapter::Tokens {
                as_token: matrix_adapter::AsToken::parse("as").unwrap(),
                hs_token: matrix_adapter::HsToken::parse(token).unwrap(),
            })
            .start(),
            transactions: Arc::new(Mutex::new(TransactionHandler::new())),
            relay: Arc::new(NullRelay),
            observer: matrix_adapter::TransactionObserver::new(),
            #[cfg(feature = "e2ee")]
            crypto: None,
        }
    }

    fn test_admin_state() -> AdminState {
        let db = Arc::new(parking_lot::Mutex::new(
            crate::db::BridgeDb::open_in_memory().unwrap(),
        ));
        let appserver = unreachable_appserver();
        let homeserver = Arc::new(matrix_adapter::HomeserverClient::new(
            "http://127.0.0.1:1",
            matrix_adapter::AsToken::parse("token").unwrap(),
        ));
        let sender: Arc<dyn matrix_adapter::MatrixSender> = Arc::new(
            matrix_adapter::HttpSender::new(matrix_adapter::HomeserverClient::new(
                "http://127.0.0.1:1",
                matrix_adapter::AsToken::parse("token").unwrap(),
            )),
        );
        let (writer, _writer_queue) = tokio::sync::mpsc::unbounded_channel();
        let (supervisor, _queue) =
            crate::supervisor::Supervisor::new(crate::supervisor::SupervisorDeps {
                db: db.clone(),
                homeserver,
                sender,
                backfill_limit: 50,
                max_depth: 2,
                ghosts: Arc::new(parking_lot::Mutex::new(matrix_adapter::GhostRegistry::new(
                    "matrix.test",
                ))),
                media: matrix_adapter::MediaStore::new(
                    "http://127.0.0.1:1",
                    matrix_adapter::AsToken::parse("token").unwrap(),
                    "http://127.0.0.1:1",
                ),
                roomy_events: writer,
                state: Arc::new(parking_lot::Mutex::new(bridge_core::BridgeState::new())),
                encryption: crate::supervisor::EncryptionSupport::Unavailable(
                    bridge_core::MissingFeature::CryptoDevice,
                ),
            });
        AdminState {
            db,
            appserver,
            auth: Arc::new(crate::auth::AdminAuth::new("did:web:bridge")),
            probe: crate::probe::ProbeState::new(),
            supervisor: Arc::new(supervisor),
            homeserver_url: "http://127.0.0.1:1".into(),
            as_token: matrix_adapter::AsToken::parse("token").unwrap(),
            max_depth: 2,
            sender_localpart: "_roomyprobe".into(),
            domain: "matrix.test".into(),
            observer: matrix_adapter::TransactionObserver::new(),
            encryption: crate::supervisor::EncryptionSupport::Unavailable(
                bridge_core::MissingFeature::CryptoDevice,
            ),
            test_did: None,
        }
    }

    fn unreachable_appserver() -> Arc<roomy_client::AppserverClient> {
        Arc::new(roomy_client::AppserverClient::new(
            "http://127.0.0.1:1",
            roomy_events::Did::parse("did:web:appserver").unwrap(),
            Arc::new(roomy_client::ServiceAuth::new("http://127.0.0.1:1")),
            "token",
        ))
    }
}
