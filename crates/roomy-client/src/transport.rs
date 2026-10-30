//! The seam between the client and everything outside this process.
//!
//! Every call the client makes — XRPC queries and procedures, the PDS calls
//! that mint service-auth tokens and upload blobs, the sync socket — goes
//! through one [`Transport`]. The client is constructed with one, so a test
//! supplies its own adapter and exercises the whole client without a network;
//! [`HttpTransport`] is the adapter a deployment uses.
//!
//! A transport does not interpret what it carries: it executes a request and
//! returns the status and the raw body. Turning those into a value or an error
//! happens once, in [`call`] and [`call_empty`], so every NSID shares one
//! decode and one error mapping.

use std::fmt::Debug;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::error::{ClientError, TransportError};

/// A future produced by a transport method.
///
/// The trait is used behind `dyn`, so its methods return boxed futures: an
/// `async fn` in a trait is not object-safe.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An HTTP method the client uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

/// One call, built by the client and executed by a transport.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    /// The NSID being called, which every error names.
    pub nsid: &'static str,
    /// The HTTP method the call uses.
    pub method: HttpMethod,
    /// The absolute URL, query string included.
    pub url: String,
    /// Headers the call needs beyond the credential: content type, and the
    /// credential itself once the client has resolved it.
    pub headers: Vec<(&'static str, String)>,
    /// The request body, for a procedure that carries one.
    pub body: Option<Vec<u8>>,
}

/// A response as the transport observed it.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// The status code.
    pub status: u16,
    /// The status's reason phrase, when the transport knows one.
    pub reason: Option<String>,
    /// The body, undecoded.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Whether the status is a success.
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The status as an error message names it, e.g. `429 Too Many Requests`.
    #[must_use]
    pub fn status_line(&self) -> String {
        match &self.reason {
            Some(reason) if !reason.is_empty() => format!("{} {reason}", self.status),
            _ => self.status.to_string(),
        }
    }

    /// The body as text, for an error message.
    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One connection to the sync stream.
pub trait SyncSocket: Send {
    /// The next binary frame, or `None` when the peer closed the connection.
    fn next_frame(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>>;

    /// Send one text frame.
    fn send_text(&mut self, text: String) -> BoxFuture<'_, Result<(), TransportError>>;
}

/// Everything that leaves this process.
pub trait Transport: Send + Sync + Debug {
    /// Execute one HTTP call.
    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>>;

    /// Open the sync socket at `url`.
    fn connect(&self, url: &str) -> BoxFuture<'_, Result<Box<dyn SyncSocket>, TransportError>>;
}

/// Execute one call and decode its JSON body.
///
/// The one place a response becomes a value: a non-2xx status is an
/// [`ClientError::Xrpc`] naming the NSID, and a body that does not have the
/// expected shape is a [`ClientError::Decode`].
pub(crate) async fn call<T: DeserializeOwned>(
    transport: &dyn Transport,
    request: HttpRequest,
) -> Result<T, ClientError> {
    let nsid = request.nsid;
    let response = execute(transport, request).await?;
    check_status(nsid, &response)?;
    serde_json::from_slice(&response.body).map_err(|error| ClientError::Decode {
        nsid: nsid.to_string(),
        message: error.to_string(),
    })
}

/// Execute one call whose response carries nothing the client reads.
pub(crate) async fn call_empty(
    transport: &dyn Transport,
    request: HttpRequest,
) -> Result<(), ClientError> {
    let nsid = request.nsid;
    let response = execute(transport, request).await?;
    check_status(nsid, &response)
}

/// Hand a request to the transport, naming the call if it never completes.
async fn execute(
    transport: &dyn Transport,
    request: HttpRequest,
) -> Result<HttpResponse, ClientError> {
    let method = request.nsid;
    transport
        .http(request)
        .await
        .map_err(|source| ClientError::Transport {
            method: method.to_string(),
            source,
        })
}

/// Turn a rejected status into the XRPC error the caller sees.
fn check_status(nsid: &str, response: &HttpResponse) -> Result<(), ClientError> {
    if response.is_success() {
        return Ok(());
    }
    Err(ClientError::Xrpc {
        nsid: nsid.to_string(),
        error: response.status_line(),
        message: response.text(),
    })
}

/// Percent-encode a query value.
#[must_use]
pub(crate) fn urlencode(value: &str) -> String {
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

/// The live transport: `reqwest` for HTTP, `tokio-tungstenite` for the socket.
#[derive(Debug, Clone)]
pub struct HttpTransport {
    http: reqwest::Client,
}

impl HttpTransport {
    /// The live adapter: one `reqwest` client, with a bounded request timeout
    /// so a stalled peer cannot hold a caller forever.
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client builds"),
        }
    }
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for HttpTransport {
    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        Box::pin(async move {
            let mut builder = match request.method {
                HttpMethod::Get => self.http.get(&request.url),
                HttpMethod::Post => self.http.post(&request.url),
            };
            for (name, value) in &request.headers {
                builder = builder.header(*name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }

            let response = builder
                .send()
                .await
                .map_err(|error| TransportError::new(error.to_string()))?;
            let status = response.status();
            let body = response
                .bytes()
                .await
                .map_err(|error| TransportError::new(error.to_string()))?;
            Ok(HttpResponse {
                status: status.as_u16(),
                reason: status.canonical_reason().map(str::to_string),
                body: body.to_vec(),
            })
        })
    }

    fn connect(&self, url: &str) -> BoxFuture<'_, Result<Box<dyn SyncSocket>, TransportError>> {
        let url = url.to_string();
        Box::pin(async move {
            let (socket, _response) = tokio_tungstenite::connect_async(&url)
                .await
                .map_err(|error| TransportError::new(format!("could not connect: {error}")))?;
            Ok(Box::new(WebSocket { socket }) as Box<dyn SyncSocket>)
        })
    }
}

/// The live socket: a WebSocket stream, read one frame at a time.
#[derive(Debug)]
struct WebSocket {
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl SyncSocket for WebSocket {
    fn next_frame(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        Box::pin(async move {
            loop {
                match self.socket.next().await {
                    None => return Ok(None),
                    Some(Ok(WsMessage::Binary(bytes))) => return Ok(Some(bytes.to_vec())),
                    Some(Ok(WsMessage::Close(_))) => return Ok(None),
                    Some(Err(error)) => return Err(TransportError::new(error.to_string())),
                    Some(Ok(_)) => continue,
                }
            }
        })
    }

    fn send_text(&mut self, text: String) -> BoxFuture<'_, Result<(), TransportError>> {
        Box::pin(async move {
            self.socket
                .send(WsMessage::Text(text.into()))
                .await
                .map_err(|error| TransportError::new(format!("could not subscribe: {error}")))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_percent_encoded() {
        assert_eq!(
            urlencode("did:web:api.roomy.space"),
            "did%3Aweb%3Aapi.roomy.space"
        );
    }

    #[test]
    fn a_status_line_keeps_the_reason_phrase_when_there_is_one() {
        let with_reason = HttpResponse {
            status: 429,
            reason: Some("Too Many Requests".into()),
            body: Vec::new(),
        };
        assert_eq!(with_reason.status_line(), "429 Too Many Requests");

        let without = HttpResponse {
            status: 0,
            reason: None,
            body: Vec::new(),
        };
        assert_eq!(without.status_line(), "0");
    }
}
