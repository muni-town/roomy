//! Appservice registration and the homeserver client.
//!
//! An appservice is registered with the homeserver by a YAML file naming its
//! tokens, its URL, and the namespaces it owns. Everything the bridge does on
//! the Matrix side — sending as a ghost, joining a room, reading history — goes
//! through that registration, so the values here must match the file the
//! homeserver was given.

use std::fmt;
use std::marker::PhantomData;

use serde::{Deserialize, Serialize};

/// The token the appservice presents to the homeserver's client API.
///
/// The two tokens are both opaque strings to the homeserver, and swapping them
/// is a misconfiguration that only shows up as a 403 at the first send, so they
/// are distinct types parsed at the configuration boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AsToken(String);

impl AsToken {
    pub fn parse(value: impl Into<String>) -> Result<Self, TokenError> {
        parse_token(value.into()).map(AsToken)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AsToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<&str> for AsToken {
    type Error = TokenError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        AsToken::parse(value)
    }
}

/// The token the homeserver presents on each transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HsToken(String);

impl HsToken {
    pub fn parse(value: impl Into<String>) -> Result<Self, TokenError> {
        parse_token(value.into()).map(HsToken)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for HsToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<&str> for HsToken {
    type Error = TokenError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        HsToken::parse(value)
    }
}

fn parse_token(value: String) -> Result<String, TokenError> {
    if value.is_empty() {
        return Err(TokenError::Empty);
    }
    if value.contains(char::is_whitespace) {
        return Err(TokenError::Whitespace);
    }
    Ok(value)
}

/// A shared secret could not be parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("a token cannot be empty")]
    Empty,
    #[error("a token cannot contain whitespace")]
    Whitespace,
}

/// The token pair a registered appservice holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub as_token: AsToken,
    pub hs_token: HsToken,
}

/// A user/alias/room namespace the appservice claims.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Namespace {
    /// Whether the appservice has exclusive control of the namespace.
    pub exclusive: bool,
    pub regex: String,
}

/// The three namespace kinds a registration declares.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Namespaces {
    #[serde(default)]
    pub users: Vec<Namespace>,
    #[serde(default)]
    pub aliases: Vec<Namespace>,
    #[serde(default)]
    pub rooms: Vec<Namespace>,
}

/// The appservice's registration, as the homeserver holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppserviceRegistration {
    /// An opaque id naming this registration.
    pub id: String,
    /// Where the homeserver pushes transactions.
    pub url: String,
    /// Token the appservice presents to the homeserver's client API.
    pub as_token: AsToken,
    /// Token the homeserver presents on each transaction, which the appservice
    /// must verify — an unverified one lets anyone write messages.
    pub hs_token: HsToken,
    /// The localpart the appservice's own user is created with.
    pub sender_localpart: String,
    /// Whether to receive typing, presence and receipt EDUs. MSC2409's
    /// to-device delivery rides on this.
    pub receive_ephemeral: bool,
    /// Synapse's opt-in for the MSC3202 transaction extensions. Without it a
    /// transaction carries `events` and nothing else, so the device lists and
    /// one-time-key counts encryption needs never arrive.
    #[serde(rename = "org.matrix.msc3202", default)]
    pub msc3202_transaction_extensions: bool,
    /// Synapse's opt-in for MSC4190 device management, which lets the bridge
    /// create the device its `OlmMachine` runs on.
    #[serde(rename = "io.element.msc4190", default)]
    pub msc4190_device_management: bool,
    pub namespaces: Namespaces,
}

impl AppserviceRegistration {
    /// The appservice user's MXID, `@<sender_localpart>:<domain>`.
    pub fn sender_mxid(&self, domain: &str) -> String {
        format!("@{}:{}", self.sender_localpart, domain)
    }

    /// The ghost namespace regex, for a bridge whose ghosts live under a fixed
    /// prefix on `domain`.
    pub fn ghost_user_namespace(prefix: &str, domain: &str) -> Namespace {
        Namespace {
            exclusive: true,
            regex: format!("@{}_.*:{}", regex_escape(prefix), regex_escape(domain)),
        }
    }
}

