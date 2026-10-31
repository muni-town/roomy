//! The in-process Loki sink: what the TypeScript appserver's
//! `packages/appserver/src/telemetry/loki.ts` is, for this binary.
//!
//! The container's stdout is not collected into Grafana, so a process that only
//! logs through `fmt` is invisible in production. A shadow worker that nobody
//! can watch is not a shadow. This module gives the process the same path the
//! TypeScript service has: one JSON line per event, batched and pushed to the
//! Alloy Loki push API at `ALLOY_URL`.
//!
//! Design constraints, in the order they matter:
//!
//! - **The logging call never blocks and never panics.** The queue is behind a
//!   `try_lock`: contention or a full queue drops the record and counts it. Every
//!   HTTP error, timeout and poisoned lock is swallowed — a sink that can take
//!   the process down is worse than no sink.
//! - **Bounded memory.** A dead Alloy must not grow the queue; the bound is
//!   enforced on both sides, on push and on re-queue after a failed push.
//! - **Cheap when off.** `ALLOY_URL` unset constructs nothing, and the layer's
//!   `enabled` is false, so the process pays nothing per event.
//! - **One stream per label set**, so Grafana can select `service_name`,
//!   `env`, `level` and `scope` without parsing the line.
//!
//! `build_id` is deliberately not a label: it changes on every deploy, and a
//! label that changes per deploy fragments a stream into one per release. It
//! rides in the JSON line instead.

use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use tracing::field::{Field, Visit};
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// The Loki `service_name` for this process. The TypeScript appserver writes
/// `appserver`; a stream that mixed the two would attribute the shadow's
/// numbers to the service it shadows.
const SERVICE_NAME: &str = "space-worker";

const DEFAULT_MAX_QUEUE: usize = 10_000;
const DEFAULT_BATCH_SIZE: usize = 500;
const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_secs(2);
const DEFAULT_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(60);
const DEFAULT_PUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a shutdown gets to drain the queue. The same bound the TypeScript
/// service uses on its fatal-exit path.
pub const SHUTDOWN_FLUSH: Duration = Duration::from_secs(5);

/// The most often the sink repeats a failure it has already announced. The line
/// goes to container stdout, which an operator reads: one per minute is a
/// signal, one per retry is a flood.
const REPORT_INTERVAL: Duration = Duration::from_secs(60);

/// The keys the line already has; an event field of the same name cannot
/// overwrite them.
const RESERVED: [&str; 5] = ["ts", "level", "scope", "msg", "build_id"];

/// The host a push URL addresses, without its credentials, path or query: what
/// an operator needs to know which Alloy the sink is talking to, and nothing a
/// log line should not carry.
fn host_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// Why `ALLOY_URL` is unusable, as one operator-length clause: `Ok(None)` when
/// it is unset, `Ok(Some(url))` when a sink can use it, `Err(reason)` when it is
/// set and cannot.
///
/// The check is absolute-plus-http(s) because that is the whole of what
/// `reqwest` accepts: everything else fails at request time, forever, on a sink
/// that from the inside looks exactly like one with nothing to say.
fn parse_alloy_url(raw: Option<&str>) -> Result<Option<Url>, String> {
    let Some(raw) = clean(raw) else {
        return Ok(None);
    };
    let url = Url::parse(raw).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("scheme is {:?}, not http or https", url.scheme()));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("the URL has no host".to_string());
    }
    Ok(Some(url))
}

/// The line for an `ALLOY_URL` that names no Alloy this process can reach.
fn disabled_line(reason: &str) -> String {
    format!("[loki] log sink disabled — ALLOY_URL is not an absolute URL ({reason})")
}

/// Which `scope` a `target` maps to: the logging analogue of the TypeScript
/// service's small scope enum, not a free-form module path — a scope is a label
/// value, and a label set with a hundred values is not a facet anyone can select.
///
/// An entry matches its target exactly or as a module prefix (`roomy_gateway`
/// matches `roomy_gateway::traffic::ws`), and the longest matching prefix wins,
/// so `roomy_gateway::signals` is a `signal` rather than a `gateway`.
const SCOPES: [(&str, &str); 11] = [
    ("roomy_appserver", "startup"),
    ("main", "startup"),
    ("roomy_space_worker::worker", "materialise"),
    ("roomy_space_worker::supervisor", "materialise"),
    ("space_db", "materialise"),
    ("space_feed", "feed"),
    ("roomy_space_worker::lease", "lease"),
    ("roomy_space_worker::signal", "signal"),
    ("roomy_space_worker::relay", "signal"),
    ("roomy_gateway::signals", "signal"),
    ("roomy_gateway", "gateway"),
];

fn scope_of(target: &str) -> &'static str {
    let mut best: Option<(usize, &'static str)> = None;
    for (prefix, scope) in SCOPES {
        let matched = target == prefix
            || target
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with("::"));
        if matched && best.is_none_or(|(length, _)| prefix.len() > length) {
            best = Some((prefix.len(), scope));
        }
    }
    best.map_or("other", |(_, scope)| scope)
}

fn level_name(level: &tracing::Level) -> &'static str {
    match *level {
        tracing::Level::TRACE => "trace",
        tracing::Level::DEBUG => "debug",
        tracing::Level::INFO => "info",
        tracing::Level::WARN => "warn",
        _ => "error",
    }
}

/// Trim, and treat an empty or whitespace-only value as absent: a platform that
/// sets a variable to `""` is saying nothing, not saying "empty".
fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The `env` label: `APP_ENV`, then `RAILWAY_ENVIRONMENT_NAME`, then `unknown`,
/// lowercased. One spelling so a Grafana variable matches every service.
fn resolve_env(app_env: Option<&str>, railway: Option<&str>) -> String {
    clean(app_env)
        .or_else(|| clean(railway))
        .map(str::to_lowercase)
        .unwrap_or_else(|| "unknown".to_string())
}

fn resolve_build_id(value: Option<&str>) -> String {
    clean(value).unwrap_or("unknown").to_string()
}

