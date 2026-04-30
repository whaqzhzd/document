use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct ServerState {
    pub asset_dir: PathBuf,
}

pub async fn run_server(asset_dir: PathBuf, host: &str, port: u16) -> Result<(), String> {
    let bind_address = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_address)
        .await
        .map_err(|error| format!("failed to bind {bind_address}: {error}"))?;

    let app = Router::new()
        .route("/__health", get(health))
        .route("/", get(index))
        .route("/{*path}", get(static_or_index))
        .with_state(ServerState { asset_dir });

    axum::serve(listener, app)
        .await
        .map_err(|error| format!("axum server failed: {error}"))?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn index(State(state): State<ServerState>) -> impl IntoResponse {
    serve_path_or_404(&state.asset_dir.join("index.html")).await
}

async fn static_or_index(
    State(state): State<ServerState>,
    AxumPath(path): AxumPath<String>,
) -> impl IntoResponse {
    let relative = sanitize_relative_path(&path);
    let target_path = state.asset_dir.join(&relative);

    if is_safe_path(&state.asset_dir, &target_path) && target_path.is_file() {
        return serve_path_or_404(&target_path).await;
    }

    serve_path_or_404(&state.asset_dir.join("index.html")).await
}

async fn serve_path_or_404(path: &Path) -> Response<Body> {
    let content = match fs::read(path).await {
        Ok(content) => content,
        Err(_) => return (StatusCode::NOT_FOUND, "Not Found").into_response(),
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(Body::from(content));
    *response.status_mut() = StatusCode::OK;

    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );

    if should_disable_cache(path) {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
    } else {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    }

    response
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