/// Escape the characters that are meaningful in a regex.
fn regex_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
        ) {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// An appservice that knows its identity but has no shared secrets yet.
///
/// The appservice cannot serve anything in this state: without tokens it can
/// neither authenticate to the homeserver nor recognise the transactions the
/// homeserver sends it, so no server route exists that could be started with
/// one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unregistered {
    id: String,
    url: String,
    sender_localpart: String,
    namespaces: Namespaces,
}

/// An appservice whose tokens exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    unregistered: Unregistered,
    tokens: Tokens,
}

/// An appservice whose registration is being served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Running {
    registered: Registered,
}

/// An appservice registration, typed by how far through startup it is.
///
/// `unregistered()` → [`Appservice::register`] → [`Appservice::start`]. The
/// transaction endpoint takes an `Appservice<Running>`, so serving before the
/// tokens exist is a type error rather than a runtime `403` on every message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appservice<S> {
    state: S,
    _marker: PhantomData<S>,
}

impl Appservice<Unregistered> {
    /// The identity half of a registration, as the operator configures it.
    pub fn new(
        id: impl Into<String>,
        url: impl Into<String>,
        sender_localpart: impl Into<String>,
        namespaces: Namespaces,
    ) -> Self {
        Self {
            state: Unregistered {
                id: id.into(),
                url: url.into(),
                sender_localpart: sender_localpart.into(),
                namespaces,
            },
            _marker: PhantomData,
        }
    }

    /// Attach the shared secrets. Both are validated tokens, so an empty or
    /// malformed secret cannot reach a registration.
    pub fn register(self, tokens: Tokens) -> Appservice<Registered> {
        Appservice {
            state: Registered {
                unregistered: self.state,
                tokens,
            },
            _marker: PhantomData,
        }
    }
}

impl Registered {
    /// The registration file the homeserver must be given.
    fn registration(&self) -> AppserviceRegistration {
        let state = &self.unregistered;
        AppserviceRegistration {
            id: state.id.clone(),
            url: state.url.clone(),
            as_token: self.tokens.as_token.clone(),
            hs_token: self.tokens.hs_token.clone(),
            sender_localpart: state.sender_localpart.clone(),
            receive_ephemeral: true,
            // Synapse reads both of these per registration, not from its own
            // config alone. Without them `/transactions` carries `events` and
            // nothing else, so to-device messages and device lists never arrive
            // and the bridge cannot decrypt anything.
            msc3202_transaction_extensions: true,
            msc4190_device_management: true,
            namespaces: state.namespaces.clone(),
        }
    }
}

impl Appservice<Registered> {
    /// The registration file the homeserver must be given.
    pub fn registration(&self) -> AppserviceRegistration {
        self.state.registration()
    }

    /// The token the bridge presents to the homeserver.
    pub fn as_token(&self) -> &AsToken {
        &self.state.tokens.as_token
    }

    /// The appservice user's localpart.
    pub fn sender_localpart(&self) -> &str {
        &self.state.unregistered.sender_localpart
    }

    /// Begin serving this registration.
    ///
    /// Taking `self` by value means the registration cannot be served twice
    /// from the same value, and a `Running` value cannot be built except from a
    /// `Registered` one.
    pub fn start(self) -> Appservice<Running> {
        Appservice {
            state: Running {
                registered: self.state,
            },
            _marker: PhantomData,
        }
    }
}

impl Appservice<Running> {
    /// The token the homeserver must present on each transaction.
    pub fn hs_token(&self) -> &HsToken {
        &self.state.registered.tokens.hs_token
    }

    /// The token the bridge presents to the homeserver.
    pub fn as_token(&self) -> &AsToken {
        &self.state.registered.tokens.as_token
    }

    /// The registration this appservice is serving.
    pub fn registration(&self) -> AppserviceRegistration {
        self.state.registered.registration()
    }

    /// Whether a presented transaction token is the one this registration was
    /// given.
    pub fn verifies_hs_token(&self, presented: &str) -> bool {
        constant_time_eq(presented, self.hs_token().as_str())
    }
}

