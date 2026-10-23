//! Configuration, parsed once from TOML.
//!
//! TOML is deployment only: values true for the whole process, never
//! per-bridge. Which space a Matrix room is bridged into is a row in the
//! bridge's SQLite, created through the admin API, because it changes at
//! runtime and a config edit should not be required to add a portal.

use std::path::PathBuf;

use serde::Deserialize;

/// The whole bridge configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub homeserver: HomeserverConfig,
    pub bridge: BridgeConfig,
    pub appserver: AppserverConfig,
    pub atproto: AtprotoConfig,
}

/// The homeserver the bridge is an appservice of.
#[derive(Debug, Clone, Deserialize)]
pub struct HomeserverConfig {
    /// Base URL, e.g. `http://synapse:8008`.
    pub url: String,
    /// The server name, e.g. `matrix.roomy.local`. Ghost MXIDs end in this.
    pub domain: String,
    /// Token the bridge presents to the homeserver.
    pub as_token: String,
    /// Token the homeserver presents on each transaction. Verified on every
    /// push; an unverified transaction would let anyone write messages.
    pub hs_token: String,
    /// The localpart of the appservice's own user.
    pub sender_localpart: String,
}

/// The bridge process itself.
#[derive(Debug, Clone, Deserialize)]
pub struct BridgeConfig {
    /// Address the appservice's HTTP server binds, e.g. `0.0.0.0:29331`.
    pub listen: String,
    /// Path to the bridge's SQLite database.
    pub db_path: PathBuf,
    /// The bridge's own ATProto DID, which is every admin token's `aud`.
    pub bridge_did: String,
    /// The hostname ghost MXIDs live under.
    pub hostname: String,
    /// The URL the homeserver pushes transactions to, derived from `listen`
    /// when unset.
    ///
    /// This is the address *as the homeserver reaches it*, which the listen
    /// address cannot answer: `0.0.0.0:29331` is not reachable from another
    /// container, and `--check-homeserver` writes a registration the homeserver
    /// under test has to call back on. Getting it wrong means the probe reports
    /// "no transaction arrived" instead of a measurement.
    #[serde(default)]
    pub transaction_url: Option<String>,
    /// The namespace prefix for ghosts, matching the registration.
    #[serde(default = "default_ghost_prefix")]
    pub ghost_prefix: String,
    /// How many recent Matrix messages a new portal backfills before going
    /// live. The rest arrives in the background.
    #[serde(default = "default_backfill_limit")]
    pub backfill_limit: u32,
    /// The deepest Matrix hierarchy level bridged as a thread before further
    /// levels flatten into the nearest thread.
    #[serde(default = "default_max_depth")]
    pub max_depth: u32,
    #[serde(default)]
    pub e2ee: E2eeConfig,
}

fn default_ghost_prefix() -> String {
    "_roomy".into()
}

fn default_backfill_limit() -> u32 {
    50
}

fn default_max_depth() -> u32 {
    2
}

impl BridgeConfig {
    /// The URL the homeserver pushes transactions to.
    ///
    /// Explicit config wins. Otherwise the listen address is reused with
    /// `localhost` substituted for a wildcard bind, which is right for a
    /// single-host deployment and wrong across a container network — which is
    /// why the field exists.
    pub fn transactions_url(&self) -> String {
        if let Some(url) = &self.transaction_url {
            return url.trim_end_matches('/').to_string();
        }
        let listen = self.listen.replace("0.0.0.0", "localhost");
        let listen = listen.replace("[::]", "localhost");
        format!("http://{listen}")
    }
}

/// Encryption settings.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct E2eeConfig {
    /// `off` never enables encryption; `preferred` enables it when the
    /// homeserver probe passes; `required` refuses to start when it does not.
    #[serde(default = "default_e2ee_mode")]
    pub mode: E2eeMode,
    /// Where the crypto store lives. Defaults to a sibling of the bridge
    /// database, because the store *is* the bridge device: losing it means
    /// losing every room key the bridge has received.
    #[serde(default)]
    pub store_path: Option<PathBuf>,
}

impl E2eeConfig {
    /// The crypto store's path for a bridge whose database is at `db_path`.
    pub fn crypto_store_path(&self, db_path: &std::path::Path) -> PathBuf {
        self.store_path
            .clone()
            .unwrap_or_else(|| db_path.with_file_name("crypto-store.sqlite"))
    }
}

fn default_e2ee_mode() -> E2eeMode {
    E2eeMode::Preferred
}

impl Default for E2eeConfig {
    fn default() -> Self {
        Self {
            mode: default_e2ee_mode(),
            store_path: None,
        }
    }
}

/// How badly the bridge wants encryption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum E2eeMode {
    /// Never encrypt. Encrypted rooms are refused at configuration time.
    Off,
    /// Encrypt when the homeserver probe passes; otherwise run without.
    Preferred,
    /// Require the probe to pass, and refuse to start when it does not.
    Required,
}

