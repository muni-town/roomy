//! Media: `mxc://` references in, bytes out, and back.
//!
//! Attachments cross the bridge as bytes: a Matrix file is downloaded, uploaded
//! to the bridge account's PDS as a blob, and referenced from Roomy as
//! `atblob://<bridge did>/<cid>`. The reverse fetches the `atblob://` ref through
//! the appserver's blob proxy and uploads it to the homeserver as `mxc://`.
//!
//! Neither side is passed as a URL to the other, because neither can fetch the
//! other's authenticated media — both proxies require credentials the receiving
//! platform does not have.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::appservice::AsToken;
use crate::transport::{
    percent_encode, Exchange, HomeserverClient, HttpExchange, Transport, TransportError,
};

/// A Matrix content URI, `mxc://<server>/<media id>`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MxcUri(String);

impl MxcUri {
    /// Parse an `mxc://` URI.
    pub fn parse(value: impl Into<String>) -> Result<Self, MediaError> {
        let value = value.into();
        let rest = value.strip_prefix("mxc://").ok_or(MediaError::NotMxc)?;
        let mut parts = rest.splitn(2, '/');
        let server = parts.next().unwrap_or("");
        let media_id = parts.next().unwrap_or("");
        if server.is_empty() || media_id.is_empty() {
            return Err(MediaError::NotMxc);
        }
        Ok(MxcUri(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The server half.
    pub fn server(&self) -> &str {
        self.0
            .trim_start_matches("mxc://")
            .split_once('/')
            .map(|(server, _)| server)
            .unwrap_or("")
    }

    /// The media-id half.
    pub fn media_id(&self) -> &str {
        self.0
            .trim_start_matches("mxc://")
            .split_once('/')
            .map(|(_, id)| id)
            .unwrap_or("")
    }
}

impl std::fmt::Display for MxcUri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A fetched attachment, ready to upload on the other side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaBytes {
    pub mime_type: String,
    pub data: Vec<u8>,
    pub name: Option<String>,
}

/// Downloads and uploads media.
///
/// Two origins are involved — the homeserver, which holds `mxc://` items, and
/// the appserver's blob proxy, which holds the bytes a Roomy attachment
/// references — and both speak through the same exchange. The bridge holds one
/// connection pool, and a failure on either side is classified in one place.
#[derive(Debug, Clone)]
pub struct MediaStore {
    homeserver: HomeserverClient,
    /// The appserver's blob proxy, which takes no token.
    proxy: Transport,
}

impl MediaStore {
    pub fn new(
        homeserver_url: impl Into<String>,
        as_token: AsToken,
        appserver_url: impl Into<String>,
    ) -> Self {
        Self::with_exchange(
            homeserver_url,
            as_token,
            appserver_url,
            Arc::new(HttpExchange::new()),
        )
    }

    /// A store over an arbitrary exchange, which is how a fake homeserver takes
    /// the place of the network.
    pub fn with_exchange(
        homeserver_url: impl Into<String>,
        as_token: AsToken,
        appserver_url: impl Into<String>,
        exchange: Arc<dyn Exchange>,
    ) -> Self {
        Self {
            homeserver: HomeserverClient::with_exchange(homeserver_url, as_token, exchange.clone()),
            proxy: Transport::with_exchange(appserver_url, None, exchange),
        }
    }

    /// Fetch a Matrix media item.
    pub async fn download_mxc(&self, uri: &MxcUri) -> Result<MediaBytes, MediaError> {
        let download = self
            .homeserver
            .download_media(uri.server(), uri.media_id())
            .await?;
        Ok(MediaBytes {
            mime_type: download
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            name: download
                .content_disposition
                .as_deref()
                .and_then(parse_filename),
            data: download.data,
        })
    }

    /// Fetch the bytes behind a Roomy `atblob://<did>/<cid>` reference, through
    /// the appserver's blob proxy.
    pub async fn download_blob(&self, uri: &str) -> Result<MediaBytes, MediaError> {
        let rest = uri.strip_prefix("atblob://").ok_or(MediaError::NotAtblob)?;
        let (did, cid) = rest.split_once('/').ok_or(MediaError::NotAtblob)?;
        let response = self
            .proxy
            .get(&format!(
                "/blob/{}/{}",
                percent_encode(did),
                percent_encode(cid)
            ))
            .await?;

        Ok(MediaBytes {
            mime_type: response
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            data: response.body,
            name: None,
        })
    }

    /// Upload bytes to the homeserver and return their `mxc://` URI.
    pub async fn upload_to_matrix(&self, bytes: &MediaBytes) -> Result<MxcUri, MediaError> {
        let content_uri = self
            .homeserver
            .upload_media(&bytes.mime_type, &bytes.data)
            .await?;
        MxcUri::parse(content_uri)
    }
}

/// Extract a filename from a `Content-Disposition` header.
fn parse_filename(header: &str) -> Option<String> {
    let marker = "filename=";
    let index = header.find(marker)? + marker.len();
    let rest = &header[index..];
    let rest = rest.trim_start_matches('"');
    let rest = rest.strip_suffix('"').unwrap_or(rest);
    (!rest.is_empty()).then(|| rest.to_string())
}

/// Media could not be moved.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("not an mxc:// URI")]
    NotMxc,
    #[error("not an atblob:// reference")]
    NotAtblob,
    #[error(transparent)]
    Transport(#[from] TransportError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{FakeHomeserver, FakeResponse, Method};

    fn store(fake: &FakeHomeserver) -> MediaStore {
        let exchange: Arc<dyn Exchange> = Arc::new(fake.clone());
        MediaStore::with_exchange(
            "http://hs.test",
            AsToken::parse("as-secret").unwrap(),
            "http://app.test",
            exchange,
        )
    }

    #[tokio::test]
    async fn a_media_download_keeps_its_type_its_name_and_its_bytes() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Get,
            "/_matrix/client/v1/media/download/matrix.example.org/abc123",
            FakeResponse::bytes(200, "image/png", b"\x89PNG")
                .named("attachment; filename=\"photo.png\""),
        );

        let bytes = store(&fake)
            .download_mxc(&MxcUri::parse("mxc://matrix.example.org/abc123").unwrap())
            .await
            .expect("the fake serves the media");

        assert_eq!(bytes.mime_type, "image/png");
        assert_eq!(bytes.name.as_deref(), Some("photo.png"));
        assert_eq!(bytes.data, b"\x89PNG");

        // Authenticated media (MSC3916) is the only path a current Synapse
        // serves, and the redirect flag is part of the request.
        let request = fake.only_request();
        assert_eq!(request.token.as_deref(), Some("as-secret"));
        assert!(
            request.url.contains("allow_redirects=true"),
            "{}",
            request.url
        );
    }

    #[tokio::test]
    async fn a_refused_download_is_a_refusal_not_bytes() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Get,
            "/media/download/",
            FakeResponse::refusing(404, "M_NOT_FOUND"),
        );

