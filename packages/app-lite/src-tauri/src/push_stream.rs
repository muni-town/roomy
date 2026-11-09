use crate::bring_to_front;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{channel, Receiver, Sender},
        Mutex,
    },
    thread,
    time::Duration,
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

const TOKEN_TIMEOUT: Duration = Duration::from_secs(15);
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const RETRY_DELAY: Duration = Duration::from_secs(5);
const TOKEN_REQUEST_EVENT: &str = "push-stream-token-request";
const REJECTED_EVENT: &str = "push-stream-rejected";

pub struct PushStreamState {
    generation: AtomicU64,
    token_sender: Sender<String>,
    token_receiver: Mutex<Receiver<String>>,
}

impl PushStreamState {
    pub fn new() -> Self {
        let (token_sender, token_receiver) = channel();
        Self {
            generation: AtomicU64::new(0),
            token_sender,
            token_receiver: Mutex::new(token_receiver),
        }
    }
}

#[tauri::command]
pub fn push_stream_endpoint_new() -> Result<String, String> {
    loop {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|err| format!("no random bytes available: {err}"))?;
        let endpoint: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let distinct_characters = endpoint.chars().collect::<HashSet<char>>().len();
        if distinct_characters >= 10 {
            return Ok(endpoint);
        }
    }
}

#[tauri::command]
pub fn push_stream_start(
    app: AppHandle,
    state: State<'_, PushStreamState>,
    server_url: String,
    endpoint: String,
) {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    thread::spawn(move || run_stream(app, generation, server_url, endpoint));
}

#[tauri::command]
pub fn push_stream_stop(state: State<'_, PushStreamState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

/// webview's response to TOKEN_REQUEST_EVENT.
#[tauri::command]
pub fn push_stream_provide_token(
    state: State<'_, PushStreamState>,
    token: String,
) -> Result<(), String> {
    let token = state
        .token_sender
        .send(token)
        .map_err(|err| err.to_string());
    log::debug!("push stream: received token: {:#?}", token);

    token
}

fn request_token(app: &AppHandle, state: &PushStreamState) -> Option<String> {
    let receiver = state.token_receiver.lock().ok()?;
    // Drop old response f it arrives late.
    while receiver.try_recv().is_ok() {}
    app.emit(TOKEN_REQUEST_EVENT, ()).ok()?;
    receiver.recv_timeout(TOKEN_TIMEOUT).ok()
}

#[derive(Default)]
struct SseEvent {
    name: String,
    data: String,
}

/// Assembles SSE events from lines
fn parse_event(event: &mut  SseEvent, line: &str) -> Option<SseEvent> {
    if line.is_empty() {
        if event.data.is_empty() {
            event.name.clear();
            return None;
        }
        event.data.pop();
        let name = if event.name.is_empty() {
            "message".to_string()
        } else {
            std::mem::take(&mut event.name)
        };
        return Some(SseEvent {
            name,
            data: std::mem::take(&mut event.data),
        });
    }
    // Comment line, used by the server as a keepalive.
    if line.starts_with(':') {
        return None;
    }
    let (field, value) = match line.split_once(':') {
        Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
        None => (line, ""),
    };
    match field {
        "event" => {
            event.name.clear();
            event.name.push_str(value);
        }
        "data" => {
            event.data.push_str(value);
            event.data.push('\n');
        }
        _ => {}
    }
    None
}

fn run_stream(app: AppHandle, generation: u64, server_url: String, endpoint: String) {
    let state = app.state::<PushStreamState>();
    let url = format!(
        "{}/xrpc/space.roomy.push.stream",
        server_url.trim_end_matches('/')
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut event = SseEvent::default();
    let mut line = String::new();

    while state.generation.load(Ordering::SeqCst) == generation {
        let Some(token) = request_token(&app, &state) else {
            log::warn!("push stream: the webview did not provide a token");
            thread::sleep(RETRY_DELAY);
            continue;
        };

        let result = agent
            .get(&url)
            .query("endpoint", &endpoint)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .call();
        let response = match result {
            Ok(response) => response,
            Err(err) => {
                log::warn!("push stream: connect failed: {err}");
                thread::sleep(RETRY_DELAY);
                continue;
            }
        };

        let status = response.status().as_u16();
        if status != 200 {
            log::warn!("push stream: server answered {status}");
            if matches!(status, 400 | 403 | 404) {
                let _ = app.emit(REJECTED_EVENT, status);
                return;
            }
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(RETRY_DELAY);
            thread::sleep(retry_after);
            continue;
        }

        event.name.clear();
        event.data.clear();
        let mut reader = BufReader::new(response.into_body().into_reader());
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(err) => {
                    log::warn!("push stream: read failed: {err}");
                    break;
                }
            }
            if state.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            let Some(event) = parse_event(&mut event, trimmed) else {
                continue;
            };
            match event.name.as_str() {
                "ready" => log::info!("push stream ready: {}", event.data),
                "push" => {
                    let app = app.clone();
                    show_notification(app, &event.data);
                }
                other => log::info!("push stream: ignoring event {other}"),
            }
        }

        log::info!("push stream closed; reconnecting");
        thread::sleep(RECONNECT_DELAY);
    }
}

fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}


fn show_notification(app: AppHandle, data: &str) {
    let payload: Value = match serde_json::from_str(data) {
        Ok(payload) => {
            log::info!("push stream: payload: {payload}");
            payload
        }
        Err(err) => {
            log::warn!("push stream: unreadable push payload: {err}");
            return;
        }
    };

    // build notification text.
    // mirrors `notificationText` in `packages/sdk/src/push/notificationText.ts`
    let count = payload.get("count").and_then(Value::as_u64).unwrap_or(1);
    let room = string_field(&payload, "roomName").unwrap_or_else(|| "a room".to_string());

    let icon = string_field(&payload, "icon").unwrap_or_default();
    let author = string_field(&payload, "authorName").or_else(|| string_field(&payload, "authorDid"));
    let title = match &author {
        Some(author) => format!("{author} in {room}"),
        None => format!("{count} new messages in {room}"),
    };

		let body = match string_field(&payload, "type").unwrap_or_default().as_ref() {
			"digest"=>  format!("{count} new messages"),
			"message"=> {
          match (string_field(&payload, "messageContent"), &author) {
            (Some(content), _) => content,
            (None, Some(author)) => format!("{author} sent a message"),
            (None, None) => "New message".to_string(),
        }
			}
			other => format!("New `{other}` message in Roomy"),
		};


    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        let notification = notification
            .appname("Roomy")
            .summary(&title)
            .body(&body)
            .icon(&icon)
            .action("default", "Open");

        if let Some(attachment) = payload.get("attachment") {
            log::debug!("payload attachment: {}", attachment);
        }

        match notification.show() {
            Err(err) => log::warn!("push stream: could not show notification: {err}"),
            Ok(handle) => handle.wait_for_action(|action| {
                if action == "default" {
                    bring_to_front(&app);
                }
            }),
        }
    });
}
