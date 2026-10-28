//! The appserver binary: one process, one role.
//!
//! ```text
//! roomy-appserver [--role all|gateway|worker]
//! ```
//!
//! `all` (the default) is the embedded deployment: the gateway and its space
//! workers share this process, and they still talk through the same seams a
//! split deployment uses — the change feed, the global sink, the signal sink —
//! so `gateway` and `worker` are the same code with one half switched off, not a
//! second implementation.
//!
//! Configuration is environment only, and it is read here rather than in the
//! crates. Every variable has a default that makes `all` work against a local
//! data directory:
//!
//! ```text
//! ROOMY_DATA_DIR       data            per-space and global files live under here
//! ROOMY_EVENTS_DB      —               the event log this process reads;
//!                                     defaults to `ROOMY_DATA_DIR/roomy-events.sqlite`
//! ROOMY_HTTP_ADDR      127.0.0.1:8080  the gateway's listener
//! ROOMY_HEALTH_ADDR    —               a supervisor's `/health` listener; the
//!                                     gateway role serves its own and ignores it
//! ROOMY_SPACES         —               comma-separated space DIDs to own
//! ROOMY_TICKET_SECRET  —               required by the gateway role
//! ROOMY_TICKET_TTL     60              a ticket's lifetime, in seconds
//! ROOMY_TICKET_AUDIENCE roomy-gateway  the audience a ticket is bound to
//! ROOMY_TEST_MODE      —               `true` enables `X-Test-Did`
//! ROOMY_INTERNAL_SECRET —              the shared secret for `/internal/feed`; a
//!                                     gateway that sets it serves its log to
//!                                     workers on other machines
//! ROOMY_FEED_URL       —               the gateway whose log this worker reads;
//!                                     unset reads this machine's SQLite file
//! ROOMY_SIGNAL_URL     —               the gateway this worker's signals go to;
//!                                     unset keeps them in this process
//! ROOMY_OWNERSHIP      owner           `follower` replays beside the owner and
//!                                     serves reads without taking a lease
//! ROOMY_TS_ORIGIN      —               the TypeScript appserver; when set, spaces
//!                                     not yet cut over are proxied to it
//! ROOMY_SHADOW_PERCENT 0               how many eligible reads to mirror to it
//! ALLOY_URL            —               the Alloy Loki push URL; unset logs to
//!                                     stdout only
//! APP_ENV              —               the `env` log label; falls back to
//!                                     RAILWAY_ENVIRONMENT_NAME, then `unknown`
//! BUILD_ID             —               the `build_id` log field; `unknown` when
//!                                     unset (the image bakes it from the commit)
//! ```
//!
//! A path that is set but blank counts as unset, so a deployment template that
//! renders an empty value falls through to the default.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::cutover::{MaterialisationOwners, OwnerStore, ShadowConfig, SqliteOwnerStore};
use roomy_gateway::internal::{FeedService, INTERNAL_HEADER};
use roomy_gateway::traffic::Traffic;
use roomy_gateway::{cache, router, GatewaySignals, GatewayState};
use roomy_space_worker::relay::RelaySignals;
use roomy_space_worker::signal::SignalSink;
use roomy_space_worker::supervisor::{FeedFactory, Ownership, SignalFactory};
use roomy_space_worker::{Supervisor, SupervisorConfig};
use space_core::ids::SpaceDid;
use space_feed::http::{HttpChangeFeed, UreqPull};
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::ChangeFeed;
use space_xrpc::registry::{SpaceRegistry, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::{GatewayServiceAuth, TestMode};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

mod health;
mod loki;

use loki::{LokiLayer, LokiSink};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    All,
    Gateway,
    Worker,
}

