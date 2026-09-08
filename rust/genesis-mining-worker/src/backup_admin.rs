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

pub async fn run_backup_create(cfg: &WorkerConfig, body: Value) -> Result<Value, PlayerReadError> {
    let raw = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("manual_backup");
    let base = sanitize_base_name(raw, "manual_backup");
    let base = format!("{base}_");

    let artifact = create_verified_backup(&cfg.backup_dir, &cfg.database_url, &base)
        .await
        .map_err(PlayerReadError::bad)?;

    let mut gdrive = json!(false);
    if cfg.gdrive_active() {
        match crate::gdrive_backup::mirror_backup(cfg, &artifact).await {
            Ok(()) => gdrive = json!(true),
            Err(e) => {
                tracing::warn!(err = %e, file = %artifact.filename, "manual backup: gdrive mirror failed");
                gdrive = json!({ "ok": false, "error": e });
            }
        }
    }

    Ok(json!({
        "ok": true,
        "filename": artifact.filename,
        "bytes": artifact.bytes,
        "sha256": artifact.sha256,
        "integrity": "ok",
        "format": "custom",
        "gdrive": gdrive,
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
    Ok(json!({ "ok": true, "results": Value::Object(results) }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn paths_stable() {
        assert_eq!(super::BACKUP_CREATE_PATH, "/v1/admin/backups/create");
        assert_eq!(super::BACKUP_VERIFY_PATH, "/v1/admin/backups/verify");
    }
}
