//! The HTTP feed: the log owner answers a cursor question over the network.
//!
//! A worker on another machine cannot open the log's SQLite file, and must not
//! try — a network filesystem over an SQLite database is not a supported way to
//! read one. Instead the owner exposes one internal endpoint:
//!
//! ```text
//! GET /internal/feed/{spaceDid}?afterIdx=<i64>&afterOrd=<i64>&limit=<usize>
//! 200 {"changes": [<FeedRow>...], "latestIdx": <i64>}
//! ```
//!
//! The contract is the same as the SQLite feed's: rows strictly after the cursor,
//! never splitting an entry, at-least-once across a crash. `latestIdx` is what a
//! worker reports as its lag.
//!
//! The transport is a trait ([`Pull`]) so the parsing and the cursor arithmetic
//! are testable without a socket, and so a deployment can put the pull behind an
//! authenticated client without this crate learning about credentials.

use std::time::Duration;

use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;

use crate::{ChangeFeed, Cursor, FeedError};

/// One HTTP GET, as the feed needs it.
pub trait Pull: Send + Sync {
    /// Fetch `url`, returning the response body or an error.
    fn get(&self, url: &str) -> Result<String, PullError>;
}

/// A pull that failed: the network, the status, or the body.
#[derive(Debug, thiserror::Error)]
pub enum PullError {
    #[error("{0}")]
    Transport(String),
}

/// The body the feed endpoint answers with.
#[derive(Debug, Deserialize)]
struct FeedResponse {
    changes: Vec<FeedRow>,
    #[serde(rename = "latestIdx")]
    latest_idx: i64,
}

/// A change feed read over HTTP.
pub struct HttpChangeFeed<P: Pull> {
    /// The gateway's base URL, without a trailing slash.
    base_url: String,
    pull: P,
}

impl<P: Pull> HttpChangeFeed<P> {
    /// A feed over the gateway at `base_url`, pulled through `pull`.
    pub fn new(base_url: impl Into<String>, pull: P) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            pull,
        }
    }

    fn url(&self, space: &SpaceDid, cursor: Cursor, limit: usize) -> String {
        let base_url = &self.base_url;
        let space = space.as_str();
        let (idx, ord) = (cursor.idx, cursor.ord);
        format!("{base_url}/internal/feed/{space}?afterIdx={idx}&afterOrd={ord}&limit={limit}")
    }

    fn fetch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<FeedResponse, FeedError> {
        let body = self
            .pull
            .get(&self.url(space, cursor, limit))
            .map_err(FeedError::Transport)?;
        serde_json::from_str(&body).map_err(|error| FeedError::Decode(error.to_string()))
    }
}

impl<P: Pull> ChangeFeed for HttpChangeFeed<P> {
    fn batch(
        &self,
        space: &SpaceDid,
        cursor: Cursor,
        limit: usize,
    ) -> Result<Vec<FeedRow>, FeedError> {
        let response = self.fetch(space, cursor, limit)?;
        // The answer must start after the cursor. Anything else means the
        // owner's cursor arithmetic and ours disagree, which is a bug worth
        // failing on rather than replaying from the wrong place.
        if let Some(first) = response.changes.first() {
            let answered = Cursor::from((first.idx, first.ord));
            if answered <= cursor {
                return Err(FeedError::Rewound { cursor, answered });
            }
        }
        Ok(response.changes)
    }

    fn latest_idx(&self, space: &SpaceDid) -> Result<i64, FeedError> {
        Ok(self.fetch(space, Cursor::START, 0)?.latest_idx)
    }
}

/// A [`Pull`] over `ureq`, blocking, with a timeout.
pub struct UreqPull {
    agent: ureq::Agent,
    /// Sent on every request: the feed an owner serves to workers other than
    /// its own is behind a shared secret, never open to the edge.
    header: Option<(String, String)>,
}

impl UreqPull {
    /// A pull whose every request times out after `timeout`.
    pub fn new(timeout: Duration) -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(timeout)
                .timeout_read(timeout)
                .build(),
            header: None,
        }
    }

    /// Authenticate every pull with `name: value`.
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.header = Some((name.into(), value.into()));
        self
    }
}

impl Default for UreqPull {
    fn default() -> Self {
        Self::new(Duration::from_secs(10))
    }
}

impl Pull for UreqPull {
    fn get(&self, url: &str) -> Result<String, PullError> {
        let mut request = self.agent.get(url);
        if let Some((name, value)) = &self.header {
            request = request.set(name, value);
        }
        let response = request
            .call()
            .map_err(|error| PullError::Transport(error.to_string()))?;
        response
            .into_string()
            .map_err(|error| PullError::Transport(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A pull that answers from a script and records what it was asked.
    struct Scripted {
        body: String,
        asked: Mutex<Vec<String>>,
    }

    impl Scripted {
        fn new(body: String) -> Self {
            Self {
                body,
                asked: Mutex::new(Vec::new()),
            }
        }
    }

    impl Pull for Scripted {
        fn get(&self, url: &str) -> Result<String, PullError> {
            self.asked.lock().expect("lock").push(url.to_string());
            Ok(self.body.clone())
        }
    }

    fn row(idx: i64, ord: i64) -> serde_json::Value {
        serde_json::json!({
            "streamId": "did:web:feed.example",
            "idx": idx,
            "ord": ord,
            "kind": "ban",
            "repo": "did:web:feed.example",
            "collection": "space.roomy.space.ban",
            "rkey": "did:plc:user",
            "op": "delete",
            "orderStamp": "01HF7YAT000000000000000001",
            "actor": "did:web:feed.example",
            "eventId": "01HF7YAT00000000000000000A",
            "body": null,
        })
    }

    #[test]
    fn a_batch_is_asked_for_after_the_cursor() {
        let body = serde_json::json!({ "changes": [row(5, 1)], "latestIdx": 9 }).to_string();
        let pull = Scripted::new(body);
        let feed = HttpChangeFeed::new("http://owner.example/", pull);
        let space = SpaceDid::parse("did:web:feed.example").expect("space");

        let rows = feed
            .batch(&space, Cursor::from((4, 2)), 50)
            .expect("a batch");
        assert_eq!(rows.len(), 1);
        let asked = feed.pull.asked.lock().expect("lock").clone();
        assert_eq!(
            asked,
            vec!["http://owner.example/internal/feed/did:web:feed.example?afterIdx=4&afterOrd=2&limit=50"]
        );
        assert_eq!(feed.latest_idx(&space).expect("latest"), 9);
    }

    #[test]
    fn a_batch_that_rewinds_is_an_error() {
        let body = serde_json::json!({ "changes": [row(1, 0)], "latestIdx": 9 }).to_string();
        let feed = HttpChangeFeed::new("http://owner.example", Scripted::new(body));
        let space = SpaceDid::parse("did:web:feed.example").expect("space");
        assert!(matches!(
            feed.batch(&space, Cursor::from((3, 0)), 10),
            Err(FeedError::Rewound { .. })
        ));
    }

    #[test]
    fn an_unreadable_body_is_a_decode_error() {
        let feed = HttpChangeFeed::new("http://owner.example", Scripted::new("not json".into()));
        let space = SpaceDid::parse("did:web:feed.example").expect("space");
        assert!(matches!(
            feed.batch(&space, Cursor::START, 10),
            Err(FeedError::Decode(_))
        ));
    }
}
