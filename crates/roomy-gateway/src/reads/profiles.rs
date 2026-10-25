//! `space.roomy.user.getProfile`.
//!
//! A profile is assembled from the sources that know the most about it, in
//! order:
//!
//!  1. the Roomy profile record HappyView indexed for the DID,
//!  2. the materialised `profiles` row in the global store,
//!  3. the DID's ATProto profile at the Bluesky appview.
//!
//! A Roomy record carries display fields but no handle, so the handle always
//! comes from the materialised row or, when that row has none, from the
//! appview. Every remote lookup is best-effort: a source that is unconfigured,
//! slow, or fails degrades to the next one, and a DID no source knows still
//! answers with its DID alone.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use regex::Regex;
use serde::{Deserialize, Serialize};

use space_xrpc::error::XrpcError;
use space_xrpc::handlers::common::Context;
use space_xrpc::params::Params;
use space_xrpc::store::GlobalStores;

use crate::GatewayState;

pub const NSID: &str = "space.roomy.user.getProfile";

/// The public Bluesky appview, which serves `app.bsky.actor.getProfiles`.
const BLUESKY_APPVIEW: &str = "https://api.bsky.app";

/// Deadline for one outbound profile lookup. Matches the appserver's
/// `fetchWithTimeout` default and is overridable through
/// `PROFILE_FETCH_TIMEOUT_MS`.
const DEFAULT_PROFILE_FETCH_TIMEOUT_MS: f64 = 3000.0;

/// How long a DID that resolved to nothing is kept out of the appview fetch
/// path. One minute collapses repeated reads for an unresolvable author
/// without pinning a DID that gets indexed a moment later.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);

/// The wire shape of the answer.
///
/// Field order is the response's key order: the appserver builds
/// `{ did, handle, displayName, avatar, description, banner, pronouns, website }`
/// for a record-backed profile and `{ did, handle, displayName, avatar,
/// description }` for a Bluesky one. Absent fields are omitted, never null.
#[derive(Debug, Clone, Serialize)]
pub struct GetProfileResult {
    pub did: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronouns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

impl GetProfileResult {
    fn with_did(did: String) -> Self {
        Self {
            did,
            handle: None,
            display_name: None,
            avatar: None,
            description: None,
            banner: None,
            pronouns: None,
            website: None,
        }
    }
}

/// A profile as one remote source describes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteProfile {
    pub handle: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub pronouns: Option<String>,
    pub website: Option<String>,
    pub avatar: Option<String>,
    pub banner: Option<String>,
}

/// Which remote source a lookup asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSource {
    /// The Roomy profile record indexed by HappyView.
    HappyView,
    /// The ATProto profile served by the Bluesky appview.
    Bluesky,
}

/// The external half of profile resolution.
#[async_trait]
pub trait ProfileResolver: Send + Sync {
    /// Resolve `did` at `source`.
    ///
    /// `None` means a miss of any kind — no record, an unconfigured source, or
    /// a failed lookup — because every caller treats them the same way.
    async fn resolve(&self, did: &str, source: ProfileSource) -> Option<RemoteProfile>;
}

/// Resolves profiles over HTTP from HappyView and the Bluesky appview.
pub struct HttpProfileResolver {
    client: reqwest::Client,
    happy_view: Option<HappyViewConfig>,
    bluesky_endpoint: String,
    timeout: Duration,
}

/// HappyView connection settings. HappyView is enabled only when both an
/// endpoint and a client key are configured; the client secret is optional.
#[derive(Debug, Clone)]
struct HappyViewConfig {
    endpoint: String,
    client_key: String,
    client_secret: Option<String>,
}

