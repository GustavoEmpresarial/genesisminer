//! Auto SQL backup loop — owns Node `startScheduledSqlBackups`.
//!
//! Local-clock schedule (`BACKUP_AUTO_LOCAL_HOUR`/`MINUTE`), Redis lock
//! `genesis:lock:job:backup-sql`, PG advisory `AUTO_SQL_BACKUP_LOCK_K1/K2`,
//! `pg_dump` → `BACKUP_DIR`, prune keep-N, prune `profile_audit_log`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use chrono::Local;
use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_DAY;
use tokio::process::Command;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, AUTO_BACKUP_KEEP_MAX, AUTO_BACKUP_KEEP_MIN, AUTO_SQL_BACKUP_LOCK_K1,
    AUTO_SQL_BACKUP_LOCK_K2, AUTO_SQL_BACKUP_PREFIX, BACKUP_SCHEDULE_MIN_DELAY_MS,
    POSTGRES_DEFAULT_PORT, PROFILE_AUDIT_RETENTION_DAYS, REDIS_LOCK_JOB_BACKUP_SQL,
    REDIS_LOCK_TTL_BACKUP_SQL_SEC,
};
use crate::player_reads::now_ms;
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

/// Node `UNIX_PG_BIN_DIRS`.
const UNIX_PG_BIN_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin"];
/// Node `POSTGRESQL_VERSIONED_ROOT`.
const POSTGRESQL_VERSIONED_ROOT: &str = "/usr/lib/postgresql";
/// Node `MAX_SAFE_UNIX_PATH_LENGTH`.
const MAX_SAFE_UNIX_PATH_LENGTH: usize = 512;

pub async fn run_backup_sql_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.backup_sql_loop_active() {
        info!(
            event = "backup_sql_disabled",
            reason = "SCHEDULER_ENABLED=0 or BACKUP_SQL_LOOP_ENABLED=0 or BACKUP_DISABLE_AUTO",
            "auto SQL backup idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        hour = cfg.backup_auto_local_hour,
        minute = cfg.backup_auto_local_minute,
        keep = cfg.backup_sql_keep,
        timeout_ms = cfg.job_timeout_backup_sql_ms,
        backup_dir = %cfg.backup_dir,
        "auto SQL backup cron starting"
    );

    loop {
        let delay =
            ms_until_next_local_clock_run(cfg.backup_auto_local_hour, cfg.backup_auto_local_minute);
        info!(
            event = "scheduled",
            hour = cfg.backup_auto_local_hour,
            minute = cfg.backup_auto_local_minute,
            delay_ms = delay,
            "auto SQL backup next run"
        );
        tokio::time::sleep(Duration::from_millis(delay)).await;
        run_one_tick(&pool, &locks, &cfg).await;
    }
}

/// Tempo até a próxima ocorrência de `hour:minute` no relógio local (Node
/// `msUntilNextLocalClockRun`).
pub fn ms_until_next_local_clock_run(hour: u32, minute: u32) -> u64 {
    let now = Local::now();
    let mut target = now
        .date_naive()
        .and_hms_opt(hour, minute, 0)
        .unwrap_or_else(|| now.date_naive().and_hms_opt(0, 0, 0).expect("midnight"))
        .and_local_timezone(Local)
        .single()
        .unwrap_or(now);
    if target.timestamp_millis() <= now.timestamp_millis() {
        let next_day = now.date_naive() + chrono::Duration::days(1);
        target = next_day
            .and_hms_opt(hour, minute, 0)
            .unwrap_or_else(|| next_day.and_hms_opt(0, 0, 0).expect("midnight"))
            .and_local_timezone(Local)
            .single()
            .unwrap_or(now);
    }
    let delta = (target.timestamp_millis() - now.timestamp_millis()).max(0) as u64;
    delta.max(BACKUP_SCHEDULE_MIN_DELAY_MS)
}

async fn run_one_tick(pool: &Pool, locks: &RedisLockClient, cfg: &WorkerConfig) {
    let handle = match locks
        .try_acquire(REDIS_LOCK_JOB_BACKUP_SQL, REDIS_LOCK_TTL_BACKUP_SQL_SEC)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(
                event = "backup_sql_lock_busy",
                "backup sql lock held elsewhere"
            );
            return;
        }
        Err(e) => {
            warn!(err = %e, "backup sql lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match run_backup_with_advisory(pool, cfg).await {
            Ok(Some(r)) => {
                info!(
                    event = "completed",
                    filename = %r.filename,
                    bytes = r.bytes,
                    "auto SQL backup done"
                );
            }
            Ok(None) => {
                info!(event = "skipped_advisory", "backup skipped (pg advisory)");
            }
            Err(e) => warn!(err = %e, "auto SQL backup failed"),
        }
    };
    match tokio::time::timeout(Duration::from_millis(cfg.job_timeout_backup_sql_ms), tick).await {
        Ok(()) => {}
        Err(_) => warn!(
            timeout_ms = cfg.job_timeout_backup_sql_ms,
            "backup sql tick timed out"
        ),
    }
    owned.release().await;
}