/// `1970-01-01T00:00:00.000Z`-shaped, in UTC, with no dependency for it: the
/// only clock this process needs to format is the log's.
fn iso8601(ts: SystemTime) -> String {
    let since = ts.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let millis = since.subsec_millis();
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let second_of_day = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        second_of_day / 3_600,
        (second_of_day % 3_600) / 60,
        second_of_day % 60,
    )
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm), proleptic
/// Gregorian, in the range a log file will ever cover.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Nanoseconds since the epoch, the timestamp a Loki value carries.
fn loki_timestamp(ts: SystemTime) -> u128 {
    ts.duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0)
}

/// The label set of a stream. `env` and `service_name` are per-process, so they
/// live on the sink; level and scope vary per record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Labels {
    level: &'static str,
    scope: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    ts: SystemTime,
    labels: Labels,
    line: String,
}

#[derive(Clone, Copy, Debug)]
struct Limits {
    max_queue: usize,
    batch_size: usize,
    flush_interval: Duration,
    initial_backoff: Duration,
    max_backoff: Duration,
    push_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_queue: DEFAULT_MAX_QUEUE,
            batch_size: DEFAULT_BATCH_SIZE,
            flush_interval: DEFAULT_FLUSH_INTERVAL,
            initial_backoff: DEFAULT_INITIAL_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
            push_timeout: DEFAULT_PUSH_TIMEOUT,
        }
    }
}

#[derive(Debug)]
struct Backoff {
    /// When the next push may be attempted; `None` until one fails.
    next_attempt: Option<Instant>,
    /// The delay the next failure installs, doubling up to the ceiling.
    delay: Duration,
}

/// What the sink has done with what it was given. `queued` is the current
/// depth; `sent`, `dropped` and `failed` are cumulative.
///
/// A sink that silently delivers nothing looks exactly like a sink with nothing
/// to say, so these numbers are served on the process's `/health`: "are the logs
/// arriving" is a question the process can answer about itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SinkStats {
    pub queued: usize,
    pub sent: u64,
    pub dropped: u64,
    pub failed: u64,
    /// A push failed and the batch is waiting out its backoff.
    pub retrying: bool,
}

impl SinkStats {
    /// The object `/health` carries. `queued` is left out: it changes per record,
    /// and the four counters here are the ones that answer whether the sink is
    /// delivering.
    #[must_use]
    pub fn to_value(self) -> Value {
        serde_json::json!({
            "sent": self.sent,
            "failed": self.failed,
            "dropped": self.dropped,
            "retrying": self.retrying,
        })
    }
}

/// What one push did.
enum Outcome {
    Sent,
    /// Why it did not, with no URL in it: an Alloy URL may carry credentials and
    /// this text reaches stderr.
    Failed(Failure),
}

/// The sink's account of itself, on stderr.
///
/// Deliberately not `tracing`: an event would be fed back into the queue this
/// reporter exists to say is not draining. stderr reaches the container log the
/// operator already reads, however broken the sink is.
#[derive(Debug, Default)]
struct Reporter {
    /// Whether the last push failed. `false` until one does, so the first failure
    /// of a run is always announced.
    failing: bool,
    /// When the last line was written.
    last: Option<Instant>,
}

impl Reporter {
    /// The line to write for `outcome`, or `None`. A change of state is always
    /// worth a line; repeating the same failure is worth one per
    /// [`REPORT_INTERVAL`].
    fn observe(&mut self, target: &str, outcome: &Outcome, now: Instant) -> Option<String> {
        match outcome {
            Outcome::Sent => {
                let was_failing = std::mem::replace(&mut self.failing, false);
                if !was_failing {
                    return None;
                }
                self.last = Some(now);
                Some(format!(
                    "[loki] push to {target} recovered; logs are reaching Loki again"
                ))
            }
            Outcome::Failed(failure) => {
                let repeated = self.failing
                    && self
                        .last
                        .is_some_and(|at| now.duration_since(at) < REPORT_INTERVAL);
                self.failing = true;
                if repeated {
                    return None;
                }
                self.last = Some(now);
                Some(format!(
                    "[loki] push to {target} failed ({}): {}; retrying — logs are not reaching Loki",
                    failure.class, failure.message
                ))
            }
        }
    }
}

/// What one push failed on, in the two terms an operator needs: the kind, and
/// the transport's own account of it.
#[derive(Debug)]
struct Failure {
    /// One word naming the kind, except for the catch-all, which carries the
    /// flags so the next occurrence needs no rerun to be classified.
    class: String,
    /// The failure's message, with the push URL replaced by its host: `reqwest`
    /// quotes the URL, which may carry a token in its path or query.
    message: String,
}

impl Failure {
    /// Alloy answered, and not with success. The status is the actionable part:
    /// 400 is a push body Loki refused, 401 is a credential, 5xx is Alloy's.
    fn status(status: u16) -> Self {
        Self {
            class: "status".to_string(),
            message: format!("Alloy answered HTTP {status}"),
        }
    }

    fn transport(error: &reqwest::Error, push_url: &str, target: &str) -> Self {
        let class = if error.is_builder() {
            // The request was never built: the URL is the problem, not the path
            // to Alloy. `parse_alloy_url` should have caught this at startup.
            "builder".to_string()
        } else if error.is_timeout() {
            "timeout".to_string()
        } else if error.is_connect() {
            "connect".to_string()
        } else if error.is_redirect() {
            "redirect".to_string()
        } else if error.is_body() || error.is_decode() {
            "response".to_string()
        } else if error.is_request() {
            "request".to_string()
        } else {
            // Nothing above named it, so print what would have: a request that
            // failed while being sent is not the same failure as one that never
            // left, and the next occurrence should say which it was.
            format!(
                "unknown timeout={} connect={} request={} builder={} redirect={}",
                error.is_timeout(),
                error.is_connect(),
                error.is_request(),
                error.is_builder(),
                error.is_redirect(),
            )
        };
        Self {
            class,
            message: error_chain(error, push_url, target),
        }
    }
}

