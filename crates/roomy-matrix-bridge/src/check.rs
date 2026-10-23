//! `--check-homeserver`: measure a homeserver without a full deployment.
//!
//! The stream-dependent checks (MSC2409, MSC3202, MSC4203) are decided by what a
//! homeserver puts on a transaction, so a probe that only reads `/versions`
//! cannot answer them: Synapse does not advertise the MSCs there, it enables
//! them per registration. This runs a real appservice endpoint for the duration
//! of the check, provokes a transaction, and reports what arrived.
//!
//! Two details make the measurement trustworthy rather than merely optimistic:
//!
//! * **The capture is bound to the room the probe created.** The listen address
//!   is fixed by configuration, so a second homeserver pushing there — a stale
//!   registration, a deployment mid-migration — would otherwise have its traffic
//!   counted as evidence for the homeserver under test.
//! * **A stream that could not be exercised reports that**, rather than
//!   defaulting to a pass. The MSC3202 fields are only emitted once the
//!   homeserver has queued a to-device message for the appservice, and the
//!   `ephemeral` array only appears once a typing, receipt or presence EDU has
//!   been queued, neither of which a fresh deployment has had.

use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::put,
    Json, Router,
};
use matrix_adapter::{AsToken, CapabilityProbe, HsToken, TransactionObserver};

use crate::config::Config;

/// The state the capture endpoint reads.
#[derive(Clone)]
struct CheckState {
    /// Accumulates the evidence every transaction carries. Shared with the
    /// probe, which reads it once the wait below ends.
    observer: TransactionObserver,
    hs_token: HsToken,
    /// The room a transaction must mention to count as evidence.
    probe_room: String,
}

/// Run the probe and print its verdict.
pub async fn run(config: &Config) -> std::process::ExitCode {
    let Some(capabilities) = measure(config).await else {
        return std::process::ExitCode::FAILURE;
    };
    print!("{}", capabilities.report());

    if !capabilities.msc3202_device_lists.passed() && capabilities.msc4203_to_device.passed() {
        eprintln!(
            "note: this homeserver delivers to-device messages but no MSC3202 device-list \
             field, so an `OlmMachine` cannot track device changes and encryption is unsafe \
             even though to-device works."
        );
    }

    if capabilities.e2ee_available() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

/// Measure a homeserver, end to end: create a probe room, run an appservice
/// endpoint, provoke traffic, and report what the homeserver actually sent.
///
/// This owns its listener, which is why both the standalone probe and the
/// running bridge call it before they serve. The evidence MSC2409 and MSC3202
/// rest on is what a *transaction* carries, so the measurement needs a live
/// endpoint to receive one — asking `/versions` cannot answer it, and asking
/// before any endpoint exists reports a working homeserver as broken.
///
/// The listener is bound to the configured address and released once the
/// measurement ends, so the caller can bind the same address afterwards.
pub async fn measure(config: &Config) -> Option<matrix_adapter::HomeserverCapabilities> {
    let listener = match tokio::net::TcpListener::bind(&config.bridge.listen).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "could not bind {} for the probe: {error}",
                config.bridge.listen
            );
            return None;
        }
    };
    let Ok(bound) = listener.local_addr() else {
        eprintln!("could not read the probe's address");
        return None;
    };

    // The room is created before the server starts, so the capture can tell this
    // homeserver's transaction from another's.
    let probe_room = create_probe_room(config).await?;

    let (as_token, hs_token) = match (
        AsToken::parse(config.homeserver.as_token.clone()),
        HsToken::parse(config.homeserver.hs_token.clone()),
    ) {
        (Ok(as_token), Ok(hs_token)) => (as_token, hs_token),
        (Err(error), _) => {
            eprintln!("homeserver.as_token: {error}");
            return None;
        }
        (_, Err(error)) => {
            eprintln!("homeserver.hs_token: {error}");
            return None;
        }
    };

    let observer = TransactionObserver::new();
    let app = Router::new()
        .route(
            "/_matrix/app/v1/transactions/{txn_id}",
            put(capture_transaction),
        )
        .with_state(CheckState {
            observer: observer.clone(),
            hs_token,
            probe_room: probe_room.clone(),
        });

    let server = axum::serve(listener, app);
    let handle = tokio::spawn(async move {
        let _ = server.await;
    });

    tracing::info!(%bound, "probe endpoint listening; provoking a transaction");
    provoke_streams(config, &probe_room, &observer).await;
    handle.abort();

    if observer.last().is_none() {
        eprintln!(
            "no transaction for {probe_room} arrived at \
             http://{bound}/_matrix/app/v1/transactions — the homeserver's registration must \
             point its `url` at that address (set [bridge] transaction_url to the address the \
             homeserver reaches this process on)"
        );
    }

    Some(
        CapabilityProbe::new(
            &config.homeserver.url,
            as_token,
            &config.homeserver.sender_localpart,
            &config.homeserver.domain,
            observer,
        )
        .run()
        .await,
    )
}