        let error = store(&fake)
            .download_mxc(&MxcUri::parse("mxc://matrix.example.org/missing").unwrap())
            .await
            .expect_err("the fake refuses");

        let MediaError::Transport(refused) = error else {
            panic!("expected the homeserver's refusal, got {error}");
        };
        assert_eq!(refused.status(), Some(404));
    }

    #[tokio::test]
    async fn an_upload_returns_the_uri_the_homeserver_minted() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Post,
            "/_matrix/media/v3/upload",
            FakeResponse::ok(serde_json::json!({ "content_uri": "mxc://hs.test/uploaded" })),
        );

        let bytes = MediaBytes {
            mime_type: "text/plain".into(),
            data: b"hello".to_vec(),
            name: None,
        };
        let uri = store(&fake)
            .upload_to_matrix(&bytes)
            .await
            .expect("the fake accepts the upload");

        assert_eq!(uri.as_str(), "mxc://hs.test/uploaded");
        let request = fake.only_request();
        assert_eq!(
            request.body,
            crate::transport::Body::Bytes {
                content_type: "text/plain".into(),
                data: b"hello".to_vec(),
            }
        );
    }

    #[tokio::test]
    async fn an_atblob_reference_is_fetched_through_the_appserver_proxy() {
        let fake = FakeHomeserver::new();
        fake.route(
            Method::Get,
            "http://app.test/blob/did%3Aplc%3Aalice/bafyrei",
            FakeResponse::bytes(200, "application/pdf", b"%PDF"),
        );

        let bytes = store(&fake)
            .download_blob("atblob://did:plc:alice/bafyrei")
            .await
            .expect("the proxied blob is served");

        assert_eq!(bytes.mime_type, "application/pdf");
        assert_eq!(bytes.data, b"%PDF");
        assert_eq!(
            fake.only_request().token,
            None,
            "the appserver proxy takes no appservice token"
        );
    }

    #[tokio::test]
    async fn a_reference_that_is_not_an_atblob_is_refused_before_any_request() {
        let fake = FakeHomeserver::new();
        let error = store(&fake)
            .download_blob("https://example.org/file.png")
            .await
            .expect_err("not an atblob reference");
        assert!(matches!(error, MediaError::NotAtblob));
        assert!(fake.requests().is_empty());
    }

    #[test]
    fn an_mxc_uri_splits_into_its_parts() {
        let uri = MxcUri::parse("mxc://matrix.example.org/abc123").unwrap();
        assert_eq!(uri.server(), "matrix.example.org");
        assert_eq!(uri.media_id(), "abc123");
    }

    #[test]
    fn a_non_mxc_uri_is_rejected() {
        assert!(MxcUri::parse("https://example.org/file.png").is_err());
        assert!(MxcUri::parse("mxc://no-id").is_err());
        assert!(MxcUri::parse("mxc://server/").is_err());
    }

    #[test]
    fn a_filename_is_read_from_content_disposition() {
        assert_eq!(
            parse_filename("attachment; filename=\"photo.png\""),
            Some("photo.png".to_string())
        );
        assert_eq!(parse_filename("attachment"), None);
    }
}
