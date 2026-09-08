//! Daily 00:00 UTC Telegram report of partners whose Streamer room is active
//! but who are overdue on approved videos (no approved submission in the last
//! 60 days — the same rule the admin "Sala Streamer em falta" badge uses).
//!
//! Idles unless `TELEGRAM_BOT_TOKEN` + `TELEGRAM_PARTNER_REPORT_CHAT_ID` are set
//! (+ `SCHEDULER_ENABLED != 0`). Redis lock `genesis:lock:job:partner-report`
//! coordinates replicas.

use std::time::Duration;

use chrono::{Datelike, Timelike, Utc};
use deadpool_postgres::Pool;
use serde_json::json;
use tracing::{info, warn};

use crate::config::{
    WorkerConfig, REDIS_LOCK_JOB_PARTNER_REPORT, REDIS_LOCK_TTL_PARTNER_REPORT_SEC, TELEGRAM_API_BASE,
};
use crate::player_reads::{i64_cell, now_ms, string_cell};
use crate::redis_lock::{OwnedYieldTickLock, RedisLockClient};

const DAY_MS: i64 = 86_400_000;
const STREAMER_OVERDUE_DAYS: i64 = 60;
/// `STREAMER_ROOM_ID` in `partners_admin.rs`.
const STREAMER_ROOM_ID: &str = "room_1766898636697";
/// Telegram rejects messages over 4096 UTF-16 code units; keep a safe margin.
const TELEGRAM_MAX_CHARS: usize = 3800;

/// Streamer-room occupants (via `user_rig_rooms` or a rack placed in the room)
/// with their approved-video history — mirrors `STREAMER_ROOM_USERS_SQL`.
const REPORT_SQL: &str = r#"
    SELECT DISTINCT ON (u.id)
      u.id AS user_id,
      u.username,
      u.email,
      (SELECT MAX(pys.created_at) FROM partner_youtube_submissions pys
        WHERE pys.user_id = u.id AND pys.status = 'approved') AS last_approved_at,
      (SELECT COUNT(*) FROM partner_youtube_submissions pys
        WHERE pys.user_id = u.id AND pys.status = 'approved' AND pys.created_at >= $1) AS approved_last_60d,
      (SELECT COUNT(*) FROM partner_youtube_submissions pys
        WHERE pys.user_id = u.id AND pys.status = 'approved' AND pys.created_at >= $3) AS approved_last_365d
    FROM users u
    WHERE (
      EXISTS (SELECT 1 FROM user_rig_rooms urr WHERE urr.user_id = u.id AND urr.room_id = $2)
      OR EXISTS (
        SELECT 1 FROM placed_racks pr
         WHERE pr.user_id = u.id
           AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = $2
      )
    )
    ORDER BY u.id ASC
"#;

pub async fn run_partner_report_loop(pool: Pool, locks: RedisLockClient, cfg: WorkerConfig) {
    if !cfg.partner_report_loop_active() {
        info!(
            event = "partner_report_disabled",
            reason = "SCHEDULER_ENABLED=0 / PARTNER_REPORT_LOOP_ENABLED=0 / TELEGRAM_* unset",
            "daily partner report idle"
        );
        std::future::pending::<()>().await;
        return;
    }

    info!(
        timeout_ms = cfg.job_timeout_partner_report_ms,
        "daily partner report loop starting (fires at 00:00 UTC)"
    );

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    loop {
        let delay = ms_until_next_utc_midnight();
        info!(event = "scheduled", delay_ms = delay, "partner report next run");
        tokio::time::sleep(Duration::from_millis(delay)).await;
        run_one_tick(&pool, &locks, &cfg, &http).await;
    }
}

/// Milliseconds from now until the next 00:00:00 UTC (min 60s so a run that
/// finishes just before midnight does not immediately re-fire).
pub fn ms_until_next_utc_midnight() -> u64 {
    let now = Utc::now();
    let secs_today = i64::from(now.hour()) * 3600 + i64::from(now.minute()) * 60 + i64::from(now.second());
    let ms_today = secs_today * 1000 + i64::from(now.timestamp_subsec_millis());
    let remaining = DAY_MS - ms_today;
    (remaining.max(60_000)) as u64
}

async fn run_one_tick(
    pool: &Pool,
    locks: &RedisLockClient,
    cfg: &WorkerConfig,
    http: &reqwest::Client,
) {
    let handle = match locks
        .try_acquire(REDIS_LOCK_JOB_PARTNER_REPORT, REDIS_LOCK_TTL_PARTNER_REPORT_SEC)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            info!(event = "partner_report_lock_busy", "partner report lock held elsewhere");
            return;
        }
        Err(e) => {
            warn!(err = %e, "partner report lock acquire failed");
            return;
        }
    };
    let owned = OwnedYieldTickLock::new(locks.clone(), handle);
    let tick = async {
        match build_report(pool).await {
            Ok(text) => match send_telegram(cfg, http, &text).await {
                Ok(chunks) => info!(event = "partner_report_sent", chunks, "daily partner report sent"),
                Err(e) => warn!(err = %e, "partner report telegram send failed"),
            },
            Err(e) => warn!(err = %e, "partner report build failed"),
        }
    };
    if tokio::time::timeout(
        Duration::from_millis(cfg.job_timeout_partner_report_ms),
        tick,
    )
    .await
    .is_err()
    {
        warn!(
            timeout_ms = cfg.job_timeout_partner_report_ms,
            "partner report tick timed out"
        );
    }
    owned.release().await;
}

