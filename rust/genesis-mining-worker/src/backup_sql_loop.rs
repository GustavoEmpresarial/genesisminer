//! Auto backup loop — owns Node `startScheduledSqlBackups`.
//!
//! Local-clock schedule (`BACKUP_AUTO_LOCAL_HOUR`/`MINUTE`), Redis lock
//! `genesis:lock:job:backup-sql`, PG advisory `AUTO_SQL_BACKUP_LOCK_K1/K2`.
//! Each tick: `pg_dump -Fc` + integrity verify + sha256 sidecar
//! ([`crate::backup_pgdump`]) → age-based prune (keep `BACKUP_RETENTION_DAYS`,
//! newest always kept, hard count cap) → Google Drive off-site copy
//! ([`crate::gdrive_backup`]) → prune `profile_audit_log`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Local;
use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_DAY;
use tracing::{info, warn};

use crate::backup_pgdump::{create_verified_backup, BackupArtifact};
use crate::config::{
    WorkerConfig, AUTO_BACKUP_KEEP_MAX, AUTO_BACKUP_KEEP_MIN, AUTO_SQL_BACKUP_LOCK_K1,
    AUTO_SQL_BACKUP_LOCK_K2, AUTO_SQL_BACKUP_PREFIX, BACKUP_ARCHIVE_EXT,
    BACKUP_SCHEDULE_MIN_DELAY_MS, PROFILE_AUDIT_RETENTION_DAYS, REDIS_LOCK_JOB_BACKUP_SQL,
    REDIS_LOCK_TTL_BACKUP_SQL_SEC,
};
use crate::player_reads::now_ms;
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

pub async fn run_backup_sql_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.backup_sql_loop_active() {
        info!(
            event = "backup_sql_disabled",
            reason = "SCHEDULER_ENABLED=0 or BACKUP_SQL_LOOP_ENABLED=0 or BACKUP_DISABLE_AUTO",
            "auto backup idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        hour = cfg.backup_auto_local_hour,
        minute = cfg.backup_auto_local_minute,
        retention_days = cfg.backup_retention_days,
        count_cap = cfg.backup_sql_keep,
        gdrive = cfg.gdrive_active(),
        backup_dir = %cfg.backup_dir,
        "auto backup cron starting"
    );

    // A dump killed mid-write (deploy / OOM) leaves a large `.tmp`. Clear stale
    // ones (>1h old) on startup so they don't accumulate.
    sweep_stale_tmp(Path::new(&cfg.backup_dir));

    loop {
        let delay =
            ms_until_next_local_clock_run(cfg.backup_auto_local_hour, cfg.backup_auto_local_minute);
        info!(event = "scheduled", delay_ms = delay, "auto backup next run");
        tokio::time::sleep(Duration::from_millis(delay)).await;
        run_one_tick(&pool, &locks, &cfg).await;
    }
}

/// Time until the next `hour:minute` on the local clock (Node
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
            info!(event = "backup_sql_lock_busy", "backup lock held elsewhere");
            return;
        }
        Err(e) => {
            warn!(err = %e, "backup lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match run_backup_with_advisory(pool, cfg).await {
            Ok(Some(a)) => {
                info!(
                    event = "completed",
                    filename = %a.filename,
                    bytes = a.bytes,
                    sha256 = %a.sha256,
                    "auto backup done + verified"
                );
                prune_auto_backups_by_age(
                    Path::new(&cfg.backup_dir),
                    cfg.backup_retention_days,
                    cfg.backup_sql_keep,
                );
                if cfg.gdrive_active() {
                    if let Err(e) = crate::gdrive_backup::mirror_backup(cfg, &a).await {
                        warn!(err = %e, file = %a.filename, "gdrive mirror failed (non-fatal)");
                    }
                }
            }
            Ok(None) => info!(event = "skipped_advisory", "backup skipped (pg advisory held)"),
            Err(e) => warn!(err = %e, "auto backup failed"),
        }
    };
    if tokio::time::timeout(Duration::from_millis(cfg.job_timeout_backup_sql_ms), tick)
        .await
        .is_err()
    {
        warn!(
            timeout_ms = cfg.job_timeout_backup_sql_ms,
            "backup tick timed out"
        );
    }
    owned.release().await;
}

