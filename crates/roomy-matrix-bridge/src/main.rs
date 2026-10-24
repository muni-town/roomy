//! The bridge binary.
//!
//! Two modes:
//!
//! * **serve** (default) — run the appservice, the admin API, and the
//!   supervisor.
//! * **`--check-homeserver`** — run the capability probe alone and print its
//!   verdict per MSC, which is how an operator decides whether a homeserver can
//!   carry encryption before deploying it.

mod admin;
mod auth;
mod check;
mod config;
mod db;
#[cfg(feature = "e2ee")]
mod encrypting_sender;
mod outbound;
mod probe;
mod relay;
mod server;
mod supervisor;

use std::sync::Arc;

use bridge_core::{BridgeState, MatrixDeviceId, MissingFeature, SpaceDid};
use clap::Parser;
use config::{Config, E2eeMode};
use matrix_adapter::{AsToken, HsToken, Tokens};
use probe::ProbeState;
use supervisor::EncryptionSupport;

/// Command-line arguments.
#[derive(Debug, Parser)]
#[command(
    name = "roomy-matrix-bridge",
    about = "Bidirectional Roomy <-> Matrix bridge"
)]
struct Cli {
    /// Path to the TOML configuration file.
    #[arg(
        long,
        env = "BRIDGE_CONFIG",
        default_value = "/etc/roomy-matrix-bridge/config.toml"
    )]
    config: std::path::PathBuf,

    /// Probe the homeserver's appservice encryption capabilities and exit.
    ///
    /// Reports pass/fail for msc4190-devices, msc2409-ephemeral,
    /// msc4203-to-device and the three MSC3202 fields. Exits non-zero when a
    /// feature encryption needs fails, so a container healthcheck can use it
    /// directly.
    #[arg(long)]
    check_homeserver: bool,

    /// Print the registration file the homeserver needs and exit.
    #[arg(long)]
    print_registration: bool,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let config = match Config::load(&cli.config) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    if cli.check_homeserver {
        return check::run(&config).await;
    }

    if cli.print_registration {
        return print_registration(&config);
    }

    serve(config).await
}

/// The appservice's namespaces, as the registration declares them.
fn namespaces(config: &Config) -> matrix_adapter::Namespaces {
    matrix_adapter::Namespaces {
        users: vec![
            matrix_adapter::AppserviceRegistration::ghost_user_namespace(
                &config.bridge.ghost_prefix,
                &config.homeserver.domain,
            ),
        ],
        aliases: Vec::new(),
        rooms: Vec::new(),
    }
}

/// The appservice registration, registered and ready to serve.
///
/// Both tokens are parsed here, so every later use — the homeserver client, the
/// media store, the transaction check — holds validated values and the server
/// cannot be started without them.
fn register(
    config: &Config,
) -> Result<matrix_adapter::Appservice<matrix_adapter::Registered>, String> {
    let as_token = AsToken::parse(config.homeserver.as_token.clone())
        .map_err(|error| format!("homeserver.as_token: {error}"))?;
    let hs_token = HsToken::parse(config.homeserver.hs_token.clone())
        .map_err(|error| format!("homeserver.hs_token: {error}"))?;
    Ok(matrix_adapter::Appservice::new(
        "roomy-matrix-bridge",
        config.bridge.transactions_url(),
        config.homeserver.sender_localpart.clone(),
        namespaces(config),
    )
    .register(Tokens { as_token, hs_token }))
}

