//! The response cache: a caller's answer, for a short while.
//!
//! A read is cached under `(nsid, canonical params, caller DID)`. The caller is
//! part of the key because the answer is not the same for two callers — unread
//! counts, access, and the viewer's own reaction all depend on who asked. The
//! params are canonicalised (sorted, empty values dropped) so two spellings of
//! one request share an entry.
//!
//! **TTL is the correctness bound.** A signal evicts the entries for its space,
//! which is what makes a cache hit fresh rather than merely young; but a signal
//! may be dropped — they are advisory — so every entry also expires. The TTL is
//! therefore a bound on staleness, never a hint.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::task::JoinHandle;

use crate::GatewayState;

/// One request, as the cache sees it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub nsid: String,
    /// Sorted `key=value` pairs, empty values dropped.
    pub params: String,
    /// The caller's DID; `None` is an anonymous request, which is its own key.
    pub caller: Option<String>,
    /// The space the request names, for signal-driven eviction. `None` when the
    /// request is not about one space.
    pub space: Option<String>,
}

impl CacheKey {
    /// The key for one request. `params` is whatever the query string parsed to.
    pub fn new(
        nsid: &str,
        params: &[(String, String)],
        caller: Option<&str>,
        space: Option<&str>,
    ) -> Self {
        let mut pairs: Vec<(String, String)> = params
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .cloned()
            .collect();
        pairs.sort();
        Self {
            nsid: nsid.to_string(),
            params: pairs
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join("&"),
            caller: caller.map(str::to_string),
            space: space.map(str::to_string),
        }
    }
}

/// A stored answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug)]
struct Entry {
    response: CachedResponse,
    expires_at: Instant,
}

/// The cache.
#[derive(Debug)]
pub struct ResponseCache {
    ttl: Duration,
    entries: Mutex<HashMap<CacheKey, Entry>>,
}

impl ResponseCache {
    /// An empty cache whose entries live for `ttl`.
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// How long a stored answer is served for.
    #[must_use]
    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    /// The stored answer, if one is there and still inside its TTL.
    pub fn get(&self, key: &CacheKey) -> Option<CachedResponse> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.get(key)?;
        if entry.expires_at <= Instant::now() {
            entries.remove(key);
            return None;
        }
        Some(entry.response.clone())
    }

    /// Store an answer. Only successful answers are worth keeping: caching an
    /// error would make a transient failure outlive itself.
    pub fn put(&self, key: CacheKey, response: CachedResponse) {
        if !(200..300).contains(&response.status) {
            return;
        }
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.insert(
            key,
            Entry {
                response,
                expires_at: Instant::now() + self.ttl,
            },
        );
    }

    /// Drop every entry a change to `space` could have invalidated.
    ///
    /// That is the entries naming `space` — and the entries naming no space at
    /// all, which are the ones keyed by a room or message id. Attributing those
    /// to a space would need the registry's index on the eviction path, so they
    /// are dropped instead: the cost of a miss is a read, the cost of a stale hit
    /// is a wrong answer.
    pub fn invalidate_space(&self, space: &str) -> usize {
        let Ok(mut entries) = self.entries.lock() else {
            return 0;
        };
        let before = entries.len();
        entries.retain(|key, _| match key.space.as_deref() {
            Some(known) => known != space,
            None => false,
        });
        before - entries.len()
    }

    /// How many entries are held, expired ones included.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }

    /// Whether the cache holds no entry at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(body: &str) -> CachedResponse {
        CachedResponse {
            status: 200,
            content_type: "application/json".into(),
            body: body.as_bytes().to_vec(),
        }
    }

    fn key(params: &[(&str, &str)], caller: Option<&str>, space: Option<&str>) -> CacheKey {
        let params: Vec<(String, String)> = params
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        CacheKey::new("space.roomy.room.getMessages", &params, caller, space)
    }

    #[test]
    fn a_stored_answer_is_returned_inside_its_ttl() {
        let cache = ResponseCache::new(Duration::from_secs(5));
        let key = key(
            &[("roomId", "01ABC")],
            Some("did:plc:alice"),
            Some("did:web:s"),
        );
        cache.put(key.clone(), response("{\"messages\":[]}"));
        assert_eq!(cache.get(&key), Some(response("{\"messages\":[]}")));
    }

    #[test]
    fn the_caller_is_part_of_the_key() {
        let cache = ResponseCache::new(Duration::from_secs(5));
        let alice = key(
            &[("roomId", "01ABC")],
            Some("did:plc:alice"),
            Some("did:web:s"),
        );
        let bob = key(
            &[("roomId", "01ABC")],
            Some("did:plc:bob"),
            Some("did:web:s"),
        );
        cache.put(alice.clone(), response("alice"));
        assert_eq!(cache.get(&bob), None);
    }

    #[test]
    fn two_spellings_of_one_request_share_an_entry() {
        let a = key(
            &[("roomId", "01ABC"), ("limit", "10")],
            Some("did:plc:a"),
            None,
        );
        let b = key(
            &[("limit", "10"), ("roomId", "01ABC")],
            Some("did:plc:a"),
            None,
        );
        assert_eq!(a, b);
        // An empty value is not a parameter.
        let c = key(
            &[("roomId", "01ABC"), ("limit", "10"), ("cursor", "")],
            Some("did:plc:a"),
            None,
        );
        assert_eq!(a, c);
    }

    #[test]
    fn a_signal_evicts_its_own_space_and_the_entries_it_cannot_attribute() {
        let cache = ResponseCache::new(Duration::from_secs(60));
        let one = key(&[("spaceId", "did:web:one")], None, Some("did:web:one"));
        let two = key(&[("spaceId", "did:web:two")], None, Some("did:web:two"));
        // An entry keyed by a room id names no space.
        let room = key(&[("roomId", "01ABC")], None, None);
        cache.put(one.clone(), response("one"));
        cache.put(two.clone(), response("two"));
        cache.put(room.clone(), response("room"));
        assert_eq!(cache.invalidate_space("did:web:one"), 2);
        assert_eq!(cache.get(&one), None);
        assert_eq!(cache.get(&room), None);
        assert_eq!(cache.get(&two), Some(response("two")));
    }

    #[test]
    fn an_expired_entry_is_not_returned() {
        let cache = ResponseCache::new(Duration::from_millis(1));
        let key = key(&[("roomId", "01ABC")], None, None);
        cache.put(key.clone(), response("stale"));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(cache.get(&key), None);
    }

    #[test]
    fn an_error_is_not_cached() {
        let cache = ResponseCache::new(Duration::from_secs(60));
        let key = key(&[("roomId", "01ABC")], None, None);
        cache.put(
            key.clone(),
            CachedResponse {
                status: 404,
                content_type: "application/json".into(),
                body: b"no".to_vec(),
            },
        );
        assert_eq!(cache.get(&key), None);
        assert!(cache.is_empty());
    }
}