async fn run_backup_with_advisory(
    pool: &Pool,
    cfg: &WorkerConfig,
) -> Result<Option<BackupArtifact>, String> {
    let client = pool.get().await.map_err(|e| format!("pool get: {e}"))?;
    let lock_row = client
        .query_one(
            "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS ok",
            &[&AUTO_SQL_BACKUP_LOCK_K1, &AUTO_SQL_BACKUP_LOCK_K2],
        )
        .await
        .map_err(|e| format!("advisory lock: {e}"))?;
    if !lock_row.get::<_, bool>("ok") {
        return Ok(None);
    }

    let result = async {
        let a =
            create_verified_backup(&cfg.backup_dir, &cfg.database_url, AUTO_SQL_BACKUP_PREFIX).await?;
        if let Err(e) = prune_profile_audit_logs(&client).await {
            warn!(err = %e, "prune profile_audit_log failed");
        }
        Ok::<BackupArtifact, String>(a)
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

/// Delete `auto_pgdump_*` archives older than `retention_days`, but always keep
/// the newest one. `count_cap` is a hard upper bound regardless of age.
/// `.sha256` sidecars follow their archive. Manual backups are untouched.
pub fn prune_auto_backups_by_age(backup_dir: &Path, retention_days: u32, count_cap: u32) {
    let cap = count_cap.clamp(AUTO_BACKUP_KEEP_MIN, AUTO_BACKUP_KEEP_MAX) as usize;
    let max_age = Duration::from_secs(u64::from(retention_days.max(1)) * 86_400);
    let now = SystemTime::now();

    let Ok(rd) = std::fs::read_dir(backup_dir) else {
        return;
    };
    let mut archives: Vec<(PathBuf, SystemTime)> = Vec::new();
    for ent in rd.flatten() {
        let Ok(ft) = ent.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let name = ent.file_name();
        let Some(n) = name.to_str() else { continue };
        let lower = n.to_ascii_lowercase();
        if !n.starts_with(AUTO_SQL_BACKUP_PREFIX) || lower.ends_with(".tmp") {
            continue;
        }
        if !lower.ends_with(BACKUP_ARCHIVE_EXT) && !lower.ends_with(".sql") {
            continue;
        }
        let Ok(md) = ent.metadata() else { continue };
        let mtime = md.modified().unwrap_or(now);
        archives.push((ent.path(), mtime));
    }
    // Newest first.
    archives.sort_by(|a, b| b.1.cmp(&a.1));

    for (i, (path, mtime)) in archives.iter().enumerate() {
        let too_old = now.duration_since(*mtime).map(|d| d > max_age).unwrap_or(false);
        let over_cap = i >= cap;
        if i == 0 || (!too_old && !over_cap) {
            continue; // always keep the newest; keep the rest within age + cap
        }
        remove_with_sidecar(path);
    }
}

/// Delete `*.tmp` backup files older than one hour (orphans from a killed dump).
fn sweep_stale_tmp(backup_dir: &Path) {
    let Ok(rd) = std::fs::read_dir(backup_dir) else {
        return;
    };
    let cutoff = Duration::from_secs(3600);
    let now = SystemTime::now();
    for ent in rd.flatten() {
        let name = ent.file_name();
        let Some(n) = name.to_str() else { continue };
        if !n.to_ascii_lowercase().ends_with(".tmp") {
            continue;
        }
        let stale = ent
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age > cutoff)
            .unwrap_or(true);
        if stale {
            match std::fs::remove_file(ent.path()) {
                Ok(()) => info!(path = %ent.path().display(), "stale backup .tmp removed"),
                Err(e) => warn!(path = %ent.path().display(), err = %e, "remove stale .tmp failed"),
            }
        }
    }
}

fn remove_with_sidecar(archive: &Path) {
    match std::fs::remove_file(archive) {
        Ok(()) => info!(path = %archive.display(), "backup pruned"),
        Err(e) => {
            warn!(path = %archive.display(), err = %e, "prune backup failed");
            return;
        }
    }
    let sidecar = PathBuf::from(format!("{}.sha256", archive.display()));
    let _ = std::fs::remove_file(sidecar);
}

async fn prune_profile_audit_logs(client: &deadpool_postgres::Object) -> Result<u64, String> {
    let cutoff = now_ms() - PROFILE_AUDIT_RETENTION_DAYS * (MS_PER_DAY as i64);
    let n = client
        .execute("DELETE FROM profile_audit_log WHERE created_at < $1", &[&cutoff])
        .await
        .map_err(|e| format!("prune profile_audit_log: {e}"))?;
    if n > 0 {
        info!(event = "audit_pruned", pruned = n, "profile_audit_log pruned");
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn lock_key_matches_node() {
        assert_eq!(REDIS_LOCK_JOB_BACKUP_SQL, "genesis:lock:job:backup-sql");
    }

    #[test]
    fn schedule_delay_at_least_min() {
        assert!(ms_until_next_local_clock_run(0, 0) >= BACKUP_SCHEDULE_MIN_DELAY_MS);
    }

    #[test]
    fn age_prune_keeps_newest_and_drops_old() {
        let dir = std::env::temp_dir().join(format!("genesis_prune_{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str, age_secs: u64| {
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; 2048]).unwrap();
            let t = SystemTime::now() - Duration::from_secs(age_secs);
            filetime_set(&p, t);
            p
        };
        let fresh = mk("auto_pgdump_fresh.dump", 10);
        let old1 = mk("auto_pgdump_old1.dump", 10 * 86_400);
        let old2 = mk("auto_pgdump_old2.dump", 20 * 86_400);
        std::fs::write(dir.join("manual_keepme.dump"), vec![0u8; 2048]).unwrap();

        prune_auto_backups_by_age(&dir, 3, 30);

        assert!(fresh.exists(), "newest auto kept");
        assert!(!old1.exists(), "10d-old auto pruned");
        assert!(!old2.exists(), "20d-old auto pruned");
        assert!(dir.join("manual_keepme.dump").exists(), "manual untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Minimal mtime setter (avoids a `filetime` dep for the test).
    fn filetime_set(path: &Path, t: SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        let times = std::fs::FileTimes::new().set_modified(t).set_accessed(t);
        f.set_times(times).unwrap();
    }
}
