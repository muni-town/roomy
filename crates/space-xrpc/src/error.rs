//! XRPC error envelope, identical to `src/xrpc/errors.ts`.
//!
//! `Response.json({ error, message }, { status })` in the appserver — the field
//! order here is the same, so the serialised body matches byte for byte.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{error}: {message}")]
pub struct XrpcError {
    pub status: u16,
    pub error: String,
    pub message: String,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    message: &'a str,
}

impl XrpcError {
    pub fn new(status: u16, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            error: error.into(),
            message: message.into(),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(400, "InvalidRequest", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "NotFound", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "Forbidden", message)
    }

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