impl HappyViewConfig {
    fn from_env() -> Option<Self> {
        let endpoint = non_empty_env("HAPPYVIEW_ENDPOINT")?;
        let client_key = non_empty_env("HAPPYVIEW_CLIENT_KEY")?;
        Some(Self {
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            client_key,
            client_secret: non_empty_env("HAPPYVIEW_CLIENT_SECRET"),
        })
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn profile_fetch_timeout() -> Duration {
    let millis = std::env::var("PROFILE_FETCH_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|millis| millis.is_finite() && *millis > 0.0)
        .unwrap_or(DEFAULT_PROFILE_FETCH_TIMEOUT_MS);
    Duration::from_secs_f64(millis / 1000.0)
}

impl HttpProfileResolver {
    /// A resolver over `client` and the process environment.
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            happy_view: HappyViewConfig::from_env(),
            bluesky_endpoint: BLUESKY_APPVIEW.to_owned(),
            timeout: profile_fetch_timeout(),
        }
    }

    /// Override the HappyView endpoint and credentials.
    pub fn with_happy_view(
        mut self,
        endpoint: impl Into<String>,
        client_key: impl Into<String>,
        client_secret: Option<String>,
    ) -> Self {
        self.happy_view = Some(HappyViewConfig {
            endpoint: endpoint.into().trim_end_matches('/').to_owned(),
            client_key: client_key.into(),
            client_secret,
        });
        self
    }

    /// Override the Bluesky appview origin.
    pub fn with_bluesky_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.bluesky_endpoint = endpoint.into().trim_end_matches('/').to_owned();
        self
    }

    /// Override the per-lookup deadline.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Resolve an `actor` param to a DID.
    ///
    /// Anything starting with `did:` is already a DID; anything else is a
    /// handle, resolved through its host's `/.well-known/atproto-did`.
    pub async fn actor_to_did(&self, actor: &str) -> Result<String, XrpcError> {
        if actor.starts_with("did:") {
            return Ok(actor.to_owned());
        }
        self.resolve_handle(actor).await.ok_or_else(|| {
            XrpcError::new(
                404,
                "ActorNotFound",
                format!("Could not resolve handle: {actor}"),
            )
        })
    }

    async fn resolve_handle(&self, handle: &str) -> Option<String> {
        if !is_valid_handle(handle) {
            return None;
        }
        let url = format!("https://{handle}/.well-known/atproto-did");
        let response = self
            .client
            .get(url)
            .timeout(self.timeout)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body = response.text().await.ok()?;
        let did = body.trim();
        did.starts_with("did:").then(|| did.to_owned())
    }

    async fn fetch_happy_view(&self, did: &str) -> Option<RemoteProfile> {
        let config = self.happy_view.as_ref()?;
        let mut request = self
            .client
            .get(format!(
                "{}/xrpc/space.roomy.user.getProfiles",
                config.endpoint
            ))
            .query(&[("actors", did)])
            .header("X-Client-Key", config.client_key.as_str())
            .timeout(self.timeout);
        if let Some(secret) = &config.client_secret {
            request = request.header("X-Client-Secret", secret.as_str());
        }
        let response = request.send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: HappyViewResponse = response
            .bytes()
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
        let profile = body.profiles?.into_iter().next()?;
        Some(RemoteProfile {
            handle: non_empty(profile.handle),
            display_name: profile.display_name,
            description: profile.description,
            pronouns: profile.pronouns,
            website: profile.website,
            avatar: profile.avatar,
            banner: profile.banner,
        })
    }

    async fn fetch_bluesky(&self, did: &str) -> Option<RemoteProfile> {
        if !is_fetchable_did(did) {
            record_unresolved(did);
            return None;
        }
        if is_backed_off(did) {
            return None;
        }
        let profile = self.request_bluesky(did).await;
        if profile.is_none() {
            record_unresolved(did);
        }
        profile
    }

    async fn request_bluesky(&self, did: &str) -> Option<RemoteProfile> {
        let response = self
            .client
            .get(format!(
                "{}/xrpc/app.bsky.actor.getProfiles",
                self.bluesky_endpoint
            ))
            .query(&[("actors", did)])
            .timeout(self.timeout)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body: BlueskyResponse = response
            .bytes()
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
        let profile = body.profiles?.into_iter().next()?;
        Some(RemoteProfile {
            handle: non_empty(profile.handle),
            display_name: profile.display_name,
            description: profile.description,
            pronouns: None,
            website: None,
            avatar: profile.avatar,
            banner: None,
        })
    }
}

/// One client for every request-time resolver, so connections are pooled
/// across the endpoints.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

impl Default for HttpProfileResolver {
    fn default() -> Self {
        Self::new(CLIENT.clone())
    }
}

