mod navigation;

use std::{
    hash::{BuildHasher, Hasher, RandomState},
    io::{BufRead, BufReader},
    ops::ControlFlow,
    thread,
    time::Duration,
};

use tauri::{Builder, Manager, Url};

/// Plugin that keeps the webview on the app's own document.
///
/// The frontend routes link clicks out to the OS browser
/// (`packages/app-lite/src/lib/link-routing.ts`); this covers the navigations
/// no click produces — `window.location.assign` from app code, redirects, a
/// load that starts before the handler is installed. A refused navigation is
/// opened in the OS browser instead, so the URL the user asked for still
/// arrives; the webview stays on the app. See `navigation.rs` for the rule.
fn navigation_policy() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("navigation-policy")
        .on_navigation(|webview, url| {
            // The document's own origin, so the SPA's client-side routes and
            // the dev server's reloads pass. The URL is whatever the webview is
            // showing; before the first load that is `about:blank`, which has
            // no origin and lets the first navigation through.
            let document_origin = webview
                .url()
                .map(|current| current.origin().ascii_serialization())
                .unwrap_or_default();

            if navigation::allows_in_place_navigation(&document_origin, url.as_str()) {
                return true;
            }
            send_to_browser(webview, url);
            false
        })
        .build()
}

/// Hand a URL the webview refused to the OS browser. Failure is logged rather
/// than retried: the navigation is already cancelled, and the alternative
/// (letting it through) is the bug this policy exists to prevent.
fn send_to_browser(webview: &tauri::Webview<tauri::Wry>, url: &Url) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(err) = webview.opener().open_url(url.as_str(), None::<&str>) {
        log::warn!("navigation policy: could not open {url} externally: {err}");
    }
}

/// Bring the main window forward after an out-of-process event (the OAuth
/// callback arriving as a deep link). The browser that handled the
/// authorization page is in front; without this the user has to find the app.
#[cfg(desktop)]
fn bring_to_front(app: &tauri::AppHandle) {
    use tauri::Manager as _;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.set_focus();
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = Builder::default().plugin(navigation_policy());
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
          log::info!("a new app instance was opened with {args:?} and the deep link event was already triggered");

          // focus running instance when new app instance is requested
          let _ = app.get_webview_window("main")
           .expect("no main window")
           .set_focus();
        }));
    }
    #[cfg(mobile)]
    {
        builder = builder.plugin(
            tauri_plugin_mobile_push::Builder::new()
                .ios_foreground_presentation(
                    tauri_plugin_mobile_push::ForegroundPresentationOptions::silent(),
                )
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        // The query cache's native store. Its file is named by the client
        // (`src/lib/cache-store.ts`), which opens it with this plugin's JS API.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            #[cfg(desktop)]
            let _ = app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build());
            // runtime deep_link registration
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            // Desktop OAuth: the PDS authorization page opens in the system
            // browser, and the callback returns as a `space.roomy:` deep link.
            // Bring the app forward so the user sees the login complete instead
            // of having to find the window behind the browser.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    log::info!("deep link received: {:?}", event.urls());
                    bring_to_front(&handle);
                });
            }

            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::new()
                        .target(tauri_plugin_log::Target::new(
                            tauri_plugin_log::TargetKind::Stdout,
                        ))
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Request(#[from] ureq::Error),
}

// we must manually implement serde::Serialize
impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

pub struct SseEvent {
    pub name: String,
    pub data: String,
}

pub enum Exit {
    Stopped,
    Rejected(u16),
}


fn open_push_stream(
    server_url: &str,
    endpoint: &str,
    mut borrow_token: impl FnMut() -> Option<String>,
    mut on_event: impl FnMut(SseEvent) -> ControlFlow<()>,
) -> Exit {
    const BASE_DELAY_MS: u64 = 1_000;
    const MAX_DELAY_MS: u64 = 30_000;
    let url = format!(
        "{}/xrpc/space.roomy.push.stream",
        server_url.trim_end_matches('/')
    );
    let mut attempt: u32 = 0;
    let mut line = String::new();
    let mut name = String::new();
    let mut data = String::new();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();

    loop {
        let mut retry_after = Duration::ZERO;

        let Some(token) = borrow_token() else {
            return Exit::Stopped;
        };

        // connect stream
        let result = agent
            .get(&url)
            .query("endpoint", endpoint)
            .header("Authorization", &format!("Bearer {token}"))
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .call();

        match result {
            Err(err) => eprintln!("push stream: connect failed: {err}"),
            Ok(response) => {
                let status = response.status().as_u16();

                if status == 200 {
                    attempt = 0;
                    name.clear();
                    let mut reader = BufReader::new(response.into_body().into_reader());

                    // read events. for line in reader.lines() without the allocation
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(err) => {
                                eprintln!("push stream: read failed: {err}");
                                break;
                            }
                        }

                        let line = line.trim_end_matches(['\r', '\n']);
                        if line.is_empty() {
                            if !data.is_empty() {
                                data.pop();
                                if on_event(SseEvent {
                                    name: if name.is_empty() {
                                        "message".into()
                                    } else {
                                        std::mem::take(&mut name)
                                    },
                                    data: std::mem::take(&mut data),
                                })
                                .is_break()
                                {
                                    return Exit::Stopped;
                                }
                            }
                            name.clear();
                            data.clear();
                            continue;
                        }

                        if line.starts_with(':') {
                            continue;
                        }
                        let (field, value) = line
                            .split_once(':')
                            .map(|(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)))
                            .unwrap_or((&line, ""));

                        match field {
                            "event" => {
                                name.clear();
                                name.push_str(value);
                            }
                            "data" => {
                                data.push_str(value);
                                data.push('\n');
                            }
                            _ => {}
                        }
                    }
                } else if status == 401 || status >= 500 {
                    let seconds = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or_default();
                    retry_after = Duration::from_secs(seconds);
                    eprintln!("push stream: server returned {status}");
                } else {
                    return Exit::Rejected(status);
                }
            }
        }

        let backoff_ms = BASE_DELAY_MS
            .saturating_mul(1 << attempt.min(5))
            .min(MAX_DELAY_MS);
        let rand = (RandomState::new().build_hasher().finish() >> 11) as f64 / (1 << 53) as f64;
        let delay_ms = backoff_ms / 2 + (rand * (backoff_ms / 2) as f64) as u64;

        thread::sleep(Duration::from_millis(delay_ms).max(retry_after));
        attempt = attempt.saturating_add(1);
    }
}