struct Overdue {
    username: String,
    user_id: i64,
    email: String,
    last_approved_at: i64,
    approved_365: i64,
}

async fn build_report(pool: &Pool) -> Result<String, String> {
    let conn = pool.get().await.map_err(|e| format!("pool get: {e}"))?;
    let now = now_ms();
    let threshold_60 = now - STREAMER_OVERDUE_DAYS * DAY_MS;
    let threshold_365 = now - 365 * DAY_MS;
    let rows = conn
        .query(REPORT_SQL, &[&threshold_60, &STREAMER_ROOM_ID, &threshold_365])
        .await
        .map_err(|e| format!("report query: {e}"))?;

    let active_total = rows.len();
    let mut overdue: Vec<Overdue> = rows
        .iter()
        .filter(|r| i64_cell(r, "approved_last_60d") == 0)
        .map(|r| Overdue {
            username: string_cell(r, "username"),
            user_id: i64_cell(r, "user_id"),
            email: string_cell(r, "email"),
            last_approved_at: i64_cell(r, "last_approved_at"),
            approved_365: i64_cell(r, "approved_last_365d"),
        })
        .collect();
    overdue.sort_by(|a, b| a.last_approved_at.cmp(&b.last_approved_at));

    let today = Utc::now();
    let header = format!(
        "\u{1F4CA} <b>Relatório diário — parceiros inativos</b>\n<i>{:04}-{:02}-{:02} 00:00 UTC</i>\n",
        today.year(),
        today.month(),
        today.day()
    );

    if overdue.is_empty() {
        return Ok(format!(
            "{header}\n\u{2705} Nenhum parceiro em atraso hoje.\nSala Streamer ativa: {active_total} parceiro(s)."
        ));
    }

    let mut body = String::new();
    for o in &overdue {
        let last = if o.last_approved_at > 0 {
            let days = ((now - o.last_approved_at).max(0) / DAY_MS) as i64;
            format!("há {days} dia(s)")
        } else {
            "nunca".to_string()
        };
        body.push_str(&format!(
            "\u{26A0}\u{FE0F} <b>{}</b> (#{}) — {}\n     último aprovado: {} · últimos 12 meses: {}/6\n",
            esc(&o.username),
            o.user_id,
            esc(&o.email),
            last,
            o.approved_365
        ));
    }

    Ok(format!(
        "{header}\nSala Streamer ativa, sem vídeo aprovado nos últimos {STREAMER_OVERDUE_DAYS} dias:\n\n{body}\nTotal: {} em falta / {} com sala ativa.",
        overdue.len(),
        active_total
    ))
}

/// Minimal HTML escaping for Telegram `parse_mode=HTML`.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn split_chunks(text: &str) -> Vec<String> {
    if text.chars().count() <= TELEGRAM_MAX_CHARS {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in text.split_inclusive('\n') {
        if cur.chars().count() + line.chars().count() > TELEGRAM_MAX_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

async fn send_telegram(
    cfg: &WorkerConfig,
    http: &reqwest::Client,
    text: &str,
) -> Result<usize, String> {
    let token = cfg
        .telegram_bot_token
        .as_deref()
        .ok_or("TELEGRAM_BOT_TOKEN unset")?;
    let chat_id = cfg
        .telegram_partner_report_chat_id
        .as_deref()
        .ok_or("TELEGRAM_PARTNER_REPORT_CHAT_ID unset")?;
    let url = format!("{TELEGRAM_API_BASE}/bot{token}/sendMessage");

    let chunks = split_chunks(text);
    for chunk in &chunks {
        let resp = http
            .post(&url)
            .json(&json!({
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": true,
            }))
            .send()
            .await
            .map_err(|e| format!("telegram request: {e}"))?;
        if !resp.status().is_success() {
            let code = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("telegram HTTP {code}: {}", body.chars().take(300).collect::<String>()));
        }
    }
    Ok(chunks.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_key_is_namespaced() {
        assert_eq!(REDIS_LOCK_JOB_PARTNER_REPORT, "genesis:lock:job:partner-report");
    }

    #[test]
    fn midnight_delay_is_within_a_day_and_at_least_a_minute() {
        let d = ms_until_next_utc_midnight();
        assert!(d >= 60_000);
        assert!(d <= DAY_MS as u64);
    }

    #[test]
    fn html_escaping() {
        assert_eq!(esc("a<b>&c"), "a&lt;b&gt;&amp;c");
    }

    #[test]
    fn chunking_splits_on_line_boundaries() {
        let big = "linha\n".repeat(2000);
        let parts = split_chunks(&big);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|p| p.chars().count() <= TELEGRAM_MAX_CHARS));
        assert_eq!(parts.concat(), big);
    }
}
