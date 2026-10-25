//! `space.roomy.embed.getLinkMetadata`.
//!
//! Rich link previews, unfurled at the edge. A page is read once with a
//! browser User-Agent, and its metadata is taken in this order:
//!
//!  1. the oEmbed endpoint the page advertises, when it advertises one and
//!     the call succeeds — structured data from the provider that publishes it;
//!  2. OpenGraph meta tags, then Twitter meta tags, then `<title>`.
//!
//! The two are merged field by field: oEmbed wins where it has a value, and
//! anything it lacks is filled from OpenGraph.
//!
//! This is best-effort by design. A URL that is not http(s), does not answer,
//! answers with an error, or yields no metadata is answered with `{}` and a
//! 200, so a link card degrades to a URL-only preview. Only a missing or empty
//! `url` parameter is a request error.
//!
//! The returned shape mirrors the SDK's `LinkEmbedData` (a subset of the
//! Lantern `EmbedV1` protocol), and its key order is the wire order: keys
//! appear as they are found, so a merged answer can list a fallback field
//! after one the oEmbed response supplied.

use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use regex::Regex;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;
use space_xrpc::params::Params;

use crate::GatewayState;

pub const NSID: &str = "space.roomy.embed.getLinkMetadata";

/// Deadline for one outbound fetch — the page or its oEmbed endpoint.
/// Link previews sit inline under the composer, so an upstream that does not
/// answer promptly yields nothing rather than a slow response. Tunable through
/// `EMBED_METADATA_TIMEOUT_MS`.
const DEFAULT_FETCH_TIMEOUT_MS: f64 = 8000.0;

/// Sites serve different, sometimes metadata-free markup to non-browser
/// agents, and some block default bot agents outright. Presenting as a browser
/// is what makes OpenGraph and oEmbed discovery yield anything on them.
const BROWSER_UA: &str = concat!(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ",
    "Chrome/124.0.0.0 Safari/537.36",
);

const ACCEPT_HTML: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/// axum handler for `GET /xrpc/space.roomy.embed.getLinkMetadata`.
pub async fn http(
    State(state): State<std::sync::Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let nsid = space_xrpc::ids::Nsid::try_from(NSID).expect("static nsid");
    let params = Params::parse(query.as_deref());
    let _context = match crate::reads::context(&state, &headers, &nsid).await {
        Ok(context) => context,
        Err(error) => return error.into_response(),
    };

    // The only request error: enrichment itself never fails a request.
    let url = match params.require_string("url") {
        Ok(url) => url,
        Err(error) => return error.into_response(),
    };

    let metadata = fetch_link_metadata(&url).await.unwrap_or_default();
    Json(metadata).into_response()
}

// ─── Wire shape ─────────────────────────────────────────────────────────

/// A metadata key, in the order the merge fills it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Key {
    Title,
    Description,
    Provider,
    Author,
    Images,
    Video,
}

impl Key {
    /// The order in which oEmbed gaps are filled from OpenGraph.
    const FILL_ORDER: [Key; 6] = [
        Key::Title,
        Key::Description,
        Key::Provider,
        Key::Author,
        Key::Images,
        Key::Video,
    ];

    fn name(self) -> &'static str {
        match self {
            Key::Title => "t",
            Key::Description => "d",
            Key::Provider => "p",
            Key::Author => "au",
            Key::Images => "imgs",
            Key::Video => "vid",
        }
    }
}

/// The publishing site or author an embed names. `n` is always present;
/// `u` only when the source supplied one.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct EmbedProvider {
    n: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    u: Option<String>,
}

/// An image or video reference. `u` is always present; dimensions only when
/// the source supplied a truthy value for them.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct EmbedMedia {
    u: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    w: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    h: Option<Value>,
}

/// A metadata value, serialised as the bare value the key names.
#[derive(Debug, Clone, PartialEq)]
enum Field {
    Text(String),
    Provider(EmbedProvider),
    Media(EmbedMedia),
    MediaList(Vec<EmbedMedia>),
}

impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Field::Text(value) => value.serialize(serializer),
            Field::Provider(value) => value.serialize(serializer),
            Field::Media(value) => value.serialize(serializer),
            Field::MediaList(value) => value.serialize(serializer),
        }
    }
}

/// Link metadata as an ordered set of present keys.
///
/// The entries are kept in the order they were found, not sorted: the wire
/// object carries insertion order, and that order is what a byte-identical
/// response has to reproduce. An entry is present only when its value is
/// truthy, which is also what makes an absent key absent rather than `null`.
#[derive(Debug, Clone, Default, PartialEq)]
struct LinkMetadata {
    entries: Vec<(Key, Field)>,
}

impl LinkMetadata {
    fn insert(&mut self, key: Key, field: Field) {
        if !self.entries.iter().any(|(existing, _)| *existing == key) {
            self.entries.push((key, field));
        }
    }

    fn get(&self, key: Key) -> Option<&Field> {
        self.entries
            .iter()
            .find(|(existing, _)| *existing == key)
            .map(|(_, field)| field)
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// This metadata with the fields it lacks filled from `fallback`.
    fn merged_with(&self, fallback: &LinkMetadata) -> LinkMetadata {
        let mut merged = self.clone();
        for key in Key::FILL_ORDER {
            if merged.get(key).is_none() {
                if let Some(field) = fallback.get(key) {
                    merged.entries.push((key, field.clone()));
                }
            }
        }
        merged
    }
}

impl Serialize for LinkMetadata {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, field) in &self.entries {
            map.serialize_entry(key.name(), field)?;
        }
        map.end()
    }
}

// ─── Fetching ───────────────────────────────────────────────────────────

fn fetch_timeout() -> Duration {
    let millis = std::env::var("EMBED_METADATA_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|millis| millis.is_finite() && *millis > 0.0)
        .unwrap_or(DEFAULT_FETCH_TIMEOUT_MS);
    Duration::from_secs_f64(millis / 1000.0)
}

/// The one client for outbound link reads. Built on first use so the process
/// holds a single connection pool, with the fetch deadline applied to every
/// request and redirects followed as a browser would.
fn http_client() -> Option<&'static reqwest::Client> {
    static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(fetch_timeout())
            .redirect(reqwest::redirect::Policy::limited(20))
            .build()
            .ok()
    });
    CLIENT.as_ref()
}

/// A page as fetch sees it: the body only when the request succeeded, and the
/// final URL after redirects so the page's own URL can be handed to oEmbed.
struct FetchedPage {
    status: u16,
    html: Option<String>,
    final_url: String,
}

/// Fetch a page as a browser, following redirects.
///
/// `status` is 0 when no response arrived (a network or timeout failure) and
/// the final URL falls back to the requested one. The body is decoded as
/// UTF-8, replacement characters and all, which is what reading a response as
/// text does.
async fn fetch_page(url: &str) -> FetchedPage {
    let Some(client) = http_client() else {
        return FetchedPage {
            status: 0,
            html: None,
            final_url: url.to_owned(),
        };
    };

    let response = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT, ACCEPT_HTML)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en,en-US;q=0.9")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return FetchedPage {
                status: 0,
                html: None,
                final_url: url.to_owned(),
            }
        }
    };

    let status = response.status().as_u16();
    let final_url = response.url().as_str().to_owned();
    let final_url = if final_url.is_empty() {
        url.to_owned()
    } else {
        final_url
    };

    if !(200..300).contains(&status) {
        return FetchedPage {
            status,
            html: None,
            final_url,
        };
    }

    match response.bytes().await {
        Ok(bytes) => FetchedPage {
            status,
            html: Some(decode_text(&bytes)),
            final_url,
        },
        Err(_) => FetchedPage {
            status: 0,
            html: None,
            final_url: url.to_owned(),
        },
    }
}

/// Decode a response body as text: UTF-8, invalid sequences replaced, and a
/// single leading byte-order mark dropped — what reading a fetch response as
/// text yields.
fn decode_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    match text.strip_prefix('\u{feff}') {
        Some(stripped) => stripped.to_owned(),
        None => text.into_owned(),
    }
}

