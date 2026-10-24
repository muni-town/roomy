//! One transport for the homeserver.
//!
//! Every call this adapter makes to a homeserver goes through the types here,
//! which own the four things no caller should repeat: the base url, the token,
//! how a request is executed, and what a failure means for a caller that must
//! decide whether to try again.
//!
//! The seam is [`Exchange`] — one request in, one answer or one failure out,
//! with no token and no policy. [`HttpExchange`] is the network adapter;
//! [`FakeHomeserver`] is the second, which is what lets the probe, the media
//! path and the crypto wire be tested without a homeserver.
//!
//! ```text
//! HomeserverClient ──typed calls──▶ Transport ──Exchange──▶ reqwest
//!                                                    └─────▶ FakeHomeserver
//! ```

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::appservice::AsToken;

mod client;
mod fake;

pub use client::{CreateRoomRequest, HomeserverClient, RoomSummary, SpaceChildContent};
pub use fake::{FakeHomeserver, FakeResponse};

#[cfg(test)]
pub(crate) use fake::fake_client;

/// The HTTP method of a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

impl Method {
    fn to_reqwest(self) -> reqwest::Method {
        match self {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Delete => reqwest::Method::DELETE,
        }
    }
}

/// What a request carries.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    None,
    Json(Value),
    Bytes { content_type: String, data: Vec<u8> },
}

/// One request, fully built: absolute url, credential, body.
///
/// The path and query are already encoded and the base url already applied, so
/// an [`Exchange`] has nothing left to decide.
#[derive(Clone, PartialEq)]
pub struct Request {
    pub method: Method,
    pub url: String,
    /// Sent as `Authorization: Bearer`. Absent for an origin that needs none.
    pub token: Option<String>,
    pub body: Body,
}

impl fmt::Debug for Request {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            // A shared secret does not go into a log line.
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("body", &self.body)
            .finish()
    }
}

/// One answer, with the headers the media path reads kept apart from the body.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub body: Vec<u8>,
}

impl Response {
    /// Read the body as `T`, or report what about it could not be read.
    ///
    /// The url is built only when it is needed: it names the failure, and a
    /// body that parses needs no name.
    fn decode<T: DeserializeOwned>(
        &self,
        url: impl FnOnce() -> String,
    ) -> Result<T, TransportError> {
        serde_json::from_slice(&self.body).map_err(|error| TransportError::Decode {
            url: url(),
            message: error.to_string(),
        })
    }
}

/// No answer arrived.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{url}: {message}")]
pub struct ExchangeError {
    pub url: String,
    pub message: String,
}

/// The network seam: one request, one answer.
///
/// An adapter executes a request and returns what came back, or fails when
/// nothing did. It presents no token and draws no conclusion — those belong to
/// [`Transport`], so that both adapters are measured by the same rules.
pub trait Exchange: Send + Sync {
    fn exchange<'a>(
        &'a self,
        request: Request,
    ) -> Pin<Box<dyn Future<Output = Result<Response, ExchangeError>> + Send + 'a>>;
}

/// The network adapter.
#[derive(Debug, Clone, Default)]
pub struct HttpExchange {
    http: reqwest::Client,
}

