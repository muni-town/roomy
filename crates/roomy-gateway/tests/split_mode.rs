//! Split mode: the gateway serves its log, and a worker elsewhere reads it.
//!
//! The two halves of the deployment only share a network and a secret. This test
//! starts both in one process — a gateway with its event log, a supervisor whose
//! `ChangeFeed` is HTTP — and requires the projection the remote worker
//! materialises to equal the one a worker reading the same file directly
//! produces. If the wire format, the cursor arithmetic or the entry grouping
//! disagreed, the digests would.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use roomy_auth::{InMemoryNonces, TicketIssuer, TicketVerifier};
use roomy_gateway::internal::{FeedService, INTERNAL_HEADER};
use roomy_gateway::{router, GatewaySignals, GatewayState};
use roomy_space_worker::supervisor::FeedFactory;
use roomy_space_worker::{Supervisor, SupervisorConfig};
use serde::Deserialize;
use space_core::change::FeedRow;
use space_core::ids::SpaceDid;
use space_db::{digest_of, snapshot_db, worker_snapshot, SpaceDb};
use space_feed::http::{HttpChangeFeed, UreqPull};
use space_feed::sqlite::SqliteChangeFeed;
use space_feed::ChangeFeed;
use space_xrpc::registry::FixedSpaces;
use space_xrpc::state::{SpaceReadDb, XrpcState};
use space_xrpc::verify::TestMode;

const SPACE: &str = "did:web:split.example";
const SECRET: &str = "split-mode-secret";

#[derive(Deserialize)]
struct Fixture {
    changes: Vec<serde_json::Value>,
}

fn fixture_path() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../space-db/tests/fixtures/registry-corpus/fixture.json")
}

/// The event log: the fixture corpus, under this test's space.
fn build_events_db(path: &Path, space: &SpaceDid) {
    let fixture: Fixture =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("fixture readable"))
            .expect("fixture parses");
    let conn = rusqlite::Connection::open(path).expect("events DB");
    conn.execute_batch(
        "create table record_changes (
           stream_id text not null,
           idx integer not null,
           ord integer not null,
           kind text not null,
           repo text not null,
           collection text not null,
           rkey text not null,
           op text not null,
           order_stamp text not null,
           actor text not null,
           event_id text not null,
           body text,
           primary key (stream_id, idx, ord)
         ) strict;",
    )
    .expect("schema");
    for row in &fixture.changes {
        conn.execute(
            "insert into record_changes (
               stream_id, idx, ord, kind, repo, collection, rkey, op,
               order_stamp, actor, event_id, body
             ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                space.as_str(),
                row["idx"].as_i64(),
                row["ord"].as_i64(),
                row["kind"].as_str(),
                row["repo"].as_str(),
                row["collection"].as_str(),
                row["rkey"].as_str(),
                row["op"].as_str(),
                row["orderStamp"].as_str(),
                row["actor"].as_str(),
                row["eventId"].as_str(),
                row["body"].as_str(),
            ],
        )
        .expect("inserting a feed row");
    }
}

struct Served {
    base_url: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

/// A gateway over `events_db`, listening on a loopback port.
async fn serve_gateway(events_db: &Path) -> Served {
    serve_gateway_with_signals(events_db, GatewaySignals::new(16)).await
}

async fn serve_gateway_with_signals(events_db: &Path, signals: GatewaySignals) -> Served {
    let placeholder = Arc::new(SpaceReadDb::from_connection(
        rusqlite::Connection::open_in_memory().expect("placeholder"),
    ));
    let reads = XrpcState::new(placeholder, Arc::new(TestMode))
        .with_spaces(Arc::new(FixedSpaces::new(Vec::new())));
    let state = GatewayState::new(
        reads,
        Arc::new(TicketIssuer::new(b"ticket-secret".to_vec(), "test", 60)),
        Arc::new(TicketVerifier::new(
            b"ticket-secret".to_vec(),
            "test",
            Box::new(InMemoryNonces::new()),
        )),
        signals,
    )
    .with_internal_secret(SECRET)
    .with_feed(FeedService::open(events_db).expect("feed service"));

    let app = router(Arc::new(state));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let (shutdown, stop) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await;
    });
    Served {
        base_url: format!("http://{address}"),
        shutdown,
        handle,
    }
}

