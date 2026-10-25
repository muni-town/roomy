//! The gateway: HTTP, WebSocket, and the seams they compose.
//!
//! What the gateway owns, and what it deliberately hands outward:
//!
//!  * **Routing.** A request names a space — directly by `spaceId`, or through a
//!    room or message id — and the gateway resolves it to the worker that serves
//!    it ([`space_xrpc::registry`]). The per-space handlers are the worker's and
//!    are unchanged.
//!  * **Tickets.** [`roomy_auth`] mints and verifies the signed connection
//!    ticket, so any gateway can accept a socket with no process-local state.
//!  * **The connection plane.** [`roomy_sync::SessionCore`] decides who hears
//!    what; this crate is the axum skin that turns its commands into frames.
//!  * **Health and metrics.** One process's view of its spaces and sessions.
//!
//! It is the same composition whether the workers live in this process or
//! another: the embedded mode reads the same registry and the same signals as a
//! split one.

pub mod cache;
pub mod cutover;
pub mod internal;
pub mod procedures;
pub mod reads;
pub mod signals;
pub mod traffic;
pub mod ws;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use roomy_auth::{TicketIssuer, TicketVerifier};
use roomy_sync::SessionCore;
use space_xrpc::state::XrpcState;

pub use signals::GatewaySignals;

/// What the gateway is made of.
pub struct GatewayState {
    /// The per-space read router, resolving requests through the registry.
    pub reads: XrpcState,
    pub tickets: Arc<TicketIssuer>,
    pub verifier: Arc<TicketVerifier>,
    /// The connection plane. A mutex because every handler mutates it; the
    /// critical sections are map operations.
    pub sessions: Arc<Mutex<SessionCore>>,
    /// Signals from the workers in this process.
    pub signals: GatewaySignals,
    pub counters: Arc<Counters>,
    /// Answers to repeat, bounded by a TTL and evicted by signals.
    pub cache: Arc<cache::ResponseCache>,
    /// The event log, when this process accepts writes. A gateway without one
    /// is a read replica and refuses `sendEvents` rather than losing it.
    pub ingest: Option<Arc<Mutex<roomy_ingest::EventLog>>>,
    /// The service's own DID, which authorizes the narrow set of events the
    /// service may write without membership.
    pub service_did: Option<String>,
    /// Injected so a write's ordering key is a function of its inputs.
    pub clock: Arc<dyn roomy_space_worker::clock::Clock>,
    /// The event log, served to workers on other machines over `/internal/feed`.
    /// `None` in a process that neither owns the log nor relays it.
    pub feed: Option<Arc<internal::FeedService>>,
    /// Where undecided traffic goes while a space is still the TypeScript
    /// appserver's, and what is mirrored for comparison. `None` serves every space
    /// from this process.
    pub traffic: Option<Arc<traffic::Traffic>>,
    /// The secret the internal endpoints require. `None` refuses every internal
    /// call: a process that serves neither a feed nor a signal relay has no
    /// reason to accept one.
    pub internal_secret: Option<String>,
}

/// The numbers `/metrics` reports.
#[derive(Debug, Default)]
pub struct Counters {
    pub tickets_issued: AtomicU64,
    pub sessions_opened: AtomicU64,
    pub sessions_closed: AtomicU64,
    pub frames_sent: AtomicU64,
    pub signals_received: AtomicU64,
    /// Reads and writes answered by the TypeScript appserver because their space
    /// is not this implementation's yet.
    pub proxied: AtomicU64,
}

impl Counters {
    pub fn snapshot(&self) -> Vec<(String, u64)> {
        vec![
            (
                "roomy_gateway_tickets_issued".to_string(),
                self.tickets_issued.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_sessions_opened".to_string(),
                self.sessions_opened.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_sessions_closed".to_string(),
                self.sessions_closed.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_frames_sent".to_string(),
                self.frames_sent.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_signals_received".to_string(),
                self.signals_received.load(Ordering::Relaxed),
            ),
            (
                "roomy_gateway_proxied".to_string(),
                self.proxied.load(Ordering::Relaxed),
            ),
        ]
    }
}

impl GatewayState {
    pub fn new(
        reads: XrpcState,
        tickets: Arc<TicketIssuer>,
        verifier: Arc<TicketVerifier>,
        signals: GatewaySignals,
    ) -> Self {
        Self {
            reads,
            tickets,
            verifier,
            sessions: Arc::new(Mutex::new(SessionCore::new())),
            signals,
            counters: Arc::new(Counters::default()),
            cache: Arc::new(cache::ResponseCache::new(Duration::from_millis(2000))),
            ingest: None,
            service_did: None,
            clock: Arc::new(roomy_space_worker::clock::SystemClock),
            feed: None,
            traffic: None,
            internal_secret: None,
        }
    }

    /// The same gateway, accepting writes into `log` as `service_did`.
    pub fn with_ingest(
        mut self,
        log: Arc<Mutex<roomy_ingest::EventLog>>,
        service_did: Option<String>,
    ) -> Self {
        self.ingest = Some(log);
        self.service_did = service_did;
        self
    }

    /// The same gateway, serving its event log to workers on other machines.
    pub fn with_feed(mut self, feed: internal::FeedService) -> Self {
        self.feed = Some(Arc::new(feed));
        self
    }

