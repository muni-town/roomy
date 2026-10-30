//! XRPC error envelope, identical to `src/xrpc/errors.ts`.
//!
//! `Response.json({ error, message }, { status })` in the appserver — the field
//! order here is the same, so the serialised body matches byte for byte.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// An XRPC error response: the status, the machine-readable `error` name and
/// the human-readable `message`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{error}: {message}")]
pub struct XrpcError {
    /// The HTTP status the response carries.
    pub status: u16,
    /// The XRPC error name, e.g. `InvalidRequest`.
    pub error: String,
    /// The message the client displays.
    pub message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    message: &'a str,
}

impl XrpcError {
    /// An error with an explicit status and name.
    pub fn new(status: u16, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            message: message.into(),
        }
    }

    /// A 400 `InvalidRequest`.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(400, "InvalidRequest", message)
    }

    /// A 404 `NotFound`.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NotFound", message)
    }

    /// A 403 `Forbidden`.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "Forbidden", message)
    }

    /// A 500 `InternalServerError`.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "InternalServerError", message)
    }
}

impl IntoResponse for XrpcError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = ErrorBody {
            error: &self.error,
            message: &self.message,
        };
        (status, Json(body)).into_response()
    }
}

impl From<rusqlite::Error> for XrpcError {
    fn from(err: rusqlite::Error) -> Self {
        XrpcError::internal(format!("database error: {err}"))
    }
}