struct BackupResult {
    filename: String,
    bytes: u64,
}

async fn run_backup_with_advisory(
    pool: &Pool,
    cfg: &WorkerConfig,
) -> Result<Option<BackupResult>, String> {
    let client = pool.get().await.map_err(|e| format!("pool get: {e}"))?;

    let lock_row = client
        .query_one(
            "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok",
            &[&AUTO_SQL_BACKUP_LOCK_K1, &AUTO_SQL_BACKUP_LOCK_K2],
        )
        .await
        .map_err(|e| format!("advisory lock: {e}"))?;
    let got: bool = lock_row.get("ok");
    if !got {
        return Ok(None);
    }

    let result = async {
        let r = create_scheduled_sql_backup_once(cfg).await?;
        if let Err(e) = prune_profile_audit_logs(&client).await {
            warn!(err = %e, "prune profile_audit_log failed");
        }
        Ok::<BackupResult, String>(r)
    }
    .await;

    if let Err(e) = client
        .execute(
            "SELECT pg_advisory_unlock($1::integer, $2::integer)",
            &[&AUTO_SQL_BACKUP_LOCK_K1, &AUTO_SQL_BACKUP_LOCK_K2],
        )
        .await
    {
        warn!(err = %e, "advisory unlock failed");
    }

    result.map(Some)
}

async fn create_scheduled_sql_backup_once(cfg: &WorkerConfig) -> Result<BackupResult, String> {
    ensure_backup_dir(&cfg.backup_dir)?;
    let filename = format!(
        "{}{}.sql",
        AUTO_SQL_BACKUP_PREFIX,
        iso_timestamp_for_filename()
    );
    let dest = resolve_safe_backup_path(&cfg.backup_dir, &filename)
        .ok_or_else(|| "Caminho de backup inválido".to_string())?;
    run_pg_dump_to_file(&cfg.database_url, &dest).await?;
    prune_auto_sql_backups(Path::new(&cfg.backup_dir), cfg.backup_sql_keep);
    let meta = tokio::fs::metadata(&dest)
        .await
        .map_err(|e| format!("stat backup: {e}"))?;
    Ok(BackupResult {
        filename,
        bytes: meta.len(),
    })
}

fn iso_timestamp_for_filename() -> String {
    // Node: `new Date().toISOString().replace(/[:.]/g, '-')`
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-")
}

fn ensure_backup_dir(dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir backup dir: {e}"))
}

fn resolve_safe_backup_path(backup_dir: &str, filename: &str) -> Option<PathBuf> {
    let base = PathBuf::from(backup_dir);
    let safe_name = Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|n| !n.is_empty() && *n != "." && *n != "..")?;
    let resolved = base.join(safe_name);
    if resolved == base {
        return None;
    }
    let base_canon = base.canonicalize().unwrap_or(base.clone());
    let resolved_check = base_canon.join(safe_name);
    if !resolved_check.starts_with(&base_canon) {
        return None;
    }
    Some(resolved)
}

async fn run_pg_dump_to_file(database_url: &str, output: &Path) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.tmp", output.display()));
    let exe = resolve_pg_dump_path();
    let mut args: Vec<String> = vec![
        "--format=plain".into(),
        "--encoding=UTF8".into(),
        "--no-owner".into(),
        "--no-acl".into(),
        "--clean".into(),
        "--if-exists".into(),
        "-f".into(),
        tmp.display().to_string(),
    ];
    // Node `getPostgresCliSpawnOptions`: DATABASE_URL present → connection string.
    let use_url = !database_url.trim().is_empty();
    if use_url {
        args.push(database_url.to_string());
    } else {
        let host = std::env::var("PGHOST").unwrap_or_else(|_| "localhost".into());
        let port = std::env::var("PGPORT").unwrap_or_else(|_| POSTGRES_DEFAULT_PORT.to_string());
        let user = std::env::var("PGUSER").unwrap_or_else(|_| "postgres".into());
        let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "minestation".into());
        args.extend([
            "-h".into(),
            host,
            "-p".into(),
            port,
            "-U".into(),
            user,
            "-d".into(),
            database,
        ]);
    }

    let mut cmd = Command::new(&exe);
    cmd.args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Job timeout cancels this future → kill child (`kill_on_drop`).
        .kill_on_drop(true);
    if !use_url {
        let pw = std::env::var("PGPASSWORD")
            .or_else(|_| std::env::var("POSTGRES_PASSWORD"))
            .unwrap_or_else(|_| "postgres".into());
        cmd.env("PGPASSWORD", pw);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("spawn pg_dump ({exe}): {e}"))?;

    let output_result = child.wait_with_output().await.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("wait pg_dump: {e}")
    })?;

    if !output_result.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let stderr = String::from_utf8_lossy(&output_result.stderr);
        let msg = stderr.trim();
        return Err(if msg.is_empty() {
            format!(
                "pg_dump terminou com código {:?}",
                output_result.status.code()
            )
        } else {
            msg.to_string()
        });
    }

    tokio::fs::rename(&tmp, output).await.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename backup: {e}")
    })?;
    Ok(())
}