fn config(dir: &Path, events_db: &Path, holder: &str) -> SupervisorConfig {
    SupervisorConfig {
        events_db: events_db.to_path_buf(),
        global_db: dir.join("global.sqlite"),
        spaces_dir: dir.join("spaces"),
        holder: holder.to_string(),
        lease_ttl: Duration::from_secs(30),
        idle_poll: Duration::from_millis(2),
        batch_limit: 500,
        idle_unload: None,
        ownership: roomy_space_worker::supervisor::Ownership::Owner,
    }
}

fn digest(dir: &Path, space: &SpaceDid) -> String {
    let db = SpaceDb::open(
        dir.join("spaces").join(format!("{space}.sqlite")),
        space.clone(),
    )
    .expect("space DB");
    digest_of(&worker_snapshot(
        &snapshot_db(db.connection()).expect("snapshot"),
    ))
}

fn wait_for_catch_up(config: &SupervisorConfig, space: &SpaceDid, timeout: Duration) -> bool {
    let latest: i64 = {
        let conn = rusqlite::Connection::open(&config.events_db).expect("events DB");
        conn.query_row(
            "select max(idx) from record_changes where stream_id = ?",
            [space.as_str()],
            |row| row.get(0),
        )
        .expect("latest idx")
    };
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(db) = SpaceDb::open(config.space_path(space), space.clone()) {
            if let Ok(Some((idx, _))) = db.cursor() {
                if idx >= latest {
                    return true;
                }
            }
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_worker_reads_the_owner_s_log_over_http() {
    let gateway_dir = tempfile::tempdir().expect("gateway dir");
    let remote_dir = tempfile::tempdir().expect("remote worker dir");
    let local_dir = tempfile::tempdir().expect("local worker dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");

    let events_db = gateway_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);

    let gateway = serve_gateway(&events_db).await;

    // The remote worker: a feed that only knows a URL and a secret.
    let url = gateway.base_url.clone();
    let factory: FeedFactory = Arc::new(move || {
        Ok(Box::new(HttpChangeFeed::new(
            url.clone(),
            UreqPull::default().with_header(INTERNAL_HEADER, SECRET),
        )) as Box<dyn ChangeFeed>)
    });
    let remote_config = config(remote_dir.path(), &events_db, "remote");
    let remote = Supervisor::new(remote_config.clone()).with_feed(factory);
    remote.start_all([space.clone()]).expect("remote space");

    let caught_up = tokio::task::spawn_blocking({
        let config = remote_config.clone();
        let space = space.clone();
        move || wait_for_catch_up(&config, &space, Duration::from_secs(20))
    })
    .await
    .expect("join");
    assert!(caught_up, "the remote worker never reached the last entry");
    remote.stop();

    // The same log read as a file, by a worker that shares the machine.
    let local_config = config(local_dir.path(), &events_db, "local");
    let local = Supervisor::new(local_config.clone()).with_feed({
        let events_db = events_db.clone();
        Arc::new(move || Ok(Box::new(SqliteChangeFeed::open(&events_db)?) as Box<dyn ChangeFeed>))
    });
    local.start_all([space.clone()]).expect("local space");
    let caught_up = tokio::task::spawn_blocking({
        let config = local_config.clone();
        let space = space.clone();
        move || wait_for_catch_up(&config, &space, Duration::from_secs(20))
    })
    .await
    .expect("join");
    assert!(caught_up, "the local worker never reached the last entry");
    local.stop();

    let _ = gateway.shutdown.send(());
    let _ = gateway.handle.await;

    assert_eq!(
        digest(remote_dir.path(), &space),
        digest(local_dir.path(), &space),
        "both feeds must feed the same projection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_feed_refuses_a_worker_without_the_secret() {
    let gateway_dir = tempfile::tempdir().expect("gateway dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let events_db = gateway_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);

    let gateway = serve_gateway(&events_db).await;
    let anonymous = HttpChangeFeed::new(gateway.base_url.clone(), UreqPull::default());
    let error = anonymous
        .batch(&space, space_feed::Cursor::START, 10)
        .expect_err("a forbidden answer is not a batch");
    let _ = gateway.shutdown.send(());
    let _ = gateway.handle.await;
    assert!(
        error.to_string().contains("403"),
        "the refusal names the status: {error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_space_is_an_empty_feed_not_an_error() {
    let gateway_dir = tempfile::tempdir().expect("gateway dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let events_db = gateway_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);
    let unknown = SpaceDid::parse("did:web:nobody.example".to_string()).expect("space DID");

    let gateway = serve_gateway(&events_db).await;
    let feed = HttpChangeFeed::new(
        gateway.base_url.clone(),
        UreqPull::default().with_header(INTERNAL_HEADER, SECRET),
    );
    let rows: Vec<FeedRow> = feed
        .batch(&unknown, space_feed::Cursor::START, 10)
        .expect("an empty answer");
    let latest = feed.latest_idx(&unknown).expect("a latest index");
    let _ = gateway.shutdown.send(());
    let _ = gateway.handle.await;

    assert!(rows.is_empty());
    assert_eq!(latest, -1, "a space with no rows has no last entry");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_worker_s_signal_reaches_the_gateway_s_sockets() {
    let gateway_dir = tempfile::tempdir().expect("gateway dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let events_db = gateway_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);

    let signals = GatewaySignals::new(16);
    let mut received = signals.subscribe();
    let gateway = serve_gateway_with_signals(&events_db, signals).await;

    // The worker's half: a relay that only knows a URL and the secret.
    let url = gateway.base_url.clone();
    let delivered = tokio::task::spawn_blocking(move || {
        let mut relay = roomy_space_worker::relay::RelaySignals::new(url, Some(SECRET.to_string()));
        let signal = roomy_space_worker::signal::SpaceSignal {
            space: SpaceDid::parse(SPACE.to_string()).expect("space DID"),
            cursor: (4, 2),
            entries: 3,
        };
        roomy_space_worker::signal::SignalSink::signal(&mut relay, &signal);
        relay.counts()
    })
    .await
    .expect("join");

    let signal = tokio::time::timeout(Duration::from_secs(10), received.recv())
        .await
        .expect("the relayed signal arrives")
        .expect("the gateway's sender is alive");
    let _ = gateway.shutdown.send(());
    let _ = gateway.handle.await;

    assert_eq!(delivered, (1, 0), "the relay delivered the signal");
    assert_eq!(signal.space, space);
    assert_eq!(signal.cursor, (4, 2), "the cursor crosses untouched");
    assert_eq!(signal.entries, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_relay_without_the_secret_is_refused_and_drops_the_signal() {
    let gateway_dir = tempfile::tempdir().expect("gateway dir");
    let space = SpaceDid::parse(SPACE.to_string()).expect("space DID");
    let events_db = gateway_dir.path().join("events.sqlite");
    build_events_db(&events_db, &space);

    let signals = GatewaySignals::new(16);
    let mut received = signals.subscribe();
    let gateway = serve_gateway_with_signals(&events_db, signals).await;

    let url = gateway.base_url.clone();
    let counts = tokio::task::spawn_blocking(move || {
        let mut relay = roomy_space_worker::relay::RelaySignals::new(url, None);
        let signal = roomy_space_worker::signal::SpaceSignal {
            space: SpaceDid::parse(SPACE.to_string()).expect("space DID"),
            cursor: (1, 0),
            entries: 1,
        };
        roomy_space_worker::signal::SignalSink::signal(&mut relay, &signal);
        relay.counts()
    })
    .await
    .expect("join");

    let _ = gateway.shutdown.send(());
    let _ = gateway.handle.await;

    assert_eq!(counts, (0, 1), "a refused signal is dropped, not retried");
    assert!(received.try_recv().is_err(), "nothing reached the sockets");
}
