//! Query-parameter access, mirroring `src/xrpc/params.ts`.
//!
//! The router keeps the *first* value for a repeated key, which is what
//! `URLSearchParams`-backed `params[key]` yields in the appserver.

use std::collections::HashMap;

use crate::error::XrpcError;
use crate::ids;
use crate::ids::{Cursor, Limit};

/// The query parameters of one request, as strings.
#[derive(Debug, Default, Clone)]
pub struct Params {
    values: HashMap<String, String>,
}

impl Params {
    /// Parse a raw query string, keeping the first value for a repeated key.
    pub fn parse(raw: Option<&str>) -> Self {
        let mut values = HashMap::new();
        if let Some(raw) = raw {
            for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
                values.entry(key.into_owned()).or_insert(value.into_owned());
            }
        }
        Self { values }
    }

    /// The first value for `key`, exactly as sent.
    #[must_use]
    pub fn raw(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    /// The value for `key`, or an error when it is absent or empty.
    pub fn require_string(&self, key: &str) -> Result<String, XrpcError> {
        match self.raw(key) {
            Some(value) if !value.is_empty() => Ok(value.to_owned()),
            _ => Err(XrpcError::invalid_request(format!(
                "Missing or empty required param: {key}"
            ))),
        }
    }

    /// The value for `key`, or `None` when it is absent or empty.
    #[must_use]
    pub fn optional_string(&self, key: &str) -> Option<String> {
        self.raw(key).filter(|v| !v.is_empty()).map(str::to_owned)
    }

    /// An integer param bounded by `min` and `max`, or `default` when absent.
    pub fn optional_int(
        &self,
        key: &str,
        min: Option<i64>,
        max: Option<i64>,
        default: Option<i64>,
    ) -> Result<Option<i64>, XrpcError> {
        let Some(raw) = self.optional_string(key) else {
            return Ok(default);
        };
        let n = ids::parse_js_integer(&raw, key)?;
        if let Some(min) = min {
            if n < min {
                return Err(XrpcError::invalid_request(format!(
                    "Param {key} must be ≥ {min}, got: {n}"
                )));
            }
        }
        if let Some(max) = max {
            if n > max {
                return Err(XrpcError::invalid_request(format!(
                    "Param {key} must be ≤ {max}, got: {n}"
                )));
            }
        }
        Ok(Some(n))
    }

    /// The `limit` param, bounded to `1..=Limit::MAX`.
    pub fn limit(&self, default: u32) -> Result<Limit, XrpcError> {
        Limit::parse(self.raw("limit"), 1, Limit::MAX, default)
    }

    /// The `cursor` param, or `None` when absent.
    pub fn cursor(&self) -> Result<Option<Cursor>, XrpcError> {
        self.optional_string("cursor")
            .map(Cursor::try_from)
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_value_wins() {
        let params = Params::parse(Some("a=1&a=2&b=&c=hello+w%C3%B6rld"));
        assert_eq!(params.raw("a"), Some("1"));
        assert_eq!(params.optional_string("b"), None);
        assert_eq!(params.raw("c"), Some("hello wörld"));
    }

    #[test]
    fn required_param_messages() {
        let params = Params::parse(Some("spaceId="));
        let err = params.require_string("spaceId").unwrap_err();
        assert_eq!(err.message, "Missing or empty required param: spaceId");
        assert_eq!(err.status, 400);
    }
}