impl HttpExchange {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Exchange for HttpExchange {
    fn exchange<'a>(
        &'a self,
        request: Request,
    ) -> Pin<Box<dyn Future<Output = Result<Response, ExchangeError>> + Send + 'a>> {
        Box::pin(async move {
            let Request {
                method,
                url,
                token,
                body,
            } = request;

            let mut builder = self.http.request(method.to_reqwest(), &url);
            if let Some(token) = token {
                builder = builder.bearer_auth(token);
            }
            builder = match body {
                Body::None => builder,
                Body::Json(value) => builder.json(&value),
                Body::Bytes { content_type, data } => {
                    builder.header("content-type", content_type).body(data)
                }
            };

            let response = builder.send().await.map_err(|error| ExchangeError {
                url: url.clone(),
                message: error.to_string(),
            })?;
            let status = response.status().as_u16();
            let content_type = header(&response, reqwest::header::CONTENT_TYPE);
            let content_disposition = header(&response, reqwest::header::CONTENT_DISPOSITION);
            let body = response
                .bytes()
                .await
                .map_err(|error| ExchangeError {
                    url: url.clone(),
                    message: error.to_string(),
                })?
                .to_vec();

            Ok(Response {
                status,
                content_type,
                content_disposition,
                body,
            })
        })
    }
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// One origin, one exchange, and the token to present to it.
///
/// The homeserver is one of these; the appserver's blob proxy is another.
#[derive(Clone)]
pub struct Transport {
    exchange: Arc<dyn Exchange>,
    base_url: String,
    token: Option<AsToken>,
}

impl fmt::Debug for Transport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Transport")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl Transport {
    /// A transport to `base_url` over the network.
    pub fn new(base_url: impl Into<String>, token: Option<AsToken>) -> Self {
        Self::with_exchange(base_url, token, Arc::new(HttpExchange::new()))
    }

    /// A transport over an arbitrary exchange, which is how a fake homeserver
    /// takes the place of the network.
    pub fn with_exchange(
        base_url: impl Into<String>,
        token: Option<AsToken>,
        exchange: Arc<dyn Exchange>,
    ) -> Self {
        Self {
            exchange,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The exchange this transport sends through, for another origin that
    /// should share its connections.
    pub fn exchange(&self) -> Arc<dyn Exchange> {
        self.exchange.clone()
    }

    /// Execute one request and read the verdict.
    ///
    /// This is the only place the token is attached and the only place a
    /// non-2xx answer becomes an error, which is what makes the retry verdict
    /// one decision rather than one per call site.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Body,
    ) -> Result<Response, TransportError> {
        let url = format!("{}{}", self.base_url, path);
        let request = Request {
            method,
            url: url.clone(),
            token: self.token.as_ref().map(|token| token.as_str().to_string()),
            body,
        };

        let response =
            self.exchange
                .exchange(request)
                .await
                .map_err(|error| TransportError::Transport {
                    url: url.clone(),
                    message: error.message,
                })?;

        if !(200..300).contains(&response.status) {
            return Err(TransportError::Rejected {
                url,
                status: response.status,
                body: String::from_utf8_lossy(&response.body).into_owned(),
            });
        }
        Ok(response)
    }

    /// `GET` a path that is already encoded, including its query.
    pub async fn get(&self, path: &str) -> Result<Response, TransportError> {
        self.send(Method::Get, path, Body::None).await
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, TransportError> {
        let response = self.get(path).await?;
        response.decode(|| format!("{}{}", self.base_url, path))
    }

    pub async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, TransportError> {
        let response = self
            .send(Method::Post, path, Body::Json(body.clone()))
            .await?;
        response.decode(|| format!("{}{}", self.base_url, path))
    }

    pub async fn put_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, TransportError> {
        let response = self
            .send(Method::Put, path, Body::Json(body.clone()))
            .await?;
        response.decode(|| format!("{}{}", self.base_url, path))
    }

    /// Parse a successful answer with ruma's own response decoding.
    ///
    /// ruma's generated types are read by [`ruma::api::IncomingResponseExt`]
    /// rather than by `serde_json`, so the crypto wire cannot use the helpers
    /// above; the status check and the bytes stay here all the same.
    pub async fn call_ruma<T: ruma::api::IncomingResponseExt>(
        &self,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<T, TransportError> {
        let url = format!("{}{}", self.base_url, path);
        let response = self.send(method, path, Body::Json(body.clone())).await?;

        let http_response = ruma::exports::http::Response::builder()
            .status(response.status)
            .body(response.body.as_slice())
            .map_err(|error| TransportError::Decode {
                url: url.clone(),
                message: error.to_string(),
            })?;
        T::try_from_http_response(http_response).map_err(|error| TransportError::Decode {
            url,
            message: format!("{error:?}"),
        })
    }
}

/// Percent-encode one path segment or query value.
pub(crate) fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// A media item as the homeserver served it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDownload {
    pub content_type: Option<String>,
    pub content_disposition: Option<String>,
    pub data: Vec<u8>,
}

/// A homeserver call failed.
///
/// The three cases a caller must not conflate: whether an answer arrived,
/// whether that answer was a refusal, and whether the request could be put on
/// the wire at all.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// No answer arrived: DNS, connection, TLS, a dropped socket.
    #[error("could not reach {url}: {message}")]
    Transport { url: String, message: String },
    /// The homeserver answered and refused.
    ///
    /// The status is always the one it answered with. A refusal this adapter
    /// invents would be indistinguishable from a network fault, and
    /// [`TransportError::is_permanent`] would then retry it until the outbox
    /// gave up on something that could never succeed.
    #[error("{url} answered HTTP {status}: {body}")]
    Rejected {
        url: String,
        status: u16,
        body: String,
    },
    /// The call could not be expressed as a request, so no homeserver saw it.
    /// Retrying sends the same thing.
    #[error("{url}: {reason}")]
    Invalid { url: String, reason: String },
    /// The answer arrived and is not what the call asked for.
    #[error("{url} returned a body this adapter cannot read: {message}")]
    Decode { url: String, message: String },
}

