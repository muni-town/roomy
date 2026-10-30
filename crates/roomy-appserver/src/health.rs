//! A supervisor's `/health`: what each space an actor runs is doing.
//!
//! The gateway's `/health` reports the sockets it holds; this one reports the
//! materialisation loops, which a gateway-only process does not have. A follower
//! binds no other listener, so without this it has no liveness or freshness
//! signal at all — this is where an operator reads a follower's cursor, its lag,
//! and whether it is still following.
//!
//! It also reports the log sink's counters. A sink that accepts records and
//! delivers none is indistinguishable from one with nothing to say, and the
//! follower's lines are the only thing anyone can see: `loki` is the process
//! answering "are my logs arriving" about itself.
//!
//! Nothing here needs a gateway credential: the body is a read of the
//! supervisor's health snapshot and the sink's counters, so a probe observes and
//! never writes.

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use roomy_space_worker::{Health, Supervisor};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::loki::LokiSink;

/// What the listener reads: the running actors, and the sink they log through.
#[derive(Clone)]
struct Probes {
    supervisor: Arc<Supervisor>,
    loki: Option<Arc<LokiSink>>,
}

/// The listener's routes: one readiness endpoint, no authentication.
pub fn router(supervisor: Arc<Supervisor>, loki: Option<Arc<LokiSink>>) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(Probes { supervisor, loki })
}

async fn health(State(probes): State<Probes>) -> Response {
    Json(body(&probes.supervisor, probes.loki.as_deref())).into_response()
}

/// The body, assembled from the two snapshots. A process with no sink reports
/// `"loki": null` rather than a zeroed object, so "no sink" and "a sink that has
/// sent nothing" stay distinguishable.
fn body(supervisor: &Supervisor, loki: Option<&LokiSink>) -> Value {
    let spaces: Vec<Value> = supervisor.health().iter().map(Health::to_value).collect();
    json!({
        "status": "ok",
        "spaces": spaces,
        "loki": loki.map(|sink| sink.stats().to_value()),
    })
}

/// Serve a bound listener until the process stops.
///
/// The caller binds, so an address already in use fails startup rather than a
/// task nobody joins.
pub async fn serve(
    listener: TcpListener,
    supervisor: Arc<Supervisor>,
    loki: Option<Arc<LokiSink>>,
) {
    match listener.local_addr() {
        Ok(addr) => tracing::info!(address = %addr, "health listening"),
        Err(_) => tracing::info!("health listening"),
    }
    let _ = axum::serve(listener, router(supervisor, loki))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use roomy_space_worker::SupervisorConfig;

    use super::*;

    fn supervisor() -> Supervisor {
        // Nothing is opened until an actor is started, so the paths need not
        // exist: this test reads an empty snapshot.
        let dir = PathBuf::from("/nonexistent-health-test");
        Supervisor::new(SupervisorConfig {
            events_db: dir.join("events.sqlite"),
            global_db: dir.join("global.sqlite"),
            spaces_dir: dir.join("spaces"),
            holder: "test#1".into(),
            lease_ttl: Duration::from_secs(30),
            idle_poll: Duration::from_millis(250),
            batch_limit: 500,
            idle_unload: None,
            ownership: roomy_space_worker::supervisor::Ownership::Follower,
        })
    }

    #[test]
    fn the_body_carries_the_sink_counters_beside_the_spaces() {
        let supervisor = supervisor();
        let sink = LokiSink::from_url(Some("http://alloy.internal:3100/loki/api/v1/push".into()))
            .expect("a sink");

        let body = body(&supervisor, Some(&sink));
        assert_eq!(body["status"], "ok");
        assert_eq!(body["spaces"], json!([]));
        assert_eq!(
            body["loki"],
            json!({ "sent": 0, "failed": 0, "dropped": 0, "retrying": false })
        );
    }

    #[test]
    fn a_process_with_no_sink_reports_null_rather_than_zeros() {
        let body = body(&supervisor(), None);
        assert_eq!(body["loki"], Value::Null);
        assert_eq!(body["status"], "ok");
    }
}
