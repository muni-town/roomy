//! Configuration, from the environment.
//!
//! Everything a worker needs to be started: which space it owns, where its
//! files are, and who it says it is on the lease. One space per process is
//! deliberate — the lease is per space, so a process that owned several would
//! serialise them against itself for no reason.

use std::path::PathBuf;
use std::time::Duration;

use space_core::ids::SpaceDid;

/// What the process reads at startup.
#[derive(Debug, Clone)]
pub struct Config {
    /// The space this worker materialises.
    pub space: SpaceDid,
    /// Where the per-space database lives.
    pub space_db: PathBuf,
    /// The event-log database, which holds the change feed.
    pub events_db: PathBuf,
    /// The global database: leases in, global statements out.
    pub global_db: PathBuf,
    /// This process's identity on the lease row.
    pub holder: String,
    /// How long a claim stays valid without renewal.
    pub lease_ttl: Duration,
    /// How long to wait between drains when a batch came back full.
    pub idle_poll: Duration,
    /// The most changes one batch may hold.
    pub batch_limit: usize,
    /// Where `/health` listens.
    pub http_addr: String,
}

/// A required variable that is missing or empty.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} is not valid: {message}")]
    Invalid { name: &'static str, message: String },
}

impl Config {
    /// Read the configuration, or say which variable is wrong.
    pub fn from_env() -> Result<Self, ConfigError> {
        let space = value("SPACE_WORKER_SPACE_DID")?;
        let space = SpaceDid::parse(space.clone()).map_err(|_| ConfigError::Invalid {
            name: "SPACE_WORKER_SPACE_DID",
            message: format!("{space} is not a DID"),
        })?;
        let data_dir =
            std::env::var("SPACE_WORKER_DATA_DIR").unwrap_or_else(|_| "data".to_string());
        let data_dir = PathBuf::from(data_dir);

        Ok(Self {
            space: space.clone(),
            space_db: std::env::var("SPACE_WORKER_SPACE_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| data_dir.join("spaces").join(format!("{space}.sqlite"))),
            events_db: std::env::var("SPACE_WORKER_EVENTS_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| data_dir.join("roomy-events.sqlite")),
            global_db: std::env::var("SPACE_WORKER_GLOBAL_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| data_dir.join("global.sqlite")),
            holder: std::env::var("SPACE_WORKER_HOLDER").unwrap_or_else(|_| {
                let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string());
                format!("{host}#{}", std::process::id())
            }),
            lease_ttl: Duration::from_secs(number("SPACE_WORKER_LEASE_TTL_SECS", 30)?),
            idle_poll: Duration::from_millis(number("SPACE_WORKER_IDLE_POLL_MS", 500)?),
            batch_limit: number("SPACE_WORKER_BATCH_LIMIT", 500)? as usize,
            http_addr: std::env::var("SPACE_WORKER_HTTP_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8089".to_string()),
        })
    }
}

fn value(name: &'static str) -> Result<String, ConfigError> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(ConfigError::Missing(name)),
    }
}

fn number(name: &'static str, default: u64) -> Result<u64, ConfigError> {
    match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw.parse().map_err(|_| ConfigError::Invalid {
            name,
            message: format!("{raw} is not a number"),
        }),
        _ => Ok(default),
    }
}
