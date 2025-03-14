use tauri::{command, Builder, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
          println!("a new app instance was opened with {args:?} and the deep link event was already triggered");
          // focus running instance when new app instance is requested
          let _ = app.get_webview_window("main")
           .expect("no main window")
           .set_focus();
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
                app.deep_link().on_open_url(|event| {
                    println!("deep link URLs: {:?}", event.urls());
                });
            }

            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[command(rename_all = "snake_case")]
fn open_url(url: &str) -> Result<(), Error> {
    open::that(url).unwrap();

    Ok(())
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
