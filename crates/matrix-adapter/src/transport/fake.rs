//! A homeserver that answers from a script.
//!
//! This is the second [`Exchange`] adapter. Without it the seam's only tenant
//! is reqwest and nothing above it — the probe, the media path, the crypto
//! wire, the ghost join — can be tested without a live homeserver. It records
//! every request it was handed, so a test asserts the call that was made as
//! well as what came back.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;

use super::{Exchange, ExchangeError, Method, Request, Response};

/// One scripted answer.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub body: Vec<u8>,
}

impl FakeResponse {
    /// Answer `status` with a JSON body.
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            content_type: Some("application/json".to_string()),
            content_disposition: None,
            body: serde_json::to_vec(&body).expect("a scripted body serialises"),
        }
    }

    /// Answer `200` with a JSON body.
    pub fn ok(body: Value) -> Self {
        Self::json(200, body)
    }

    /// Refuse with the `errcode` a homeserver would send.
    pub fn refusing(status: u16, errcode: &str) -> Self {
        Self::json(status, serde_json::json!({ "errcode": errcode }))
    }

    /// Answer `status` with raw bytes and the media headers a download carries.
    pub fn bytes(status: u16, content_type: &str, data: &[u8]) -> Self {
        Self {
            status,
            content_type: Some(content_type.to_string()),
            content_disposition: None,
            body: data.to_vec(),
        }
    }

    /// Attach a `Content-Disposition`, which is where a media item's filename
    /// comes from.
    pub fn named(mut self, disposition: &str) -> Self {
        self.content_disposition = Some(disposition.to_string());
        self
    }
}

/// A scripted route: a method and a fragment of the url it answers.
#[derive(Debug, Clone)]
struct Route {
    method: Method,
    fragment: String,
    response: FakeResponse,
}

#[derive(Debug, Default)]
struct State {
    routes: Vec<Route>,
    requests: Vec<Request>,
}

/// A homeserver that answers from a script, and records what it was asked.
///
/// A route matches when the request's method is equal and its url contains the
/// fragment; the most recently added matching route wins, except by a route
/// added later in the same test.
///
/// A request no route matches fails as a transport error — the same shape a
/// test needs to drive the "homeserver unreachable" path.
#[derive(Debug, Clone, Default)]
pub struct FakeHomeserver {
    state: Arc<Mutex<State>>,
}

impl FakeHomeserver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Answer `method` requests whose url contains `fragment`.
    pub fn route(&self, method: Method, fragment: impl Into<String>, response: FakeResponse) {
        self.state.lock().routes.push(Route {
            method,
            fragment: fragment.into(),
            response,
        });
    }

    /// Every request the adapter sent, in order.
    pub fn requests(&self) -> Vec<Request> {
        self.state.lock().requests.clone()
    }

    /// The url of every request the adapter sent, in order.
    pub fn urls(&self) -> Vec<String> {
        self.state
            .lock()
            .requests
            .iter()
            .map(|request| request.url.clone())
            .collect()
    }

    /// The one request the adapter sent, which is what a single-call test
    /// expects.
    pub fn only_request(&self) -> Request {
        let requests = self.requests();
        assert_eq!(
            requests.len(),
            1,
            "expected exactly one request, got {:?}",
            requests.iter().map(|r| &r.url).collect::<Vec<_>>()
        );
        requests.into_iter().next().expect("one request")
    }
}

impl Exchange for FakeHomeserver {
    fn exchange<'a>(
        &'a self,
        request: Request,
    ) -> Pin<Box<dyn Future<Output = Result<Response, ExchangeError>> + Send + 'a>> {
        Box::pin(async move {
            let mut state = self.state.lock();
            state.requests.push(request.clone());

            let answer = state
                .routes
                .iter()
                .rev()
                .find(|route| {
                    route.method == request.method && request.url.contains(&route.fragment)
                })
                .map(|route| route.response.clone());

            let Some(answer) = answer else {
                return Err(ExchangeError {
                    url: request.url.clone(),
                    message: format!(
                        "no scripted answer for {:?} {}",
                        request.method, request.url
                    ),
                });
            };

            // The status is handed back as-is, even a 5xx: deciding what it
            // means is the transport's job, not the fake's.
            Ok(Response {
                status: answer.status,
                content_type: answer.content_type,
                content_disposition: answer.content_disposition,
                body: answer.body,
            })
        })
    }
}

/// A client over `fake`, authenticated as an appservice — what a test needs to
/// drive a typed call without a network.
#[cfg(test)]
pub(crate) fn fake_client(fake: &FakeHomeserver) -> super::HomeserverClient {
    super::HomeserverClient::with_exchange(
        "http://hs.test",
        crate::appservice::AsToken::parse("as-secret").expect("a test token"),
        Arc::new(fake.clone()),
    )
}
