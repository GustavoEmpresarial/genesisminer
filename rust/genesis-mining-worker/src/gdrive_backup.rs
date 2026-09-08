//! Off-site copy of every verified backup to Google Drive.
//!
//! Auth: OAuth **refresh token** for a normal Google account (personal Gmail,
//! free 15 GB) — a service account has no storage quota on a personal Drive.
//! `refresh_token` → `access_token` is a plain form POST; no JWT/RSA signing.
//!
//! Idle unless all of `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`,
//! `GDRIVE_REFRESH_TOKEN`, `GDRIVE_BACKUP_FOLDER_ID` are set. Every failure is
//! logged and non-fatal — a Drive outage must never fail the local backup.

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::backup_pgdump::BackupArtifact;
use crate::config::{WorkerConfig, AUTO_SQL_BACKUP_PREFIX, GOOGLE_OAUTH_TOKEN_URL};

const DRIVE_UPLOAD_URL: &str =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
const DRIVE_FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
/// Read-into-memory cap for the upload body. `-Fc` dumps compress well; a bigger
/// archive is skipped (logged) rather than risking OOM.
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;

struct CachedToken {
    value: String,
    expires_at: Instant,
}

fn token_cache() -> &'static Mutex<Option<CachedToken>> {
    static C: OnceLock<Mutex<Option<CachedToken>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

/// Upload `artifact` (+ its `.sha256` sidecar) to the configured Drive folder,
/// then prune old `auto_pgdump_*` files from that folder.
pub async fn mirror_backup(cfg: &WorkerConfig, artifact: &BackupArtifact) -> Result<(), String> {
    let http = client();
    let token = access_token(cfg, &http).await?;
    let folder = cfg
        .gdrive_backup_folder_id
        .as_deref()
        .ok_or("GDRIVE_BACKUP_FOLDER_ID unset")?;

    let dump_path = Path::new(&cfg.backup_dir).join(&artifact.filename);
    let id = upload_file(
        &http,
        &token,
        folder,
        &dump_path,
        &artifact.filename,
        Some(&artifact.sha256),
    )
    .await?;
    info!(event = "gdrive_uploaded", file = %artifact.filename, drive_id = %id, "backup mirrored to Drive");

    // Best-effort sidecar upload (tiny).
    let sidecar = Path::new(&cfg.backup_dir).join(format!("{}.sha256", artifact.filename));
    if sidecar.is_file() {
        if let Err(e) = upload_file(
            &http,
            &token,
            folder,
            &sidecar,
            &format!("{}.sha256", artifact.filename),
            None,
        )
        .await
        {
            warn!(err = %e, "gdrive sidecar upload failed (non-fatal)");
        }
    }

    if let Err(e) = prune_drive_folder(&http, &token, folder, cfg.gdrive_retention_days).await {
        warn!(err = %e, "gdrive folder prune failed (non-fatal)");
    }
    Ok(())
}

async fn access_token(cfg: &WorkerConfig, http: &reqwest::Client) -> Result<String, String> {
    {
        let guard = token_cache().lock().await;
        if let Some(c) = guard.as_ref() {
            if c.expires_at > Instant::now() + Duration::from_secs(60) {
                return Ok(c.value.clone());
            }
        }
    }
    let (Some(cid), Some(secret), Some(refresh)) = (
        cfg.gdrive_client_id.as_deref(),
        cfg.gdrive_client_secret.as_deref(),
        cfg.gdrive_refresh_token.as_deref(),
    ) else {
        return Err("GDRIVE_* credentials unset".into());
    };

    let resp = http
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .form(&[
            ("client_id", cid),
            ("client_secret", secret),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("oauth request: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("oauth json: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "oauth HTTP {}: {}",
            status.as_u16(),
            body.get("error_description")
                .or_else(|| body.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
        ));
    }
    let value = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("oauth: no access_token")?
        .to_string();
    let ttl = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3300);

    *token_cache().lock().await = Some(CachedToken {
        value: value.clone(),
        expires_at: Instant::now() + Duration::from_secs(ttl.min(3600)),
    });
    Ok(value)
}

