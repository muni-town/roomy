mod navigation;

#[cfg(desktop)]
mod push_stream;

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
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = Builder::default();
    #[cfg(desktop)]
    {
        builder = builder
          .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
              log::info!("a new app instance was opened with {args:?} and the deep link event was already triggered");

              // focus running instance when new app instance is requested
              let _ = app.get_webview_window("main")
               .expect("no main window")
               .set_focus();
          }))
          .manage(push_stream::PushStreamState::new())
          .invoke_handler(tauri::generate_handler![
            push_stream::push_stream_start,
            push_stream::push_stream_stop,
            push_stream::push_stream_provide_token,
            push_stream::push_stream_endpoint_new,
          ]);
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
        .plugin(navigation_policy())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        // The query cache's native store. Its file is named by the client
        // (`src/lib/cache-store.ts`), which opens it with this plugin's JS API.
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // runtime deep_link registration
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            #[cfg(desktop)]
            {
                let _ = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build());

                // Desktop OAuth: the PDS authorization page opens in the system
                // browser, and the callback returns as a `space.roomy:` deep link.
                // Bring the app forward so the user sees the login complete instead
                // of having to find the window behind the browser.
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    log::info!("deep link received: {:?}", event.urls());
                    bring_to_front(&handle);
                });

                // setup tray
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
                };

                let toggle =
                    MenuItem::with_id(app, "toggle", "Toggle", true, None::<&str>).unwrap();
                let menu = Menu::with_items(
                    app,
                    &[
                        &toggle,
                        &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                        &MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?,
                    ],
                )?;
                let _ = TrayIconBuilder::new()
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if let Ok(visible) = window.is_visible() {
                                    if visible {
                                        let _ = window.hide();
                                    } else {
                                        let _ = window.show();
                                        let _ = window.unminimize();
                                        let _ = window.set_focus();
                                    }
                                }
                            }
                        }
                        _ => {}
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "toggle" => {
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap() {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        "restart" => {
                            app.request_restart();
                        }
                        _ => {
                            println!("unhandled menu item: {:?}", event.id)
                        }
                    })
                    .icon(app.default_window_icon().unwrap().clone())
                    .build(app)?;
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
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
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

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
