//! Shared `pg_dump` + integrity verification, used by both the scheduled loop
//! ([`crate::backup_sql_loop`]) and the manual admin endpoint
//! ([`crate::backup_admin`]).
//!
//! Format: `pg_dump -Fc` (custom, compressed). Integrity: `pg_restore --list`
//! must succeed on the finished archive (a truncated / killed dump fails there),
//! the file must be non-trivial, and a `<name>.dump.sha256` sidecar is written
//! at creation for later download / Google Drive verification. A dump that does
//! not verify is deleted and never renamed to its final `.dump` name.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::config::{BACKUP_ARCHIVE_EXT, POSTGRES_DEFAULT_PORT};

/// `pg_dump` search paths (Node `UNIX_PG_BIN_DIRS`).
const UNIX_PG_BIN_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin"];
const POSTGRESQL_VERSIONED_ROOT: &str = "/usr/lib/postgresql";
const MAX_SAFE_UNIX_PATH_LENGTH: usize = 512;
/// A real `-Fc` archive is always well over this even for a tiny DB.
const MIN_ARCHIVE_BYTES: u64 = 1024;

#[derive(Debug, Clone)]
pub struct BackupArtifact {
    pub filename: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Integrity {
    /// `pg_restore --list` succeeded (and, if a sidecar exists, the digest matches).
    Ok,
    /// `pg_restore --list` failed or the sidecar digest mismatched — do not trust.
    Corrupt,
    /// Not a `.dump` archive (legacy `.sql` / `.json`) — cannot check cheaply.
    Unverified,
}

impl Integrity {
    pub fn as_str(self) -> &'static str {
        match self {
            Integrity::Ok => "ok",
            Integrity::Corrupt => "corrupt",
            Integrity::Unverified => "unverified",
        }
    }
}

pub fn ensure_backup_dir(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir backup dir: {e}"))
}

/// `<backup_dir>/<basename>` with any path components stripped (no traversal).
pub fn resolve_safe_backup_path(backup_dir: &str, filename: &str) -> Option<PathBuf> {
    let base = PathBuf::from(backup_dir);
    let safe_name = Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")?;
    let resolved = base.join(safe_name);
    if resolved == base {
        return None;
    }
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.clone());
    if !base_canon.join(safe_name).starts_with(&base_canon) {
        return None;
    }
    Some(resolved)
}

pub fn iso_timestamp_for_filename() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-")
}

/// Sanitize a caller-supplied backup label to `[A-Za-z0-9_-]`, max 80 chars.
pub fn sanitize_base_name(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(80)
        .collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Dump the DB to `<backup_dir>/<base_name><iso>.dump`, verify it, and write the
/// `.sha256` sidecar. Returns `Err` (and leaves no `.dump`) if anything fails.
pub async fn create_verified_backup(
    backup_dir: &str,
    database_url: &str,
    base_name: &str,
) -> Result<BackupArtifact, String> {
    ensure_backup_dir(backup_dir)?;
    let filename = format!(
        "{base_name}{}{BACKUP_ARCHIVE_EXT}",
        iso_timestamp_for_filename()
    );
    let dest = resolve_safe_backup_path(backup_dir, &filename)
        .ok_or_else(|| "invalid backup path".to_string())?;
    let tmp = PathBuf::from(format!("{}.tmp", dest.display()));

    if let Err(e) = run_pg_dump(database_url, &tmp).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }

    // Integrity gate — never promote an unverifiable archive.
    let size = tokio::fs::metadata(&tmp)
        .await
        .map(|m| m.len())
        .map_err(|e| format!("stat dump: {e}"))?;
    if size < MIN_ARCHIVE_BYTES {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("dump too small ({size} bytes) — likely truncated"));
    }
    if !pg_restore_list_ok(&tmp).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err("pg_restore --list failed — dump is corrupt or truncated".into());
    }

    let sha256 = sha256_file(&tmp).await?;
    tokio::fs::rename(&tmp, &dest)
        .await
        .map_err(|e| format!("rename dump: {e}"))?;
    write_sha256_sidecar(&dest, &filename, &sha256).await;

    Ok(BackupArtifact { filename, bytes: size, sha256 })
}

/// Verify an existing backup file (by name) inside `backup_dir`.
pub async fn verify_existing(backup_dir: &str, filename: &str) -> Integrity {
    let Some(path) = resolve_safe_backup_path(backup_dir, filename) else {
        return Integrity::Corrupt;
    };
    if !path.is_file() {
        return Integrity::Corrupt;
    }
    if !filename.to_ascii_lowercase().ends_with(BACKUP_ARCHIVE_EXT) {
        return Integrity::Unverified;
    }
    if !pg_restore_list_ok(&path).await {
        return Integrity::Corrupt;
    }
    // If a sidecar exists, the recorded digest must match.
    if let Ok(expected) = tokio::fs::read_to_string(sidecar_path(&path)).await {
        let expected = expected.split_whitespace().next().unwrap_or("").to_string();
        if !expected.is_empty() {
            match sha256_file(&path).await {
                Ok(actual) if actual.eq_ignore_ascii_case(&expected) => {}
                _ => return Integrity::Corrupt,
            }
        }
    }
    Integrity::Ok
}

fn sidecar_path(dump: &Path) -> PathBuf {
    PathBuf::from(format!("{}.sha256", dump.display()))
}

async fn write_sha256_sidecar(dump: &Path, filename: &str, digest: &str) {
    // `sha256sum` format: "<hex>  <filename>\n".
    let _ = tokio::fs::write(sidecar_path(dump), format!("{digest}  {filename}\n")).await;
}