struct Config {
    role: Role,
    data_dir: PathBuf,
    /// The event log this process reads. It defaults to the log in its own data
    /// directory, and is set elsewhere when the log belongs to another process:
    /// that is what lets a follower replay production without writing beside it.
    events_db: PathBuf,
    http_addr: SocketAddr,
    /// Where a supervisor's `/health` is served. `None` binds nothing.
    health_addr: Option<SocketAddr>,
    spaces: Vec<SpaceDid>,
    ticket_secret: Vec<u8>,
    ticket_ttl: u64,
    ticket_audience: String,
    test_mode: bool,
    max_open_spaces: usize,
    /// Serves this process's event log to workers on other machines. Unset keeps
    /// the endpoint unmounted.
    internal_secret: Option<String>,
    /// Where this worker pulls its changes from, when it does not own the log.
    feed_url: Option<String>,
    /// Where this worker relays its post-commit signals, when the sockets that
    /// need them are in another process.
    signal_url: Option<String>,
    /// The TypeScript appserver this gateway proxies to and mirrors against.
    ts_origin: Option<String>,
    /// The percentage of reads mirrored to it for comparison.
    shadow_percent: u8,
}

fn main() {
    // The format layer writes the line an operator reads in `docker logs`, and
    // the Loki layer writes the same events to Grafana when `ALLOY_URL` names an
    // Alloy. Unset, the layer is disabled and costs a branch.
    let loki = LokiSink::from_env();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(LokiLayer::new(loki.clone()))
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };

    if let Err(error) = run(config, loki) {
        tracing::error!(%error, "appserver");
        std::process::exit(1);
    }
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let mut role = Role::All;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--role" => {
                    role = match args.next().as_deref() {
                        Some("all") => Role::All,
                        Some("gateway") => Role::Gateway,
                        Some("worker") => Role::Worker,
                        other => return Err(format!("unknown role: {other:?}")),
                    }
                }
                "-h" | "--help" => {
                    println!("usage: roomy-appserver [--role all|gateway|worker]");
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }

        let data_dir = PathBuf::from(var("ROOMY_DATA_DIR").unwrap_or_else(|| "data".into()));
        let events_db = resolve_events_db(&data_dir, var("ROOMY_EVENTS_DB"));
        let health_addr = resolve_health_addr(var("ROOMY_HEALTH_ADDR"))?;
        let http_addr: SocketAddr = var("ROOMY_HTTP_ADDR")
            .unwrap_or_else(|| "127.0.0.1:8080".into())
            .parse()
            .map_err(|error| format!("ROOMY_HTTP_ADDR is not an address: {error}"))?;
        let spaces: Vec<SpaceDid> = var("ROOMY_SPACES")
            .map(|spaces| {
                spaces
                    .split(',')
                    .map(str::trim)
                    .filter(|space| !space.is_empty())
                    .map(|space| {
                        SpaceDid::parse(space.to_string())
                            .map_err(|_| format!("ROOMY_SPACES: {space} is not a DID"))
                    })
                    .collect()
            })
            .transpose()?
            .unwrap_or_default();
        let ticket_secret = var("ROOMY_TICKET_SECRET").unwrap_or_default();
        if role != Role::Worker && ticket_secret.is_empty() {
            return Err("ROOMY_TICKET_SECRET is required for the gateway".to_string());
        }
        let ticket_ttl = var("ROOMY_TICKET_TTL")
            .map(|ttl| {
                ttl.parse()
                    .map_err(|_| "ROOMY_TICKET_TTL is not a number".to_string())
            })
            .transpose()?
            .unwrap_or(60);
        let max_open_spaces = var("ROOMY_MAX_OPEN_SPACES")
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| "ROOMY_MAX_OPEN_SPACES is not a number".to_string())
            })
            .transpose()?
            .unwrap_or(256);

        let internal_secret = var("ROOMY_INTERNAL_SECRET").filter(|secret| !secret.is_empty());
        let feed_url = var("ROOMY_FEED_URL").filter(|url| !url.is_empty());
        if feed_url.is_some() && role != Role::Worker {
            return Err("ROOMY_FEED_URL is for a worker; a gateway reads the log it owns".into());
        }
        let signal_url = var("ROOMY_SIGNAL_URL").filter(|url| !url.is_empty());
        if signal_url.is_some() && role != Role::Worker {
            return Err(
                "ROOMY_SIGNAL_URL is for a worker; a gateway fans signals out locally".into(),
            );
        }

        let ts_origin = var("ROOMY_TS_ORIGIN");
        let shadow_percent = var("ROOMY_SHADOW_PERCENT")
            .map(|value| {
                value
                    .parse::<u8>()
                    .map(|percent| percent.min(100))
                    .map_err(|_| "ROOMY_SHADOW_PERCENT is not a number".to_string())
            })
            .transpose()?
            .unwrap_or(0);

        Ok(Self {
            role,
            data_dir,
            events_db,
            http_addr,
            health_addr,
            spaces,
            ticket_secret: ticket_secret.into_bytes(),
            ticket_ttl,
            ticket_audience: var("ROOMY_TICKET_AUDIENCE").unwrap_or_else(|| "roomy-gateway".into()),
            test_mode: var("ROOMY_TEST_MODE").as_deref() == Some("true"),
            max_open_spaces,
            internal_secret,
            feed_url,
            signal_url,
            ts_origin,
            shadow_percent,
        })
    }

    fn spaces_dir(&self) -> PathBuf {
        self.data_dir.join("spaces")
    }

    fn events_db(&self) -> PathBuf {
        self.events_db.clone()
    }

    fn global_db(&self) -> PathBuf {
        self.data_dir.join("global.sqlite")
    }
}

