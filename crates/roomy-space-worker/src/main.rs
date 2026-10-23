//! The space worker process: configuration, the loop, and `/health`.
//!
//! One process owns one space. It takes the space's lease, materialises from
//! the change feed until told to stop, and answers `/health` while it does.

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use roomy_space_worker::config::Config;
use roomy_space_worker::feed::SqliteChangeFeed;
use roomy_space_worker::lease::SqliteLease;
use roomy_space_worker::sink::SqliteGlobalSink;
use roomy_space_worker::worker::{Progress, Worker, WorkerParts};
use space_db::SpaceDb;

/// Set by the signal handler; read once per iteration.
static STOP: AtomicBool = AtomicBool::new(false);

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(%error, "configuration");
            std::process::exit(2);
        }
    };

    let db = match SpaceDb::open(&config.space_db, config.space.clone()) {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, path = %config.space_db.display(), "opening the space database");
            std::process::exit(2);
        }
    };
    let feed = SqliteChangeFeed::open(&config.events_db).expect("open the change feed");
    let lease = SqliteLease::open(&config.global_db).expect("open the global database");
    let sink = SqliteGlobalSink::open(&config.global_db).expect("open the global database");

    let mut worker = Worker::new(WorkerParts {
        space: config.space.clone(),
        holder: config.holder.clone(),
        lease_ttl: config.lease_ttl,
        batch_limit: config.batch_limit,
        feed,
        lease,
        sink,
        db,
    });

    // Ctrl-C stops the loop; the space DB stays where the last committed batch
    // put it, and the lease is handed back so another worker takes over.
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            STOP.store(true, Ordering::Relaxed);
            tracing::info!("stopping after the current batch");
        }
    });

    let health = Arc::new(Mutex::new(worker.health()));
    let listener = TcpListener::bind(&config.http_addr).expect("bind the health listener");
    serve_health(listener, Arc::clone(&health));

    // The loop runs here; `/health` reads a snapshot refreshed after every
    // batch, so a slow batch never blocks the answer.
    while !STOP.load(Ordering::Relaxed) {
        let progress = worker.step();
        match &progress {
            Ok(Progress::Applied {
                cursor,
                entries,
                changes,
            }) => {
                tracing::info!(idx = cursor.0, ord = cursor.1, entries, changes, "applied");
            }
            Ok(Progress::NotLeased) => tracing::debug!("another process holds the lease"),
            Ok(Progress::Idle { .. }) => {}
            Err(error) => tracing::warn!(%error, "batch failed"),
        }

        if let Ok(mut snapshot) = health.lock() {
            *snapshot = worker.health();
        }

        // A full batch means there may be more behind it; anything else waits.
        if !matches!(progress, Ok(Progress::Applied { .. })) {
            tokio::time::sleep(config.idle_poll).await;
        }
    }

    worker.release();
}

/// Answer `GET /health` from a shared snapshot.
fn serve_health(listener: TcpListener, health: Arc<Mutex<roomy_space_worker::health::Health>>) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let health = Arc::clone(&health);
            std::thread::spawn(move || {
                let mut stream = stream;
                let body = health
                    .lock()
                    .map(|health| health.to_json())
                    .unwrap_or_else(|_| "{}".to_string());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                use std::io::Write as _;
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
}