fn resolve_pg_dump_path() -> String {
    if let Ok(raw) = std::env::var("PG_DUMP_PATH") {
        let t = raw.trim();
        if is_safe_abs_unix_path(t) && Path::new(t).is_file() {
            if Path::new(t).file_name().and_then(|n| n.to_str()) == Some("pg_dump") {
                return t.to_string();
            }
        }
    }
    if let Ok(raw_dir) = std::env::var("POSTGRES_CLIENT_BIN") {
        let t = raw_dir.trim();
        if is_safe_abs_unix_path(t) {
            let joined = Path::new(t).join("pg_dump");
            if joined.is_file() {
                return joined.display().to_string();
            }
        }
    }
    for dir in UNIX_PG_BIN_DIRS {
        let joined = Path::new(dir).join("pg_dump");
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
                .join("pg_dump");
            if joined.is_file() {
                return joined.display().to_string();
            }
        }
    }
    "pg_dump".to_string()
}

fn is_safe_abs_unix_path(p: &str) -> bool {
    if p.is_empty()
        || p.len() > MAX_SAFE_UNIX_PATH_LENGTH
        || !p.starts_with('/')
        || p.contains("..")
    {
        return false;
    }
    p.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '+' | '-'))
}

fn prune_auto_sql_backups(backup_dir: &Path, keep: u32) {
    let keep = keep.max(AUTO_BACKUP_KEEP_MIN).min(AUTO_BACKUP_KEEP_MAX) as usize;
    let Ok(rd) = std::fs::read_dir(backup_dir) else {
        return;
    };
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for ent in rd.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let name = ent.file_name();
        let Some(n) = name.to_str() else { continue };
        if n.to_ascii_lowercase().ends_with(".tmp") {
            continue;
        }
        if !n.starts_with(AUTO_SQL_BACKUP_PREFIX) || !n.to_ascii_lowercase().ends_with(".sql") {
            continue;
        }
        let Ok(st) = ent.metadata() else { continue };
        if st.len() == 0 {
            continue;
        }
        let Ok(mtime) = st.modified() else { continue };
        entries.push((ent.path(), mtime));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in entries.into_iter().skip(keep) {
        if let Err(e) = std::fs::remove_file(&path) {
            warn!(path = %path.display(), err = %e, "prune auto backup failed");
        } else {
            info!(path = %path.display(), "auto backup pruned");
        }
    }
}

async fn prune_profile_audit_logs(client: &deadpool_postgres::Object) -> Result<u64, String> {
    let cutoff = now_ms() - PROFILE_AUDIT_RETENTION_DAYS * (MS_PER_DAY as i64);
    let n = client
        .execute(
            "DELETE FROM profile_audit_log WHERE created_at < $1",
            &[&cutoff],
        )
        .await
        .map_err(|e| format!("prune profile_audit_log: {e}"))?;
    if n > 0 {
        info!(
            event = "audit_pruned",
            pruned = n,
            "profile_audit_log pruned"
        );
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_key_matches_node() {
        assert_eq!(REDIS_LOCK_JOB_BACKUP_SQL, "genesis:lock:job:backup-sql");
    }

    #[test]
    fn advisory_keys_and_prefix_match_node() {
        assert_eq!(AUTO_SQL_BACKUP_LOCK_K1, 0x4d53);
        assert_eq!(AUTO_SQL_BACKUP_LOCK_K2, 0x6270);
        assert_eq!(AUTO_SQL_BACKUP_PREFIX, "auto_pgdump_");
    }

    #[test]
    fn profile_audit_retention_matches_node() {
        assert_eq!(PROFILE_AUDIT_RETENTION_DAYS, 90);
    }

    #[test]
    fn schedule_delay_at_least_min() {
        let d = ms_until_next_local_clock_run(0, 0);
        assert!(d >= BACKUP_SCHEDULE_MIN_DELAY_MS);
    }

    #[test]
    fn pg_dump_abort_grace_matches_node() {
        use crate::config::PG_DUMP_ABORT_KILL_GRACE_MS;
        use genesis_core::time::MS_PER_SECOND;
        assert_eq!(PG_DUMP_ABORT_KILL_GRACE_MS, 2 * MS_PER_SECOND);
    }

    #[test]
    fn safe_path_uses_basename_like_node() {
        let dir = "/tmp/backups_test_safe";
        let _ = std::fs::create_dir_all(dir);
        assert!(resolve_safe_backup_path(dir, "ok.sql").is_some());
        let p = resolve_safe_backup_path(dir, "../escape.sql");
        assert!(p.is_some());
        assert_eq!(
            p.unwrap().file_name().and_then(|n| n.to_str()),
            Some("escape.sql")
        );
    }
}
