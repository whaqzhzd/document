mod runtime;
mod server;

use runtime::{
    acquire_lock, clear_state, current_pid, current_timestamp, ensure_runtime_dirs, normalize_asset_dir, read_state,
    resolve_runtime_paths, resolve_server_asset_dir, wait_for_health, write_state, RuntimeState,
};
use serde::Serialize;
use std::env;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{self, Command, Stdio};

const HOST: &str = "127.0.0.1";
const BASE_PORT: u16 = 18080;
const MAX_PORT_ATTEMPTS: usize = 100;

#[derive(Serialize)]
struct LaunchResponse<'a> {
    ok: bool,
    port: Option<u16>,
    url: Option<String>,
    pid: Option<u32>,
    message: Option<&'a str>,
}

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        print_json_and_exit(
            LaunchResponse {
                ok: false,
                port: None,
                url: None,
                pid: None,
                message: Some(&message),
            },
            1,
        );
    }
}

async fn run() -> Result<(), String> {
    match env::args().nth(1).as_deref() {
        Some("serve") => serve_mode().await,
        _ => launch_mode().await,
    }
}

async fn launch_mode() -> Result<(), String> {
    let paths = resolve_runtime_paths()?;
    ensure_runtime_dirs(&paths)?;

    if let Some(existing) = read_state(&paths) {
        if existing.is_healthy() {
            print_json_and_exit(
                LaunchResponse {
                    ok: true,
                    port: Some(existing.port),
                    url: Some(existing.url),
                    pid: Some(existing.pid),
                    message: None,
                },
                0,
            );
        }
    }

    clear_state(&paths);
    let asset_directory = resolve_server_asset_dir()?;

    let port = find_available_port(BASE_PORT, MAX_PORT_ATTEMPTS)?;
    let child = spawn_serve_process(port, &asset_directory)?;

    if !wait_for_health(HOST, port, 80) {
        return Err(format!("background serve process failed health check on port {port}"));
    }

    print_json_and_exit(
        LaunchResponse {
            ok: true,
            port: Some(port),
            url: Some(format!("http://{HOST}:{port}/")),
            pid: Some(child.id()),
            message: None,
        },
        0,
    );
}

async fn serve_mode() -> Result<(), String> {
    let port = env_required_u16("DOCUMENT_SERVER_PORT")?;
    let asset_dir = PathBuf::from(env_required("DOCUMENT_SERVER_ASSET_DIR")?);

    let paths = resolve_runtime_paths()?;
    ensure_runtime_dirs(&paths)?;
    let _lock = acquire_lock(&paths)?;

    let state = RuntimeState {
        pid: current_pid(),
        host: HOST.to_string(),
        port,
        url: format!("http://{HOST}:{port}/"),
        asset_hash: "external-dist".to_string(),
        asset_dir: normalize_asset_dir(&asset_dir),
        started_at: current_timestamp(),
    };

    write_state(&paths, &state)?;
    server::run_server(asset_dir, HOST, port).await
}

fn find_available_port(base_port: u16, max_attempts: usize) -> Result<u16, String> {
    for offset in 0..max_attempts {
        let port = base_port + offset as u16;
        if TcpListener::bind((HOST, port)).is_ok() {
            return Ok(port);
        }
    }

    Err(format!(
        "failed to find an available port starting at {base_port} within {max_attempts} attempts"
    ))
}

fn spawn_serve_process(port: u16, asset_dir: &PathBuf) -> Result<process::Child, String> {
    let current_exe = env::current_exe().map_err(|error| format!("failed to resolve current exe: {error}"))?;
    let mut command = Command::new(current_exe);
    command
        .arg("serve")
        .env("DOCUMENT_SERVER_PORT", port.to_string())
        .env("DOCUMENT_SERVER_ASSET_DIR", asset_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    configure_background_process(&mut command);
    command
        .spawn()
        .map_err(|error| format!("failed to spawn background serve process: {error}"))
}

#[cfg(windows)]
fn configure_background_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(not(windows))]
fn configure_background_process(command: &mut Command) {
    command.process_group(0);
}

fn env_required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("missing required environment variable: {name}"))
}

fn env_required_u16(name: &str) -> Result<u16, String> {
    let value = env_required(name)?;
    value
        .parse::<u16>()
        .map_err(|error| format!("invalid u16 value for {name}: {error}"))
}

fn print_json_and_exit(response: LaunchResponse<'_>, code: i32) -> ! {
    let payload = serde_json::to_string(&response).unwrap_or_else(|_| {
        "{\"ok\":false,\"message\":\"failed to serialize launch response\"}".to_string()
    });

    if code == 0 {
        println!("{payload}");
    } else {
        eprintln!("{payload}");
    }

    process::exit(code);
}