#[async_trait]
impl ProfileResolver for HttpProfileResolver {
    async fn resolve(&self, did: &str, source: ProfileSource) -> Option<RemoteProfile> {
        match source {
            ProfileSource::HappyView => self.fetch_happy_view(did).await,
            ProfileSource::Bluesky => self.fetch_bluesky(did).await,
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn is_fetchable_did(did: &str) -> bool {
    static SHAPE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^did:[a-z]+:.+$").expect("static did pattern"));
    SHAPE.is_match(did)
}

/// ATProto handles are hostnames: dot-separated labels of letters, digits and
/// inner hyphens. Validating before the lookup keeps `actor` from naming an
/// arbitrary URL.
fn is_valid_handle(handle: &str) -> bool {
    static SHAPE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$",
        )
        .expect("static handle pattern")
    });
    if handle.len() > 253 {
        return false;
    }
    SHAPE.is_match(handle)
}

/// DIDs whose last appview lookup resolved nothing, and when.
static NEGATIVE_CACHE: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_backed_off(did: &str) -> bool {
    let Ok(mut cache) = NEGATIVE_CACHE.lock() else {
        return false;
    };
    match cache.get(did) {
        Some(at) if at.elapsed() < NEGATIVE_CACHE_TTL => true,
        Some(_) => {
            cache.remove(did);
            false
        }
        None => false,
    }
}

fn record_unresolved(did: &str) {
    let Ok(mut cache) = NEGATIVE_CACHE.lock() else {
        return;
    };
    cache.retain(|_, at| at.elapsed() < NEGATIVE_CACHE_TTL);
    cache.insert(did.to_owned(), Instant::now());
}

#[derive(Deserialize)]
struct HappyViewResponse {
    #[serde(default)]
    profiles: Option<Vec<HappyViewProfile>>,
}

#[derive(Deserialize)]
struct HappyViewProfile {
    #[serde(default)]
    handle: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    pronouns: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    banner: Option<String>,
}

#[derive(Deserialize)]
struct BlueskyResponse {
    #[serde(default)]
    profiles: Option<Vec<BlueskyProfile>>,
}

