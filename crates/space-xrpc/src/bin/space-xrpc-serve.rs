//! Serve one space's XRPC reads for manual verification.
//!
//! ```text
//! space-xrpc-serve --db data/spaces/<spaceDid>.sqlite [--global-db data/global.sqlite] [--port 8090]
//! ```
//!
//! `SPACE_WORKER_TEST_MODE=true` enables `X-Test-Did`; otherwise
//! `SPACE_WORKER_GATEWAY_DID`, `SPACE_WORKER_DID` and
//! `SPACE_WORKER_GATEWAY_JWK` must be set for gateway service auth.

use std::sync::Arc;

use space_xrpc::state::{SpaceDb, XrpcState};
use space_xrpc::store::{GlobalStores, SqliteGlobalStores};
use space_xrpc::verify::verifier_from_env;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let mut db_path: Option<String> = None;
    let mut global_path: Option<String> = None;
    let mut port: u16 = 8090;
    let mut bind = "127.0.0.1".to_owned();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next(),
            "--global-db" => global_path = args.next(),
            "--port" => {
                port = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(|| usage("--port needs a number"))
            }
            "--bind" => {
                bind = args
                    .next()
                    .unwrap_or_else(|| usage("--bind needs an address"))
            }
            "-h" | "--help" => usage(""),
            other => usage(&format!("unknown argument: {other}")),
        }
    }

    let db_path = db_path.unwrap_or_else(|| usage("--db is required"));
    let db = match SpaceDb::open_readonly(&db_path) {
        Ok(db) => Arc::new(db),
        Err(err) => {
            eprintln!("cannot open {db_path}: {err}");
            std::process::exit(1);
        }
    };
    let verifier = verifier_from_env().unwrap_or_else(|err| usage(&err));

    let mut state = XrpcState::new(db, verifier);
    if let Some(path) = global_path {
        match SqliteGlobalStores::open(&path) {
            Ok(stores) => {
                state = state.with_stores(Arc::new(stores) as Arc<dyn GlobalStores>);
            }
            Err(err) => {
                eprintln!("cannot open {path}: {err}");
                std::process::exit(1);
            }
        }
    }

    let app = space_xrpc::router(state);
    let address = format!("{bind}:{port}");
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("cannot bind {address}: {err}");
            std::process::exit(1);
        }
    };
    tracing::info!("space-xrpc listening on http://{address}");
    if let Err(err) = axum::serve(listener, app).await {
        eprintln!("server error: {err}");
        std::process::exit(1);
    }
}

fn usage(message: &str) -> ! {
    if !message.is_empty() {
        eprintln!("{message}");
    }
    eprintln!(
        "usage: space-xrpc-serve --db <space.sqlite> [--global-db <global.sqlite>] [--port <port>] [--bind <addr>]"
    );
    std::process::exit(if message.is_empty() { 0 } else { 2 })
}