/// The file a data directory keeps its log in, when `ROOMY_EVENTS_DB` names no
/// other.
const EVENTS_DB_FILE: &str = "roomy-events.sqlite";

/// The log this process reads.
///
/// A configured path is trimmed, and one that is blank is absent: a deployment
/// template that renders an empty value falls through to the default rather than
/// opening a file named nothing.
fn resolve_events_db(data_dir: &Path, configured: Option<String>) -> PathBuf {
    match configured
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => PathBuf::from(path),
        None => data_dir.join(EVENTS_DB_FILE),
    }
}

/// The address a supervisor serves `/health` on. Unset — or blank, by the same
/// rule — binds nothing.
fn resolve_health_addr(configured: Option<String>) -> Result<Option<SocketAddr>, String> {
    match configured
        .as_deref()
        .map(str::trim)
        .filter(|addr| !addr.is_empty())
    {
        Some(addr) => addr
            .parse()
            .map(Some)
            .map_err(|error| format!("ROOMY_HEALTH_ADDR is not an address: {error}")),
        None => Ok(None),
    }
}

fn run(config: Config, loki: Option<Arc<LokiSink>>) -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        // The sink's HTTP client lives on this runtime, so the flusher does too.
        let flusher = loki.as_ref().and_then(|sink| sink.spawn());

        // One sink for the process: a worker's committed batch and the sockets
        // that must be woken share it, whether or not the two roles are the same
        // binary invocation.
        let signals = GatewaySignals::new(1024);

        // The workers first: an embedded gateway that starts before its spaces
        // have a projection would serve reads from empty databases.
        let supervisor = if config.role != Role::Gateway {
            let signals = signals.clone();
            let supervisor = Supervisor::new(supervisor_config(&config))
                .with_signals(signal_factory(&config, signals.clone()))
                .with_feed(feed_factory(&config));
            supervisor.start_all(config.spaces.clone())?;
            Some(Arc::new(supervisor))
        } else {
            None
        };

        // A supervisor's health is served on its own listener, because the worker
        // role binds no other: a follower that is falling behind has to be
        // observable. The gateway role has no supervisor, and serves `/health`
        // itself.
        let health_task = match (&config.health_addr, &supervisor) {
            (Some(addr), Some(supervisor)) => {
                let listener = tokio::net::TcpListener::bind(addr).await?;
                let supervisor = Arc::clone(supervisor);
                Some(tokio::spawn(health::serve(listener, supervisor)))
            }
            _ => None,
        };

        if config.role != Role::Worker {
            let state = gateway_state(&config, signals)?;
            let eviction = cache::spawn_eviction(Arc::clone(&state));
            let app = router(state);
            let listener = tokio::net::TcpListener::bind(config.http_addr).await?;
            tracing::info!(address = %config.http_addr, "gateway listening");
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
            eviction.abort();
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }

        if let Some(task) = health_task {
            task.abort();
        }
        if let Some(supervisor) = supervisor {
            supervisor.stop();
        }

        // ctrl-c, or the gateway's graceful shutdown after it: take the queue's
        // tail and the last few log lines with us, bounded so a dead Alloy cannot
        // hold the exit open.
        if let Some(sink) = loki.as_ref() {
            sink.flush(loki::SHUTDOWN_FLUSH).await;
        }
        if let Some(flusher) = flusher {
            flusher.abort();
        }
        Ok(())
    })
}