/// Fetch an oEmbed endpoint for `url`.
///
/// `None` for any failure: no response, a non-2xx status, a body that is not
/// JSON, and any JSON value that is not an object or array (which is what a
/// JSON response can usefully be here).
async fn fetch_oembed(endpoint: &str, url: &str) -> Option<Value> {
    let client = http_client()?;
    let target = build_oembed_url(endpoint, url);
    let response = client
        .get(&target)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let value: Value = serde_json::from_str(&decode_text(&bytes)).ok()?;
    match value {
        Value::Object(_) | Value::Array(_) => Some(value),
        _ => None,
    }
}

/// Enrich `url`, or `None` when it is not http(s), cannot be fetched, or has
/// no metadata.
async fn fetch_link_metadata(url: &str) -> Option<LinkMetadata> {
    if !is_http_url(url) {
        return None;
    }

    let page = fetch_page(url).await;
    if page.status == 0 || !(200..300).contains(&page.status) {
        return None;
    }

    let html = page.html.unwrap_or_default();
    let from_og = og_to_metadata(&html);

    // Prefer the provider's own oEmbed answer; fill its gaps from OpenGraph.
    if let Some(endpoint) = extract_oembed_endpoint(&html) {
        if let Some(oembed) = fetch_oembed(&endpoint, &page.final_url).await {
            return Some(oembed_to_metadata(&oembed).merged_with(&from_og));
        }
    }

    (!from_og.is_empty()).then_some(from_og)
}

/// Whether `url` begins with an http or https scheme.
fn is_http_url(url: &str) -> bool {
    fn starts_with(bytes: &[u8], prefix: &[u8]) -> bool {
        bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
    }
    let bytes = url.as_bytes();
    starts_with(bytes, b"http://") || starts_with(bytes, b"https://")
}

// ─── HTML ───────────────────────────────────────────────────────────────

/// Decode the entities that appear in attribute values and text nodes, in the
/// same sequence so a doubly-escaped entity resolves the same way.
fn html_decode(value: &str) -> String {
    fn patterns() -> &'static [(Regex, &'static str)] {
        static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
            fn pattern(source: &str) -> Regex {
                Regex::new(source).expect("static html entity regex")
            }
            vec![
                (pattern(r"(?i)&amp;"), "&"),
                (pattern(r"(?i)&lt;"), "<"),
                (pattern(r"(?i)&gt;"), ">"),
                (pattern(r"(?i)&quot;"), "\""),
                (pattern(r"(?i)&#0*39;"), "'"),
                (pattern(r"(?i)&#x27;"), "'"),
                (pattern(r"(?i)&apos;"), "'"),
                (pattern(r"(?i)&nbsp;"), " "),
            ]
        });
        &PATTERNS
    }

    let mut decoded = value.to_owned();
    for (pattern, replacement) in patterns() {
        decoded = pattern.replace_all(&decoded, *replacement).into_owned();
    }
    decoded
}

/// Escape the characters that are special in a regular expression.
fn escape_regex(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// A meta tag's `content`, found by a `property` or `name` attribute with
/// `key`. The key attribute must precede the content attribute within the tag,
/// and the content may be single- or double-quoted.
fn extract_meta(html: &str, key: &str, attr: &str) -> Option<String> {
    let pattern = format!(
        r#"(?i)<meta[^>]*\b{attr}\s*=\s*["']{key}["'][^>]*\bcontent\s*=\s*["']([^"']*)["'][^>]*>"#,
        attr = attr,
        key = escape_regex(key),
    );
    let regex = Regex::new(&pattern).ok()?;
    let content = regex.captures(html)?.get(1)?.as_str().trim();
    (!content.is_empty()).then(|| html_decode(content))
}

/// The document's `<title>` text.
fn extract_title(html: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)<title[^>]*>([\s\S]*?)</title>").expect("static title regex")
    });
    let regex = &*PATTERN;
    let title = regex.captures(html)?.get(1)?.as_str().trim();
    (!title.is_empty()).then(|| html_decode(title))
}

