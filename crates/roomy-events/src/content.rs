//! Event content: a mime type plus bytes, and the `Bytes` wrapper that picks
//! its wire form from the target format.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Raw bytes in whichever form the encoding wants.
///
/// Roomy's JSON encoding carries bytes as `{"$bytes": "<std base64>"}`, which
/// is what the `Serialize` impl writes. CBOR has a native byte string, so
/// [`Content::to_cbor`] writes the raw slice through `serde_bytes` instead of
/// this wrapper — encoding base64 into CBOR would cost 33% and force every
/// reader to decode it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bytes(Vec<u8>);

impl Bytes {
    /// `data`, as the value to be encoded.
    #[must_use]
    pub fn new(data: impl Into<Vec<u8>>) -> Self {
        Bytes(data.into())
    }

    /// The bytes, borrowed.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }

    /// The bytes, by value.
    #[must_use]
    pub fn into_vec(self) -> Vec<u8> {
        self.0
    }

    /// How many bytes this holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether this holds no bytes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl From<Vec<u8>> for Bytes {
    fn from(value: Vec<u8>) -> Self {
        Bytes(value)
    }
}

impl From<&[u8]> for Bytes {
    fn from(value: &[u8]) -> Self {
        Bytes(value.to_vec())
    }
}

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use base64::Engine as _;
        use serde::ser::SerializeStruct;

        let encoded = base64::engine::general_purpose::STANDARD.encode(&self.0);
        let mut state = serializer.serialize_struct("Bytes", 1)?;
        state.serialize_field("$bytes", &encoded)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use base64::Engine as _;

        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(rename = "$bytes")]
            bytes: String,
        }
        let wrapper = Wrapper::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(wrapper.bytes.as_bytes())
            .map(Bytes)
            .map_err(serde::de::Error::custom)
    }
}

/// Mime types a message body can carry.
pub mod mime {
    /// What the bridge sends: Roomy renders markdown.
    pub const MARKDOWN: &str = "text/markdown";
}

/// A message body: a mime type and its bytes.
///
/// The bridge produces `text/markdown` only. Matrix carries formatted HTML and
/// a plain-text fallback; Roomy renders markdown, so the bridge converts the
/// Matrix body to markdown once rather than sending a block tree it would have
/// to construct and the appserver would have to validate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Content {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: Bytes,
}

impl Content {
    /// A body declaring `mime_type` and carrying `data`.
    #[must_use]
    pub fn new(mime_type: impl Into<String>, data: impl Into<Vec<u8>>) -> Self {
        Self {
            mime_type: mime_type.into(),
            data: Bytes::new(data),
        }
    }

    /// A markdown body.
    #[must_use]
    pub fn markdown(text: impl AsRef<str>) -> Self {
        Self::new(mime::MARKDOWN, text.as_ref().as_bytes().to_vec())
    }

    /// The body as UTF-8 text, or `None` when the bytes are not valid UTF-8.
    pub fn as_text(&self) -> Option<&str> {
        std::str::from_utf8(self.data.as_slice()).ok()
    }

    /// Encode the CBOR form: the same shape as JSON except that `data` is a
    /// CBOR byte string rather than the `$bytes` wrapper.
    pub fn to_cbor(&self) -> Result<Vec<u8>, ciborium::ser::Error<std::io::Error>> {
        #[derive(Serialize)]
        struct CborContent<'a> {
            #[serde(rename = "mimeType")]
            mime_type: &'a str,
            data: serde_bytes::ByteBuf,
        }

        let mut out = Vec::new();
        ciborium::ser::into_writer(
            &CborContent {
                mime_type: &self.mime_type,
                data: serde_bytes::ByteBuf::from(self.data.as_slice().to_vec()),
            },
            &mut out,
        )?;
        Ok(out)
    }
}

impl fmt::Display for Content {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.as_text() {
            Some(text) => f.write_str(text),
            None => write!(f, "<{} bytes of {}>", self.data.len(), self.mime_type),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_carries_bytes_as_std_base64() {
        let json = serde_json::to_value(Content::markdown("hi")).unwrap();
        assert_eq!(json["mimeType"], "text/markdown");
        assert_eq!(json["data"]["$bytes"], "aGk=");
    }

    #[test]
    fn cbor_carries_bytes_as_a_byte_string() {
        let encoded = Content::markdown("hi").to_cbor().unwrap();
        #[derive(Deserialize)]
        struct Decoded {
            #[serde(rename = "mimeType")]
            mime_type: String,
            data: serde_bytes::ByteBuf,
        }
        let decoded: Decoded = ciborium::de::from_reader(encoded.as_slice()).unwrap();
        assert_eq!(decoded.mime_type, "text/markdown");
        assert_eq!(decoded.data.as_ref(), b"hi");
    }

    #[test]
    fn round_trips_through_json() {
        let content = Content::markdown("a body with ünicode");
        let json = serde_json::to_string(&content).unwrap();
        let back: Content = serde_json::from_str(&json).unwrap();
        assert_eq!(content, back);
    }
}