/// Print the registration the homeserver requires.
fn print_registration(config: &Config) -> std::process::ExitCode {
    let appservice = match register(config) {
        Ok(appservice) => appservice,
        Err(error) => {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match serde_json::to_string_pretty(&appservice.registration()) {
        Ok(json) => {
            println!("{json}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("could not render the registration: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Run the bridge.
async fn serve(config: Config) -> std::process::ExitCode {
    let registered = match register(&config) {
        Ok(registered) => registered,
        Err(error) => {
            eprintln!("{error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let as_token = registered.as_token().clone();

    let db = match db::BridgeDb::open(&config.bridge.db_path) {
        Ok(db) => Arc::new(parking_lot::Mutex::new(db)),
        Err(error) => {
            eprintln!(
                "could not open {}: {error}",
                config.bridge.db_path.display()
            );
            return std::process::ExitCode::FAILURE;
        }
    };

    // The probe decides whether encryption can run. With `required`, a failure
    // stops the process before it relays anything, naming what is missing —
    // running an encrypted room without the pieces encryption needs is worse
    // than not starting.
    // The device check answers from a single call, but the MSC2409, MSC3202 and
    // MSC4203 checks are decided by what a *transaction* carries. At startup the
    // appservice has received nothing, so asking before any traffic exists
    // reports a working homeserver as broken and holds `e2ee = "required"` shut
    // forever. The stimulus below runs the same measurement `--check-homeserver`
    // does, against the observer the live server fills.
    let probe_state = ProbeState::new();
    let observer = matrix_adapter::TransactionObserver::new();
    let capabilities = match check::measure(&config).await {
        Some(capabilities) => capabilities,
        None => return std::process::ExitCode::FAILURE,
    };
    let e2ee_available = capabilities.e2ee_available();
    probe_state.set(capabilities.clone());

    match config.bridge.e2ee.mode {
        E2eeMode::Required if !e2ee_available => {
            eprintln!(
                "e2ee is required but this homeserver does not support it: {}",
                capabilities.missing().join(", ")
            );
            eprint!("{}", capabilities.report());
            return std::process::ExitCode::FAILURE;
        }
        E2eeMode::Off if !e2ee_available => {
            tracing::info!("e2ee is off and the homeserver does not support it");
        }
        _ if !e2ee_available => {
            tracing::warn!(
                missing = capabilities.missing().join(", "),
                "running without encryption"
            );
        }
        _ => tracing::info!("e2ee is available"),
    }

    // Bound after the probe, which needs the same address to receive the
    // transactions it provokes.
    let listener = match tokio::net::TcpListener::bind(&config.bridge.listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("could not bind {}: {error}", config.bridge.listen);
            return std::process::ExitCode::FAILURE;
        }
    };

    let bridge_did = match roomy_events::Did::parse(config.bridge.bridge_did.clone()) {
        Ok(did) => did,
        Err(_) => {
            eprintln!("bridge.did is not a DID: {}", config.bridge.bridge_did);
            return std::process::ExitCode::FAILURE;
        }
    };
    let appserver_did = match roomy_events::Did::parse(config.appserver.did.clone()) {
        Ok(did) => did,
        Err(_) => {
            eprintln!("appserver.did is not a DID: {}", config.appserver.did);
            return std::process::ExitCode::FAILURE;
        }
    };

    let service_auth = Arc::new(roomy_client::ServiceAuth::new(&config.atproto.pds_url));

    // A test deployment has no PDS, so it cannot mint a session. `test_did`
    // says to address the appserver with that DID instead, which is what the
    // appserver's own test mode authenticates on. A session is still requested
    // whenever an atproto identifier is configured: blob uploads carry its
    // access JWT, and without one they would be refused.
    let access_jwt = if config.atproto.identifier.is_empty() {
        String::new()
    } else {
        let credentials = roomy_client::SessionCredentials {
            identifier: config.atproto.identifier.clone(),
            app_password: config.atproto.app_password.clone(),
        };
        match service_auth.create_session(&credentials).await {
            Ok(session) => session.access_jwt.clone(),
            Err(error) => {
                eprintln!("could not log in to the PDS: {error}");
                return std::process::ExitCode::FAILURE;
            }
        }
    };
    let appserver = roomy_client::AppserverClient::new(
        &config.appserver.url,
        appserver_did,
        service_auth,
        access_jwt,
    )
    .with_pds_url(&config.atproto.pds_url);
    let appserver = match &config.appserver.test_did {
        Some(did) => appserver.with_test_did(did.clone()),
        None => appserver,
    };
    let appserver = Arc::new(appserver);

    // The crypto store is the bridge device. Opening it before the server
    // starts means a device identity exists for any encrypted room the bridge
    // later joins, and a restart reuses the same keys rather than silently
    // losing them.
    #[cfg(feature = "e2ee")]
    let crypto = if e2ee_available && config.bridge.e2ee.mode != E2eeMode::Off {
        let user_id = format!(
            "@{}:{}",
            config.homeserver.sender_localpart, config.homeserver.domain
        );
        match open_crypto(&user_id, &config) {
            Ok(machine) => {
                tracing::info!(
                    device_key = %machine.identity_key(),
                    "crypto device ready"
                );
                Some(Arc::new(machine))
            }
            Err(error) => {
                if config.bridge.e2ee.mode == E2eeMode::Required {
                    eprintln!("could not open the crypto store: {error}");
                    return std::process::ExitCode::FAILURE;
                }
                tracing::warn!(%error, "running without a crypto device");
                None
            }
        }
    } else {
        None
    };
    #[cfg(not(feature = "e2ee"))]
    let crypto: Option<Arc<matrix_adapter::CryptoMachine>> = None;
    let _ = &crypto;

    // What the process can do about encrypted rooms. A portal can only be
    // described as encryptable while a device that can encrypt exists, which is
    // what makes a plaintext send into an encrypted room unrepresentable.
    #[cfg(feature = "e2ee")]
    let encryption = match &crypto {
        Some(machine) => EncryptionSupport::Ready(
            MatrixDeviceId::parse(machine.device_id().as_str())
                .expect("the homeserver minted a non-empty device id"),
        ),
        None if !capabilities.msc4203_to_device.passed() => {
            EncryptionSupport::Unavailable(MissingFeature::Msc4203ToDevice)
        }
        None => EncryptionSupport::Unavailable(MissingFeature::CryptoDevice),
    };
    #[cfg(not(feature = "e2ee"))]
    let encryption = EncryptionSupport::Unavailable(MissingFeature::CryptoDevice);

    let clock: Arc<dyn bridge_core::Clock> = Arc::new(bridge_core::SystemClock);

    let homeserver = Arc::new(matrix_adapter::HomeserverClient::new(
        &config.homeserver.url,
        as_token.clone(),
    ));
    // Ghosts live under the registration's user namespace, which is the
    // homeserver domain unless the bridge is configured with its own hostname.
    let ghost_host = if config.bridge.hostname.is_empty() {
        config.homeserver.domain.clone()
    } else {
        config.bridge.hostname.clone()
    };
    let ghosts = Arc::new(parking_lot::Mutex::new(matrix_adapter::GhostRegistry::new(
        ghost_host,
    )));
    // Reload the ghosts this bridge has already minted. A ghost's MXID is the
    // identity its author's history was attributed to, so it must be the same
    // across a restart.
    if let Err(error) = load_ghosts(&db, &ghosts) {
        tracing::warn!(%error, "could not reload the ghost registry");
    }
    // The plain sender writes plaintext. When a crypto device is running the
    // encrypting sender wraps it, so a message bound for an encrypted room
    // leaves as ciphertext with its key already shared.
    let http_sender = Arc::new(matrix_adapter::HttpSender::new(
        matrix_adapter::HomeserverClient::new(&config.homeserver.url, as_token.clone()),
    ));
    #[cfg(feature = "e2ee")]
    let sender: Arc<dyn matrix_adapter::MatrixSender> = match &crypto {
        Some(machine) => {
            // The key upload has to happen before any message is sent, or the
            // room's other devices cannot claim a session with this one, and a
            // device the homeserver does not have cannot hold keys at all.
            if let Err(error) = homeserver
                .ensure_device(
                    machine.user_id().as_str(),
                    machine.device_id().as_str(),
                    "Roomy bridge",
                )
                .await
            {
                tracing::warn!(%error, "could not create the bridge device");
            }
            let transport = matrix_adapter::CryptoTransport::new(
                (*homeserver).clone(),
                machine.user_id(),
                machine.device_id(),
            );
            if let Err(error) = transport.pump(machine).await {
                tracing::warn!(%error, "could not upload the bridge device's keys");
            }
            Arc::new(encrypting_sender::EncryptingSender::new(
                http_sender,
                homeserver.clone(),
                machine.clone(),
            ))
        }
        None => http_sender,
    };
    #[cfg(not(feature = "e2ee"))]
    let sender: Arc<dyn matrix_adapter::MatrixSender> = http_sender;
    // One writer channel: everything that becomes a Roomy event — inbound
    // transactions and backfilled history alike — goes through it, so ordering
    // and retry have one owner.
    let (writer_tx, writer_rx) = tokio::sync::mpsc::unbounded_channel();
    // One state machine, shared by both directions: the id map the inbound
    // relay writes is the one the outbound translator reads.
    let bridge_state = Arc::new(parking_lot::Mutex::new(BridgeState::new()));

    let media = matrix_adapter::MediaStore::new(
        &config.homeserver.url,
        as_token.clone(),
        &config.appserver.url,
    );

    let (supervisor, backfill_queue) = supervisor::Supervisor::new(supervisor::SupervisorDeps {
        db: db.clone(),
        homeserver: homeserver.clone(),
        sender,
        backfill_limit: config.bridge.backfill_limit,
        max_depth: config.bridge.max_depth,
        ghosts,
        media: media.clone(),
        roomy_events: writer_tx,
        state: bridge_state.clone(),
        encryption: encryption.clone(),
    });
    let supervisor = Arc::new(supervisor);
    let relay = relay::Relay::new(relay::RelayDeps {
        db: db.clone(),
        supervisor: supervisor.clone(),
        bridge_did: bridge_did.clone(),
        sender_localpart: config.homeserver.sender_localpart.clone(),
        domain: config.homeserver.domain.clone(),
        media,
        appserver: appserver.clone(),
        state: bridge_state.clone(),
        clock,
    });

    let writer = tokio::spawn(writer_task(writer_rx, appserver.clone(), db.clone()));
    let outbound = tokio::spawn(outbound_task(
        supervisor.clone(),
        appserver.clone(),
        config.appserver.websocket_origin(),
        config.bridge.bridge_did.clone(),
    ));
    let backfiller = tokio::spawn(backfill_task(supervisor.clone(), backfill_queue));

    let admin_state = admin::AdminState {
        db: db.clone(),
        appserver,
        auth: Arc::new(auth::AdminAuth::new(bridge_did.as_str())),
        probe: probe_state,
        supervisor: supervisor.clone(),
        homeserver_url: config.homeserver.url.clone(),
        as_token: as_token.clone(),
        max_depth: config.bridge.max_depth,
        sender_localpart: config.homeserver.sender_localpart.clone(),
        domain: config.homeserver.domain.clone(),
        observer: observer.clone(),
        encryption: encryption.clone(),
        test_did: config.appserver.test_did.clone(),
    };

    let state = server::ServerState {
        admin: admin_state,
        appservice: registered.start(),
        transactions: Arc::new(parking_lot::Mutex::new(
            matrix_adapter::transaction::TransactionHandler::new(),
        )),
        relay: Arc::new(relay),
        observer,
        #[cfg(feature = "e2ee")]
        crypto: crypto.clone(),
    };

    tracing::info!(
        listen = %config.bridge.listen,
        bridge_did = %bridge_did,
        "roomy-matrix-bridge listening"
    );

    tokio::select! {
        result = axum::serve(listener, server::router(state)) => {
            if let Err(error) = result {
                eprintln!("server stopped: {error}");
                return std::process::ExitCode::FAILURE;
            }
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
        }
    }
    writer.abort();
    outbound.abort();
    backfiller.abort();
    std::process::ExitCode::SUCCESS
}

/// Drain the relay's queue into the appserver.
///
/// A failed batch is retried with the outbox's backoff rather than dropped: a
/// relay that loses events on a transient appserver error silently diverges the
/// two sides, which is the one failure mode a bridge cannot recover from.
async fn writer_task(
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<(
        roomy_events::Did,
        Vec<roomy_events::Event>,
    )>,
    appserver: Arc<roomy_client::AppserverClient>,
    db: Arc<parking_lot::Mutex<db::BridgeDb>>,
) {
    let outbox = bridge_core::Outbox::new(bridge_core::RetryPolicy::default());

    loop {
        // A short poll keeps the outbox's schedule honest without a second task.
        let job =
            tokio::time::timeout(std::time::Duration::from_millis(200), receiver.recv()).await;

        match job {
            Ok(Some((space_did, events))) => {
                deliver(&appserver, &db, &outbox, &space_did, events).await;
            }
            Ok(None) => return,
            Err(_elapsed) => {}
        }

        // Retry whatever is due. A bridge that only retried on the next inbound
        // message would stall its own retries during a quiet period, which is
        // exactly when a homeserver outage is most likely to go unnoticed.
        retry_due(&appserver, &db, now_ms()).await;
    }
}

/// Send one batch, recording a failure for retry.
async fn deliver(
    appserver: &roomy_client::AppserverClient,
    db: &parking_lot::Mutex<db::BridgeDb>,
    outbox: &bridge_core::Outbox,
    space_did: &roomy_events::Did,
    events: Vec<roomy_events::Event>,
) {
    let Some(first) = events.first().map(|event| event.id.as_str().to_string()) else {
        return;
    };
    match appserver.send_events(space_did, events.clone()).await {
        Ok(()) => {
            let _ = db.lock().clear_failed_send(&first);
        }
        Err(error) => {
            tracing::warn!(%error, id = %first, "sendEvents failed; queuing for retry");
            // The appserver treats a repeated ULID as a no-op, so re-sending is
            // safe: an event that already landed is not written twice. The
            // events are the payload because a batch is the smallest unit the
            // appserver accepts.
            let payload = serde_json::to_string(
                &events
                    .iter()
                    .map(|event| event.to_json())
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default();
            let _ = db.lock().put_failed_send(&db::FailedSendWrite {
                id: &first,
                space_did: space_did.as_str(),
                payload: &payload,
                attempts: 1,
                next_attempt_at: now_ms() + outbox.policy().delay_for(1),
                last_error: Some(&error.to_string()),
                created_at: now_ms(),
            });
        }
    }
}

/// Re-send every failed batch that is due.
async fn retry_due(
    appserver: &roomy_client::AppserverClient,
    db: &parking_lot::Mutex<db::BridgeDb>,
    now: i64,
) {
    let due = match db.lock().due_failed_sends(now, 10) {
        Ok(due) => due,
        Err(error) => {
            tracing::warn!(%error, "could not read the retry queue");
            return;
        }
    };

    let policy = bridge_core::RetryPolicy::default();
    for row in due {
        let events: Vec<roomy_events::Event> =
            match serde_json::from_str::<Vec<serde_json::Value>>(&row.op)
                .ok()
                .and_then(|values| {
                    values
                        .into_iter()
                        .map(roomy_events::Event::from_json)
                        .collect::<Result<Vec<_>, _>>()
                        .ok()
                }) {
                Some(events) => events,
                None => {
                    // A row whose payload cannot be read would fail identically
                    // forever, so it is dropped rather than retried.
                    tracing::error!(id = %row.id, "dropping an unreadable retry payload");
                    let _ = db.lock().clear_failed_send(&row.id);
                    continue;
                }
            };

        let Ok(space_did) = roomy_events::Did::parse(row.space_did.clone()) else {
            let _ = db.lock().clear_failed_send(&row.id);
            continue;
        };

        match appserver.send_events(&space_did, events).await {
            Ok(()) => {
                tracing::info!(id = %row.id, "retry succeeded");
                let _ = db.lock().clear_failed_send(&row.id);
            }
            Err(error) => {
                let attempts = row.attempts.saturating_add(1);
                if attempts >= policy.max_attempts {
                    tracing::error!(id = %row.id, %error, "retry budget spent; parking the batch");
                }
                let _ = db.lock().put_failed_send(&db::FailedSendWrite {
                    id: &row.id,
                    space_did: &row.space_did,
                    payload: &row.op,
                    attempts,
                    next_attempt_at: now + policy.delay_for(attempts),
                    last_error: Some(&error.to_string()),
                    created_at: now_ms(),
                });
            }
        }
    }
}

/// Milliseconds since the epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Keep every bridged space's outbound socket running.
///
/// One task per space rather than one per portal: the appserver's socket is
/// subscribed per stream, and a space is the stream.
async fn outbound_task(
    supervisor: Arc<supervisor::Supervisor>,
    appserver: Arc<roomy_client::AppserverClient>,
    ws_origin: String,
    _bridge_did: String,
) {
    let mut running: std::collections::HashMap<SpaceDid, tokio::task::JoinHandle<()>> =
        std::collections::HashMap::new();

    loop {
        // Any space with portals gets a socket. A portal appearing later is
        // picked up on the next sweep, which is why this is a poll rather than
        // a single startup pass.
        let spaces = discover_spaces(&supervisor);
        for space_did in spaces {
            if running.contains_key(&space_did) {
                continue;
            }
            let supervisor = supervisor.clone();
            let appserver = appserver.clone();
            let origin = ws_origin.clone();
            let did = space_did.clone();
            let handle = tokio::spawn(async move {
                run_space_socket(supervisor, appserver, origin, did).await;
            });
            running.insert(space_did, handle);
        }
        tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    }
}

/// The spaces that currently have portals.
fn discover_spaces(supervisor: &supervisor::Supervisor) -> Vec<SpaceDid> {
    supervisor.known_spaces()
}

/// Keep one space's sync socket open, reconnecting with backoff.
async fn run_space_socket(
    supervisor: Arc<supervisor::Supervisor>,
    appserver: Arc<roomy_client::AppserverClient>,
    ws_origin: String,
    space_did: SpaceDid,
) {
    let Ok(did) = space_did.to_did() else {
        return;
    };
    supervisor.load_space(&space_did);

    let mut cursor = supervisor.cursor_for(&space_did);
    let mut backoff = std::time::Duration::from_secs(1);

    loop {
        match appserver
            .subscribe_stream(&ws_origin, &did, cursor.get())
            .await
        {
            Ok(mut subscription) => {
                backoff = std::time::Duration::from_secs(1);
                loop {
                    match supervisor
                        .pump_outbound(&space_did, &mut subscription)
                        .await
                    {
                        Ok(_relayed) => {}
                        Err(supervisor::OutboundError::Closed) => break,
                        Err(error) => {
                            tracing::warn!(%error, %space_did, "outbound socket error");
                            break;
                        }
                    }
                    cursor = supervisor.cursor_for(&space_did).max(cursor);
                }
            }
            Err(error) => {
                tracing::warn!(%error, %space_did, "could not subscribe to the space stream");
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(std::time::Duration::from_secs(60));
    }
}

/// Drain the backfill queue, one portal at a time.
async fn backfill_task(
    supervisor: Arc<supervisor::Supervisor>,
    mut queue: tokio::sync::mpsc::UnboundedReceiver<supervisor::BackfillRequest>,
) {
    while let Some(request) = queue.recv().await {
        match supervisor.step_backfill(&request).await {
            Ok(step) => {
                tracing::info!(
                    portal = %request.portal,
                    phase = %step.phase,
                    messages = step.messages,
                    relayed = step.relayed,
                    complete = step.complete,
                    "backfill step"
                );
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    portal = %request.portal,
                    "backfill step failed"
                );
            }
        }
    }
}

/// Reload minted ghosts from the database into the registry.
fn load_ghosts(
    db: &parking_lot::Mutex<db::BridgeDb>,
    ghosts: &parking_lot::Mutex<matrix_adapter::GhostRegistry>,
) -> Result<(), db::DbError> {
    let stored = db.lock().all_ghosts()?;
    let mut registry = ghosts.lock();
    for ghost in stored {
        let Ok(did) = roomy_events::Did::parse(ghost.did.clone()) else {
            tracing::warn!(did = %ghost.did, "stored ghost has an invalid DID");
            continue;
        };
        match registry.register(&did, None, None) {
            Ok(minted) if minted.mxid.as_str() == ghost.mxid => {}
            Ok(minted) => {
                // A registry that mints a different MXID than the stored one
                // means the hostname or prefix changed; the stored ghost is the
                // one the room's history names, so it is reported rather than
                // silently replaced.
                tracing::warn!(
                    stored = %ghost.mxid,
                    minted = %minted.mxid,
                    did = %ghost.did,
                    "stored ghost does not match the configured namespace"
                );
            }
            Err(error) => tracing::warn!(%error, did = %ghost.did, "could not reload a ghost"),
        }
    }
    Ok(())
}

/// Open the bridge's crypto device.
#[cfg(feature = "e2ee")]
fn open_crypto(user_id: &str, config: &Config) -> Result<matrix_adapter::CryptoMachine, String> {
    use ruma::OwnedDeviceId;

    let parsed = ruma::OwnedUserId::try_from(user_id)
        .map_err(|error| format!("{user_id} is not a Matrix user id: {error}"))?;
    // The device id is stable across restarts: it is stored beside the crypto
    // store, because a *new* id would orphan every room key the store holds.
    let device_id_path = config
        .bridge
        .e2ee
        .crypto_store_path(&config.bridge.db_path)
        .with_extension("device");
    let device_id = match std::fs::read_to_string(&device_id_path) {
        Ok(stored) if !stored.trim().is_empty() => stored.trim().to_string(),
        _ => {
            let generated = format!("ROOMYBRIDGE{}", ulid::Ulid::generate());
            std::fs::write(&device_id_path, &generated).map_err(|error| {
                format!("could not persist {}: {error}", device_id_path.display())
            })?;
            generated
        }
    };
    let device_id = OwnedDeviceId::from(device_id.as_str());
    let store = config.bridge.e2ee.crypto_store_path(&config.bridge.db_path);
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }

    // The crypto store is opened on a blocking thread: `matrix-sdk-sqlite`
    // does synchronous SQLite work under the hood, and a large store open on
    // the async runtime would stall every other task.
    let runtime = tokio::runtime::Handle::current();
    let machine = std::thread::spawn(move || {
        runtime.block_on(matrix_adapter::CryptoMachine::open(
            &parsed, &device_id, store,
        ))
    })
    .join()
    .map_err(|_| "the crypto store thread panicked".to_string())?
    .map_err(|error| error.to_string())?;

    Ok(machine)
}
