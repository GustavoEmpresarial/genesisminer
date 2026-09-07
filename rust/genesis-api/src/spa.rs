//! SPA from `CLIENT_DIST`. Missing `index.html` → 404 (dev). No invented HTML.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio_util::io::ReaderStream;

use crate::config::{AppState, SPA_HASHED_ASSET_MAX_AGE_SEC};
use crate::download::content_type_for_ext;

const INDEX_HTML: &str = "index.html";
const ASSETS_PREFIX: &str = "/assets/";
const CACHE_NO_STORE: &str = "no-store, no-cache, must-revalidate, private, no-transform";

fn spa_content_type(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ico" => "image/x-icon",
        "map" => "application/json",
        _ => content_type_for_ext(name),
    }
}

fn safe_rel(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() {
        return None;
    }
    Some(out)
}

async fn file_under(root: &Path, rel: &Path) -> Option<PathBuf> {
    let joined = root.join(rel);
    let canon_root = tokio::fs::canonicalize(root).await.ok()?;
    let canon_file = tokio::fs::canonicalize(&joined).await.ok()?;
    if !canon_file.starts_with(&canon_root) {
        return None;
    }
    let meta = tokio::fs::metadata(&canon_file).await.ok()?;
    if meta.is_file() {
        Some(canon_file)
    } else {
        None
    }
}

async fn send_file(path: &Path, cache: Option<&str>) -> Response {
    let file_handle = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let stream = ReaderStream::new(file_handle);
    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = StatusCode::OK;
    if let Ok(ct) = header::HeaderValue::from_str(spa_content_type(path.to_string_lossy().as_ref()))
    {
        res.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    if let Some(cc) = cache {
        if let Ok(hv) = header::HeaderValue::from_str(cc) {
            res.headers_mut().insert(header::CACHE_CONTROL, hv);
        }
    }
    res
}

async fn send_index(state: &AppState) -> Response {
    let root = PathBuf::from(&state.cfg.client_dist);
    let Some(index) = file_under(&root, Path::new(INDEX_HTML)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    send_file(&index, Some(CACHE_NO_STORE)).await
}

pub fn is_spa_candidate(method: &Method, path: &str) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    if path.starts_with("/api") || path.starts_with("/img") || path.starts_with("/socket.io") {
        return false;
    }
    if path.starts_with("/health") {
        return false;
    }
    true
}

pub async fn serve_spa(
    State(state): State<Arc<AppState>>,
    req: axum::http::Request<Body>,
) -> Response {
    if !is_spa_candidate(req.method(), req.uri().path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = req.uri().path();
    if path.starts_with(ASSETS_PREFIX) {
        let Some(rel) = safe_rel(path) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let root = PathBuf::from(&state.cfg.client_dist);
        let Some(file) = file_under(&root, &rel).await else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let cache = format!("public, max-age={SPA_HASHED_ASSET_MAX_AGE_SEC}, immutable");
        return send_file(&file, Some(&cache)).await;
    }
    if path == "/" || path == "/index.html" {
        return send_index(&state).await;
    }
    // Static files from `client/public/` land at the dist root without the
    // `/assets/` prefix (`/transparency-art/*.png`, `/genesis-miner-logo.png`,
    // `/landing/*`, `/favicon.ico`, …). Serve the real file when it exists;
    // otherwise fall through to the SPA shell for client-side routes.
    if let Some(rel) = safe_rel(path) {
        let root = PathBuf::from(&state.cfg.client_dist);
        if let Some(file) = file_under(&root, &rel).await {
            return send_file(&file, Some("public, max-age=3600")).await;
        }
    }
    // Client routes: index.html if the build exists; hashed miss already 404 above.
    send_index(&state).await
}