impl TransportError {
    /// The status the homeserver answered with, when it answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            TransportError::Rejected { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Whether another attempt could succeed.
    ///
    /// A refusal names the request as the problem, so a repeat sends the same
    /// request and earns the same refusal — except 429, where the homeserver
    /// is asking for a later attempt rather than refusing the request. An
    /// unreachable homeserver, an unreadable answer and a local precondition
    /// are decided on their own terms.
    pub fn is_permanent(&self) -> bool {
        match self {
            TransportError::Transport { .. } => false,
            TransportError::Rejected { status, .. } => {
                (400..500).contains(status) && *status != 429
            }
            TransportError::Invalid { .. } => true,
            TransportError::Decode { .. } => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(status: u16) -> TransportError {
        TransportError::Rejected {
            url: "http://hs.test/x".into(),
            status,
            body: String::new(),
        }
    }

    #[test]
    fn a_refusal_is_permanent_unless_the_homeserver_asked_for_later() {
        for status in [400, 401, 403, 404, 409, 422] {
            assert!(
                error(status).is_permanent(),
                "HTTP {status} names the request"
            );
            assert_eq!(error(status).status(), Some(status));
        }
        // The homeserver answered; it is asking for a later attempt.
        assert!(!error(429).is_permanent());
        assert!(!error(500).is_permanent());
        assert!(!error(502).is_permanent());
    }

    #[test]
    fn a_call_that_never_reached_the_homeserver_is_retried() {
        let unreachable = TransportError::Transport {
            url: "http://hs.test/x".into(),
            message: "connection refused".into(),
        };
        assert!(!unreachable.is_permanent());
        assert_eq!(unreachable.status(), None);
    }

    #[test]
    fn a_call_this_adapter_could_not_build_is_permanent_and_carries_no_status() {
        // The redaction with no target: no homeserver ever saw it, so there is
        // no status to report and no attempt that could succeed.
        let invalid = TransportError::Invalid {
            url: "m.room.redaction for room !r:hs".into(),
            reason: "a redaction names no event".into(),
        };
        assert!(invalid.is_permanent());
        assert_eq!(invalid.status(), None);
    }

    #[test]
    fn a_path_segment_is_percent_encoded() {
        assert_eq!(percent_encode("!room:example.org"), "%21room%3Aexample.org");
        assert_eq!(percent_encode("m.room.message"), "m.room.message");
        assert_eq!(
            percent_encode("@alice:example.org"),
            "%40alice%3Aexample.org"
        );
    }
}