/// Compare two strings without an early exit on the first differing byte.
///
/// The token is a shared secret compared on every transaction; a comparison
/// that returns as soon as a byte differs leaks its prefix length through
/// timing.
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// A client for the homeserver's client-server and appservice APIs.
#[derive(Debug, Clone)]
pub struct HomeserverClient {
    http: reqwest::Client,
    base_url: String,
    as_token: AsToken,
}

impl HomeserverClient {
    pub fn new(base_url: impl Into<String>, as_token: AsToken) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            as_token,
        }
    }

    /// The homeserver base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Create `device_id` for `user_id` if it is not there.
    ///
    /// A crypto device's keys can only be uploaded for a device the homeserver
    /// has: without this, every key upload is refused with `M_UNKNOWN_DEVICE`
    /// and the bridge can neither decrypt nor share a room key.
    pub async fn ensure_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<(), HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/devices/{}?user_id={}",
            self.base_url,
            percent_encode(device_id),
            percent_encode(user_id)
        );
        let response = self
            .http
            .put(&url)
            .bearer_auth(&self.as_token)
            .json(&serde_json::json!({ "display_name": "Roomy bridge" }))
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: url.clone(),
                source,
            })?;
        if response.status().is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(HomeserverError::Rejected {
            url,
            status: 0,
            body,
        })
    }

    /// Make `user_id` exist on the homeserver, and put it in `room_id`.
    ///
    /// An appservice may speak for its namespaced users, but only for users the
    /// homeserver already has: a send as an unregistered ghost is refused with
    /// "Application service has not registered this user". Registering through
    /// `m.login.application_service` is the one path that works when open
    /// registration is disabled, which is every real deployment.
    pub async fn ensure_ghost(&self, user_id: &str, room_id: &str) -> Result<(), HomeserverError> {
        let localpart = user_id
            .strip_prefix('@')
            .and_then(|rest| rest.split(':').next())
            .unwrap_or(user_id);

        let url = format!("{}/_matrix/client/v3/register", self.base_url);
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.as_token)
            .json(&serde_json::json!({
                "type": "m.login.application_service",
                "username": localpart,
                // A homeserver with MSC4190 requires this: the ghost never
                // logs in, it only exists to be an author.
                "inhibit_login": true,
            }))
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: url.clone(),
                source,
            })?;
        // `M_USER_IN_USE` is the already-registered case, which is success here.
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            if !body.contains("M_USER_IN_USE") {
                return Err(HomeserverError::Rejected {
                    url,
                    status: 0,
                    body,
                });
            }
        }

        let join = format!(
            "{}/_matrix/client/v3/rooms/{}/join?user_id={}",
            self.base_url,
            percent_encode(room_id),
            percent_encode(user_id)
        );
        let response = self
            .http
            .post(&join)
            .bearer_auth(&self.as_token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: join.clone(),
                source,
            })?;
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(HomeserverError::Rejected {
                url: join,
                status: 0,
                body,
            });
        }
        Ok(())
    }

    /// The appservice token, for callers that build their own requests.
    pub fn as_token(&self) -> &AsToken {
        &self.as_token
    }

    /// Resolve a room alias to a room id.
    pub async fn resolve_alias(&self, alias: &str) -> Result<String, HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/directory/room/{}",
            self.base_url,
            percent_encode(alias)
        );
        #[derive(Deserialize)]
        struct Resolved {
            #[serde(rename = "room_id")]
            room_id: String,
        }
        self.get_json::<Resolved>(&url)
            .await
            .map(|resolved| resolved.room_id)
    }

    /// Read a room's `m.space.child` edges, which is what the hierarchy derives
    /// from.
    pub async fn space_children(
        &self,
        room_id: &str,
    ) -> Result<Vec<(String, SpaceChildContent)>, HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/state",
            self.base_url,
            percent_encode(room_id)
        );
        let state = self.get_json::<Vec<StateEvent>>(&url).await?;
        Ok(state
            .into_iter()
            .filter(|event| event.kind == "m.space.child")
            .filter_map(|event| {
                let content: SpaceChildContent =
                    serde_json::from_value(event.content.clone()).ok()?;
                // A child with no `via` cannot be joined, so it is not part of
                // the hierarchy — `via` is required by the spec for exactly
                // that reason.
                if content.via.is_empty() {
                    return None;
                }
                Some((event.state_key, content))
            })
            .collect())
    }

    /// Read the room's name and encryption state.
    pub async fn room_summary(&self, room_id: &str) -> Result<RoomSummary, HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/state",
            self.base_url,
            percent_encode(room_id)
        );
        let state = self.get_json::<Vec<StateEvent>>(&url).await?;

        let name = state
            .iter()
            .find(|event| event.kind == "m.room.name")
            .and_then(|event| event.content.get("name"))
            .and_then(|name| name.as_str())
            .map(str::to_string);

        let encryption_algorithm = state
            .iter()
            .find(|event| event.kind == "m.room.encryption")
            .and_then(|event| event.content.get("algorithm"))
            .and_then(|algorithm| algorithm.as_str())
            .map(str::to_string);

        let join_rule = state
            .iter()
            .find(|event| event.kind == "m.room.join_rules")
            .and_then(|event| event.content.get("join_rule"))
            .and_then(|rule| rule.as_str())
            .map(str::to_string);

        Ok(RoomSummary {
            room_id: room_id.to_string(),
            name,
            encrypted: encryption_algorithm.is_some(),
            encryption_algorithm,
            join_rule,
        })
    }

    /// Join a room as a ghost user.
    ///
    /// Ghosts are real Matrix users under the registration's namespace, so this
    /// is an ordinary join made with the appservice's token — no password, no
    /// login dance.
    pub async fn join_as(&self, room_id: &str, mxid: &str) -> Result<(), HomeserverError> {
        let url = format!(
            "{}/_matrix/client/v3/join/{}?user_id={}",
            self.base_url,
            percent_encode(room_id),
            percent_encode(mxid)
        );
        self.post_json::<serde_json::Value>(&url, &serde_json::json!({}))
            .await
            .map(|_| ())
    }

    /// Create a room, as a ghost.
    pub async fn create_room(
        &self,
        request: &CreateRoomRequest,
    ) -> Result<String, HomeserverError> {
        let url = format!("{}/_matrix/client/v3/createRoom", self.base_url);
        #[derive(Deserialize)]
        struct Created {
            #[serde(rename = "room_id")]
            room_id: String,
        }
        self.post_json::<Created>(&url, &serde_json::to_value(request).expect("serialises"))
            .await
            .map(|created| created.room_id)
    }

    pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> Result<T, HomeserverError> {
        let response = self
            .http
            .get(url)
            .query(&[("access_token", self.as_token.as_str())])
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: url.to_string(),
                source,
            })?;
        decode(response, url).await
    }

    pub(crate) async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<T, HomeserverError> {
        let response = self
            .http
            .post(url)
            .query(&[("access_token", self.as_token.as_str())])
            .json(body)
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: url.to_string(),
                source,
            })?;
        decode(response, url).await
    }

    /// `PUT` with the appservice token, for the endpoints the spec defines that
    /// way: sending into a room and redacting an event.
    pub(crate) async fn put_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<T, HomeserverError> {
        let response = self
            .http
            .put(url)
            .query(&[("access_token", self.as_token.as_str())])
            .json(body)
            .send()
            .await
            .map_err(|source| HomeserverError::Transport {
                url: url.to_string(),
                source,
            })?;
        decode(response, url).await
    }

    /// A request builder carrying the appservice token, for callers that parse
    /// the response themselves.
    ///
    /// The crypto transport needs this: ruma's generated response types are
    /// parsed by `IncomingResponseExt`, not by `serde_json`, so it cannot go
    /// through the typed helpers above.
    pub(crate) fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .query(&[("access_token", self.as_token.as_str())])
    }
}

