//! The desktop shell around the standalone app.
//!
//! The Node backend (server/) is bundled as a sidecar executable. At start-up the bundled page
//! in desktop/loading calls `start`, which finds the configuration, reads any CalDAV passwords
//! from the OS credential store, runs the backend on a free port on 127.0.0.1, and returns the
//! address for the window to load. The backend serves the calendar page and its API, exactly as
//! when it runs on its own.
//!
//! The backend also works out when upcoming events are due a notification. It writes each one to
//! its standard output as a `CALENDAR_PRO_NOTIFICATION {"title":..,"body":..}` line, which this
//! side shows through the notification plugin. Clicking one brings the window forward.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long the backend may take to start listening before start-up is reported as failed.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// How many lines of the backend's error output to show when it fails to start.
const ERROR_LINES: usize = 20;

/// The start of a line of the backend's output that holds a notification to show.
const NOTIFICATION_PREFIX: &str = "CALENDAR_PRO_NOTIFICATION ";

/// The running backend, so it can be stopped when the app quits or starts it again.
#[derive(Default)]
struct Backend(Mutex<Option<CommandChild>>);

/// What `start` tells the start-up page.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Startup {
    /// There is no configuration file at `path` yet.
    NoConfig { path: String },
    /// These password variables are in neither the environment nor the credential store.
    NeedPasswords { names: Vec<String> },
    /// The backend is serving the calendar at `url`.
    Ready { url: String },
}

/// The part of config.yaml this side reads: which password variables the calendars name.
/// Everything else in the file is the backend's business.
#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    calendars: Vec<CalendarEntry>,
}

#[derive(Deserialize)]
struct CalendarEntry {
    password_env: Option<String>,
}

/// A notification the backend asks for.
#[derive(Deserialize)]
struct Notice {
    title: String,
    body: String,
}

/// Starts (or restarts) the backend and returns where the window should go next.
#[tauri::command]
async fn start(app: AppHandle, backend: State<'_, Backend>) -> Result<Startup, String> {
    stop(&backend);

    let config = config_path(&app)?;
    if !config.is_file() {
        return Ok(Startup::NoConfig {
            path: config.display().to_string(),
        });
    }

    let service = app.config().identifier.clone();
    let mut passwords = HashMap::new();
    let mut missing = Vec::new();
    for name in password_names(&config) {
        if std::env::var(&name).is_ok_and(|value| !value.is_empty()) {
            continue; // Set in the environment, which the backend inherits.
        }
        match keyring::Entry::new(&service, &name).and_then(|entry| entry.get_password()) {
            Ok(password) => {
                passwords.insert(name, password);
            }
            Err(keyring::Error::NoEntry) => missing.push(name),
            Err(error) => return Err(format!("Could not read {name} from the keychain: {error}")),
        }
    }
    if !missing.is_empty() {
        return Ok(Startup::NeedPasswords { names: missing });
    }

    let port = free_port()?;
    let web_root = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("web");

    let (mut events, child) = app
        .shell()
        .sidecar("calendar-server")
        .map_err(|error| error.to_string())?
        .env("CONFIG", &config)
        .env("WEB_ROOT", &web_root)
        .env("HOST", "127.0.0.1")
        .env("EXIT_WITH_STDIN", "1")
        .env("NOTIFICATIONS", "stdout")
        .env("PORT", port.to_string())
        .envs(passwords)
        .spawn()
        .map_err(|error| format!("Could not start the calendar backend: {error}"))?;
    *backend.0.lock().unwrap() = Some(child);

    // Wait for the backend's "Serving ..." line, keeping its recent error output to show if it
    // stops first.
    let mut errors: VecDeque<String> = VecDeque::new();
    let waited = tokio::time::timeout(START_TIMEOUT, async {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    if notify(&app, &line) {
                        continue;
                    }
                    println!("[backend] {line}");
                    if line.contains(" Serving ") {
                        return Ok(());
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    eprintln!("[backend] {line}");
                    errors.push_back(line);
                    if errors.len() > ERROR_LINES {
                        errors.pop_front();
                    }
                }
                CommandEvent::Error(error) => errors.push_back(error),
                CommandEvent::Terminated(status) => {
                    let mut message = format!(
                        "The calendar backend stopped (exit code {}).",
                        status.code.map_or("none".into(), |code| code.to_string())
                    );
                    for line in &errors {
                        message.push('\n');
                        message.push_str(line);
                    }
                    return Err(message);
                }
                _ => {}
            }
        }
        Err("The calendar backend closed its output before it was ready.".to_string())
    })
    .await;

    let outcome = match waited {
        Ok(result) => result,
        Err(_) => Err(format!(
            "The calendar backend did not start within {} seconds.",
            START_TIMEOUT.as_secs()
        )),
    };
    if let Err(message) = outcome {
        stop(&backend);
        return Err(message);
    }

    // Keep reading the backend's output for as long as it runs. Left unread, its pipes would
    // fill and the backend would stall on its next log line. It also carries the notifications.
    let reader_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    if !notify(&reader_app, &line) {
                        println!("[backend] {line}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[backend] stopped (exit code {:?})", status.code)
                }
                _ => {}
            }
        }
    });

    Ok(Startup::Ready {
        url: format!("http://127.0.0.1:{port}/"),
    })
}

