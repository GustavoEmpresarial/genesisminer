//! Admin DB backups (`/api/admin/backup(s)*`).
//!
//! Replaces `server/modules/admin/backup/` (Express). `require_admin` gates tab
//! `backup` (route table in [`crate::admin_auth`]). `app` and
//! `genesis-mining-worker` share the `BACKUP_DIR` volume, so **list / delete /
//! download read the local FS here**; **create** needs `pg_dump` and is
//! forwarded to the worker (`backup_admin.rs`), which also verifies the archive
//! and pushes it to Google Drive. `restore` / `upload` were never ported
//! (largest blast radius) and stay unimplemented.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use axum::body::Body;
use axum::extract::{Path as AxPath, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_mining;
use crate::session::json_status;
use crate::workers::post_mining;

const P_LIST: &str = "/api/admin/backups";
const P_CREATE: &str = "/api/admin/backup";
const P_ITEM: &str = "/api/admin/backups/{filename}";
const P_DOWNLOAD: &str = "/api/admin/backups/download/{filename}";

const W_CREATE: &str = "/v1/admin/backups/create";
const W_VERIFY: &str = "/v1/admin/backups/verify";

/// Extensions the panel recognises as a backup file.
const BACKUP_EXTS: &[&str] = &[".dump", ".sql", ".json.gz", ".json", ".gz", ".db", ".sqlite", ".back"];
const NAME_MAX: usize = 120;

fn is_backup_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    !l.ends_with(".tmp") && !l.ends_with(".sha256") && BACKUP_EXTS.iter().any(|e| l.ends_with(e))
}

/// Basename only, inside `backup_dir`, must exist as a file. No traversal.
fn safe_backup_path(backup_dir: &str, filename: &str) -> Option<PathBuf> {
    if filename.is_empty() || filename.len() > NAME_MAX {
        return None;
    }
    let base = Path::new(filename).file_name()?.to_str()?;
    if base.is_empty() || base == "." || base == ".." || base != filename {
        return None;
    }
    let p = Path::new(backup_dir).join(base);
    Some(p)
}

async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_LIST).await {
        return e;
    }
    let dir = state.cfg.backup_dir.clone();
    let _ = tokio::fs::create_dir_all(&dir).await;

    let mut files: Vec<(String, u64, u128)> = Vec::new();
    let mut rd = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(e) => return json_status(500, json!({ "error": format!("read backup dir: {e}") })),
    };
    while let Ok(Some(ent)) = rd.next_entry().await {
        let Ok(ft) = ent.file_type().await else { continue };
        if !ft.is_file() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if !is_backup_name(&name) {
            continue;
        }
        let Ok(md) = ent.metadata().await else { continue };
        let created = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        files.push((name, md.len(), created));
    }
    files.sort_by(|a, b| b.2.cmp(&a.2));

    // Ask the worker to verify the `.dump` archives in one call.
    let dumps: Vec<&str> = files
        .iter()
        .filter(|(n, _, _)| n.to_ascii_lowercase().ends_with(".dump"))
        .map(|(n, _, _)| n.as_str())
        .collect();
    let mut integrity: serde_json::Map<String, Value> = serde_json::Map::new();
    if !dumps.is_empty() {
        if let Ok(w) = post_mining(&state.cfg, &state.http, W_VERIFY, &json!({ "files": dumps })).await
        {
            if let Some(map) = w.body.get("results").and_then(Value::as_object) {
                integrity = map.clone();
            }
        }
    }

    let out: Vec<Value> = files
        .into_iter()
        .map(|(filename, size, created_at)| {
            let integ = integrity
                .get(&filename)
                .and_then(Value::as_str)
                .unwrap_or("unverified");
            json!({ "filename": filename, "size": size, "createdAt": created_at, "integrity": integ })
        })
        .collect();
    Json(out).into_response()
}

async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, P_CREATE).await {
        return e;
    }
    let name = body.get("name").and_then(Value::as_str).unwrap_or("manual_backup");
    forward_mining(&state, W_CREATE, json!({ "name": name })).await
}

async fn delete_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxPath(filename): AxPath<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, "/api/admin/backups/x").await {
        return e;
    }
    let Some(path) = safe_backup_path(&state.cfg.backup_dir, &filename) else {
        return json_status(400, json!({ "error": "Nome de arquivo inválido" }));
    };
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(format!("{}.sha256", path.display())).await;
            json_status(200, json!({ "ok": true }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            json_status(404, json!({ "error": "Arquivo não encontrado" }))
        }
        Err(e) => json_status(500, json!({ "error": format!("Falha ao deletar: {e}") })),
    }
}

async fn download(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxPath(filename): AxPath<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, "/api/admin/backups/x").await {
        return e;
    }
    let Some(path) = safe_backup_path(&state.cfg.backup_dir, &filename) else {
        return json_status(400, json!({ "error": "Nome de arquivo inválido" }));
    };
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return json_status(404, json!({ "error": "Arquivo não encontrado" })),
    };
    let ct = if filename.to_ascii_lowercase().ends_with(".sql") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    let mut res = Response::new(Body::from_stream(ReaderStream::new(file)));
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    if let Ok(v) = header::HeaderValue::from_str(ct) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = header::HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

/// Kept only so a stale client that still POSTs here gets a clear 501 instead of
/// a confusing SPA fallback.
async fn restore_not_supported(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, "/api/admin/restore").await {
        return e;
    }
    json_status(
        501,
        json!({ "error": "Restauração de backup não é suportada pelo painel. Use pg_restore no servidor." }),
    )
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_LIST, get(list))
        .route(P_CREATE, post(create))
        .route(P_DOWNLOAD, get(download))
        .route(P_ITEM, delete(delete_one))
        .route("/api/admin/restore", post(restore_not_supported))
}
