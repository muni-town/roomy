//! Errors the client surfaces.

use thiserror::Error;

/// A call that never produced a response.
///
/// It carries a message rather than the HTTP library's error type because
/// every adapter constructs it — the live transport and a test's in equal
/// measure — and only the live one has a library error to wrap.
#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct TransportError {
    message: String,
}

impl TransportError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Something the appserver or the PDS rejected, or a transport failure.
#[derive(Debug, Error)]
pub enum ClientError {
    /// The HTTP call failed below the protocol.
    #[error("transport error calling {method}: {source}")]
    Transport {
        method: String,
        #[source]
        source: TransportError,
    },

    /// The appserver answered with an XRPC error.
    #[error("{nsid} rejected the call: {error} ({message})")]
    Xrpc {
        nsid: String,
        error: String,
        message: String,
    },

    /// The call needed a token and the PDS refused to mint one.
    #[error("could not obtain a service-auth token for {aud}: {reason}")]
    ServiceAuth { aud: String, reason: String },

    /// A response body did not have the shape the caller expects.
    #[error("unexpected response from {nsid}: {message}")]
    Decode { nsid: String, message: String },

    /// The sync socket closed, or a frame was not decodable.
    #[error("sync socket error: {0}")]
    Sync(String),

    /// The batch exceeded the appserver's cap.
    #[error("batch of {count} events exceeds the appserver cap of {max}")]
    BatchTooLarge { count: usize, max: usize },
}