/// Send the stimulus, then wait for the homeserver to push the resulting
/// transactions back at this process.
async fn provoke_streams(config: &Config, probe_room: &str, observer: &TransactionObserver) {
    let probe_device = queue_to_device(config).await;
    if probe_device.is_none() {
        tracing::warn!(
            "could not queue a to-device message; the MSC3202 fields may be unobservable"
        );
    }
    // A typing EDU is what makes the `ephemeral` array appear on a transaction.
    // The bridge does not relay typing or receipts, but the report says whether
    // the homeserver pushes them, so the stream has to be provoked to be
    // measured at all.
    if !send_typing(config, probe_room).await {
        tracing::warn!(%probe_room, "could not send a typing notification; MSC2409 may be unobservable");
    }
    if !send_probe_message(config, probe_room).await {
        tracing::warn!(%probe_room, "could not send the probe message");
    }
    wait_for_streams(observer).await;
    // After the wait, not before: the to-device message the device exists for is
    // what the measurement is waiting to see in a transaction.
    if let Some(device_id) = probe_device {
        delete_probe_device(config, &device_id).await;
    }
}

/// Wait until the observer has seen every stream-dependent capability, or the
/// deadline passes.
///
/// A homeserver batches transactions on a timer and backs off exponentially
/// while a previous attempt failed, so the first delivery after a registration
/// change can take tens of seconds. The wait ends as soon as the streams have
/// been seen: a homeserver that answers them is measured, and waiting further
/// proves nothing.
async fn wait_for_streams(observer: &TransactionObserver) {
    // Two minutes, returning as soon as every stream arrives. Synapse batches
    // transactions on a timer and backs off after a failed attempt, so the
    // first delivery after a registration change can take tens of seconds; a
    // shorter window measures a healthy homeserver as broken, and the process
    // then runs without a crypto device until it is restarted.
    //
    // Every stream, not any: Synapse sends the room's ephemeral and to-device
    // traffic in one transaction and the MSC3202 fields with it, but a homeserver
    // that splits them would otherwise be measured after the first and the rest
    // reported as absent when they had merely not been sent yet.
    for _ in 0..240 {
        if observer
            .last()
            .is_some_and(|observed| observed.has_probed_streams())
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Ask the homeserver to relay a typing notification for the appservice user.
///
/// The registration carries `receive_ephemeral`, so a homeserver that supports
/// MSC2409 turns this into an `m.typing` entry in the transaction's `ephemeral`
/// array. A homeserver that does not simply never sends the key, which is what
/// the probe reports.
async fn send_typing(config: &Config, probe_room: &str) -> bool {
    let sender = format!(
        "@{}:{}",
        config.homeserver.sender_localpart, config.homeserver.domain
    );
    let url = format!(
        "{}/_matrix/client/v3/rooms/{}/typing/{}?user_id={}",
        config.homeserver.url.trim_end_matches('/'),
        percent_encode(probe_room),
        percent_encode(&sender),
        percent_encode(&sender),
    );
    let response = reqwest::Client::new()
        .put(&url)
        .bearer_auth(&config.homeserver.as_token)
        .json(&serde_json::json!({ "typing": true, "timeout": 20_000 }))
        .send()
        .await;
    matches!(response, Ok(response) if response.status().is_success())
}

#[derive(Debug, Default, serde::Deserialize)]
struct TokenQuery {
    #[serde(rename = "access_token", default)]
    access_token: Option<String>,
}

/// Capture one transaction body.
///
/// The homeserver presents `hs_token` either as a query parameter or as a bearer
/// token — Synapse uses the bearer. Both are accepted; a wrong token is a
/// refusal, not a partial read.
async fn capture_transaction(
    State(state): State<CheckState>,
    Path(_txn_id): Path<String>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !token_matches(&state, &query, &headers) {
        return (StatusCode::FORBIDDEN, "bad hs_token").into_response();
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "unreadable transaction").into_response();
    };

    // Only a transaction mentioning the probe's room is evidence: the address is
    // fixed by configuration, so anything else came from a different homeserver.
    if !mentions_room(&value, &state.probe_room) {
        return (StatusCode::OK, Json(serde_json::json!({}))).into_response();
    }

    state.observer.observe(&value);
    (StatusCode::OK, Json(serde_json::json!({}))).into_response()
}

fn token_matches(state: &CheckState, query: &TokenQuery, headers: &HeaderMap) -> bool {
    let from_query = query.access_token.as_deref() == Some(state.hs_token.as_str());
    let from_header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        == Some(state.hs_token.as_str());
    from_query || from_header
}

/// Whether any event in a transaction belongs to `room_id`.
fn mentions_room(body: &serde_json::Value, room_id: &str) -> bool {
    body.get("events")
        .and_then(|value| value.as_array())
        .map(|events| {
            events
                .iter()
                .any(|event| event.get("room_id").and_then(|value| value.as_str()) == Some(room_id))
        })
        .unwrap_or(false)
}

/// How long to keep retrying a homeserver that is not reachable yet.
///
/// A container starts as soon as its dependencies are *healthy*, but a service
/// name can still be briefly unresolvable and a freshly started homeserver
/// briefly unready. Treating that first attempt as a measurement would report a
/// working homeserver as unreachable, which is the one answer the probe exists
/// to get right.
const CONNECT_ATTEMPTS: u32 = 30;

/// Key material for the device the probe creates: 32 and 64 zero bytes in
/// base64, which is what the algorithms expect and what any client reading the
/// device list can decode.
const PROBE_CURVE25519: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROBE_ED25519: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROBE_SIGNATURE: &str =
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// Create the room the probe sends into, as the appservice's own user.
async fn create_probe_room(config: &Config) -> Option<String> {
    let http = reqwest::Client::new();
    let base = config.homeserver.url.trim_end_matches('/');
    let sender = format!(
        "@{}:{}",
        config.homeserver.sender_localpart, config.homeserver.domain
    );

    let mut response = None;
    for attempt in 0..CONNECT_ATTEMPTS {
        let requested = http
            .post(format!("{base}/_matrix/client/v3/createRoom"))
            .bearer_auth(&config.homeserver.as_token)
            .query(&[("user_id", sender.as_str())])
            .json(&serde_json::json!({ "name": "roomy bridge capability probe" }))
            .send()
            .await;

        // A transport error is the retryable case: the homeserver is not up, or
        // its name does not resolve yet. An HTTP response — even a refusal — is
        // a measurement and is reported as one.
        match requested {
            Ok(answer) => {
                response = Some(Ok(answer));
                break;
            }
            Err(error) if attempt + 1 == CONNECT_ATTEMPTS => {
                response = Some(Err(error));
                break;
            }
            Err(error) => {
                tracing::debug!(%error, attempt, "homeserver not reachable yet; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    match response.expect("the loop always sets a response") {
        Ok(response) if response.status().is_success() => {
            match response.json::<serde_json::Value>().await {
                Ok(body) => match body.get("room_id").and_then(|value| value.as_str()) {
                    Some(room_id) => {
                        tracing::info!(%room_id, "probe room created");
                        Some(room_id.to_string())
                    }
                    None => {
                        eprintln!("the homeserver created a room without returning its id");
                        None
                    }
                },
                Err(error) => {
                    eprintln!("could not read the created room: {error}");
                    None
                }
            }
        }
        Ok(response) => {
            eprintln!(
                "could not create a probe room (HTTP {}); the appservice token may be wrong",
                response.status()
            );
            None
        }
        Err(error) => {
            eprintln!("could not reach the homeserver at {base}: {error}");
            None
        }
    }
}

/// Queue a to-device message for the bridge device.
///
/// MSC3202's device-list and one-time-key fields are attached only when the
/// homeserver has something to say about devices, and a fresh deployment has no
/// such traffic. Sending one to-device message to the appservice's own device
/// gives the measurement something to observe — which is the same event an
/// encrypted room produces when another device shares a room key.
async fn queue_to_device(config: &Config) -> Option<String> {
    let http = reqwest::Client::new();
    let base = config.homeserver.url.trim_end_matches('/');
    let sender = format!(
        "@{}:{}",
        config.homeserver.sender_localpart, config.homeserver.domain
    );

    // A device of this run's own, so a previous run's keys and one-time keys
    // cannot collide with this one's: a homeserver refuses an upload that
    // reuses an existing one-time key id.
    let device_id = probe_device_id();
    let created = http
        .put(format!(
            "{base}/_matrix/client/v3/devices/{device_id}?user_id={sender}"
        ))
        .bearer_auth(&config.homeserver.as_token)
        .json(&serde_json::json!({ "display_name": "roomy bridge capability probe" }))
        .send()
        .await;
    if !matches!(&created, Ok(response) if response.status().is_success()) {
        return None;
    }

    // Uploading device keys is the stimulus MSC3202 answers. Synapse attaches
    // the device-list and one-time-key fields once a device's keys exist and
    // something has changed for the appservice to hear about; a to-device
    // message alone produces a transaction that carries the to-device field and
    // none of the MSC3202 ones. This is the same call an `OlmMachine` makes when
    // the bridge starts, so it is not a synthetic probe-only path.
    let keys_uploaded = http
        .post(format!(
            "{base}/_matrix/client/v3/keys/upload?user_id={sender}&device_id={device_id}"
        ))
        .bearer_auth(&config.homeserver.as_token)
        .json(&serde_json::json!({
            "device_keys": {
                "user_id": sender,
                "device_id": device_id,
                "algorithms": ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
                // Real key material, of the right length. A homeserver accepts
                // any bytes here, but the bridge's own `OlmMachine` reads this
                // device's keys back from `/keys/query` and cannot decode a key
                // that is not 32 base64 bytes.
                "keys": {
                    format!("curve25519:{device_id}"): PROBE_CURVE25519,
                    format!("ed25519:{device_id}"): PROBE_ED25519,
                },
                "signatures": {
                    sender.clone(): {
                        format!("ed25519:{device_id}"): PROBE_SIGNATURE,
                    },
                },
            },
        }))
        .send()
        .await;
    match keys_uploaded {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            // Not fatal: MSC2409 is still measurable, and a homeserver that
            // refuses the upload is one an `OlmMachine` could not run on either.
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                %status,
                body = %body,
                "the probe could not upload device keys; MSC3202 may read as absent"
            );
        }
        Err(error) => {
            tracing::warn!(%error, "the probe could not upload device keys");
        }
    }

    // One-time keys, which a real `OlmMachine` uploads alongside its device
    // keys. This is what makes the one-time-key counts non-empty: Synapse only
    // adds the MSC3202 fields when there is a count to report, so a probe that
    // uploaded device keys alone would measure a working homeserver as lacking
    // the extension.
    let one_time_keys = (0..3)
        .map(|index| {
            (
                format!("signed_curve25519:probe{index}"),
                serde_json::json!({
                    "key": PROBE_CURVE25519,
                    "signatures": {
                        sender.clone(): {
                            format!("ed25519:{device_id}"): PROBE_SIGNATURE,
                        },
                    },
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let otks_uploaded = http
        .post(format!(
            "{base}/_matrix/client/v3/keys/upload?user_id={sender}&device_id={device_id}"
        ))
        .bearer_auth(&config.homeserver.as_token)
        .json(&serde_json::json!({ "one_time_keys": one_time_keys }))
        .send()
        .await;
    match otks_uploaded {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                %status,
                body = %body,
                "the probe could not upload one-time keys; MSC3202 may read as absent"
            );
        }
        Err(error) => {
            tracing::warn!(%error, "the probe could not upload one-time keys");
        }
    }

    let txn_id = ulid::Ulid::generate().to_string();
    let response = http
        .put(format!(
            "{base}/_matrix/client/v3/sendToDevice/m.room_key_request/{txn_id}"
        ))
        .bearer_auth(&config.homeserver.as_token)
        .json(&serde_json::json!({
            "messages": {
                sender.clone(): {
                    device_id.clone(): {
                        "action": "request",
                        "requesting_device_id": device_id.clone(),
                        "request_id": ulid::Ulid::generate().to_string(),
                    }
                }
            }
        }))
        .send()
        .await;

    if matches!(response, Ok(response) if response.status().is_success()) {
        Some(device_id)
    } else {
        None
    }
}

/// The device id the probe creates, unique per run so repeated probes do not
/// collide on one-time key ids.
fn probe_device_id() -> String {
    format!("ROOMYPROBE{}", ulid::Ulid::generate())
}

/// Remove the probe's device, and with it the keys it uploaded.
///
/// The probe runs on every start and on every `/capabilities` request; leaving a
/// device behind per run would grow the bridge user's device list without bound
/// and make each run's one-time keys collide with the last.
async fn delete_probe_device(config: &Config, device_id: &str) {
    let base = config.homeserver.url.trim_end_matches('/');
    let sender = format!(
        "@{}:{}",
        config.homeserver.sender_localpart, config.homeserver.domain
    );
    let deleted = reqwest::Client::new()
        .delete(format!(
            "{base}/_matrix/client/v3/devices/{device_id}?user_id={sender}"
        ))
        .bearer_auth(&config.homeserver.as_token)
        .send()
        .await;
    if !matches!(&deleted, Ok(response) if response.status().is_success()) {
        tracing::debug!(device_id, "could not remove the probe's device");
    }
}

/// Send a message into the probe room, which is what makes the homeserver push.
async fn send_probe_message(config: &Config, room_id: &str) -> bool {
    let http = reqwest::Client::new();
    let base = config.homeserver.url.trim_end_matches('/');
    let sender = format!(
        "@{}:{}",
        config.homeserver.sender_localpart, config.homeserver.domain
    );
    let txn_id = ulid::Ulid::generate().to_string();

    let response = http
        .put(format!(
            "{base}/_matrix/client/v3/rooms/{}/send/m.room.message/{txn_id}",
            percent_encode(room_id)
        ))
        .bearer_auth(&config.homeserver.as_token)
        .query(&[("user_id", sender.as_str())])
        .json(&serde_json::json!({
            "msgtype": "m.text",
            "body": "roomy bridge capability probe",
        }))
        .send()
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            tracing::info!(%room_id, "probe message sent");
            true
        }
        Ok(response) => {
            eprintln!(
                "could not send into the probe room (HTTP {})",
                response.status()
            );
            false
        }
        Err(error) => {
            eprintln!("could not send into the probe room: {error}");
            false
        }
    }
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
    use serde_json::json;

    #[test]
    fn a_transaction_must_mention_the_probe_room() {
        let body = json!({
            "events": [
                { "type": "m.room.message", "room_id": "!probe:example.org" },
            ]
        });
        assert!(mentions_room(&body, "!probe:example.org"));
        assert!(!mentions_room(&body, "!other:example.org"));
    }

    #[test]
    fn a_transaction_with_no_events_mentions_nothing() {
        assert!(!mentions_room(
            &json!({ "events": [] }),
            "!probe:example.org"
        ));
        assert!(!mentions_room(&json!({}), "!probe:example.org"));
    }

    #[test]
    fn the_token_is_accepted_as_a_query_or_a_bearer() {
        let state = CheckState {
            observer: TransactionObserver::new(),
            hs_token: HsToken::parse("secret").unwrap(),
            probe_room: "!probe:example.org".into(),
        };

        assert!(token_matches(
            &state,
            &TokenQuery {
                access_token: Some("secret".into())
            },
            &HeaderMap::new()
        ));
        assert!(!token_matches(
            &state,
            &TokenQuery {
                access_token: Some("wrong".into())
            },
            &HeaderMap::new()
        ));

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(token_matches(&state, &TokenQuery::default(), &headers));

        let mut wrong = HeaderMap::new();
        wrong.insert("authorization", "Bearer nope".parse().unwrap());
        assert!(!token_matches(&state, &TokenQuery::default(), &wrong));
    }
}