/// The page's advertised oEmbed discovery endpoint, when there is one.
fn extract_oembed_endpoint(html: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)<link[^>]*rel\s*=\s*["']alternate["'][^>]*type\s*=\s*["']application/json\+oembed["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>"#,
        )
        .expect("static oembed regex")
    });
    let regex = &*PATTERN;
    let href = regex.captures(html)?.get(1)?.as_str();
    (!href.is_empty()).then(|| html_decode(href))
}

/// The `src` of the first iframe in a fragment, used for video embeds.
fn extract_iframe_src(html: &str) -> Option<String> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>"#)
            .expect("static iframe regex")
    });
    let regex = &*PATTERN;
    let src = regex.captures(html)?.get(1)?.as_str();
    (!src.is_empty()).then(|| html_decode(src))
}

/// Encode a value the way `encodeURIComponent` does: everything but the
/// unreserved characters and `!~*'()` becomes an uppercase percent escape.
fn encode_uri_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(byte as char),
            _ => {
                encoded.push('%');
                encoded.push(HEX[(byte >> 4) as usize] as char);
                encoded.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    encoded
}

/// The URL to call for an oEmbed discovery endpoint.
///
/// A discovery `href` may be a template with the page URL as a placeholder;
/// when it has none, the page URL is appended as the `url` parameter.
fn build_oembed_url(endpoint: &str, url: &str) -> String {
    let encoded = encode_uri_component(url);
    let templated = endpoint
        .replace("{URL}", &encoded)
        .replace("{url}", &encoded)
        .replace("%URL%", &encoded)
        .replace("%url%", &encoded);
    if templated != endpoint {
        return templated;
    }
    let separator = if endpoint.contains('?') { '&' } else { '?' };
    format!("{endpoint}{separator}url={encoded}")
}

// ─── Mapping ────────────────────────────────────────────────────────────

/// Truthiness of a JSON value as the metadata mapping applies it: a field is
/// present exactly when its source value is not false, zero, an empty string,
/// or null.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().map(|number| number != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A non-empty string member of an oEmbed object.
fn text_field<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Map an oEmbed response onto the metadata shape.
fn oembed_to_metadata(value: &Value) -> LinkMetadata {
    let Some(object) = value.as_object() else {
        return LinkMetadata::default();
    };
    let mut metadata = LinkMetadata::default();

    if let Some(title) = text_field(object, "title") {
        metadata.insert(Key::Title, Field::Text(html_decode(title)));
    }
    if let Some(description) = text_field(object, "description") {
        metadata.insert(Key::Description, Field::Text(html_decode(description)));
    }
    if let Some(provider_name) = text_field(object, "provider_name") {
        metadata.insert(
            Key::Provider,
            Field::Provider(EmbedProvider {
                n: html_decode(provider_name),
                u: text_field(object, "provider_url").map(str::to_owned),
            }),
        );
    }
    if let Some(author_name) = text_field(object, "author_name") {
        metadata.insert(
            Key::Author,
            Field::Provider(EmbedProvider {
                n: html_decode(author_name),
                u: text_field(object, "author_url").map(str::to_owned),
            }),
        );
    }
    if let Some(thumbnail_url) = text_field(object, "thumbnail_url") {
        let mut media = EmbedMedia {
            u: thumbnail_url.to_owned(),
            w: None,
            h: None,
        };
        if let Some(width) = object.get("thumbnail_width").filter(|value| truthy(value)) {
            media.w = Some(width.clone());
        }
        if let Some(height) = object.get("thumbnail_height").filter(|value| truthy(value)) {
            media.h = Some(height.clone());
        }
        metadata.insert(Key::Images, Field::MediaList(vec![media]));
    }
    if let Some(html) = text_field(object, "html") {
        if let Some(src) = extract_iframe_src(html) {
            metadata.insert(
                Key::Video,
                Field::Media(EmbedMedia {
                    u: src,
                    w: None,
                    h: None,
                }),
            );
        }
    }

    metadata
}

