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

use serde::{Deserialize, Serialize};

use crate::appservice::AsToken;

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
#[derive(Debug, Clone)]
pub struct MediaStore {
    http: reqwest::Client,
    homeserver_url: String,
    as_token: AsToken,
    /// The appserver's blob proxy base, used to resolve `atblob://` refs.
    appserver_url: String,
}

impl MediaStore {
    pub fn new(
        homeserver_url: impl Into<String>,
        as_token: AsToken,
        appserver_url: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            homeserver_url: homeserver_url.into().trim_end_matches('/').to_string(),
            as_token,
            appserver_url: appserver_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// Fetch a Matrix media item.
    pub async fn download_mxc(&self, uri: &MxcUri) -> Result<MediaBytes, MediaError> {
        // Authenticated media (MSC3916) is the only path a current Synapse
        // serves; the unauthenticated v3 path answers 404.
        let url = format!(
            "{}/_matrix/client/v1/media/download/{}/{}",
            self.homeserver_url,
            uri.server(),
            uri.media_id()
        );
        let response = self
            .http
            .get(&url)
            .query(&[("allow_redirects", "true")])
            .bearer_auth(&self.as_token)
            .send()
            .await
            .map_err(|source| MediaError::Transport {
                url: url.clone(),
                source,
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(MediaError::Rejected {
                url,
                status: status.as_u16(),
                body,
            });
        }

        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let name = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_filename);

        let data = response
            .bytes()
            .await
            .map_err(|source| MediaError::Transport {
                url: uri.as_str().to_string(),
                source,
            })?
            .to_vec();

        Ok(MediaBytes {
            mime_type,
            data,
            name,
        })
    }

    /// Fetch the bytes behind a Roomy `atblob://<did>/<cid>` reference, through
    /// the appserver's blob proxy.
    pub async fn download_blob(&self, uri: &str) -> Result<MediaBytes, MediaError> {
        let rest = uri.strip_prefix("atblob://").ok_or(MediaError::NotAtblob)?;
        let (did, cid) = rest.split_once('/').ok_or(MediaError::NotAtblob)?;
        let url = format!(
            "{}/blob/{}/{}",
            self.appserver_url,
            percent_encode(did),
            percent_encode(cid)
        );

        let response =
            self.http
                .get(&url)
                .send()
                .await
                .map_err(|source| MediaError::Transport {
                    url: url.clone(),
                    source,
                })?;

        let status = response.status();
        if !status.is_success() {
            return Err(MediaError::Rejected {
                url,
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }

        let mime_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let data = response
            .bytes()
            .await
            .map_err(|source| MediaError::Transport {
                url: uri.to_string(),
                source,
            })?
            .to_vec();

        Ok(MediaBytes {
            mime_type,
            data,
            name: None,
        })
    }

    /// Upload bytes to the homeserver and return their `mxc://` URI.
    pub async fn upload_to_matrix(&self, bytes: &MediaBytes) -> Result<MxcUri, MediaError> {
        let url = format!("{}/_matrix/media/v3/upload", self.homeserver_url);
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.as_token)
            .header("content-type", &bytes.mime_type)
            .body(bytes.data.clone())
            .send()
            .await
            .map_err(|source| MediaError::Transport {
                url: url.clone(),
                source,
            })?;

        let status = response.status();
        if !status.is_success() {
            return Err(MediaError::Rejected {
                url,
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }

        #[derive(Deserialize)]
        struct Uploaded {
            #[serde(rename = "content_uri")]
            content_uri: String,
        }
        let uploaded = response
            .json::<Uploaded>()
            .await
            .map_err(|error| MediaError::Decode {
                url,
                message: error.to_string(),
            })?;
        MxcUri::parse(uploaded.content_uri)
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

/// Percent-encode a path segment.
fn percent_encode(value: &str) -> String {
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

/// Media could not be moved.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("not an mxc:// URI")]
    NotMxc,
    #[error("not an atblob:// reference")]
    NotAtblob,
    #[error("transport error fetching {url}: {source}")]
    Transport {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("{url} answered HTTP {status}: {body}")]
    Rejected {
        url: String,
        status: u16,
        body: String,
    },
    #[error("{url} returned an unreadable body: {message}")]
    Decode { url: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

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