fn supervisor_config(config: &Config) -> SupervisorConfig {
    SupervisorConfig {
        events_db: config.events_db(),
        global_db: config.global_db(),
        spaces_dir: config.spaces_dir(),
        holder: format!(
            "{}#{}",
            std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".into()),
            std::process::id()
        ),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(250),
        batch_limit: 500,
        // A process owning more spaces than it is busy with keeps them open
        // only while they have work.
        idle_unload: Some(Duration::from_secs(600)),
        ownership: match std::env::var("ROOMY_OWNERSHIP").as_deref() {
            Ok("follower") => Ownership::Follower,
            _ => Ownership::Owner,
        },
    }
}

fn gateway_state(
    config: &Config,
    signals: GatewaySignals,
) -> Result<Arc<GatewayState>, Box<dyn std::error::Error>> {
    let registry = Arc::new(SpaceRegistry::new(
        config.spaces_dir(),
        Some(config.global_db()),
        config.max_open_spaces,
    ));
    // The router needs one database to hold; every request resolves its own
    // from the registry before a handler runs.
    let placeholder =
        match config.spaces.first() {
            Some(space) => registry.resolve_space(space.as_str()).unwrap_or(Arc::new(
                SpaceReadDb::open_readonly(registry.path_of(space.as_str()))?,
            )),
            None => {
                let path = config.spaces_dir().join("placeholder.sqlite");
                if !path.exists() {
                    // An empty, schema-less database: no request is answered from
                    // it, because none resolves to it.
                    std::fs::create_dir_all(config.spaces_dir())?;
                    rusqlite::Connection::open(&path)?;
                }
                Arc::new(SpaceReadDb::open_readonly(&path)?)
            }
        };

    let verifier: Arc<dyn space_xrpc::verify::CallerVerifier> = if config.test_mode {
        Arc::new(TestMode)
    } else {
        let gateway_did = std::env::var("ROOMY_GATEWAY_DID")?;
        let worker_did = std::env::var("ROOMY_WORKER_DID")?;
        let jwk = serde_json::from_str(&std::env::var("ROOMY_GATEWAY_JWK")?)?;
        Arc::new(GatewayServiceAuth::new(gateway_did, worker_did, &jwk)?)
    };

    let reads = XrpcState::new(placeholder, verifier)
        .with_spaces(Arc::clone(&registry) as Arc<dyn SpaceResolver>);

    let state = GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(
            config.ticket_secret.clone(),
            config.ticket_audience.clone(),
            config.ticket_ttl,
        )),
        Arc::new(TicketVerifier::new(
            config.ticket_secret.clone(),
            config.ticket_audience.clone(),
            Box::new(InMemoryNonces::new()),
        )),
        signals,
    );
    // A gateway that owns the log serves it; one that does not leaves the route
    // unmounted rather than answering an empty feed.
    let state = match &config.internal_secret {
        Some(secret) => state
            .with_internal_secret(secret.clone())
            .with_feed(FeedService::open(config.events_db())?),
        None => state,
    };
    let state = match (&config.ts_origin, config.role) {
        (Some(origin), _) => {
            let owners = Arc::new(MaterialisationOwners::new(Box::new(SqliteOwnerStore::open(
                config.global_db(),
            )?)
                as Box<dyn OwnerStore>));
            state.with_traffic(Traffic::new(
                origin.clone(),
                owners,
                ShadowConfig {
                    sample_percent: config.shadow_percent,
                    seed: 0,
                    eligible_nsids: Vec::new(),
                    ..ShadowConfig::default()
                },
            ))
        }
        (None, _) => state,
    };
    Ok(Arc::new(state))
}

