//! Worker HTTP for the admin Backup panel — the half that needs `pg_dump` /
//! `pg_restore` (genesis-api owns list / delete / download from the shared
//! volume). Wired in [`crate::http`].
//!
//! - `POST /v1/admin/backups/create` `{ name? }` → make a verified `-Fc` dump
//!   (+ sha256 sidecar, + Google Drive copy if configured).
//! - `POST /v1/admin/backups/verify` `{ files: [name, …] }` → per-file
//!   integrity (`pg_restore --list` + sidecar digest).

use serde_json::{json, Value};

use crate::backup_pgdump::{create_verified_backup, sanitize_base_name, verify_existing};
use crate::config::WorkerConfig;
use crate::player_reads::PlayerReadError;

pub const BACKUP_CREATE_PATH: &str = "/v1/admin/backups/create";
pub const BACKUP_VERIFY_PATH: &str = "/v1/admin/backups/verify";

/// A full `pg_dump` of a production DB runs for minutes — longer than any sane
/// HTTP / proxy budget — so the manual backup is fired in the background and the
/// admin polls the list (each file carries its verified integrity). The
/// scheduled loop does the same work on its own task.
pub async fn run_backup_create(cfg: &WorkerConfig, body: Value) -> Result<Value, PlayerReadError> {
    let raw = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("manual_backup");
    let base = format!("{}_", sanitize_base_name(raw, "manual_backup"));

    let cfg = cfg.clone();
    tokio::spawn(async move {
        match create_verified_backup(&cfg.backup_dir, &cfg.database_url, &base).await {
            Ok(a) => {
                tracing::info!(
                    event = "manual_backup_done",
                    filename = %a.filename,
                    bytes = a.bytes,
                    sha256 = %a.sha256,
                    "manual backup created + verified"
                );
                if cfg.gdrive_active() {
                    if let Err(e) = crate::gdrive_backup::mirror_backup(&cfg, &a).await {
                        tracing::warn!(err = %e, file = %a.filename, "manual backup: gdrive mirror failed");
                    }
                }
            }
            Err(e) => tracing::warn!(err = %e, "manual backup failed"),
        }
    });

    // `ok_payload` already wraps this with `ok: true`.
    Ok(json!({
        "queued": true,
        "message": "Backup iniciado em segundo plano. Atualize a lista em ~1–3 minutos.",
    }))
}

pub async fn run_backup_verify(cfg: &WorkerConfig, body: Value) -> Result<Value, PlayerReadError> {
    let names: Vec<String> = body
        .get("files")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .take(500)
                .collect()
        })
        .unwrap_or_default();

    let mut results = serde_json::Map::new();
    for name in names {
        let integrity = verify_existing(&cfg.backup_dir, &name).await;
        results.insert(name, json!(integrity.as_str()));
    }
    Ok(json!({ "results": Value::Object(results) }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn paths_stable() {
        assert_eq!(super::BACKUP_CREATE_PATH, "/v1/admin/backups/create");
        assert_eq!(super::BACKUP_VERIFY_PATH, "/v1/admin/backups/verify");
    }
}