async fn decode<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    url: &str,
) -> Result<T, HomeserverError> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(HomeserverError::Rejected {
            url: url.to_string(),
            status: status.as_u16(),
            body,
        });
    }
    serde_json::from_str(&body).map_err(|error| HomeserverError::Decode {
        url: url.to_string(),
        message: error.to_string(),
    })
}

/// A state event as `/state` returns it.
#[derive(Debug, Clone, Deserialize)]
struct StateEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "state_key", default)]
    state_key: String,
    #[serde(default)]
    content: serde_json::Value,
}

/// `m.space.child` content.
#[derive(Debug, Clone, Deserialize)]
pub struct SpaceChildContent {
    /// Servers to try when joining.
    #[serde(default)]
    pub via: Vec<String>,
    /// Display order, when the sender set one.
    #[serde(default)]
    pub order: Option<String>,
    /// `true` marks the child as removed.
    #[serde(default)]
    pub deleted: Option<bool>,
}

/// A room's identity and policy, from its state events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    pub encrypted: bool,
    pub encryption_algorithm: Option<String>,
    pub join_rule: Option<String>,
}

/// The body of a `createRoom` call.
#[derive(Debug, Clone, Serialize)]
pub struct CreateRoomRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(rename = "preset", skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// When set, the room is created inside this space.
    #[serde(rename = "space_parent", skip_serializing_if = "Option::is_none")]
    pub space_parent: Option<String>,
    #[serde(default)]
    pub creation_content: serde_json::Value,
    #[serde(default)]
    pub initial_state: Vec<serde_json::Value>,
}