/// Where this process's signals go: to the gateway in this process, or to the one
/// that serves the sockets.
fn signal_factory(config: &Config, signals: GatewaySignals) -> SignalFactory {
    match &config.signal_url {
        Some(url) => {
            let url = url.clone();
            let secret = config.internal_secret.clone();
            Arc::new(move || {
                Box::new(RelaySignals::new(url.clone(), secret.clone())) as Box<dyn SignalSink>
            })
        }
        None => Arc::new(move || Box::new(signals.clone()) as Box<dyn SignalSink>),
    }
}

/// Where this process reads its changes from: the log it owns, or the owner's
/// endpoint when the log lives on another machine.
fn feed_factory(config: &Config) -> FeedFactory {
    match &config.feed_url {
        Some(url) => {
            let url = url.clone();
            let secret = config.internal_secret.clone();
            Arc::new(move || {
                let mut pull = UreqPull::default();
                if let Some(secret) = &secret {
                    pull = pull.with_header(INTERNAL_HEADER, secret);
                }
                Ok(Box::new(HttpChangeFeed::new(url.clone(), pull)) as Box<dyn ChangeFeed>)
            })
        }
        None => {
            let events_db = config.events_db();
            Arc::new(move || {
                Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn ChangeFeed>)
            })
        }
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{resolve_events_db, resolve_health_addr};
    use std::net::SocketAddr;
    use std::path::{Path, PathBuf};

    fn data_dir() -> PathBuf {
        PathBuf::from("/shadow")
    }

    #[test]
    fn a_log_beside_the_data_dir_is_the_default() {
        assert_eq!(
            resolve_events_db(&data_dir(), None),
            data_dir().join("roomy-events.sqlite")
        );
    }

    #[test]
    fn a_configured_log_is_opened_where_it_is() {
        assert_eq!(
            resolve_events_db(&data_dir(), Some("/data/roomy-events.sqlite".to_string())),
            PathBuf::from("/data/roomy-events.sqlite")
        );
        // Surrounding space is the template's, not the path's.
        assert_eq!(
            resolve_events_db(&data_dir(), Some("  /data/log.sqlite\n".to_string())),
            PathBuf::from("/data/log.sqlite")
        );
    }

    #[test]
    fn a_blank_log_path_falls_through_to_the_default() {
        for blank in ["", " ", "\t", "  \n "] {
            assert_eq!(
                resolve_events_db(&data_dir(), Some(blank.to_string())),
                data_dir().join("roomy-events.sqlite"),
                "{blank:?} is not a path"
            );
        }
    }

    #[test]
    fn an_unset_health_address_binds_nothing() {
        assert_eq!(resolve_health_addr(None), Ok(None));
        for blank in ["", "   ", "\n"] {
            assert_eq!(resolve_health_addr(Some(blank.to_string())), Ok(None));
        }
    }

    #[test]
    fn a_configured_health_address_is_where_it_binds() {
        assert_eq!(
            resolve_health_addr(Some(" 127.0.0.1:9090 ".to_string())),
            Ok(Some(
                "127.0.0.1:9090".parse::<SocketAddr>().expect("an address")
            ))
        );
        assert!(resolve_health_addr(Some("127.0.0.1".to_string())).is_err());
    }

    /// The deployment this exists for: the log stays the owner's file, and the
    /// data directory is the follower's own.
    #[test]
    fn a_configured_log_sits_outside_the_data_dir() {
        let data = Path::new("/shadow");
        let log = resolve_events_db(data, Some("/data/roomy-events.sqlite".to_string()));
        assert!(
            !log.starts_with(data),
            "{} is inside {}",
            log.display(),
            data.display()
        );
    }
}