#[derive(Deserialize)]
struct BlueskyProfile {
    #[serde(default)]
    handle: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

/// The handle a Roomy record cannot supply: the materialised row's, or the
/// appview's when that row has none. Synthetic DIDs have no ATProto profile.
async fn hydrated_handle(
    resolver: &dyn ProfileResolver,
    did: &str,
    row_handle: Option<String>,
) -> Option<String> {
    if let Some(handle) = row_handle {
        return Some(handle);
    }
    if !did.starts_with("did:plc:") && !did.starts_with("did:web:") {
        return None;
    }
    resolver
        .resolve(did, ProfileSource::Bluesky)
        .await
        .and_then(|profile| profile.handle)
}

async fn profile(
    state: &GatewayState,
    params: &Params,
    _context: &Context,
) -> Result<GetProfileResult, XrpcError> {
    let actor = params.require_string("actor")?;
    let resolver = HttpProfileResolver::default();
    let did = resolver.actor_to_did(&actor).await?;
    Ok(assembled_profile(state.reads.stores.as_ref(), &resolver, did).await)
}

/// Assemble the answer for a resolved DID from the materialised store and the
/// remote sources.
async fn assembled_profile(
    stores: &dyn GlobalStores,
    resolver: &dyn ProfileResolver,
    did: String,
) -> GetProfileResult {
    let row = stores.profile(&did);

    // A Roomy profile record is authoritative for the display fields; the
    // handle still comes from the materialised row or the appview.
    if let Some(record) = resolver.resolve(&did, ProfileSource::HappyView).await {
        let handle = hydrated_handle(
            resolver,
            &did,
            row.as_ref().and_then(|row| row.handle.clone()),
        )
        .await;
        return GetProfileResult {
            did,
            handle,
            display_name: record.display_name,
            avatar: record.avatar,
            description: record.description,
            banner: record.banner,
            pronouns: record.pronouns,
            website: record.website,
        };
    }

    // The materialised row covers Bluesky-sourced profiles and bridged users.
    if let Some(row) = row {
        let handle = hydrated_handle(resolver, &did, row.handle).await;
        return GetProfileResult {
            did,
            handle,
            display_name: row.name,
            avatar: row.avatar,
            description: None,
            banner: None,
            pronouns: None,
            website: None,
        };
    }

    // Nothing materialised: ask the appview directly.
    if let Some(record) = resolver.resolve(&did, ProfileSource::Bluesky).await {
        return GetProfileResult {
            did,
            handle: record.handle,
            display_name: record.display_name,
            avatar: record.avatar,
            description: record.description,
            banner: None,
            pronouns: None,
            website: None,
        };
    }

    GetProfileResult::with_did(did)
}

/// axum handler for `GET /xrpc/space.roomy.user.getProfile`.
pub async fn http(
    State(state): State<std::sync::Arc<GatewayState>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let nsid = space_xrpc::ids::Nsid::try_from(NSID).expect("static nsid");
    let params = Params::parse(query.as_deref());
    let context = match crate::reads::context(&state, &headers, &nsid).await {
        Ok(context) => context,
        Err(error) => return error.into_response(),
    };
    match profile(&state, &params, &context).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use space_xrpc::store::{
        FederationOrder, FederationReceiverPermission, FederationRecord, FederationRoomPermission,
        FederationView, ProfileFields,
    };

    struct FakeStores(Option<ProfileFields>);

    impl GlobalStores for FakeStores {
        fn profile(&self, _did: &str) -> Option<ProfileFields> {
            self.0.clone()
        }

        fn link_embed_json(&self, _url: &str) -> Option<String> {
            None
        }

        fn space_handle(&self, _space_did: &str) -> Option<String> {
            None
        }

        fn federations(
            &self,
            _view: FederationView<'_>,
            _status: Option<&str>,
            _order: FederationOrder,
        ) -> Vec<FederationRecord> {
            Vec::new()
        }

        fn federation_origin_grants(&self, _space_id: &str) -> Vec<FederationRoomPermission> {
            Vec::new()
        }

        fn federation_receiver_grants(&self, _space_id: &str) -> Vec<FederationReceiverPermission> {
            Vec::new()
        }
    }

    struct FakeResolver {
        happy_view: Option<RemoteProfile>,
        bluesky: Option<RemoteProfile>,
        calls: Mutex<Vec<ProfileSource>>,
    }

    impl FakeResolver {
        fn new(happy_view: Option<RemoteProfile>, bluesky: Option<RemoteProfile>) -> Self {
            Self {
                happy_view,
                bluesky,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<ProfileSource> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ProfileResolver for FakeResolver {
        async fn resolve(&self, _did: &str, source: ProfileSource) -> Option<RemoteProfile> {
            self.calls.lock().unwrap().push(source);
            match source {
                ProfileSource::HappyView => self.happy_view.clone(),
                ProfileSource::Bluesky => self.bluesky.clone(),
            }
        }
    }

    fn row(handle: Option<&str>, name: &str, avatar: &str) -> ProfileFields {
        ProfileFields {
            name: Some(name.to_owned()),
            handle: handle.map(str::to_owned),
            avatar: Some(avatar.to_owned()),
        }
    }

    fn remote(handle: Option<&str>) -> RemoteProfile {
        RemoteProfile {
            handle: handle.map(str::to_owned),
            display_name: Some("Alice".to_owned()),
            description: Some("bio".to_owned()),
            pronouns: Some("she/her".to_owned()),
            website: Some("https://alice.example".to_owned()),
            avatar: Some("atblob://did:plc:abc/bafy".to_owned()),
            banner: Some("atblob://did:plc:abc/bafz".to_owned()),
        }
    }

    #[test]
    fn serialises_fields_in_wire_order() {
        let result = GetProfileResult {
            did: "did:plc:abc".to_owned(),
            handle: Some("alice.example".to_owned()),
            display_name: Some("Alice".to_owned()),
            avatar: Some("atblob://did:plc:abc/bafy".to_owned()),
            description: Some("hi".to_owned()),
            banner: Some("atblob://did:plc:abc/bafz".to_owned()),
            pronouns: Some("she/her".to_owned()),
            website: Some("https://alice.example".to_owned()),
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc","handle":"alice.example","displayName":"Alice","avatar":"atblob://did:plc:abc/bafy","description":"hi","banner":"atblob://did:plc:abc/bafz","pronouns":"she/her","website":"https://alice.example"}"#
        );
    }

    #[test]
    fn omits_fields_no_source_knows() {
        let result = GetProfileResult::with_did("did:plc:abc".to_owned());
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc"}"#
        );
    }

    #[test]
    fn accepts_handle_shapes_only() {
        assert!(is_valid_handle("alice.example"));
        assert!(is_valid_handle("a-b.example.com"));
        assert!(!is_valid_handle("alice"));
        assert!(!is_valid_handle("alice.example/../x"));
        assert!(!is_valid_handle("-alice.example"));
        assert!(!is_valid_handle("alice..example"));
    }

    #[test]
    fn fetchable_dids_need_a_method_and_an_identifier() {
        assert!(is_fetchable_did("did:plc:abc"));
        assert!(is_fetchable_did("did:discord:123"));
        assert!(!is_fetchable_did(""));
        assert!(!is_fetchable_did("did:plc:"));
        assert!(!is_fetchable_did("alice.example"));
    }

    #[tokio::test]
    async fn a_record_supplies_the_display_fields_and_the_row_the_handle() {
        let stores = FakeStores(Some(row(Some("alice.example"), "Row", "row-avatar")));
        let resolver = FakeResolver::new(Some(remote(None)), Some(remote(Some("appview"))));
        let result = assembled_profile(&stores, &resolver, "did:plc:abc".to_owned()).await;
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc","handle":"alice.example","displayName":"Alice","avatar":"atblob://did:plc:abc/bafy","description":"bio","banner":"atblob://did:plc:abc/bafz","pronouns":"she/her","website":"https://alice.example"}"#
        );
        assert_eq!(resolver.calls(), vec![ProfileSource::HappyView]);
    }

    #[tokio::test]
    async fn a_record_without_a_row_handle_gets_the_appview_handle() {
        let stores = FakeStores(Some(row(None, "Row", "row-avatar")));
        let resolver = FakeResolver::new(Some(remote(None)), Some(remote(Some("alice.example"))));
        let result = assembled_profile(&stores, &resolver, "did:plc:abc".to_owned()).await;
        assert_eq!(result.handle.as_deref(), Some("alice.example"));
        assert_eq!(result.display_name.as_deref(), Some("Alice"));
        assert_eq!(
            resolver.calls(),
            vec![ProfileSource::HappyView, ProfileSource::Bluesky]
        );
    }

    #[tokio::test]
    async fn the_row_answers_when_no_record_exists() {
        let stores = FakeStores(Some(row(None, "Row", "row-avatar")));
        let resolver = FakeResolver::new(None, Some(remote(Some("alice.example"))));
        let result = assembled_profile(&stores, &resolver, "did:plc:abc".to_owned()).await;
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc","handle":"alice.example","displayName":"Row","avatar":"row-avatar"}"#
        );
        assert_eq!(
            resolver.calls(),
            vec![ProfileSource::HappyView, ProfileSource::Bluesky]
        );
    }

    #[tokio::test]
    async fn the_appview_answers_when_nothing_is_materialised() {
        let stores = FakeStores(None);
        let resolver = FakeResolver::new(None, Some(remote(Some("alice.example"))));
        let result = assembled_profile(&stores, &resolver, "did:plc:abc".to_owned()).await;
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc","handle":"alice.example","displayName":"Alice","avatar":"atblob://did:plc:abc/bafy","description":"bio"}"#
        );
        assert_eq!(
            resolver.calls(),
            vec![ProfileSource::HappyView, ProfileSource::Bluesky]
        );
    }

    #[tokio::test]
    async fn an_unknown_did_answers_with_its_did_alone() {
        let stores = FakeStores(None);
        let resolver = FakeResolver::new(None, None);
        let result = assembled_profile(&stores, &resolver, "did:plc:abc".to_owned()).await;
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"did":"did:plc:abc"}"#
        );
    }

    #[tokio::test]
    async fn a_did_actor_is_not_resolved_again() {
        let resolver = HttpProfileResolver::new(reqwest::Client::new());
        assert_eq!(
            resolver.actor_to_did("did:plc:abc").await.unwrap(),
            "did:plc:abc"
        );
    }

    #[tokio::test]
    async fn an_unresolvable_handle_is_actor_not_found() {
        let resolver = HttpProfileResolver::new(reqwest::Client::new());
        let error = resolver.actor_to_did("not-a-handle").await.unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.error, "ActorNotFound");
        assert_eq!(error.message, "Could not resolve handle: not-a-handle");
    }
}