/// Map a page's OpenGraph and Twitter meta tags onto the metadata shape.
///
/// OpenGraph wins over Twitter, which wins over the document title, and each
/// field falls through independently.
fn og_to_metadata(html: &str) -> LinkMetadata {
    let property = |key: &str| extract_meta(html, key, "property");
    let name = |key: &str| extract_meta(html, key, "name");

    let title = property("og:title")
        .or_else(|| name("twitter:title"))
        .or_else(|| extract_title(html));
    let description = property("og:description")
        .or_else(|| name("twitter:description"))
        .or_else(|| name("description"));
    let image = property("og:image")
        .or_else(|| name("twitter:image"))
        .or_else(|| name("twitter:image:src"));
    let site_name = property("og:site_name");
    let video = property("og:video").or_else(|| property("og:video:url"));

    let mut metadata = LinkMetadata::default();
    if let Some(title) = title {
        metadata.insert(Key::Title, Field::Text(title));
    }
    if let Some(description) = description {
        metadata.insert(Key::Description, Field::Text(description));
    }
    if let Some(site_name) = site_name {
        metadata.insert(
            Key::Provider,
            Field::Provider(EmbedProvider {
                n: site_name,
                u: None,
            }),
        );
    }
    if let Some(image) = image {
        metadata.insert(
            Key::Images,
            Field::MediaList(vec![EmbedMedia {
                u: image,
                w: None,
                h: None,
            }]),
        );
    }
    if let Some(video) = video {
        metadata.insert(
            Key::Video,
            Field::Media(EmbedMedia {
                u: video,
                w: None,
                h: None,
            }),
        );
    }
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(metadata: &LinkMetadata) -> String {
        serde_json::to_string(metadata).unwrap()
    }

    #[test]
    fn open_graph_wins_over_twitter_and_title() {
        let html = r#"<html><head>
          <meta property="og:title" content="OG &amp; title" />
          <meta name="twitter:title" content="Twitter title" />
          <meta property="og:description" content="OG description" />
          <meta name="twitter:description" content="Twitter description" />
          <meta name="description" content="Meta description" />
          <meta property="og:image" content="https://example.com/og.png" />
          <meta name="twitter:image" content="https://example.com/twitter.png" />
          <meta property="og:site_name" content="Example" />
          <title>Document title</title>
        </head></html>"#;
        assert_eq!(
            json(&og_to_metadata(html)),
            r#"{"t":"OG & title","d":"OG description","p":{"n":"Example"},"imgs":[{"u":"https://example.com/og.png"}]}"#
        );
    }

    #[test]
    fn twitter_fills_fields_open_graph_lacks() {
        let html = r#"<meta name="twitter:title" content="Twitter title">
          <meta name="twitter:description" content="Twitter description">
          <meta name="twitter:image" content="https://example.com/twitter.png">
          <title>Document title</title>"#;
        assert_eq!(
            json(&og_to_metadata(html)),
            r#"{"t":"Twitter title","d":"Twitter description","imgs":[{"u":"https://example.com/twitter.png"}]}"#
        );
    }

    #[test]
    fn title_element_is_the_last_title_fallback() {
        let html = r#"<meta name="description" content="Meta description">
          <title>Fallback &amp; Title</title>"#;
        assert_eq!(
            json(&og_to_metadata(html)),
            r#"{"t":"Fallback & Title","d":"Meta description"}"#
        );
    }

    #[test]
    fn oembed_wins_over_open_graph_and_open_graph_fills_gaps() {
        let oembed: Value = serde_json::from_str(
            r#"{
              "title": "oEmbed title",
              "provider_name": "YouTube",
              "thumbnail_url": "https://example.com/thumb.jpg",
              "thumbnail_width": 480,
              "html": "<iframe src=\"https://www.youtube.com/embed/abc\"></iframe>"
            }"#,
        )
        .unwrap();
        let og = og_to_metadata(
            r#"<meta property="og:title" content="OG title">
               <meta property="og:description" content="OG description">"#,
        );
        assert_eq!(
            json(&oembed_to_metadata(&oembed).merged_with(&og)),
            r#"{"t":"oEmbed title","p":{"n":"YouTube"},"imgs":[{"u":"https://example.com/thumb.jpg","w":480}],"vid":{"u":"https://www.youtube.com/embed/abc"},"d":"OG description"}"#
        );
    }

    #[test]
    fn oembed_keeps_provider_author_and_media_shape() {
        let oembed: Value = serde_json::from_str(
            r#"{
              "author_name": "Author",
              "author_url": "https://example.com/author",
              "provider_name": "Site",
              "provider_url": "https://example.com",
              "thumbnail_url": "https://example.com/thumb.jpg",
              "thumbnail_width": 0,
              "thumbnail_height": 360
            }"#,
        )
        .unwrap();
        assert_eq!(
            json(&oembed_to_metadata(&oembed)),
            r#"{"p":{"n":"Site","u":"https://example.com"},"au":{"n":"Author","u":"https://example.com/author"},"imgs":[{"u":"https://example.com/thumb.jpg","h":360}]}"#
        );
    }

    #[test]
    fn metadata_with_nothing_found_is_an_empty_object() {
        assert_eq!(json(&LinkMetadata::default()), "{}");
        assert!(og_to_metadata("<html><head></head></html>").is_empty());
    }

    #[test]
    fn html_entities_decode_in_order() {
        assert_eq!(
            html_decode("Tom &amp; Jerry &#39;x&#39; &quot;y&quot; &nbsp;"),
            "Tom & Jerry 'x' \"y\"  "
        );
        assert_eq!(html_decode("&amp;lt;"), "<");
    }

    #[test]
    fn meta_tags_match_attribute_name_and_property() {
        let html = r#"<meta content="first" property="og:title">
          <meta property="og:description" content="second">"#;
        // The value attribute must follow the key attribute inside the tag.
        assert_eq!(extract_meta(html, "og:title", "property"), None);
        assert_eq!(
            extract_meta(html, "og:description", "property").as_deref(),
            Some("second")
        );
        assert_eq!(extract_meta(html, "og:description", "name"), None);
    }

    #[test]
    fn oembed_discovery_needs_alternate_json_link() {
        let html = r#"<link rel="alternate" type="application/json+oembed"
          href="https://example.com/services/oembed?format=json&amp;url={url}" />"#;
        assert_eq!(
            extract_oembed_endpoint(html).as_deref(),
            Some("https://example.com/services/oembed?format=json&url={url}")
        );
        assert_eq!(extract_oembed_endpoint("<title>none</title>"), None);
    }

    #[test]
    fn oembed_url_fills_placeholders_or_appends_the_url() {
        assert_eq!(
            build_oembed_url("https://example.com/o?url={url}", "https://a.com/x"),
            "https://example.com/o?url=https%3A%2F%2Fa.com%2Fx"
        );
        assert_eq!(
            build_oembed_url("https://example.com/o?format=json", "https://a.com/x"),
            "https://example.com/o?format=json&url=https%3A%2F%2Fa.com%2Fx"
        );
    }

    #[test]
    fn iframe_source_becomes_the_video() {
        assert_eq!(
            extract_iframe_src(r#"<iframe width="1" height="1" src="https://e.com/embed" />"#)
                .as_deref(),
            Some("https://e.com/embed")
        );
        assert_eq!(extract_iframe_src("<iframe></iframe>"), None);
    }

    #[test]
    fn only_http_urls_are_fetched() {
        assert!(is_http_url("http://example.com"));
        assert!(is_http_url("HTTPS://example.com/x"));
        assert!(!is_http_url("ftp://example.com"));
        assert!(!is_http_url("https:/example.com"));
        assert!(!is_http_url(""));
    }

    #[test]
    fn malformed_html_yields_nothing_rather_than_panicking() {
        for html in [
            "<meta property=",
            "<title>",
            "<link rel='alternate'",
            "«\u{0}»",
        ] {
            assert!(og_to_metadata(html).is_empty());
            assert_eq!(extract_oembed_endpoint(html), None);
        }
    }
}
