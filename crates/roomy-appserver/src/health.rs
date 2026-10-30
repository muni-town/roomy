//! A supervisor's `/health`: what each space an actor runs is doing.
//!
//! The gateway's `/health` reports the sockets it holds; this one reports the
//! materialisation loops, which a gateway-only process does not have. A follower
//! binds no other listener, so without this it has no liveness or freshness
//! signal at all — this is where an operator reads a follower's cursor, its lag,
//! and whether it is still following.
//!
//! Nothing here needs a gateway credential: the body is a read of the
//! supervisor's health snapshot, so a probe observes and never writes.

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use roomy_space_worker::{Health, Supervisor};
use serde_json::{json, Value};
use tokio::net::TcpListener;

/// The listener's routes: one readiness endpoint, no authentication.
pub fn router(supervisor: Arc<Supervisor>) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(supervisor)
}

async fn health(State(supervisor): State<Arc<Supervisor>>) -> Response {
    let spaces: Vec<Value> = supervisor.health().iter().map(Health::to_value).collect();
    Json(json!({ "status": "ok", "spaces": spaces })).into_response()
}

/// Serve a bound listener until the process stops.
///
/// The caller binds, so an address already in use fails startup rather than a
/// task nobody joins.
pub async fn serve(listener: TcpListener, supervisor: Arc<Supervisor>) {
    match listener.local_addr() {
        Ok(addr) => tracing::info!(address = %addr, "health listening"),
        Err(_) => tracing::info!("health listening"),
    }
    let _ = axum::serve(listener, router(supervisor))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
}
