//! The URLs a message's content names.
//!
//! A plain-text body is scanned; a rich-text body is walked for `#link` facets.
//! This is `materialization/records/effects.ts`'s rule, which is itself the
//! read path's: a link is stored where a scan of the same content would find
//! it, so the two cannot disagree about which URLs a message has.

use std::sync::LazyLock;

use regex::Regex;

/// The URL pattern, as the TypeScript rule writes it: a scheme, a host with a
/// dotted TLD, then everything up to whitespace or an angle bracket, ending on
/// a character that belongs in a URL. Surrounding angle brackets are optional.
static URL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<?(https?://)[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s<>]*[a-zA-Z0-9/]>?"#)
        .expect("the URL pattern compiles")
});

/// The unique URLs a text carries, in first-seen order.
pub fn extract_urls(text: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for found in URL_REGEX.find_iter(text) {
        let mut url = found.as_str().to_string();
        if url.starts_with('<') && url.ends_with('>') {
            url = url[1..url.len() - 1].to_string();
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            url = format!("https://{url}");
        }
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}

/// The URLs a rich-text body names: every `#link` facet's URI, over the block
/// types that carry facets.
pub fn extract_facet_urls(blocks: &serde_json::Value) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let Some(blocks) = blocks.as_array() else {
        return urls;
    };
    let mut collect = |facets: &serde_json::Value| {
        let Some(facets) = facets.as_array() else {
            return;
        };
        for facet in facets {
            let Some(features) = facet.get("features").and_then(|f| f.as_array()) else {
                continue;
            };
            for feature in features {
                if feature.get("$type").and_then(|t| t.as_str())
                    != Some("space.roomy.richtext.facet#link")
                {
                    continue;
                }
                if let Some(uri) = feature.get("uri").and_then(|u| u.as_str()) {
                    if !urls.iter().any(|seen| seen == uri) {
                        urls.push(uri.to_string());
                    }
                }
            }
        }
    };

    for block in blocks {
        let kind = block.get("$type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "space.roomy.richtext.blocks#text"
            | "space.roomy.richtext.blocks#header"
            | "space.roomy.richtext.blocks#blockquote"
            | "space.roomy.richtext.blocks#small" => {
                if let Some(facets) = block.get("facets") {
                    collect(facets);
                }
            }
            "space.roomy.richtext.blocks#orderedList"
            | "space.roomy.richtext.blocks#unorderedList" => {
                let Some(items) = block.get("items").and_then(|i| i.as_array()) else {
                    continue;
                };
                for item in items {
                    if let Some(facets) = item.get("facets") {
                        collect(facets);
                    }
                }
            }
            _ => {}
        }
    }
    urls
}

/// The mime type a rich-text body carries.
pub const RICHTEXT_MIME: &str = "application/vnd.roomy.richtext+json";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_urls_are_found_without_their_brackets() {
        let urls = extract_urls("see <https://example.com/a> and https://b.example.org/x.");
        assert_eq!(
            urls,
            vec!["https://example.com/a", "https://b.example.org/x"]
        );
    }

    #[test]
    fn a_url_appears_once() {
        let urls = extract_urls("https://a.example.com and https://a.example.com");
        assert_eq!(urls.len(), 1);
    }

    #[test]
    fn facets_come_from_the_blocks_that_carry_them() {
        let blocks = serde_json::json!([
            {
                "$type": "space.roomy.richtext.blocks#text",
                "text": "hello",
                "facets": [
                    {
                        "index": {"byteStart": 0, "byteEnd": 5},
                        "features": [
                            {"$type": "space.roomy.richtext.facet#link", "uri": "https://example.com"}
                        ]
                    }
                ]
            },
            {"$type": "space.roomy.richtext.blocks#rule"}
        ]);
        assert_eq!(extract_facet_urls(&blocks), vec!["https://example.com"]);
    }
}
