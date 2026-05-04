use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use axum::Router;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct ServerState {
    pub asset_dir: PathBuf,
    pub instance_id: String,
    pub port: u16,
    pub pid: u32,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    pid: u32,
    port: u16,
    asset_dir: String,
    instance_id: String,
}

pub async fn run_server(
    asset_dir: PathBuf,
    host: &str,
    port: u16,
    instance_id: String,
    pid: u32,
) -> Result<(), String> {
    let bind_address = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_address)
        .await
        .map_err(|error| format!("failed to bind {bind_address}: {error}"))?;

    let app = Router::new()
        .route("/__health", get(health))
        .route("/", get(index))
        .route("/{*path}", get(static_or_index))
        .with_state(ServerState {
            asset_dir,
            instance_id,
            port,
            pid,
        });

    axum::serve(listener, app)
        .await
        .map_err(|error| format!("axum server failed: {error}"))?;

    Ok(())
}

async fn health(State(state): State<ServerState>) -> impl IntoResponse {
    Json(HealthResponse {
        ok: true,
        service: crate::runtime::SERVICE_NAME,
        pid: state.pid,
        port: state.port,
        asset_dir: state.asset_dir.to_string_lossy().to_string(),
        instance_id: state.instance_id,
    })
}

async fn index(State(state): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    serve_path_or_404(&state.asset_dir.join("index.html"), &headers).await
}

async fn static_or_index(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(path): AxumPath<String>,
) -> impl IntoResponse {
    let relative = sanitize_relative_path(&path);
    let target_path = state.asset_dir.join(&relative);

    if is_safe_path(&state.asset_dir, &target_path) && is_static_asset_available(&target_path) {
        return serve_path_or_404(&target_path, &headers).await;
    }

    serve_path_or_404(&state.asset_dir.join("index.html"), &headers).await
}

async fn serve_path_or_404(path: &Path, request_headers: &HeaderMap) -> Response<Body> {
    let brotli_path = brotli_variant_path(path);
    let should_serve_brotli = path.extension().and_then(|value| value.to_str()) == Some("wasm")
        && accepts_brotli(request_headers)
        && brotli_path.is_file();
    let content_path = if should_serve_brotli {
        &brotli_path
    } else {
        path
    };

    let content = match fs::read(content_path).await {
        Ok(content) => content,
        Err(_) => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(Body::from(content));
    *response.status_mut() = StatusCode::OK;

    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );

    if should_serve_brotli {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
        headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }

    if should_disable_cache(path) {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
    } else {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }

    response
}

fn is_static_asset_available(path: &Path) -> bool {
    path.is_file() || brotli_variant_path(path).is_file()
}

fn brotli_variant_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.br",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
    ))
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .filter_map(|encoding| encoding.trim().split(';').next())
                .any(|encoding| encoding.eq_ignore_ascii_case("br"))
        })
        .unwrap_or(false)
}

fn sanitize_relative_path(path: &str) -> PathBuf {
    let mut normalized = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        normalized.push(part);
    }
    normalized
}

fn is_safe_path(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn should_disable_cache(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("index.html") | Some("sw.js") | Some("manifest.json")
    )
}