async fn upload_file(
    http: &reqwest::Client,
    token: &str,
    folder_id: &str,
    local_path: &Path,
    name: &str,
    sha256: Option<&str>,
) -> Result<String, String> {
    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("stat {name}: {e}"))?;
    if meta.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "{name} is {} bytes — over the {MAX_UPLOAD_BYTES}-byte upload cap; skipped",
            meta.len()
        ));
    }
    let bytes = tokio::fs::read(local_path)
        .await
        .map_err(|e| format!("read {name}: {e}"))?;

    let mut metadata = json!({ "name": name, "parents": [folder_id] });
    if let Some(h) = sha256 {
        metadata["appProperties"] = json!({ "sha256": h });
    }

    // 1) start resumable session
    let start = http
        .post(DRIVE_UPLOAD_URL)
        .bearer_auth(token)
        .header("Content-Type", "application/json; charset=UTF-8")
        .header("X-Upload-Content-Type", "application/octet-stream")
        .header("X-Upload-Content-Length", bytes.len().to_string())
        .body(serde_json::to_vec(&metadata).unwrap_or_default())
        .send()
        .await
        .map_err(|e| format!("resumable start: {e}"))?;
    if !start.status().is_success() {
        return Err(format!(
            "resumable start HTTP {}: {}",
            start.status().as_u16(),
            start.text().await.unwrap_or_default().chars().take(200).collect::<String>()
        ));
    }
    let session = start
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or("resumable start: no Location header")?
        .to_string();

    // 2) single PUT of the whole body
    let put = http
        .put(&session)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("upload PUT: {e}"))?;
    let status = put.status();
    let body: serde_json::Value = put.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(format!("upload PUT HTTP {}: {body}", status.as_u16()));
    }
    Ok(body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

async fn prune_drive_folder(
    http: &reqwest::Client,
    token: &str,
    folder_id: &str,
    retention_days: u32,
) -> Result<(), String> {
    let q = format!(
        "'{folder_id}' in parents and name contains '{AUTO_SQL_BACKUP_PREFIX}' and trashed = false"
    );
    let resp = http
        .get(DRIVE_FILES_URL)
        .bearer_auth(token)
        .query(&[
            ("q", q.as_str()),
            ("fields", "files(id,name,createdTime)"),
            ("pageSize", "1000"),
            ("orderBy", "createdTime desc"),
            ("supportsAllDrives", "true"),
        ])
        .send()
        .await
        .map_err(|e| format!("list request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("list HTTP {}", resp.status().as_u16()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("list json: {e}"))?;
    let files = body.get("files").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(retention_days.max(1)));
    for (i, f) in files.iter().enumerate() {
        if i == 0 {
            continue; // keep newest regardless of age
        }
        // skip `.sha256` sidecars — they piggyback on their archive
        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.ends_with(".sha256") {
            continue;
        }
        let created = f
            .get("createdTime")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        let Some(created) = created else { continue };
        if created.with_timezone(&chrono::Utc) >= cutoff {
            continue;
        }
        let Some(id) = f.get("id").and_then(|v| v.as_str()) else { continue };
        let del = http
            .delete(format!("{DRIVE_FILES_URL}/{id}?supportsAllDrives=true"))
            .bearer_auth(token)
            .send()
            .await;
        match del {
            Ok(r) if r.status().is_success() || r.status().as_u16() == 404 => {
                info!(event = "gdrive_pruned", name = %name, "old Drive backup deleted");
            }
            Ok(r) => warn!(name = %name, status = r.status().as_u16(), "gdrive delete failed"),
            Err(e) => warn!(name = %name, err = %e, "gdrive delete error"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_google() {
        assert!(DRIVE_UPLOAD_URL.starts_with("https://www.googleapis.com/upload/drive/v3/"));
        assert!(GOOGLE_OAUTH_TOKEN_URL.starts_with("https://oauth2.googleapis.com/"));
    }
}
