//! The WebSocket adapter: the session core's commands, on a socket.
//!
//! The socket carries JSON in both directions:
//!
//! ```text
//! client → {"type":"subscribe","topic":"did:web:space.example"}
//! client → {"type":"backfill","topic":"…","from":{"idx":3,"ord":0}}
//! server → {"seq":2,"topic":"…","kind":"subscribed","data":{"cursor":{…}}}
//! server → {"seq":3,"topic":"…","kind":"changed","data":{"cursor":{…}}}
//! ```
//!
//! Nothing here decides anything: the ticket decides who may connect, the
//! session core decides who hears what, and this file moves the bytes.

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;

use roomy_sync::{Command, Frame, FrameData, Input, SessionId};

use crate::{Counters, GatewayState};

#[derive(Debug, Default, Deserialize)]
pub struct TicketParams {
    /// The ticket, when a client cannot set an `Authorization` header on an
    /// upgrade (browsers cannot).
    pub ticket: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientFrame {
    Subscribe { topic: String },
    Backfill { topic: String, from: CursorWire },
    Ping,
}

#[derive(Debug, Deserialize)]
struct CursorWire {
    idx: i64,
    ord: i64,
}

/// Upgrade, verify, and run the connection.
pub async fn subscribe(
    State(state): State<Arc<GatewayState>>,
    Query(params): Query<TicketParams>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let token = params.ticket.or_else(|| {
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_string)
    });
    let Some(token) = token else {
        return (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            json!({ "error": "AuthRequired", "message": "a connection ticket is required" })
                .to_string(),
        )
            .into_response();
    };
    let claims = match state.verifier.verify(&token) {
        Ok(claims) => claims,
        Err(error) => {
            return (
                StatusCode::UNAUTHORIZED,
                [("content-type", "application/json")],
                json!({ "error": "InvalidToken", "message": error.to_string() }).to_string(),
            )
                .into_response()
        }
    };

    state
        .counters
        .sessions_opened
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    upgrade
        .on_upgrade(move |socket| run(socket, state, claims))
        .into_response()
}

async fn run(socket: WebSocket, state: Arc<GatewayState>, claims: roomy_auth::TicketClaims) {
    let (mut sink, mut stream) = socket.split();

    // Open the session before anything is sent: the core's `ready` frame is the
    // first thing the client sees.
    let (session, opening) = {
        let mut core = state.sessions.lock().expect("the session table");
        let commands = core.apply(Input::Open {
            did: claims.sub.clone(),
            spaces: claims.spaces.iter().cloned().collect(),
        });
        let session = commands
            .iter()
            .find_map(|command| match command {
                Command::Send { session, .. } => Some(*session),
                _ => None,
            })
            .unwrap_or(SessionId(0));
        (session, commands)
    };
    // The guard is dropped before the socket is touched: the future has to be
    // `Send`, and a held mutex is not.
    if !deliver(&state, &mut sink, opening, &state.counters).await {
        return;
    }

    let mut signals = state.signals.subscribe();
    let counters = Arc::clone(&state.counters);

    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(message)) = incoming else { break };
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let Ok(frame) = serde_json::from_str::<ClientFrame>(&text) else {
                    continue;
                };
                let input = match frame {
                    ClientFrame::Subscribe { topic } => Input::Subscribe { session, topic },
                    ClientFrame::Backfill { topic, from } => Input::Backfill {
                        session,
                        topic,
                        from: (from.idx, from.ord),
                    },
                    ClientFrame::Ping => continue,
                };
                let commands = {
                    let mut core = state.sessions.lock().expect("the session table");
                    core.apply(input)
                };
                let keep_going = deliver(&state, &mut sink, commands, &counters).await;
                if !keep_going {
                    break;
                }
            }
            signal = signals.recv() => {
                let Ok(signal) = signal else { continue };
                counters
                    .signals_received
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let commands = {
                    let mut core = state.sessions.lock().expect("the session table");
                    core.apply(Input::Signal {
                        space: signal.space.as_str().to_string(),
                        cursor: signal.cursor,
                    })
                };
                if !deliver(&state, &mut sink, commands, &counters).await {
                    break;
                }
            }
        }
    }

    {
        let mut core = state.sessions.lock().expect("the session table");
        core.apply(Input::Closed { session });
    }
    state
        .counters
        .sessions_closed
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _ = sink.send(Message::Close(None)).await;
}

/// Write the core's commands to the socket. Returns false when the connection
/// is finished.
async fn deliver<S>(
    state: &Arc<GatewayState>,
    sink: &mut S,
    commands: Vec<Command>,
    counters: &Counters,
) -> bool
where
    S: SinkExt<Message> + Unpin,
{
    for command in commands {
        match command {
            Command::Send { frame, .. } => {
                let text = render(&frame);
                if sink.send(Message::Text(text.into())).await.is_err() {
                    return false;
                }
                counters
                    .frames_sent
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Command::ReadBackfill {
                session,
                topic,
                from,
                to,
            } => {
                // The rows behind the gap are the space's, and the registry is
                // what knows which space this is. A worker would answer this
                // over its own transport in a split deployment; embedded, the
                // cursor pair is the whole answer, and the client reads the
                // rows through the same XRPC it always does.
                let _ = (session, &topic, from, to);
            }
            Command::Close {
                code,
                reason,
                session,
            } => {
                let _ = session;
                let _ = state;
                let frame = CloseFrame {
                    code,
                    reason: reason.into(),
                };
                let _ = sink.send(Message::Close(Some(frame))).await;
                return false;
            }
        }
    }
    true
}

fn render(frame: &Frame) -> String {
    let data = match &frame.data {
        FrameData::Subscribed { cursor } => json!({ "cursor": cursor_json(*cursor) }),
        FrameData::Changed { cursor } => json!({ "cursor": cursor_json(*cursor) }),
        FrameData::Backfill { from, to } => {
            json!({ "from": cursor_json(*from), "to": cursor_json(*to) })
        }
    };
    json!({
        "seq": frame.seq,
        "topic": frame.topic,
        "kind": frame.kind,
        "data": data,
    })
    .to_string()
}

fn cursor_json(cursor: (i64, i64)) -> serde_json::Value {
    json!({ "idx": cursor.0, "ord": cursor.1 })
}