/// The error and everything it was caused by, in one line: `reqwest`'s own
/// `Display` is the least informative link in it ("error sending request").
fn error_chain(error: &reqwest::Error, push_url: &str, target: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        let part = redact(&error.to_string(), push_url, target);
        if !part.is_empty() && parts.last() != Some(&part) {
            parts.push(part);
        }
        current = error.source();
    }
    parts.join(": ")
}

/// `message` with every form of the push URL replaced by the host. The URL may
/// carry credentials in its authority or a token in its path or query, and this
/// text reaches stderr, which the deployment's log collector may keep forever.
///
/// Two forms: the URL as configured, and the URL without its userinfo, which is
/// what `reqwest` prints — it drops credentials before quoting a URL, so the two
/// differ exactly when there are credentials to hide.
fn redact(message: &str, push_url: &str, target: &str) -> String {
    let mut text = message.replace(push_url, target);
    if let Ok(mut bare) = Url::parse(push_url) {
        let _ = bare.set_username("");
        let _ = bare.set_password(None);
        if bare.as_str() != push_url {
            text = text.replace(bare.as_str(), target);
        }
    }
    text
}

/// The queue and the HTTP client that drains it: what a `LokiLayer` hands each
/// record to.
///
/// A sink exists only when `ALLOY_URL` names an Alloy; the process logs to
/// stdout whether or not one does.
pub struct LokiSink {
    push_url: String,
    /// The push URL's host, for the self-report line: the full URL may carry
    /// credentials and never reaches a log.
    target: String,
    env: String,
    build_id: String,
    limits: Limits,
    queue: Mutex<VecDeque<Record>>,
    wake: Notify,
    requests: mpsc::UnboundedSender<oneshot::Sender<()>>,
    requests_rx: Mutex<Option<mpsc::UnboundedReceiver<oneshot::Sender<()>>>>,
    backoff: Mutex<Backoff>,
    reporter: Mutex<Reporter>,
    sent: AtomicU64,
    dropped: AtomicU64,
    failed: AtomicU64,
}

impl LokiSink {
    /// The sink `ALLOY_URL` names, or none. Unset (or blank) means no sink at
    /// all: the process logs to stdout exactly as it did before. Set but
    /// unusable means no sink and one line saying why — a sink that can never
    /// deliver is worse than none, because it looks like one that can.
    pub fn from_env() -> Option<Arc<Self>> {
        let (sink, line) = Self::from_value(std::env::var("ALLOY_URL").ok().as_deref());
        if let Some(line) = line {
            eprintln!("{line}");
        }
        sink
    }

    /// The same decision, from a value the caller supplies, so it can be tested
    /// without touching the process environment. The second half is the line the
    /// operator gets when there is no sink to speak of.
    pub(crate) fn from_value(raw: Option<&str>) -> (Option<Arc<Self>>, Option<String>) {
        let url = match parse_alloy_url(raw) {
            Ok(Some(url)) => url,
            Ok(None) => return (None, None),
            Err(reason) => return (None, Some(disabled_line(&reason))),
        };
        let sink = Self::new(
            url,
            resolve_env(
                std::env::var("APP_ENV").ok().as_deref(),
                std::env::var("RAILWAY_ENVIRONMENT_NAME").ok().as_deref(),
            ),
            resolve_build_id(std::env::var("BUILD_ID").ok().as_deref()),
            Limits::default(),
        );
        (Some(Arc::new(sink)), None)
    }

    fn new(url: Url, env: String, build_id: String, limits: Limits) -> Self {
        let (requests, requests_rx) = mpsc::unbounded_channel();
        Self {
            target: host_of(&url),
            push_url: url.to_string(),
            env,
            build_id,
            limits,
            queue: Mutex::new(VecDeque::new()),
            wake: Notify::new(),
            requests,
            requests_rx: Mutex::new(Some(requests_rx)),
            backoff: Mutex::new(Backoff {
                next_attempt: None,
                delay: limits.initial_backoff,
            }),
            reporter: Mutex::new(Reporter::default()),
            sent: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            failed: AtomicU64::new(0),
        }
    }

    /// The one line that proves this process can deliver: it goes through the
    /// same queue and the same push as every other event, so its arrival in Loki
    /// settles "are the logs arriving" at startup, instead of only after a
    /// failure. Emitted once, from the boot path, and never again.
    ///
    /// The target folds to `scope=startup` through [`SCOPES`].
    pub fn announce_startup(&self, spaces: usize) {
        tracing::info!(
            target: "roomy_appserver",
            spaces,
            sink = %self.target,
            "startup"
        );
        // Push it now rather than at the next batch window: the line is worth
        // nothing to a process that exits before the window opens.
        self.wake.notify_one();
    }

    /// Start the background flusher. Must be called inside the runtime that will
    /// also run the HTTP client; records pushed before this are simply queued.
    pub fn spawn(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        let requests = self.requests_rx.lock().ok()?.take()?;
        let sink = Arc::clone(self);
        Some(tokio::spawn(sink.run(requests)))
    }