/// Shows the notification a line of the backend's output asks for. Returns false for a line that
/// is not a notification, which is logged as usual.
fn notify(app: &AppHandle, line: &str) -> bool {
    let Some(json) = line.strip_prefix(NOTIFICATION_PREFIX) else {
        return false;
    };
    match serde_json::from_str::<Notice>(json) {
        Ok(notice) => {
            if let Err(error) = app
                .notification()
                .builder()
                .title(notice.title)
                .body(notice.body)
                .show()
            {
                eprintln!("[notifications] could not show a notification: {error}");
            }
        }
        Err(error) => {
            eprintln!("[notifications] unreadable notification from the backend: {error}")
        }
    }
    true
}

/// Brings the main window forward, as when a notification is clicked.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Saves passwords to the OS credential store, under the app's identifier and the name of the
/// variable each one stands in for.
#[tauri::command]
fn save_passwords(app: AppHandle, passwords: HashMap<String, String>) -> Result<(), String> {
    let service = app.config().identifier.clone();
    for (name, password) in passwords {
        keyring::Entry::new(&service, &name)
            .and_then(|entry| entry.set_password(&password))
            .map_err(|error| format!("Could not save {name} to the keychain: {error}"))?;
    }
    Ok(())
}

/// Writes a starter config.yaml with no calendars yet, for the settings page to fill in. The
/// backend starts without calendars and sends the window to its settings page.
#[tauri::command]
fn create_config(app: AppHandle) -> Result<(), String> {
    let config = config_path(&app)?;
    if config.exists() {
        return Ok(());
    }
    std::fs::write(
        &config,
        "# Written by Calendar Pro. Change it on the settings page, or here.\ncalendars: []\n",
    )
    .map_err(|error| format!("Could not write {}: {error}", config.display()))
}

/// `CONFIG` if set, otherwise config.yaml in the app's configuration folder (on macOS,
/// ~/Library/Application Support/<identifier>/).
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CONFIG") {
        return Ok(PathBuf::from(path));
    }
    let folder = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    Ok(folder.join("config.yaml"))
}

/// The `password_env` names the configuration's calendars use. A file this cannot read yields
/// none, and the backend then reports what is wrong with it.
fn password_names(config: &PathBuf) -> BTreeSet<String> {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|text| serde_yaml::from_str::<ConfigFile>(&text).ok())
        .map(|file| {
            file.calendars
                .into_iter()
                .filter_map(|calendar| calendar.password_env)
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// A port on 127.0.0.1 that nothing is listening on.
fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Could not find a free port: {error}"))
}

fn stop(backend: &Backend) {
    if let Some(child) = backend.0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // A click on a notification (`tap`) brings the calendar forward. With a handler
            // registered, the plugin reports clicks as far as the platform does.
            let handle = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() == "tap" {
                    let handle = handle.clone();
                    let _ = handle
                        .clone()
                        .run_on_main_thread(move || focus_main_window(&handle));
                }
            })?;
            Ok(())
        })
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![start, save_passwords, create_config])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop(&app.state::<Backend>());
            }
        });
}
