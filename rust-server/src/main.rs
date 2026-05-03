mod runtime;
mod server;

use runtime::{
    acquire_lock, clear_state, current_pid, current_timestamp, ensure_runtime_dirs, generate_instance_id,
    normalize_asset_dir, read_state, resolve_runtime_paths, resolve_server_asset_dir, wait_for_health, write_state,
    RuntimePaths, RuntimeState, SERVICE_NAME,
};
use serde::Serialize;
use std::env;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::time::Duration;

const HOST: &str = "127.0.0.1";
const BASE_PORT: u16 = 18080;
const MAX_PORT_ATTEMPTS: usize = 100;

#[derive(Serialize)]
struct LaunchResponse<'a> {
    ok: bool,
    port: Option<u16>,
    url: Option<String>,
    pid: Option<u32>,
    service: Option<&'a str>,
    instance_id: Option<String>,
    reused: bool,
    state_path: Option<String>,
    asset_dir: Option<String>,
    message: Option<&'a str>,
}

#[derive(Serialize)]
struct StopResponse<'a> {
    ok: bool,
    stopped: bool,
    pid: Option<u32>,
    state_path: Option<String>,
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
                service: None,
                instance_id: None,
                reused: false,
                state_path: None,
                asset_dir: None,
                message: Some(&message),
            },
            1,
        );
    }
}

async fn run() -> Result<(), String> {
    match env::args().nth(1).as_deref() {
        Some("serve") => serve_mode().await,
        Some("stop") => stop_mode(),
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
                    service: Some(SERVICE_NAME),
                    instance_id: Some(existing.instance_id),
                    reused: true,
                    state_path: Some(paths.state_path.to_string_lossy().to_string()),
                    asset_dir: Some(existing.asset_dir),
                    message: None,
                },
                0,
            );
        }
    }

    clear_state(&paths);
    let asset_directory = resolve_server_asset_dir()?;
    let instance_id = generate_instance_id();

    let port = find_available_port(BASE_PORT, MAX_PORT_ATTEMPTS)?;
    let child = spawn_serve_process(port, &asset_directory, &instance_id)?;

    if !wait_for_health(HOST, port, 80) {
        return Err(format!("background serve process failed health check on port {port}"));
    }

    print_json_and_exit(
        LaunchResponse {
            ok: true,
            port: Some(port),
            url: Some(format!("http://{HOST}:{port}/")),
            pid: Some(child.id()),
            service: Some(SERVICE_NAME),
            instance_id: Some(instance_id),
            reused: false,
            state_path: Some(paths.state_path.to_string_lossy().to_string()),
            asset_dir: Some(normalize_asset_dir(&asset_directory)),
            message: None,
        },
        0,
    );
}

async fn serve_mode() -> Result<(), String> {
    let port = env_required_u16("DOCUMENT_SERVER_PORT")?;
    let asset_dir = PathBuf::from(env_required("DOCUMENT_SERVER_ASSET_DIR")?);
    let instance_id = env_required("DOCUMENT_SERVER_INSTANCE_ID")?;
    let exe_path = normalize_asset_dir(
        &env::current_exe().map_err(|error| format!("failed to resolve current exe: {error}"))?
    );

    let paths = resolve_runtime_paths()?;
    ensure_runtime_dirs(&paths)?;
    let _lock = acquire_lock(&paths)?;

    let state = RuntimeState {
        pid: current_pid(),
        host: HOST.to_string(),
        port,
        url: format!("http://{HOST}:{port}/"),
        service: SERVICE_NAME.to_string(),
        instance_id: instance_id.clone(),
        asset_hash: "external-dist".to_string(),
        asset_dir: normalize_asset_dir(&asset_dir),
        exe_path,
        started_at: current_timestamp(),
    };

    write_state(&paths, &state)?;
    server::run_server(asset_dir, HOST, port, instance_id, state.pid).await
}

fn stop_mode() -> Result<(), String> {
    let paths = resolve_runtime_paths()?;
    ensure_runtime_dirs(&paths)?;

    let Some(existing) = read_state(&paths) else {
        print_stop_and_exit(&paths, true, false, None, None, 0);
    };

    if !existing.is_healthy() {
        clear_state(&paths);
        print_stop_and_exit(&paths, true, false, Some(existing.pid), Some("server already stopped"), 0);
    }

    stop_process(existing.pid)?;

    if !wait_for_stop(&existing.host, existing.port, 80) {
        return Err(format!("failed to stop server process {} on port {}", existing.pid, existing.port));
    }

    clear_state(&paths);
    print_stop_and_exit(&paths, true, true, Some(existing.pid), None, 0);
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

fn spawn_serve_process(port: u16, asset_dir: &PathBuf, instance_id: &str) -> Result<process::Child, String> {
    let current_exe = env::current_exe().map_err(|error| format!("failed to resolve current exe: {error}"))?;
    let mut command = Command::new(current_exe);
    command
        .arg("serve")
        .env("DOCUMENT_SERVER_PORT", port.to_string())
        .env("DOCUMENT_SERVER_ASSET_DIR", asset_dir)
        .env("DOCUMENT_SERVER_INSTANCE_ID", instance_id)
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

fn print_stop_and_exit(
    paths: &RuntimePaths,
    ok: bool,
    stopped: bool,
    pid: Option<u32>,
    message: Option<&str>,
    code: i32,
) -> ! {
    let payload = serde_json::to_string(&StopResponse {
        ok,
        stopped,
        pid,
        state_path: Some(paths.state_path.to_string_lossy().to_string()),
        message,
    })
    .unwrap_or_else(|_| "{\"ok\":false,\"message\":\"failed to serialize stop response\"}".to_string());

    if code == 0 {
        println!("{payload}");
    } else {
        eprintln!("{payload}");
    }

    process::exit(code);
}

#[cfg(windows)]
fn stop_process(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("failed to execute taskkill for pid {pid}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill failed for pid {pid} with exit code {:?}", status.code()))
    }
}

#[cfg(not(windows))]
fn stop_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("failed to execute kill for pid {pid}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("kill failed for pid {pid} with exit code {:?}", status.code()))
    }
}

fn wait_for_stop(host: &str, port: u16, attempts: usize) -> bool {
    for _ in 0..attempts {
        if !runtime::probe_http_health(host, port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    false
}
