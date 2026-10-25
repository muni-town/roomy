//! The cutover's edge: which implementation answers this request.
//!
//! Two decisions, both per space and both reversible:
//!
//!  * **Who answers.** A read or write for a space this process has not taken over
//!    goes to the TypeScript appserver, which is still the production writer and the
//!    read oracle. Taking a space over is one row in the ownership table; rolling it
//!    back is the same row the other way.
//!  * **What is compared.** For a space this process does answer, a sampled request
//!    is mirrored to the TypeScript appserver after the answer has been produced.
//!    The comparison is recorded; it never changes the answer, and it never makes
//!    the caller wait for it.
//!
//! Nothing here decides correctness: the two implementations agree or they do not,
//! and the divergence log is what says which.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::cutover::{
    self, MaterialisationOwners, OwnerStore, Shadow, ShadowConfig, ShadowRequest, ShadowResponse,
};
use crate::GatewayState;

/// The name this implementation writes into the ownership table. A rollback writes
/// the TypeScript appserver's name back.
pub const RUST_NODE: &str = "rust-core";

/// Where the traffic goes while a space is still the TypeScript appserver's.
pub struct Traffic {
    /// The TypeScript appserver's base URL, without a trailing slash.
    pub ts_origin: String,
    pub client: reqwest::Client,
    pub owners: Arc<MaterialisationOwners<Box<dyn OwnerStore>>>,
    pub shadow: Arc<Shadow>,
}

impl Traffic {
    pub fn new(
        ts_origin: impl Into<String>,
        owners: Arc<MaterialisationOwners<Box<dyn OwnerStore>>>,
        shadow: ShadowConfig,
    ) -> Self {
        Self {
            ts_origin: ts_origin.into().trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                // The proxy is on the request's path: a hung upstream is a hung
                // request, so it gets a deadline rather than waiting forever.
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            owners,
            shadow: Arc::new(Shadow::new(shadow)),
        }
    }

    /// Whether this process answers `space` itself.
    pub fn owned_here(&self, space: &str) -> bool {
        match self.owners.owner(&space_did(space)) {
            // An unowned space has not been cut over: the TypeScript appserver
            // still answers it, and this process only mirrors.
            Ok(None) => false,
            Ok(Some(owner)) => owner.node == RUST_NODE,
            Err(_) => false,
        }
    }

    /// The TypeScript appserver's answer to `request`, replayed verbatim.
    pub async fn proxy(&self, request: Request) -> Response {
        let (parts, body) = request.into_parts();
        let body = match axum::body::to_bytes(body, 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(error) => {
                return (axum::http::StatusCode::BAD_REQUEST, format!("{error}")).into_response()
            }
        };
        let path = parts
            .uri
            .path_and_query()
            .map(|path| path.as_str())
            .unwrap_or("/");
        let mut upstream = self
            .client
            .request(parts.method.clone(), format!("{}{path}", self.ts_origin));
        for (name, value) in parts.headers.iter() {
            // Hop-by-hop headers describe this connection, not the request.
            if matches!(name.as_str(), "host" | "content-length" | "connection") {
                continue;
            }
            upstream = upstream.header(name.as_str(), value.as_bytes());
        }
        let upstream = match upstream.body(body.to_vec()).send().await {
            Ok(response) => response,
            Err(error) => {
                return (
                    axum::http::StatusCode::BAD_GATEWAY,
                    format!("the TypeScript appserver did not answer: {error}"),
                )
                    .into_response()
            }
        };
        let status = upstream.status();
        let body = upstream.bytes().await.unwrap_or_default();
        Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap_or_else(|error| {
                (axum::http::StatusCode::BAD_GATEWAY, format!("{error}")).into_response()
            })
    }