pub async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open for hash: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).await.map_err(|e| format!("read for hash: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn run_pg_dump(database_url: &str, tmp: &Path) -> Result<(), String> {
    let exe = resolve_pg_bin("pg_dump");
    let mut args: Vec<String> = vec![
        "--format=custom".into(),
        "--compress=6".into(),
        "--no-owner".into(),
        "--no-acl".into(),
        "-f".into(),
        tmp.display().to_string(),
    ];
    let use_url = !database_url.trim().is_empty();
    if use_url {
        args.push(database_url.to_string());
    } else {
        args.extend(pg_conn_args());
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !use_url {
        cmd.env("PGPASSWORD", pg_password());
    }
    let out = cmd
        .spawn()
        .map_err(|e| format!("spawn pg_dump ({exe}): {e}"))?
        .wait_with_output()
        .await
        .map_err(|e| format!("wait pg_dump: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let msg = stderr.trim();
    Err(if msg.is_empty() {
        format!("pg_dump exit {:?}", out.status.code())
    } else {
        msg.to_string()
    })
}

/// `pg_restore --list <file>` — reads the archive TOC; exits non-zero on a
/// corrupt / truncated custom-format archive.
async fn pg_restore_list_ok(path: &Path) -> bool {
    let exe = resolve_pg_bin("pg_restore");
    Command::new(&exe)
        .arg("--list")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

fn pg_conn_args() -> Vec<String> {
    let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
    let port = std::env::var("PGPORT").unwrap_or_else(|_| POSTGRES_DEFAULT_PORT.to_string());
    let user = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
    let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "minestation".into());
    vec![
        "-h".into(), host, "-p".into(), port, "-U".into(), user, "-d".into(), database,
    ]
}

fn pg_password() -> String {
    std::env::var("PGPASSWORD")
        .or_else(|_| std::env::var("POSTGRES_PASSWORD"))
        .unwrap_or_else(|_| "postgres".into())
}

/// Locate a Postgres client binary (`pg_dump` / `pg_restore`), mirroring the
/// Node `getPgDumpPath` fallbacks. `PG_DUMP_PATH` / `POSTGRES_CLIENT_BIN` still
/// override for `pg_dump`; the sibling directory is used for `pg_restore`.
fn resolve_pg_bin(bin: &str) -> String {
    if bin == "pg_dump" {
        if let Ok(raw) = std::env::var("PG_DUMP_PATH") {
            let t = raw.trim();
            if is_safe_abs_unix_path(t)
                && Path::new(t).is_file()
                && Path::new(t).file_name().and_then(|n| n.to_str()) == Some("pg_dump")
            {
                return t.to_string();
            }
        }
    } else if let Ok(raw) = std::env::var("PG_DUMP_PATH") {
        // pg_restore lives next to pg_dump.
        let t = raw.trim();
        if let Some(parent) = Path::new(t).parent() {
            let sib = parent.join(bin);
            if sib.is_file() {
                return sib.display().to_string();
            }
        }
    }
    if let Ok(raw_dir) = std::env::var("POSTGRES_CLIENT_BIN") {
        let t = raw_dir.trim();
        if is_safe_abs_unix_path(t) {
            let joined = Path::new(t).join(bin);
            if joined.is_file() {
                return joined.display().to_string();
            }
        }
    }
    for dir in UNIX_PG_BIN_DIRS {
        let joined = Path::new(dir).join(bin);
        if joined.is_file() {
            return joined.display().to_string();
        }
    }
    if let Ok(entries) = std::fs::read_dir(POSTGRESQL_VERSIONED_ROOT) {
        let mut versions: Vec<i32> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect();
        versions.sort_by(|a, b| b.cmp(a));
        for v in versions {
            let joined = Path::new(POSTGRESQL_VERSIONED_ROOT)
                .join(v.to_string())
                .join("bin")
                .join(bin);
            if joined.is_file() {
                return joined.display().to_string();
            }
        }
    }
    bin.to_string()
}

fn is_safe_abs_unix_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= MAX_SAFE_UNIX_PATH_LENGTH
        && p.starts_with('/')
        && !p.contains("..")
        && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '+' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_path_strips_traversal() {
        let dir = "/tmp/genesis_bkp_test";
        let _ = std::fs::create_dir_all(dir);
        assert!(resolve_safe_backup_path(dir, "ok.dump").is_some());
        let p = resolve_safe_backup_path(dir, "../escape.dump").unwrap();
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("escape.dump"));
    }

    #[test]
    fn base_name_is_sanitized() {
        assert_eq!(sanitize_base_name("  a b/c;d  ", "x"), "a_b_c_d");
        assert_eq!(sanitize_base_name("   ", "manual_backup_"), "manual_backup_");
        assert_eq!(sanitize_base_name(&"z".repeat(200), "x").len(), 80);
    }

    #[test]
    fn integrity_labels() {
        assert_eq!(Integrity::Ok.as_str(), "ok");
        assert_eq!(Integrity::Corrupt.as_str(), "corrupt");
        assert_eq!(Integrity::Unverified.as_str(), "unverified");
    }

    #[tokio::test]
    async fn verify_missing_file_is_corrupt() {
        let i = verify_existing("/tmp/genesis_bkp_test", "does-not-exist.dump").await;
        assert_eq!(i, Integrity::Corrupt);
    }

    #[tokio::test]
    async fn verify_legacy_sql_is_unverified() {
        let dir = "/tmp/genesis_bkp_test_sql";
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(format!("{dir}/legacy.sql"), b"-- dump\n").unwrap();
        assert_eq!(verify_existing(dir, "legacy.sql").await, Integrity::Unverified);
    }
}
