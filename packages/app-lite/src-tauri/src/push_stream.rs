use crate::bring_to_front;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{channel, Receiver, RecvTimeoutError, Sender},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

const TOKEN_TIMEOUT: Duration = Duration::from_secs(15);
// The server sends a keepalive every 20 seconds.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
// A stream that lived this long counts as working.
const HEALTHY_STREAM: Duration = Duration::from_secs(30);
const BASE_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_UNAUTHORIZED: u32 = 3;

const TOKEN_REQUEST_EVENT: &str = "push-stream-token-request";
const REJECTED_EVENT: &str = "push-stream-rejected";
// Payload: the push payload as a JSON string.
const NOTIFICATION_CLICKED_EVENT: &str = "push-notification-clicked";

pub struct PushStreamState {
    generation: AtomicU64,
    token_sender: Sender<String>,
    token_receiver: Mutex<Receiver<String>>,
    active_room: Mutex<Option<String>>,
}

impl PushStreamState {
    pub fn new() -> Self {
        let (token_sender, token_receiver) = channel();
        Self {
            generation: AtomicU64::new(0),
            token_sender,
            token_receiver: Mutex::new(token_receiver),
            active_room: Mutex::new(None),
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

/// webview response to TOKEN_REQUEST_EVENT.
#[tauri::command]
pub fn push_stream_provide_token(
    state: State<'_, PushStreamState>,
    token: String,
) -> Result<(), String> {
    state
        .token_sender
        .send(token)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn push_stream_set_active_room(
    state: State<'_, PushStreamState>,
    room: Option<String>,
) -> Result<(), String> {
    let mut active_room = state.active_room.lock().map_err(|err| err.to_string())?;
    *active_room = room;
    Ok(())
}

fn request_token(app: &AppHandle, state: &PushStreamState) -> Option<String> {
    let receiver = state.token_receiver.lock().ok()?;
    // Drop late response
    while receiver.try_recv().is_ok() {}
    app.emit(TOKEN_REQUEST_EVENT, ()).ok()?;
    receiver.recv_timeout(TOKEN_TIMEOUT).ok()
}

#[derive(Default)]
struct SseEvent {
    name: String,
    data: String,
}

/// Feeds one line, without its line ending.
fn parse_event(event: &mut SseEvent, line: &str) -> Option<SseEvent> {
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
    // Keep-alive from server
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

enum Outcome {
    Stopped,
    // The stream ran and ended. `healthy` is true if it lasted a while.
    Closed { healthy: bool },
    Failed { retry_after: Duration },
    Unauthorized,
    Rejected(u16),
}

struct Stream {
    app: AppHandle,
    generation: u64,
    agent: ureq::Agent,
    url: String,
    endpoint: String,
    event: SseEvent,
}

impl Stream {
    fn is_current(&self) -> bool {
        let state = self.app.state::<PushStreamState>();
        state.generation.load(Ordering::SeqCst) == self.generation
    }

    fn connect_once(&mut self) -> Outcome {
        let state = self.app.state::<PushStreamState>();
        let Some(token) = request_token(&self.app, &state) else {
            log::warn!("push stream: the webview did not provide a token");
            return Outcome::Failed {
                retry_after: Duration::ZERO,
            };
        };

        let result = self
            .agent
            .get(&self.url)
            .query("endpoint", &self.endpoint)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .call();
        let response = match result {
            Ok(response) => response,
            Err(err) => {
                log::warn!("push stream: connect failed: {err}");
                return Outcome::Failed {
                    retry_after: Duration::ZERO,
                };
            }
        };

        let status = response.status().as_u16();
        match status {
            200 => {}
            401 => return Outcome::Unauthorized,
            400 | 403 | 404 => return Outcome::Rejected(status),
            _ => {
                log::warn!("push stream: server answered {status}");
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(Duration::ZERO);
                return Outcome::Failed { retry_after };
            }
        }
        self.read_stream(response.into_body())
    }

    fn read_stream(&mut self, body: ureq::Body) -> Outcome {
        self.event = SseEvent::default();
        let (line_sender, line_receiver) = channel::<String>();
        // Move blocking reads to a different tread.
        // Cleaned up on socket error when a dead connection times out
        thread::spawn(move || read_lines(body, line_sender));

        let started = Instant::now();
        loop {
            match line_receiver.recv_timeout(IDLE_TIMEOUT) {
                Ok(line) => {
                    if !self.is_current() {
                        return Outcome::Stopped;
                    }
                    let Some(event) = parse_event(&mut self.event, &line) else {
                        continue;
                    };
                    match event.name.as_str() {
                        "ready" => log::info!("push stream ready: {}", event.data),
                        "push" => show_notification(self.app.clone(), &event.data),
                        other => log::info!("push stream: ignoring event {other}"),
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    log::warn!("push stream: no data for {IDLE_TIMEOUT:?}");
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        Outcome::Closed {
            healthy: started.elapsed() >= HEALTHY_STREAM,
        }
    }
}

fn read_lines(body: ureq::Body, line_sender: Sender<String>) {
    let mut reader = BufReader::new(body.into_reader());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(err) => {
                log::warn!("push stream: read failed: {err}");
                return;
            }
        }
        let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
        if line_sender.send(trimmed).is_err() {
            return;
        }
    }
}

/// Doubles from `BASE_BACKOFF` to `MAX_BACKOFF` with jitter
fn backoff_delay(attempt: u32) -> Duration {
    let ceiling = BASE_BACKOFF
        .saturating_mul(1 << attempt.min(5))
        .min(MAX_BACKOFF);
    ceiling / 2 + ceiling.mul_f64(random_fraction() / 2.0)
}

/// A random number in [0, 1).
fn random_fraction() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.5;
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn run_stream(app: AppHandle, generation: u64, server_url: String, endpoint: String) {
    let url = format!(
        "{}/xrpc/space.roomy.push.stream",
        server_url.trim_end_matches('/')
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut stream = Stream {
        app: app.clone(),
        generation,
        agent,
        url,
        endpoint,
        event: SseEvent::default(),
    };
    let mut attempt: u32 = 0;
    let mut unauthorized: u32 = 0;

    while stream.is_current() {
        match stream.connect_once() {
            Outcome::Stopped => return,
            Outcome::Rejected(status) => {
                log::warn!("push stream: rejected with {status}");
                let _ = app.emit(REJECTED_EVENT, status);
                return;
            }
            Outcome::Unauthorized => {
                unauthorized += 1;
                log::warn!("push stream: token refused ({unauthorized}/{MAX_UNAUTHORIZED})");
                if unauthorized >= MAX_UNAUTHORIZED {
                    let _ = app.emit(REJECTED_EVENT, 401);
                    return;
                }
                thread::sleep(backoff_delay(attempt));
                attempt += 1;
            }
            Outcome::Failed { retry_after } => {
                thread::sleep(backoff_delay(attempt).max(retry_after));
                attempt += 1;
            }
            Outcome::Closed { healthy } => {
                log::info!("push stream closed; reconnecting");
                unauthorized = 0;
                attempt = if healthy { 0 } else { attempt + 1 };
                thread::sleep(backoff_delay(attempt));
            }
        }
    }
}

fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Title and body. Mirrors `notificationText` in `packages/sdk/src/push/notificationText.ts`.
fn notification_text(payload: &Value) -> (String, String) {
    let count = payload.get("count").and_then(Value::as_u64).unwrap_or(1);
    let room = string_field(payload, "roomName").unwrap_or_else(|| "a room".to_string());
    let author = string_field(payload, "authorName").or_else(|| string_field(payload, "authorDid"));
    let kind = string_field(payload, "type").unwrap_or_default();

    let title = match (&author, kind.as_str()) {
        (Some(author), _) => format!("{author} in {room}"),
        (None, "digest") => format!("{count} new messages in {room}"),
        (None, _) => format!("New message in {room}"),
    };
    let body = match kind.as_str() {
        "digest" => format!("{count} new messages"),
        "message" => match (string_field(payload, "messageContent"), &author) {
            (Some(content), _) => content,
            (None, Some(author)) => format!("{author} sent a message"),
            (None, None) => "New message".to_string(),
        },
        other => format!("New `{other}` message in Roomy"),
    };
    (title, body)
}

/// True if the window is focused on the room this push is for.
fn is_viewing_room(app: &AppHandle, payload: &Value) -> bool {
    let Some(room_id) = string_field(payload, "roomId") else {
        return false;
    };
    let state = app.state::<PushStreamState>();
    let Ok(active_room) = state.active_room.lock() else {
        return false;
    };
    if active_room.as_deref() != Some(room_id.as_str()) {
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
      return false;
    };
    window.is_visible().unwrap_or(false)
      && !window.is_minimized().unwrap_or(true)
      && window.is_focused().unwrap_or(false)
}

#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
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
    if is_viewing_room(&app, &payload) {
        return;
    }
    let (title, body) = notification_text(&payload);
    let icon = string_field(&payload, "icon").unwrap_or_default();
    let data = data.to_string();

    thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification.appname("Roomy").summary(&title).body(&body);
        if !icon.is_empty() {
            notification.icon(&icon);
        }
        // Click handling needs notify-rust's D-Bus API. Only Linux has it.
        #[cfg(target_os = "linux")]
        notification.action("default", "Open");

        match notification.show() {
            Err(err) => log::warn!("push stream: could not show notification: {err}"),
            #[cfg(target_os = "linux")]
            Ok(handle) => handle.wait_for_action(|action| {
                if action == "default" {
                    bring_to_front(&app);
                    let _ = app.emit(NOTIFICATION_CLICKED_EVENT, &data);
                }
            }),
            #[cfg(not(target_os = "linux"))]
            Ok(_) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn events(lines: &[&str]) -> Vec<(String, String)> {
        let mut event = SseEvent::default();
        lines
            .iter()
            .filter_map(|line| parse_event(&mut event, line))
            .map(|event| (event.name, event.data))
            .collect()
    }

    #[test]
    fn stream_lines_become_notification_text() {
        let lines = [
            "event: ready",
            r#"data: {"maxAgeMs":3600000}"#,
            "",
            ": keepalive",
            "event: push",
            r#"data: {"type":"message","roomName":"general","authorName":"Ada","messageContent":"hello"}"#,
            "",
            "event: push",
            r#"data: {"type":"digest","roomName":"general","count":4}"#,
            "",
        ];

        let texts: Vec<(String, String)> = events(&lines)
            .into_iter()
            .filter(|(name, _)| name == "push")
            .map(|(_, data)| {
                let payload: Value = serde_json::from_str(&data).expect("push data is JSON");
                notification_text(&payload)
            })
            .collect();

        assert_eq!(
            texts,
            vec![
                ("Ada in general".to_string(), "hello".to_string()),
                ("4 new messages in general".to_string(), "4 new messages".to_string()),
            ]
        );
    }

    #[test]
    fn parses_a_named_event() {
        let parsed = events(&["event: push", "data: {\"a\":1}", ""]);
        assert_eq!(parsed, vec![("push".into(), "{\"a\":1}".into())]);
    }

    #[test]
    fn unnamed_events_are_messages() {
        let parsed = events(&["data: hi", ""]);
        assert_eq!(parsed, vec![("message".into(), "hi".into())]);
    }

    #[test]
    fn joins_data_lines_with_newlines() {
        let parsed = events(&["data: one", "data: two", ""]);
        assert_eq!(parsed, vec![("message".into(), "one\ntwo".into())]);
    }

    #[test]
    fn ignores_comments_and_empty_events() {
        assert!(events(&[": keepalive", "", "event: ready", ""]).is_empty());
    }

    #[test]
    fn keeps_a_value_without_the_leading_space() {
        let parsed = events(&["data:tight", ""]);
        assert_eq!(parsed, vec![("message".into(), "tight".into())]);
    }

    #[test]
    fn one_event_does_not_leak_into_the_next() {
        let parsed = events(&["event: a", "data: 1", "", "data: 2", ""]);
        assert_eq!(
            parsed,
            vec![("a".into(), "1".into()), ("message".into(), "2".into())]
        );
    }

    #[test]
    fn message_text() {
        let payload = json!({
            "type": "message",
            "roomName": "general",
            "authorName": "Ada",
            "messageContent": "hello",
        });
        assert_eq!(
            notification_text(&payload),
            ("Ada in general".into(), "hello".into())
        );
    }

    #[test]
    fn message_text_without_author_or_content() {
        let payload = json!({ "type": "message", "roomName": "general" });
        assert_eq!(
            notification_text(&payload),
            ("New message in general".into(), "New message".into())
        );
    }

    #[test]
    fn digest_text() {
        let payload = json!({ "type": "digest", "roomName": "general", "count": 4 });
        assert_eq!(
            notification_text(&payload),
            ("4 new messages in general".into(), "4 new messages".into())
        );
    }

    #[test]
    fn backoff_stays_between_half_and_the_cap() {
        for attempt in 0..20 {
            let delay = backoff_delay(attempt);
            assert!(delay >= BASE_BACKOFF / 2);
            assert!(delay <= MAX_BACKOFF);
        }
    }
}