    /// Mirror `request` to the TypeScript appserver and record the comparison.
    ///
    /// Runs after the authoritative answer exists, from a task the caller does not
    /// await: the shadow is an observer, and an observer that could slow the request
    /// down would be measuring the wrong thing.
    pub fn mirror(
        self: &Arc<Self>,
        request: ShadowRequest,
        uri: String,
        authoritative: ShadowResponse,
    ) {
        if !self.shadow.should_sample(&request) {
            return;
        }
        let traffic = Arc::clone(self);
        tokio::spawn(async move {
            let shadow = match traffic
                .client
                .get(format!("{}{uri}", traffic.ts_origin))
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.bytes().await.unwrap_or_default();
                    ShadowResponse::new(status, body.to_vec())
                }
                Err(error) => ShadowResponse::new(599, error.to_string()),
            };
            let diverged = traffic.shadow.compare(&request, &authoritative, &shadow);
            if diverged {
                // One line per divergence, the sample kept in the log: an alert
                // needs the request that produced it, and a log line is how an
                // operator finds one.
                tracing::warn!(
                    nsid = request.nsid.as_str(),
                    "the TypeScript and Rust answers diverge"
                );
            }
        });
    }

    /// The NSIDs that have diverged at least once, sorted.
    ///
    /// A rate-based alert needs a full window of comparisons; this is the answer
    /// an operator asks for first — did the two paths ever disagree — and it is
    /// what `/metrics` reports.
    pub fn alerts(&self) -> Vec<String> {
        let mut nsids: Vec<String> = self
            .shadow
            .divergences()
            .all()
            .into_iter()
            .map(|divergence| divergence.nsid)
            .collect();
        nsids.sort();
        nsids.dedup();
        nsids
    }

    pub fn comparisons(&self) -> u64 {
        self.shadow
            .divergences()
            .all()
            .len()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

fn space_did(space: &str) -> space_core::ids::SpaceDid {
    space_core::ids::SpaceDid::parse(space.to_string()).unwrap_or_else(|_| {
        space_core::ids::SpaceDid::parse("did:web:unowned".to_string()).expect("a DID")
    })
}

/// What a request names: a space outright, or an entity the index can resolve to
/// one.
enum Naming {
    Space(String),
    Entity(String),
    Nothing,
}

/// The space a request names, from `spaceId` in the query or a body that carries
/// one, and the entity it names otherwise. A `roomId` is an entity, not a space:
/// treating the two as the same would send every room read to the wrong side of
/// the cutover.
fn named_space(request: &Request, body: &[u8]) -> Naming {
    if let Some(query) = request.uri().query() {
        if let Some(space) = query_value(query, "spaceId") {
            return Naming::Space(space);
        }
        if let Some(room) = query_value(query, "roomId") {
            return Naming::Entity(room);
        }
    }
    if !body.is_empty() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) {
            if let Some(space) = value.get("spaceId").and_then(serde_json::Value::as_str) {
                return Naming::Space(space.to_string());
            }
        }
    }
    Naming::Nothing
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name)
            .then(|| value.replace("%3A", ":"))
            .filter(|value| !value.is_empty())
    })
}

/// The edge layer: proxy what is not ours, shadow what is.
pub async fn cutover_layer(
    State(state): State<Arc<GatewayState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(traffic) = state.traffic.as_ref().map(Arc::clone) else {
        return next.run(request).await;
    };
    let nsid = request
        .uri()
        .path()
        .strip_prefix("/xrpc/")
        .unwrap_or_default()
        .to_string();
    if nsid.is_empty() {
        return next.run(request).await;
    }

    // A write names its space in the body, so the body is read before the decision
    // and put back for the handler.
    let (parts, body) = request.into_parts();
    let body = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (axum::http::StatusCode::BAD_REQUEST, format!("{error}")).into_response()
        }
    };
    // What the decision needs, taken before the request is handed on.
    let uri = parts
        .uri
        .path_and_query()
        .map(|path| path.as_str().to_string())
        .unwrap_or_default();
    let parameters = parts
        .uri
        .query()
        .map(|query| {
            query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let request = Request::from_parts(parts, Body::from(body.clone()));

    let space = match named_space(&request, &body) {
        Naming::Space(space) => Some(space),
        Naming::Entity(entity) => state.reads.spaces.space_of_entity(&entity),
        Naming::Nothing => None,
    };
    if let Some(space) = space.as_deref() {
        if !traffic.owned_here(space) {
            state
                .counters
                .proxied
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return traffic.proxy(request).await;
        }
    }

    let authoritative = next.run(request).await;
    {
        if let Some(space) = space {
            let _ = space;
            let (parts, body) = authoritative.into_parts();
            let bytes = match axum::body::to_bytes(body, 8 * 1024 * 1024).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    return (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        format!("{error}"),
                    )
                        .into_response()
                }
            };
            let shadow_request = ShadowRequest::new(nsid, parameters);
            traffic.mirror(
                shadow_request,
                uri,
                ShadowResponse::new(parts.status.as_u16(), bytes.to_vec()),
            );
            return Response::from_parts(parts, Body::from(bytes));
        }
    }
    authoritative
}

/// The comparison counts and alert state, as `/metrics` reports them.
pub fn metric_lines(traffic: &Traffic) -> Vec<(String, u64)> {
    let log = traffic.shadow.divergences();
    let compared: u64 = log.all().len() as u64;
    let alerting = traffic.alerts().len() as u64;
    vec![
        ("roomy_cutover_shadow_comparisons".to_string(), compared),
        ("roomy_cutover_shadow_alerting_nsids".to_string(), alerting),
    ]
}

/// The `cutover` module's ownership helpers, re-exported for the binary.
pub use cutover::{InMemoryOwnerStore, SqliteOwnerStore, WriteCutover, WritePath};