    /// Queue one record. Never blocks, never grows past `max_queue`: a full
    /// queue drops its oldest record, because the newest line is the one an
    /// operator is reading for.
    fn push(&self, record: Record) {
        let mut queue = match self.queue.try_lock() {
            Ok(queue) => queue,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                // The flusher holds the lock for the length of a `VecDeque`
                // operation; losing a record to that is preferable to waiting.
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        if queue.len() >= self.limits.max_queue {
            queue.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        queue.push_back(record);
        let ready = queue.len() >= self.limits.batch_size;
        drop(queue);
        if ready {
            self.wake.notify_one();
        }
    }

    /// Drain the queue, giving up after `timeout`. Used on the ctrl-c path: a
    /// dead Alloy must not hold the exit open.
    pub async fn flush(&self, timeout: Duration) {
        let (reply, flushed) = oneshot::channel();
        if self.requests.send(reply).is_err() {
            return;
        }
        let _ = tokio::time::timeout(timeout, flushed).await;
    }

    /// What the sink has done so far, for `/health`.
    pub fn stats(&self) -> SinkStats {
        SinkStats {
            queued: self.queue.lock().map_or(0, |queue| queue.len()),
            sent: self.sent.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Relaxed),
            retrying: self.in_backoff(),
        }
    }

    /// Say on stderr what this push means for delivery, if it is worth saying.
    fn report(&self, outcome: &Outcome) {
        let line = match self.reporter.lock() {
            Ok(mut reporter) => reporter.observe(&self.target, outcome, Instant::now()),
            Err(poisoned) => poisoned
                .into_inner()
                .observe(&self.target, outcome, Instant::now()),
        };
        if let Some(line) = line {
            eprintln!("{line}");
        }
    }

    fn in_backoff(&self) -> bool {
        self.backoff
            .lock()
            .is_ok_and(|backoff| backoff.next_attempt.is_some_and(|at| Instant::now() < at))
    }

    fn start_backoff(&self) {
        if let Ok(mut backoff) = self.backoff.lock() {
            backoff.next_attempt = Some(Instant::now() + backoff.delay);
            backoff.delay = (backoff.delay * 2).min(self.limits.max_backoff);
        }
    }

    fn reset_backoff(&self) {
        if let Ok(mut backoff) = self.backoff.lock() {
            backoff.next_attempt = None;
            backoff.delay = self.limits.initial_backoff;
        }
    }

    fn take_batch(&self) -> Vec<Record> {
        let Ok(mut queue) = self.queue.lock() else {
            return Vec::new();
        };
        let count = queue.len().min(self.limits.batch_size);
        queue.drain(..count).collect()
    }

    /// Put a failed batch back at the front — it is the work closest to being
    /// logged — and hold the queue at its bound from the back.
    fn requeue(&self, batch: Vec<Record>) {
        let Ok(mut queue) = self.queue.lock() else {
            return;
        };
        for record in batch.into_iter().rev() {
            queue.push_front(record);
        }
        while queue.len() > self.limits.max_queue {
            queue.pop_back();
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn run(self: Arc<Self>, mut requests: mpsc::UnboundedReceiver<oneshot::Sender<()>>) {
        // Built here rather than in `new`: the client's connector belongs to the
        // runtime this task runs on, and `new` is called before that runtime
        // exists.
        let client = reqwest::Client::builder()
            .timeout(self.limits.push_timeout)
            .build()
            .unwrap_or_default();

        loop {
            let request = tokio::select! {
                _ = self.wake.notified() => None,
                _ = tokio::time::sleep(self.limits.flush_interval) => None,
                request = requests.recv() => match request {
                    Some(request) => Some(request),
                    None => {
                        self.flush_once(&client).await;
                        return;
                    }
                },
            };
            self.flush_once(&client).await;
            if let Some(request) = request {
                let _ = request.send(());
            }
        }
    }

    /// Push batches until the queue is empty, the backoff window is open, or a
    /// push fails. Every outcome is a counter, never an error: the caller is a
    /// logging path or a shutdown path, and neither can do anything about a
    /// broken sink. What a broken sink can do is say so on stderr, which is what
    /// `report` is for.
    async fn flush_once(&self, client: &reqwest::Client) {
        if self.in_backoff() {
            return;
        }
        loop {
            let batch = self.take_batch();
            if batch.is_empty() {
                return;
            }
            let count = batch.len() as u64;
            let body = push_body(&self.env, &batch);
            let outcome = self.send(client, body).await;
            self.report(&outcome);
            if matches!(outcome, Outcome::Sent) {
                self.sent.fetch_add(count, Ordering::Relaxed);
                self.reset_backoff();
            } else {
                self.failed.fetch_add(1, Ordering::Relaxed);
                self.requeue(batch);
                self.start_backoff();
                return;
            }
        }
    }

    /// One push, as an outcome. Separate from the drain loop so a test can hold
    /// the failure and the line it produces.
    async fn send(&self, client: &reqwest::Client, body: String) -> Outcome {
        match client
            .post(&self.push_url)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => Outcome::Sent,
            Ok(response) => Outcome::Failed(Failure::status(response.status().as_u16())),
            Err(error) => Outcome::Failed(Failure::transport(&error, &self.push_url, &self.target)),
        }
    }

    fn record(&self, metadata: &Metadata<'_>, fields: Fields) -> Record {
        let ts = SystemTime::now();
        let labels = Labels {
            level: level_name(metadata.level()),
            scope: scope_of(metadata.target()),
        };
        Record {
            ts,
            labels,
            line: self.line(ts, labels, fields),
        }
    }

    fn line(&self, ts: SystemTime, labels: Labels, fields: Fields) -> String {
        let mut line = Map::new();
        line.insert("ts".into(), Value::String(iso8601(ts)));
        line.insert("level".into(), Value::String(labels.level.into()));
        line.insert("scope".into(), Value::String(labels.scope.into()));
        line.insert("msg".into(), Value::String(fields.message));
        for (name, value) in fields.fields {
            if RESERVED.contains(&name.as_str()) {
                continue;
            }
            line.insert(name, value);
        }
        line.insert("build_id".into(), Value::String(self.build_id.clone()));
        Value::Object(line).to_string()
    }
}

/// The Loki push body: one stream per distinct label set, each carrying its
/// records in order. Built by hand so a record's line is not copied again into
/// a `serde_json::Value` tree.
fn push_body(env: &str, batch: &[Record]) -> String {
    use std::fmt::Write;

    let mut streams: BTreeMap<Labels, Vec<&Record>> = BTreeMap::new();
    for record in batch {
        streams.entry(record.labels).or_default().push(record);
    }
    let quoted_env = serde_json::to_string(env).unwrap_or_else(|_| "\"unknown\"".into());
    let service = serde_json::to_string(SERVICE_NAME).unwrap_or_else(|_| "\"space-worker\"".into());

    let mut body = String::from("{\"streams\":[");
    for (index, (labels, records)) in streams.into_iter().enumerate() {
        if index > 0 {
            body.push(',');
        }
        let _ = write!(
            body,
            "{{\"stream\":{{\"service_name\":{service},\"env\":{quoted_env},\"level\":\"{level}\",\"scope\":\"{scope}\"}},\"values\":[",
            level = labels.level,
            scope = labels.scope,
        );
        for (position, record) in records.into_iter().enumerate() {
            if position > 0 {
                body.push(',');
            }
            let line = serde_json::to_string(&record.line).unwrap_or_else(|_| "\"\"".into());
            let timestamp = loki_timestamp(record.ts);
            let _ = write!(body, "[\"{timestamp}\",{line}]");
        }
        body.push_str("]}");
    }
    body.push_str("]}");
    body
}

/// The event's fields: `message` becomes the line's `msg`, everything else is
/// copied as a JSON value so a field survives the trip with its shape.
#[derive(Default)]
struct Fields {
    message: String,
    fields: Map<String, Value>,
}

impl Fields {
    fn insert(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            if let Value::String(message) = value {
                self.message = message;
            }
        } else {
            self.fields.insert(field.name().to_owned(), value);
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field, Value::String(value.to_owned()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.insert(field, Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, Value::from(value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.insert(field, Value::String(value.to_string()));
    }

    /// `%value` and `?value` both arrive here; both are already formatted.
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.insert(field, Value::String(format!("{value:?}")));
    }
}

/// The `tracing_subscriber` layer that feeds the sink.
///
/// With no sink this layer does not implement `enabled` as `false`: a layer's
/// `enabled` is an AND across the whole subscriber, so answering "disabled"
/// silences the `fmt` layer too — the process would log nowhere at all. The
/// cheap `is_some` in `on_event` is the whole cost of a disabled sink.
pub struct LokiLayer {
    sink: Option<Arc<LokiSink>>,
}

impl LokiLayer {
    /// A layer that feeds `sink`, or that drops every event when it is `None`.
    pub fn new(sink: Option<Arc<LokiSink>>) -> Self {
        Self { sink }
    }
}

impl<S: Subscriber> Layer<S> for LokiLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let Some(sink) = self.sink.as_deref() else {
            return;
        };
        let mut fields = Fields::default();
        event.record(&mut fields);
        sink.push(sink.record(event.metadata(), fields));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    /// An Alloy that answers `status` and keeps every body it receives.
    struct Alloy {
        url: String,
        bodies: Arc<Mutex<Vec<Value>>>,
    }

    impl Alloy {
        async fn new(status: u16) -> Self {
            use axum::extract::State;
            use axum::routing::post;

            let bodies: Arc<Mutex<Vec<Value>>> = Arc::default();
            let state = (Arc::clone(&bodies), status);

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("listener");
            let address = listener.local_addr().expect("address");
            let router = axum::Router::new()
                .route(
                    "/loki/api/v1/push",
                    post(
                        |State((bodies, status)): State<(Arc<Mutex<Vec<Value>>>, u16)>,
                         body: String| async move {
                            let parsed = serde_json::from_str(&body).expect("push body is JSON");
                            bodies.lock().expect("bodies").push(parsed);
                            axum::http::StatusCode::from_u16(status).expect("status")
                        },
                    ),
                )
                .with_state(state);
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });
            Self {
                url: format!("http://{address}/loki/api/v1/push"),
                bodies,
            }
        }

        fn bodies(&self) -> Vec<Value> {
            self.bodies.lock().expect("bodies").clone()
        }
    }

    fn sink_for(url: &str, limits: Limits) -> Arc<LokiSink> {
        let url = Url::parse(url).expect("test push URL");
        Arc::new(LokiSink::new(
            url,
            "staging".to_string(),
            "abc1234".to_string(),
            limits,
        ))
    }

    /// Fast limits: a test that waits two seconds to observe a flush is a test
    /// that has stopped being run.
    fn fast_limits() -> Limits {
        Limits {
            max_queue: 64,
            batch_size: 500,
            flush_interval: Duration::from_millis(5),
            initial_backoff: Duration::from_millis(20),
            max_backoff: Duration::from_millis(40),
            push_timeout: Duration::from_millis(500),
        }
    }

    /// Emit `events` through a subscriber carrying only this layer.
    fn emit(sink: &Arc<LokiSink>, events: impl FnOnce()) {
        let subscriber =
            tracing_subscriber::registry().with(LokiLayer::new(Some(Arc::clone(sink))));
        tracing::subscriber::with_default(subscriber, events);
    }

    fn streams(body: &Value) -> Vec<&Value> {
        body["streams"]
            .as_array()
            .expect("streams")
            .iter()
            .collect()
    }

    fn values(stream: &Value) -> Vec<(String, String)> {
        stream["values"]
            .as_array()
            .expect("values")
            .iter()
            .map(|value| {
                (
                    value[0].as_str().expect("timestamp").to_string(),
                    value[1].as_str().expect("line").to_string(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn an_event_reaches_loki_with_the_documented_labels_and_line() {
        let alloy = Alloy::new(200).await;
        let sink = sink_for(&alloy.url, fast_limits());
        let _flusher = sink.spawn().expect("flusher");

        emit(&sink, || {
            tracing::info!(target: "roomy_gateway::traffic", rooms = 3, mirrored = true, "served a read");
        });
        sink.flush(Duration::from_secs(2)).await;

        let bodies = alloy.bodies();
        assert_eq!(bodies.len(), 1, "one push per flush");
        let streams = streams(&bodies[0]);
        assert_eq!(streams.len(), 1, "one stream per label set");
        let labels = &streams[0]["stream"];
        assert_eq!(labels["service_name"], "space-worker");
        assert_eq!(labels["env"], "staging");
        assert_eq!(labels["level"], "info");
        assert_eq!(labels["scope"], "gateway");
        assert!(
            labels.get("build_id").is_none(),
            "build_id is a per-deploy label and would fragment the stream"
        );

        let values = values(streams[0]);
        assert_eq!(values.len(), 1);
        let line: Value = serde_json::from_str(&values[0].1).expect("line is JSON");
        assert_eq!(line["level"], "info");
        assert_eq!(line["scope"], "gateway");
        assert_eq!(line["msg"], "served a read");
        assert_eq!(line["build_id"], "abc1234");
        assert_eq!(line["rooms"], 3);
        assert_eq!(line["mirrored"], true);
        let ts = line["ts"].as_str().expect("ts is a string");
        assert!(
            ts.len() == 24 && ts.ends_with('Z') && ts.as_bytes()[10] == b'T',
            "ts is ISO-8601 UTC, got {ts}"
        );
        assert!(
            values[0].0.parse::<u128>().expect("nanoseconds") > 1_600_000_000_000_000_000,
            "the Loki value timestamp is nanoseconds since the epoch"
        );
    }

    #[test]
    fn every_listed_target_folds_to_its_scope_and_nothing_else_does() {
        let table = [
            ("main", "startup"),
            ("roomy_appserver", "startup"),
            ("roomy_appserver::main", "startup"),
            ("roomy_space_worker::worker", "materialise"),
            ("roomy_space_worker::supervisor::lease_renew", "materialise"),
            ("space_db", "materialise"),
            ("space_db::derived::plan", "materialise"),
            ("space_feed", "feed"),
            ("space_feed::sqlite", "feed"),
            ("roomy_space_worker::lease", "lease"),
            ("roomy_space_worker::signal", "signal"),
            ("roomy_space_worker::relay", "signal"),
            ("roomy_gateway::signals::fanout", "signal"),
            ("roomy_gateway", "gateway"),
            ("roomy_gateway::traffic::ws", "gateway"),
            ("roomy_gateway::reads::mentions", "gateway"),
            ("roomy_gateway::cutover", "gateway"),
            ("roomy_gateway::procedures::send_events", "gateway"),
            ("roomy_gateway::internal", "gateway"),
            ("axum::serve", "other"),
            ("reqwest::connect", "other"),
            ("roomy_sync::session", "other"),
        ];
        for (target, expected) in table {
            assert_eq!(scope_of(target), expected, "target {target}");
        }

        // The longest prefix wins where two entries would both match: a signal
        // is not gateway traffic.
        assert_eq!(scope_of("roomy_gateway::signals"), "signal");
        assert_eq!(scope_of("roomy_gateway::signals_extra"), "gateway");
        assert_eq!(scope_of("roomy_appserver_extra"), "other");
    }

    #[tokio::test]
    async fn one_flush_batches_records_into_one_push_grouped_by_label_set() {
        let alloy = Alloy::new(200).await;
        let sink = sink_for(&alloy.url, fast_limits());
        let _flusher = sink.spawn().expect("flusher");

        emit(&sink, || {
            for index in 0..3 {
                tracing::info!(target: "space_feed::sqlite", index, "change");
            }
            tracing::warn!(target: "roomy_space_worker::lease", "lease lost");
        });
        sink.flush(Duration::from_secs(2)).await;

        let bodies = alloy.bodies();
        assert_eq!(bodies.len(), 1, "one push carries the whole batch");
        let streams = streams(&bodies[0]);
        assert_eq!(streams.len(), 2, "two label sets, two streams");
        let feed = streams
            .iter()
            .find(|stream| stream["stream"]["scope"] == "feed")
            .expect("feed stream");
        let lease = streams
            .iter()
            .find(|stream| stream["stream"]["scope"] == "lease")
            .expect("lease stream");
        assert_eq!(feed["stream"]["level"], "info");
        assert_eq!(lease["stream"]["level"], "warn");
        assert_eq!(values(feed).len(), 3);
        assert_eq!(values(lease).len(), 1);
        assert_eq!(sink.stats().sent, 4);
        assert_eq!(sink.stats().queued, 0);
    }

    #[tokio::test]
    async fn a_failing_alloy_leaves_the_queue_bounded_and_the_logging_call_non_blocking() {
        let alloy = Alloy::new(500).await;
        let mut limits = fast_limits();
        limits.max_queue = 8;
        // Long enough that the pushes in this test are the ones we make by hand.
        limits.flush_interval = Duration::from_secs(30);
        limits.initial_backoff = Duration::from_secs(30);
        limits.max_backoff = Duration::from_secs(30);
        let sink = sink_for(&alloy.url, limits);
        let _flusher = sink.spawn().expect("flusher");

        let started = Instant::now();
        emit(&sink, || {
            for index in 0..10_000 {
                tracing::info!(target: "roomy_gateway::traffic", index, "read");
            }
        });
        let push_cost = started.elapsed();
        assert!(
            push_cost < Duration::from_secs(1),
            "ten thousand log calls took {push_cost:?}"
        );
        assert_eq!(sink.stats().queued, 8, "the queue holds at its bound");
        assert_eq!(
            sink.stats().dropped,
            9_992,
            "the oldest records were dropped"
        );

        // The push fails, the batch comes back, and the queue is still bounded.
        sink.flush(Duration::from_secs(2)).await;
        let stats = sink.stats();
        assert_eq!(stats.queued, 8);
        assert_eq!(stats.failed, 1);
        assert!(stats.retrying, "a failed push schedules its retry");
        assert_eq!(sink.stats().sent, 0);
    }

    #[tokio::test]
    async fn a_refused_connection_is_swallowed_and_retried() {
        // Nothing listens on port 1: connect() fails immediately.
        let mut limits = fast_limits();
        limits.initial_backoff = Duration::from_millis(50);
        let sink = sink_for("http://127.0.0.1:1/loki/api/v1/push", limits);
        let _flusher = sink.spawn().expect("flusher");

        emit(&sink, || tracing::error!("the world is on fire"));
        sink.flush(Duration::from_secs(2)).await;

        let stats = sink.stats();
        assert_eq!(stats.failed, 1, "the failure is counted, not raised");
        assert_eq!(stats.queued, 1, "the record is kept for the retry");
        assert!(stats.retrying, "a retry is scheduled");

        // The process is still here and the next attempt happens.
        tokio::time::sleep(Duration::from_millis(120)).await;
        sink.flush(Duration::from_secs(2)).await;
        assert!(
            sink.stats().failed > 1,
            "the batch was retried, got {} failures",
            sink.stats().failed
        );
    }

    #[tokio::test]
    async fn shutdown_flushes_the_queue_within_the_bound() {
        let alloy = Alloy::new(200).await;
        let mut limits = fast_limits();
        // Nothing but the explicit flush would drain this queue.
        limits.flush_interval = Duration::from_secs(30);
        limits.batch_size = 500;
        let sink = sink_for(&alloy.url, limits);
        let flusher = sink.spawn().expect("flusher");

        emit(&sink, || {
            for index in 0..5 {
                tracing::warn!(target: "roomy_space_worker::supervisor", index, "batch failed");
            }
        });
        assert!(alloy.bodies().is_empty(), "queued, not yet pushed");

        let started = Instant::now();
        sink.flush(SHUTDOWN_FLUSH).await;
        assert!(started.elapsed() < SHUTDOWN_FLUSH);
        assert_eq!(alloy.bodies().len(), 1);
        assert_eq!(sink.stats().queued, 0);
        flusher.abort();
    }

    #[test]
    fn an_unset_alloy_url_constructs_no_sink_and_silences_nothing() {
        for raw in [None, Some(""), Some("   ")] {
            let (sink, line) = LokiSink::from_value(raw);
            assert!(sink.is_none(), "unset ALLOY_URL is no sink at all: {raw:?}");
            assert!(line.is_none(), "an unset ALLOY_URL has nothing to report");
        }

        // No sink is not no logging: the layer sits beside `fmt`, so an event it
        // drops must still reach everything else in the subscriber.
        let subscriber = tracing_subscriber::registry().with(LokiLayer::new(None));
        tracing::subscriber::with_default(subscriber, || {
            assert!(
                tracing::event_enabled!(target: "roomy_gateway", tracing::Level::INFO),
                "a sinkless layer must not disable the subscriber for other layers"
            );
            tracing::info!(target: "roomy_gateway", "still logged");
        });
    }

    #[test]
    fn an_alloy_url_that_is_not_absolute_constructs_no_sink_and_says_why() {
        for (raw, reason) in [
            // A bare host reads as a scheme to the URL parser, which is exactly
            // why the scheme is worth printing: the line quotes what it saw.
            (
                "alloy.internal:3100/loki/api/v1/push",
                "scheme is \"alloy.internal\"",
            ),
            ("/loki/api/v1/push", "relative URL without a base"),
            ("ftp://alloy.internal/loki/api/v1/push", "\"ftp\""),
            ("http://", "empty host"),
        ] {
            let (sink, line) = LokiSink::from_value(Some(raw));
            assert!(sink.is_none(), "no sink for {raw}");
            let line = line.expect("the operator is told why there is no sink");
            assert_eq!(line.lines().count(), 1, "one line, not a paragraph: {line}");
            assert!(
                line.starts_with("[loki] log sink disabled — ALLOY_URL is not an absolute URL ("),
                "{line}"
            );
            assert!(line.contains(reason), "expected {reason} in {line}");
        }

        // A usable URL constructs a sink and says nothing.
        let (sink, line) =
            LokiSink::from_value(Some("http://alloy.internal:3100/loki/api/v1/push"));
        assert!(sink.is_some());
        assert_eq!(line, None);
    }

    #[test]
    fn env_prefers_app_env_and_falls_through_whitespace() {
        assert_eq!(resolve_env(Some("staging"), Some("production")), "staging");
        assert_eq!(resolve_env(None, Some("production")), "production");
        assert_eq!(resolve_env(Some("   "), Some("production")), "production");
        assert_eq!(resolve_env(Some("\t\n"), None), "unknown");
        assert_eq!(resolve_env(None, None), "unknown");
        assert_eq!(resolve_env(Some(" STAGING "), None), "staging");
        assert_eq!(resolve_env(None, Some("Production")), "production");
        assert_eq!(resolve_build_id(None), "unknown");
        assert_eq!(resolve_build_id(Some(" ")), "unknown");
        assert_eq!(resolve_build_id(Some("abc1234")), "abc1234");
    }

    #[test]
    fn the_first_failure_and_every_recovery_are_announced_once() {
        let mut reporter = Reporter::default();
        let start = Instant::now();
        let failing = Outcome::Failed(Failure::status(500));
        let target = "alloy.internal:3100";

        let first = reporter
            .observe(target, &failing, start)
            .expect("the first failure of a run is announced");
        assert!(first.contains(target), "the line names the host: {first}");
        assert!(
            first.contains("(status)") && first.contains("Alloy answered HTTP 500"),
            "the line names the class and the failure: {first}"
        );

        assert!(
            reporter
                .observe(target, &failing, start + Duration::from_secs(1))
                .is_none(),
            "the same failure a second later is not a second line"
        );
        assert!(
            reporter
                .observe(target, &failing, start + Duration::from_secs(59))
                .is_none(),
            "one line a minute, not one a retry"
        );
        let repeated = reporter
            .observe(target, &failing, start + Duration::from_secs(61))
            .expect("a failure still present after a minute is worth repeating");
        assert!(repeated.contains("Alloy answered HTTP 500"), "{repeated}");

        let recovered = reporter
            .observe(target, &Outcome::Sent, start + Duration::from_secs(62))
            .expect("a recovery is a change of state and is announced");
        assert!(recovered.contains("recovered"), "{recovered}");
        assert!(
            reporter
                .observe(target, &Outcome::Sent, start + Duration::from_secs(63))
                .is_none(),
            "a sink that keeps delivering says so once"
        );

        assert!(
            reporter
                .observe(target, &failing, start + Duration::from_secs(64))
                .is_some(),
            "the next failure after a healthy period is announced again"
        );
    }

    #[test]
    fn the_reported_target_is_the_host_without_credentials_or_token() {
        let sink = sink_for(
            "http://user:secret@alloy.internal:3100/loki/api/v1/push?token=s3cr3t",
            fast_limits(),
        );
        assert_eq!(sink.target, "alloy.internal:3100");
        let line = Reporter::default()
            .observe(
                &sink.target,
                &Outcome::Failed(Failure {
                    class: "connect".to_string(),
                    message: "could not connect".to_string(),
                }),
                Instant::now(),
            )
            .expect("a line");
        assert!(!line.contains("secret"), "{line}");
        assert!(!line.contains("user"), "{line}");
        assert!(!line.contains("http"), "{line}");
    }

    #[tokio::test]
    async fn a_builder_error_a_connect_error_and_a_status_each_name_themselves() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("client");

        // The request is never built: the URL is the problem, and the message
        // says so even though the URL text itself is redacted to its host.
        let refused_url = "alloy.internal:3100/loki/api/v1/push";
        let error = client
            .post(refused_url)
            .body("{}")
            .send()
            .await
            .expect_err("a URL without a scheme cannot be sent");
        let builder = Failure::transport(&error, refused_url, "alloy.internal:3100");
        assert_eq!(builder.class, "builder", "{}", builder.message);

        // Nothing listens on port 1: connect() fails immediately.
        let refused_push = "http://user:s3cr3t@127.0.0.1:1/loki/api/v1/push?token=t0ken";
        let error = client
            .post(refused_push)
            .body("{}")
            .send()
            .await
            .expect_err("nothing listens on port 1");
        let connect = Failure::transport(&error, refused_push, "127.0.0.1:1");
        assert_eq!(connect.class, "connect", "{}", connect.message);

        let status = Failure::status(500);

        // Distinct, so a line names the failure it is about, and actionable:
        // each says what to look at next.
        assert_ne!(builder.class, connect.class);
        assert_ne!(connect.class, status.class);
        assert_eq!(status.class, "status");
        assert_eq!(status.message, "Alloy answered HTTP 500");
        assert!(
            connect.message.contains("Connection refused"),
            "the transport's own account survives: {}",
            connect.message
        );
        assert!(
            connect.message.contains("127.0.0.1:1"),
            "the host stands in for the URL: {}",
            connect.message
        );

        // No form of the push URL reaches the text: not the credentials, not the
        // token in the query, not the scheme.
        for failure in [&builder, &connect] {
            for secret in ["s3cr3t", "user:", "t0ken", "http://", "/loki/api/v1/push"] {
                assert!(
                    !failure.message.contains(secret),
                    "{secret:?} leaked into {:?}",
                    failure.message
                );
            }
        }
    }

    #[tokio::test]
    async fn a_failing_alloy_line_names_the_class_and_the_message_but_never_the_url() {
        let alloy = Alloy::new(500).await;
        let sink = sink_for(&alloy.url, fast_limits());
        let client = reqwest::Client::new();

        let outcome = sink.send(&client, "{}".to_string()).await;
        let line = Reporter::default()
            .observe(&sink.target, &outcome, Instant::now())
            .expect("a failed push is always announced");

        assert!(line.contains("(status)"), "{line}");
        assert!(line.contains("Alloy answered HTTP 500"), "{line}");
        assert!(
            line.contains(&sink.target),
            "the line names the host it could not reach: {line}"
        );
        assert!(
            !line.contains(&alloy.url),
            "the push URL never reaches stderr: {line}"
        );
        assert!(!line.contains("http"), "{line}");
    }

    #[tokio::test]
    async fn the_startup_line_is_emitted_once_and_reaches_the_sink() {
        let alloy = Alloy::new(200).await;
        let sink = sink_for(&alloy.url, fast_limits());
        let _flusher = sink.spawn().expect("flusher");
        let target = sink.target.clone();

        emit(&sink, || sink.announce_startup(7));

        // No explicit flush: the boot line is pushed because announcing wakes the
        // flusher, not because something later drains the queue. A process that
        // exits before its first batch window is a process whose boot is invisible.
        let started = Instant::now();
        while alloy.bodies().is_empty() && started.elapsed() < Duration::from_secs(2) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the startup line waits for the flusher, not for the batch window"
        );

        let bodies = alloy.bodies();
        assert_eq!(bodies.len(), 1, "one push, and it carries the one line");
        let streams = streams(&bodies[0]);
        assert_eq!(streams.len(), 1, "one label set");
        assert_eq!(streams[0]["stream"]["scope"], "startup");
        assert_eq!(streams[0]["stream"]["level"], "info");

        let values = values(streams[0]);
        assert_eq!(values.len(), 1, "one line per process start");
        let line: Value = serde_json::from_str(&values[0].1).expect("line is JSON");
        assert_eq!(line["msg"], "startup");
        assert_eq!(line["scope"], "startup");
        assert_eq!(line["spaces"], 7);
        assert_eq!(line["sink"], target.as_str());
        assert_eq!(line["build_id"], "abc1234");
    }

    #[tokio::test]
    async fn an_alloy_that_always_fails_moves_the_counters_and_keeps_the_process_alive() {
        let alloy = Alloy::new(500).await;
        let mut limits = fast_limits();
        limits.max_queue = 8;
        // Nothing here pushes on its own: the explicit flush is the push, so the
        // backoff it installs is still open when the counters are read.
        limits.flush_interval = Duration::from_secs(30);
        limits.initial_backoff = Duration::from_secs(30);
        limits.max_backoff = Duration::from_secs(30);
        let sink = sink_for(&alloy.url, limits);
        let _flusher = sink.spawn().expect("flusher");

        emit(
            &sink,
            || tracing::info!(target: "roomy_space_worker::supervisor", "batch failed"),
        );
        sink.flush(Duration::from_secs(2)).await;

        let stats = sink.stats();
        assert_eq!(stats.failed, 1, "the push failed");
        assert!(stats.retrying, "a retry is scheduled, not a spin");
        assert_eq!(stats.queued, 1, "the records are kept for the retry");
        assert_eq!(stats.sent, 0);

        // The health body is what an operator reads; it has to move too.
        assert_eq!(
            sink.stats().to_value(),
            serde_json::json!({ "sent": 0, "failed": 1, "dropped": 0, "retrying": true })
        );
    }

    #[test]
    fn timestamps_are_iso8601_utc() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_millis(1_700_000_000_000)),
            "2023-11-14T22:13:20.000Z"
        );
        // A leap day, to keep the civil-date arithmetic honest.
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_secs(1_709_164_800)),
            "2024-02-29T00:00:00.000Z"
        );
    }
}
