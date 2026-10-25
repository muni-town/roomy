//! Serve per-space XRPC reads for manual verification.
//!
//! ```text
//! space-xrpc-serve --spaces-dir data/spaces [--global-db data/global.sqlite] [--port 8090]
//! space-xrpc-serve --db data/spaces/<spaceDid>.sqlite
//! ```
//!
//! A directory is served through the registry: `spaceId` names a space and a
//! room or message id resolves through the global `entity_space` index. A single
//! `--db` serves just that space.
//!
//! `SPACE_WORKER_TEST_MODE=true` enables `X-Test-Did`; otherwise
//! `SPACE_WORKER_GATEWAY_DID`, `SPACE_WORKER_DID` and
//! `SPACE_WORKER_GATEWAY_JWK` must be set for gateway service auth.

use std::sync::Arc;

use space_xrpc::registry::{FixedSpaces, SpaceRegistry, SpaceResolver};
use space_xrpc::state::{SpaceReadDb, XrpcState};
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
    let mut spaces_dir: Option<String> = None;
    let mut global_path: Option<String> = None;
    let mut max_open: usize = 256;
    let mut port: u16 = 8090;
    let mut bind = "127.0.0.1".to_owned();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db_path = args.next(),
            "--spaces-dir" => spaces_dir = args.next(),
            "--max-open" => {
                max_open = args
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or_else(|| usage("--max-open needs a number"))
            }
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

    let verifier = verifier_from_env().unwrap_or_else(|err| usage(&err));
    let (spaces, placeholder): (Arc<dyn SpaceResolver>, Arc<SpaceReadDb>) =
        match (spaces_dir, db_path) {
            (Some(dir), None) => {
                let registry = SpaceRegistry::new(
                    &dir,
                    global_path.clone().map(std::path::PathBuf::from),
                    max_open,
                );
                let first = registry.open_spaces().first().cloned().or_else(|| {
                    std::fs::read_dir(&dir).ok().and_then(|entries| {
                        entries.filter_map(|entry| entry.ok()).find_map(|entry| {
                            entry
                                .path()
                                .file_stem()
                                .map(|stem| stem.to_string_lossy().into_owned())
                        })
                    })
                });
                let placeholder = match first.and_then(|space| registry.resolve_space(&space)) {
                    Some(db) => db,
                    None => usage(&format!("no space database under {dir}")),
                };
                (Arc::new(registry), placeholder)
            }
            (None, Some(path)) => {
                let db = match SpaceReadDb::open_readonly(&path) {
                    Ok(db) => Arc::new(db),
                    Err(err) => {
                        eprintln!("cannot open {path}: {err}");
                        std::process::exit(1);
                    }
                };
                let space = space_xrpc::registry::space_of_path(std::path::Path::new(&path));
                let fixed = FixedSpaces::new([(space, Arc::clone(&db))]);
                (Arc::new(fixed), db)
            }
            _ => usage("pass exactly one of --db or --spaces-dir"),
        };

    let mut state = XrpcState::new(placeholder, verifier).with_spaces(spaces);
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
