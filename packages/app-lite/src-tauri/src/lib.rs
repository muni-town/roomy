use tauri::{Builder, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init());
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
    #[cfg(desktop)]
    {
        builder = builder
          .plugin(tauri_plugin_process::init())
          .plugin(tauri_plugin_notification::init())
          .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
          log::info!("a new app instance was opened with {args:?} and the deep link event was already triggered");
          // focus running instance when new app instance is requested
          let _ = app.get_webview_window("main")
           .expect("no main window")
           .set_focus();
        }));
    }
    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
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
                                        let _ = window.unminimize();
                                        let _ = window.show();
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
                                    let _ = window.unminimize();
                                    let _ = window.show();
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

                let _ = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build());
            }
            // runtime deep_link registration
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
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
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
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