/// The Roomy appserver.
#[derive(Debug, Clone, Deserialize)]
pub struct AppserverConfig {
    /// Base URL, e.g. `https://api.roomy.space`.
    pub url: String,
    /// The appserver's DID, which is every service-auth token's audience.
    pub did: String,
    /// WebSocket origin for the sync socket. Defaults to `url` with the scheme
    /// switched to `ws`.
    #[serde(default)]
    pub ws_url: Option<String>,
    /// The DID to address the appserver as, without a service-auth JWT.
    ///
    /// Only meaningful against an appserver started with `APPSERVER_TEST_MODE`,
    /// where the `X-Test-Did` header is the whole of authentication. A
    /// deployment must never set it: presenting an unnamed DID to a production
    /// appserver is refused, but relying on that refusal is not a design.
    #[serde(default, deserialize_with = "empty_as_none")]
    pub test_did: Option<String>,
}

/// Treat an empty string as absent.
///
/// The container entrypoint always writes this key, empty for a real
/// deployment, so `Some("")` must not read as a DID to authenticate as.
fn empty_as_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value.filter(|value| !value.trim().is_empty()))
}

impl AppserverConfig {
    /// The WebSocket origin, derived from `url` when unset.
    pub fn websocket_origin(&self) -> String {
        self.ws_url.clone().unwrap_or_else(|| {
            if let Some(rest) = self.url.strip_prefix("https://") {
                format!("wss://{rest}")
            } else if let Some(rest) = self.url.strip_prefix("http://") {
                format!("ws://{rest}")
            } else {
                self.url.clone()
            }
        })
    }
}

/// The ATProto identity the bridge runs as.
#[derive(Debug, Clone, Deserialize)]
pub struct AtprotoConfig {
    /// The PDS the bridge's session lives on.
    pub pds_url: String,
    /// Handle or DID, for `createSession`.
    pub identifier: String,
    /// App password.
    pub app_password: String,
}

/// Configuration could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}

impl Config {
    /// Read and parse a TOML configuration file.
    pub fn load(path: impl AsRef<std::path::Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref().to_path_buf();
        let text = std::fs::read_to_string(&path).map_err(|source| ConfigError::Read {
            path: path.clone(),
            source,
        })?;
        toml::from_str(&text).map_err(|source| ConfigError::Parse { path, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[homeserver]
url = "http://synapse:8008"
domain = "matrix.roomy.local"
as_token = "as"
hs_token = "hs"
sender_localpart = "_roomy_bridge"

[bridge]
listen = "0.0.0.0:29331"
db_path = "/data/bridge.sqlite"
bridge_did = "did:web:bridge.roomy.space"
hostname = "matrix.roomy.local"

[appserver]
url = "https://api.roomy.space"
did = "did:web:api.roomy.space"

[atproto]
pds_url = "https://bsky.social"
identifier = "bridge.roomy.space"
app_password = "xxxx"
"#;

    #[test]
    fn a_minimal_config_parses_with_defaults() {
        let config: Config = toml::from_str(SAMPLE).unwrap();
        assert_eq!(config.bridge.ghost_prefix, "_roomy");
        assert_eq!(config.bridge.backfill_limit, 50);
        assert_eq!(config.bridge.max_depth, 2);
        assert_eq!(config.bridge.e2ee.mode, E2eeMode::Preferred);
    }

    #[test]
    fn the_websocket_origin_is_derived_from_the_http_url() {
        let config: Config = toml::from_str(SAMPLE).unwrap();
        assert_eq!(config.appserver.websocket_origin(), "wss://api.roomy.space");
    }

    #[test]
    fn an_explicit_websocket_origin_wins() {
        let text = SAMPLE.replace(
            "did = \"did:web:api.roomy.space\"",
            "did = \"did:web:api.roomy.space\"\nws_url = \"ws://127.0.0.1:8080\"",
        );
        let config: Config = toml::from_str(&text).unwrap();
        assert_eq!(config.appserver.websocket_origin(), "ws://127.0.0.1:8080");
    }

    #[test]
    fn an_empty_test_did_is_the_same_as_unset() {
        // The container entrypoint always writes this key. An empty value must
        // not read as a DID to authenticate as, or a real deployment would
        // address its appserver with an empty header.
        let text = SAMPLE.replace(
            "did = \"did:web:api.roomy.space\"",
            "did = \"did:web:api.roomy.space\"\ntest_did = \"\"",
        );
        let config: Config = toml::from_str(&text).unwrap();
        assert!(config.appserver.test_did.is_none());

        let text = SAMPLE.replace(
            "did = \"did:web:api.roomy.space\"",
            "did = \"did:web:api.roomy.space\"\ntest_did = \"did:plc:test\"",
        );
        let config: Config = toml::from_str(&text).unwrap();
        assert_eq!(config.appserver.test_did.as_deref(), Some("did:plc:test"));
    }

    #[test]
    fn an_unknown_e2ee_mode_is_refused() {
        let text = SAMPLE.replace(
            "[atproto]",
            "[bridge.e2ee]\nmode = \"sometimes\"\n\n[atproto]",
        );
        assert!(toml::from_str::<Config>(&text).is_err());
    }
}
