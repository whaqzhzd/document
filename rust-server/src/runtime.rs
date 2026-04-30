use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Duration;

const RUNTIME_ROOT: &str = ".document-runtime";
const LOCK_FILE_NAME: &str = "server.lock";
const STATE_FILE_NAME: &str = "runtime.json";
const HEALTH_PATH: &str = "/__health";

#[derive(Debug)]
pub struct RuntimePaths {
    pub runtime_root: PathBuf,
    pub assets_root: PathBuf,
    pub state_path: PathBuf,
    pub lock_path: PathBuf,
}

#[derive(Debug)]
pub struct RuntimeLock {
    file: File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeState {
    pub pid: u32,
    pub host: String,
    pub port: u16,
    pub url: String,
    #[serde(rename = "asset_hash")]
    pub asset_hash: String,
    #[serde(rename = "asset_dir")]
    pub asset_dir: String,
    #[serde(rename = "started_at")]
    pub started_at: String,
}

impl RuntimeState {
    pub fn is_healthy(&self) -> bool {
        probe_http_health(&self.host, self.port)
    }
}

pub fn resolve_runtime_paths() -> Result<RuntimePaths, String> {
    let exe_path = std::env::current_exe().map_err(|error| format!("failed to resolve current exe path: {error}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| format!("failed to resolve exe directory from {}", exe_path.display()))?
        .to_path_buf();
    let runtime_root = exe_dir.join(RUNTIME_ROOT);
    let assets_root = runtime_root.join("assets");

    Ok(RuntimePaths {
        runtime_root: runtime_root.clone(),
        assets_root,
        state_path: runtime_root.join(STATE_FILE_NAME),
        lock_path: runtime_root.join(LOCK_FILE_NAME),
    })
}

pub fn ensure_runtime_dirs(paths: &RuntimePaths) -> Result<(), String> {
    fs::create_dir_all(&paths.runtime_root)
        .map_err(|error| format!("failed to create runtime dir {}: {error}", paths.runtime_root.display()))?;
    fs::create_dir_all(&paths.assets_root)
        .map_err(|error| format!("failed to create assets dir {}: {error}", paths.assets_root.display()))?;
    Ok(())
}

pub fn asset_dir(paths: &RuntimePaths, asset_hash: &str) -> PathBuf {
    paths.assets_root.join(asset_hash)
}

pub fn acquire_lock(paths: &RuntimePaths) -> Result<RuntimeLock, String> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&paths.lock_path)
        .map_err(|error| format!("failed to open lock file {}: {error}", paths.lock_path.display()))?;

    file.try_lock_exclusive()
        .map_err(|error| format!("failed to acquire runtime lock {}: {error}", paths.lock_path.display()))?;

    Ok(RuntimeLock { file })
}

pub fn read_state(paths: &RuntimePaths) -> Option<RuntimeState> {
    let content = fs::read_to_string(&paths.state_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_state(paths: &RuntimePaths, state: &RuntimeState) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|error| format!("failed to serialize runtime state: {error}"))?;
    fs::write(&paths.state_path, format!("{serialized}\n"))
        .map_err(|error| format!("failed to write runtime state {}: {error}", paths.state_path.display()))
}

pub fn clear_state(paths: &RuntimePaths) {
    let _ = fs::remove_file(&paths.state_path);
}

pub fn current_pid() -> u32 {
    process::id()
}

pub fn current_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub fn probe_http_health(host: &str, port: u16) -> bool {
    let address = format!("{host}:{port}");
    let mut stream = match TcpStream::connect(address) {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));

    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

pub fn wait_for_health(host: &str, port: u16, attempts: usize) -> bool {
    for _ in 0..attempts {
        if probe_http_health(host, port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    false
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn normalize_asset_dir(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