/// The middleware: serve a repeated read from the cache, and store a fresh one.
pub mod middleware {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::extract::{Request, State};
    use axum::http::{header, HeaderValue, StatusCode};
    use axum::middleware::Next;
    use axum::response::{IntoResponse, Response};

    use crate::cache::{CacheKey, CachedResponse};
    use crate::GatewayState;

    pub async fn cached(
        State(state): State<Arc<GatewayState>>,
        request: Request,
        next: Next,
    ) -> Response {
        use http_body_util::BodyExt;

        if request.method() != axum::http::Method::GET {
            return next.run(request).await;
        }
        let nsid = request
            .uri()
            .path()
            .strip_prefix("/xrpc/")
            .unwrap_or_default()
            .to_string();
        let mut params: Vec<(String, String)> =
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
        params.sort();
        let caller = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .or_else(|| {
                request
                    .headers()
                    .get("x-test-did")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            });
        let space = params
            .iter()
            .find(|(key, _)| key == "spaceId")
            .map(|(_, value)| value.clone());
        let key = CacheKey::new(&nsid, &params, caller.as_deref(), space.as_deref());

        if let Some(cached) = state.cache.get(&key) {
            let mut response = Response::new(Body::from(cached.body));
            *response.status_mut() = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            if let Ok(value) = HeaderValue::from_str(&cached.content_type) {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            return response;
        }

        let response = next.run(request).await;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let (parts, body) = response.into_parts();
        let Ok(collected) = body.collect().await else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        let bytes = collected.to_bytes().to_vec();
        state.cache.put(
            key,
            CachedResponse {
                status,
                content_type,
                body: bytes.clone(),
            },
        );
        Response::from_parts(parts, Body::from(bytes))
    }
}

/// Evict cache entries as signals arrive.
///
/// Advisory signals only shorten a wait; the TTL is what bounds staleness, so a
/// dropped signal costs freshness and never correctness.
pub fn spawn_eviction(state: Arc<GatewayState>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut signals = state.signals.subscribe();
        loop {
            match signals.recv().await {
                Ok(signal) => {
                    state.cache.invalidate_space(signal.space.as_str());
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    })
}