    /// The same gateway, routing per space between this implementation and the
    /// TypeScript appserver.
    pub fn with_traffic(mut self, traffic: traffic::Traffic) -> Self {
        self.traffic = Some(Arc::new(traffic));
        self
    }

    /// The same gateway, accepting the internal endpoints' shared secret.
    pub fn with_internal_secret(mut self, secret: impl Into<String>) -> Self {
        self.internal_secret = Some(secret.into());
        self
    }

    /// The same gateway, reading an injected clock.
    pub fn with_clock(mut self, clock: Arc<dyn roomy_space_worker::clock::Clock>) -> Self {
        self.clock = clock;
        self
    }
}

impl std::fmt::Debug for GatewayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayState").finish_non_exhaustive()
    }
}

/// The gateway's routes: health, metrics, a ticket, the socket plane, and the
/// per-space reads the worker serves.
pub fn router(state: Arc<GatewayState>) -> Router {
    // The per-space reads are the worker's router, mounted as they are: the
    // gateway adds the edge, not a second implementation of the queries.
    // The per-space reads, behind the response cache: a repeated read for the
    // same caller and params is served from it until a signal for its space
    // evicts it or its TTL runs out.
    let reads =
        space_xrpc::router(state.reads.clone()).layer(axum::middleware::from_fn_with_state(
            std::sync::Arc::clone(&state),
            cache::middleware::cached,
        ));
    // The gateway's own routes first, then the worker's per-space reads. The
    // socket and ticket routes are static paths, so they win over the worker's
    // `/xrpc/{nsid}` catch-all.
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route(
            "/xrpc/space.roomy.auth.getConnectionTicket",
            post(get_connection_ticket),
        )
        .route("/xrpc/space.roomy.sync.subscribe", get(ws::subscribe))
        .route(
            "/xrpc/space.roomy.space.sendEvents",
            post(procedures::send_events::http),
        )
        .route(
            "/xrpc/space.roomy.room.updateSeen",
            post(procedures::update_seen::http),
        )
        // The owner's half of the change feed: not part of the XRPC surface, and
        // answered from the log this process holds.
        .route("/internal/feed/{space}", get(internal::feed))
        .route("/internal/signal", post(internal::signal))
        // The reads no single space can answer: a feed merged across the
        // caller's spaces, mentions hydrated per space, a profile that may
        // leave the process, and a link card fetched from its host.
        .route(
            "/xrpc/space.roomy.space.getActivityFeed",
            get(reads::activity_feed::http),
        )
        .route(
            "/xrpc/space.roomy.mention.getMentions",
            get(reads::mentions::http),
        )
        .route(
            "/xrpc/space.roomy.user.getProfile",
            get(reads::profiles::http),
        )
        .route(
            "/xrpc/space.roomy.embed.getLinkMetadata",
            get(reads::link_metadata::http),
        )
        .with_state(Arc::clone(&state))
        .merge(reads)
        // Outermost: a space the TypeScript appserver still answers is proxied
        // before any handler here sees it, and an answer produced here is mirrored
        // for comparison after it exists.
        .layer(axum::middleware::from_fn_with_state(
            state,
            traffic::cutover_layer,
        ))
}

async fn health(State(state): State<Arc<GatewayState>>) -> Response {
    let sessions = state
        .sessions
        .lock()
        .map(|sessions| sessions.sessions())
        .unwrap_or(0);
    Json(json!({
        "status": "ok",
        "sessions": sessions,
        "signals": state.signals.subscriber_count(),
    }))
    .into_response()
}

async fn metrics(State(state): State<Arc<GatewayState>>) -> Response {
    let mut body = String::new();
    let mut lines = state.counters.snapshot();
    if let Some(traffic) = &state.traffic {
        lines.extend(traffic::metric_lines(traffic));
    }
    for (name, value) in lines {
        body.push_str(&format!("# TYPE {name} counter\n{name} {value}\n"));
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        body,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct TicketQuery {
    #[serde(default)]
    spaces: Option<String>,
}

/// Mint a connection ticket for the authenticated caller.
///
/// The caller is authenticated by the same verifier the reads use, so there is
/// one way to be authenticated at this edge and not two. The spaces the ticket
/// names are the spaces its socket may subscribe to.
async fn get_connection_ticket(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    Query(query): Query<TicketQuery>,
) -> Response {
    let nsid = match space_xrpc::ids::Nsid::try_from("space.roomy.auth.getConnectionTicket") {
        Ok(nsid) => nsid,
        Err(error) => return error.into_response(),
    };
    let caller = match state.reads.verifier.verify(&headers, &nsid).await {
        Ok(caller) => caller,
        Err(error) => return error.into_response(),
    };
    let Some(did) = caller.did else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "AuthRequired", "message": "no caller" })),
        )
            .into_response();
    };
    let spaces: Vec<String> = query
        .spaces
        .map(|spaces| {
            spaces
                .split(',')
                .map(str::trim)
                .filter(|space| !space.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    match state.tickets.issue(did.as_str(), spaces.clone()) {
        Ok(ticket) => {
            state
                .counters
                .tickets_issued
                .fetch_add(1, Ordering::Relaxed);
            Json(json!({ "ticket": ticket, "spaces": spaces })).into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "TicketError", "message": error.to_string() })),
        )
            .into_response(),
    }
}