/// A homeserver call failed.
#[derive(Debug, thiserror::Error)]
pub enum HomeserverError {
    #[error("transport error calling {url}: {source}")]
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
    #[error("{url} returned a body this adapter cannot read: {message}")]
    Decode { url: String, message: String },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sender_mxid_uses_the_domain() {
        let registration = AppserviceRegistration {
            id: "roomy".into(),
            url: "http://bridge:29331".into(),
            as_token: AsToken::parse("as").unwrap(),
            hs_token: HsToken::parse("hs").unwrap(),
            sender_localpart: "_roomy_bridge".into(),
            receive_ephemeral: true,
            msc3202_transaction_extensions: true,
            msc4190_device_management: true,
            namespaces: Namespaces::default(),
        };
        assert_eq!(
            registration.sender_mxid("matrix.roomy.local"),
            "@_roomy_bridge:matrix.roomy.local"
        );
    }

    #[test]
    fn the_ghost_namespace_is_scoped_and_escaped() {
        let namespace =
            AppserviceRegistration::ghost_user_namespace("_roomy", "matrix.roomy.local");
        assert!(namespace.exclusive);
        assert_eq!(namespace.regex, "@_roomy_.*:matrix\\.roomy\\.local");
    }

    #[test]
    fn a_registered_appservice_renders_its_tokens() {
        let appservice = Appservice::new(
            "roomy",
            "http://bridge:29331",
            "_roomy_bridge",
            Namespaces::default(),
        )
        .register(Tokens {
            as_token: AsToken::parse("as-secret").unwrap(),
            hs_token: HsToken::parse("hs-secret").unwrap(),
        });

        let registration = appservice.registration();
        assert_eq!(registration.as_token.as_str(), "as-secret");
        assert_eq!(registration.hs_token.as_str(), "hs-secret");
        assert!(registration.msc3202_transaction_extensions);
        assert!(registration.msc4190_device_management);
    }

    #[test]
    fn only_the_configured_hs_token_is_accepted() {
        let appservice = Appservice::new(
            "roomy",
            "http://bridge:29331",
            "_roomy",
            Namespaces::default(),
        )
        .register(Tokens {
            as_token: AsToken::parse("as").unwrap(),
            hs_token: HsToken::parse("hs-secret").unwrap(),
        })
        .start();
        assert!(appservice.verifies_hs_token("hs-secret"));
        assert!(!appservice.verifies_hs_token("hs-secre"));
        assert!(!appservice.verifies_hs_token(""));
    }

    #[test]
    fn an_empty_token_is_not_a_token() {
        assert!(AsToken::parse("").is_err());
        assert!(HsToken::parse("").is_err());
        assert!(AsToken::parse("a b").is_err());
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(percent_encode("!room:example.org"), "%21room%3Aexample.org");
    }
}
