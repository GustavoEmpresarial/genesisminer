//! Admin Dashboard / "Hub" — ports `server/modules/admin/dashboard/` (Express):
//! `services/dashboard-stats.ts` (`computeAdminDashboardStatsUncached`, 10 s cache),
//! `services/site-metrics.ts` (`computeAdminSiteMetrics`), plus `ranking-exclusion`
//! and `users/map`. Admin auth stays in `genesis-api` (`admin_dashboard.rs`).

use std::sync::Mutex;
use std::time::Instant;

use chrono::{Datelike, TimeZone, Utc};
use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_DAY;
use genesis_core::utc_week_start_ms;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::{now_ms, PlayerReadError};

pub const DASHBOARD_STATS_PATH: &str = "/v1/admin/dashboard/stats";
pub const DASHBOARD_METRICS_PATH: &str = "/v1/admin/dashboard/metrics";
pub const DASHBOARD_RANKING_EXCLUSION_PATH: &str = "/v1/admin/dashboard/ranking-exclusion";
pub const DASHBOARD_USERS_MAP_PATH: &str = "/v1/admin/dashboard/users-map";

/// Node `ADMIN_DASHBOARD_ONLINE_STALE_MINUTES * MS_PER_MINUTE` (4 min).
const ONLINE_STALE_MS: i64 = 4 * 60 * 1000;
const TOP_LIST_LIMIT: usize = 10;
const STATS_CACHE_TTL_MS: u128 = 10_000;
const SERIES_DAYS: i64 = 14;
const WAU_ROLLING_DAYS: i64 = 7;
const MAU_ROLLING_DAYS: i64 = 30;
const MS_PER_DAY_I64: i64 = MS_PER_DAY as i64;

static STATS_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

pub fn invalidate_dashboard_stats_cache() {
    if let Ok(mut g) = STATS_CACHE.lock() {
        *g = None;
    }
}

fn s(row: &tokio_postgres::Row, col: &str) -> String {
    row.try_get::<_, Option<String>>(col)
        .ok()
        .flatten()
        .unwrap_or_default()
}
fn count_col(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, i32>(col) {
        return i64::from(v);
    }
    0
}
fn f64_col(row: &tokio_postgres::Row, col: &str) -> f64 {
    row.try_get::<_, Option<f64>>(col).ok().flatten().unwrap_or(0.0)
}

// ===========================================================================
// dashboard-stats
// ===========================================================================

pub async fn run_dashboard_stats(pool: &Pool) -> Result<Value, PlayerReadError> {
    if let Ok(g) = STATS_CACHE.lock() {
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed().as_millis() < STATS_CACHE_TTL_MS {
                return Ok(v.clone());
            }
        }
    }
    let fresh = compute_dashboard_stats(pool).await?;
    if let Ok(mut g) = STATS_CACHE.lock() {
        *g = Some((Instant::now(), fresh.clone()));
    }
    Ok(fresh)
}

async fn compute_dashboard_stats(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let now = now_ms();
    let online_cutoff = now - ONLINE_STALE_MS;

    let total_users = count_col(
        &c.query_one(
            "SELECT COUNT(*) AS count FROM users WHERE is_admin = 0 AND COALESCE(is_blocked, 0) = 0",
            &[],
        )
        .await?,
        "count",
    );
    let deactivated_users = count_col(
        &c.query_one(
            "SELECT COUNT(*) AS count FROM users WHERE is_admin = 0 AND COALESCE(is_blocked, 0) <> 0",
            &[],
        )
        .await?,
        "count",
    );
    let online_users = count_col(
        &c.query_one(
            "SELECT COUNT(DISTINCT s.user_id) AS count
               FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE u.is_admin = 0 AND s.expires_at > $1
                AND COALESCE(NULLIF(s.last_seen_at, 0), s.created_at) > $2",
            &[&now, &online_cutoff],
        )
        .await?,
        "count",
    );
    let total_deposited = f64_col(
        &c.query_one(
            "SELECT SUM(gs.total_usdc_deposited)::double precision AS total
               FROM game_states gs JOIN users u ON gs.user_id = u.id
              WHERE u.is_admin = 0",
            &[],
        )
        .await?,
        "total",
    );
    let total_withdrawn = f64_col(
        &c.query_one(
            "SELECT SUM(amount_usdc)::double precision AS total
               FROM withdrawal_requests WHERE status = 'completed'",
            &[],
        )
        .await?,
        "total",
    );

    let last10: Vec<Value> = c
        .query(
            "SELECT username, email FROM users WHERE is_admin = 0 ORDER BY id DESC LIMIT 10",
            &[],
        )
        .await?
        .iter()
        .map(|r| json!({ "username": s(r, "username"), "email": s(r, "email") }))
        .collect();

    let top_deposits: Vec<Value> = c
        .query(
            "SELECT u.username, u.email, gs.total_usdc_deposited::double precision AS amount
               FROM users u JOIN game_states gs ON u.id = gs.user_id
              WHERE u.is_admin = 0 AND gs.total_usdc_deposited > 0
              ORDER BY gs.total_usdc_deposited DESC LIMIT 10",
            &[],
        )
        .await?
        .iter()
        .map(|r| json!({ "username": s(r, "username"), "email": s(r, "email"), "amount": f64_col(r, "amount") }))
        .collect();

    let power_rows = c
        .query(
            "WITH rack_base AS (
               SELECT r.id AS rack_id, r.user_id,
                      SUM(COALESCE(u.base_production, 0)) AS base_prod
                 FROM placed_racks r
                 JOIN rack_slots rs ON r.id = rs.rack_id
                 LEFT JOIN upgrades u ON rs.machine_item_id = u.id
                WHERE r.is_on = 1 AND r.wiring_id IS NOT NULL AND r.battery_id IS NOT NULL
                GROUP BY r.id, r.user_id
             ),
             rack_mult AS (
               SELECT rms.rack_id, 1 + SUM(COALESCE(u.multiplier, 0)) AS total_mult
                 FROM rack_multiplier_slots rms
                 JOIN upgrades u ON rms.multiplier_item_id = u.id
                GROUP BY rms.rack_id
             ),
             user_power AS (
               SELECT rb.user_id,
                      SUM(rb.base_prod * COALESCE(rm.total_mult, 1)) AS power
                 FROM rack_base rb
                 LEFT JOIN rack_mult rm ON rb.rack_id = rm.rack_id
                GROUP BY rb.user_id
             )
             SELECT up.power::double precision AS power, u.username, u.email
               FROM user_power up JOIN users u ON up.user_id = u.id
              WHERE COALESCE(u.ranking_excluded, 0) = 0
              ORDER BY up.power DESC",
            &[],
        )
        .await?;
    let global_power: f64 = power_rows.iter().map(|r| f64_col(r, "power")).sum();
    let top_miners: Vec<Value> = power_rows
        .iter()
        .take(TOP_LIST_LIMIT)
        .map(|r| json!({ "username": s(r, "username"), "email": s(r, "email"), "amount": f64_col(r, "power") }))
        .collect();

    let ranking_excluded: Vec<Value> = c
        .query(
            "SELECT id, username, email, COALESCE(is_admin, 0) AS is_admin
               FROM users WHERE COALESCE(ranking_excluded, 0) = 1
              ORDER BY LOWER(username) LIMIT 500",
            &[],
        )
        .await?
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<_, i32>("id"),
                "username": s(r, "username"),
                "email": s(r, "email"),
                "is_admin": count_col(r, "is_admin"),
            })
        })
        .collect();

    let mining_coins: Vec<Value> = c
        .query("SELECT id, name FROM mining_coins ORDER BY name ASC", &[])
        .await?
        .iter()
        .map(|r| {
            let id = s(r, "id");
            let name = {
                let n = s(r, "name");
                if n.is_empty() {
                    id.clone()
                } else {
                    n
                }
            };
            json!({ "id": id, "name": name })
        })
        .collect();

    let tw_rows = c
        .query(
            "WITH ranked AS (
               SELECT w.coin_id, u.username, u.email,
                      SUM(w.amount_crypto)::double precision AS total,
                      ROW_NUMBER() OVER (PARTITION BY w.coin_id ORDER BY SUM(w.amount_crypto) DESC) AS rn
                 FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
                WHERE w.status = 'completed'
                GROUP BY w.coin_id, u.id, u.username, u.email
             )
             SELECT r.coin_id, mc.name AS coin_name, r.username, r.email, r.total
               FROM ranked r JOIN mining_coins mc ON mc.id = r.coin_id
              WHERE r.rn <= 10
              ORDER BY LOWER(mc.name) ASC, r.total DESC",
            &[],
        )
        .await?;
    let mut by_coin: Vec<Value> = Vec::new();
    let mut order: Vec<String> = Vec::new();
    for r in &tw_rows {
        let coin_id = s(r, "coin_id");
        let coin_name = {
            let n = s(r, "coin_name");
            if n.is_empty() {
                coin_id.clone()
            } else {
                n
            }
        };
        let entry = json!({
            "username": s(r, "username"),
            "email": s(r, "email"),
            "total": f64_col(r, "total"),
        });
        if let Some(idx) = order.iter().position(|x| x == &coin_id) {
            by_coin[idx]["top"].as_array_mut().unwrap().push(entry);
        } else {
            order.push(coin_id.clone());
            by_coin.push(json!({ "coinId": coin_id, "coinName": coin_name, "top": [entry] }));
        }
    }

    Ok(json!({
        "totalUsers": total_users,
        "deactivatedUsers": deactivated_users,
        "onlineUsers": online_users,
        "totalDeposited": total_deposited,
        "totalWithdrawn": total_withdrawn,
        "last10": last10,
        "topDeposits": top_deposits,
        "topWithdrawalsByCoin": by_coin,
        "globalPower": global_power,
        "topMiners": top_miners,
        "rankingExcluded": ranking_excluded,
        "miningCoins": mining_coins,
    }))
}

// ===========================================================================
// site-metrics
// ===========================================================================

fn utc_day_start_ms(now_ms: i64) -> i64 {
    let dt = Utc.timestamp_millis_opt(now_ms).single().unwrap_or_else(Utc::now);
    Utc.with_ymd_and_hms(dt.year(), dt.month(), dt.day(), 0, 0, 0)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms)
}
fn utc_month_start_ms(now_ms: i64) -> i64 {
    let dt = Utc.timestamp_millis_opt(now_ms).single().unwrap_or_else(Utc::now);
    Utc.with_ymd_and_hms(dt.year(), dt.month(), 1, 0, 0, 0)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms)
}
fn utc_ymd(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

const REGISTERED_USER_SQL: &str = "u.is_admin = 0 AND COALESCE(u.is_blocked, 0) = 0";
const ACTIVITY_MS_SQL: &str = "COALESCE(NULLIF(s.last_seen_at, 0), s.created_at)";

pub async fn run_site_metrics(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let now = now_ms();
    let today_start = utc_day_start_ms(now);
    let week_start = utc_week_start_ms(now);
    let month_start = utc_month_start_ms(now);
    let series_start = today_start - (SERIES_DAYS - 1) * MS_PER_DAY_I64;
    let series_end_excl = today_start + MS_PER_DAY_I64;
    let online_cutoff = now - ONLINE_STALE_MS;
    let dau_cutoff = now - MS_PER_DAY_I64;
    let wau_cutoff = now - WAU_ROLLING_DAYS * MS_PER_DAY_I64;
    let mau_cutoff = now - MAU_ROLLING_DAYS * MS_PER_DAY_I64;

    let one = |sql: String, params: Vec<i64>| {
        let c = &c;
        async move {
            let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                params.iter().map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync)).collect();
            c.query_one(&sql, &refs).await.map(|r| count_col(&r, "count"))
        }
    };

    let registered = one(
        format!("SELECT COUNT(*) AS count FROM users u WHERE {REGISTERED_USER_SQL}"),
        vec![],
    )
    .await?;
    let deactivated = one(
        "SELECT COUNT(*) AS count FROM users u WHERE u.is_admin = 0 AND COALESCE(u.is_blocked, 0) <> 0"
            .to_string(),
        vec![],
    )
    .await?;
    let online = one(
        format!(
            "SELECT COUNT(DISTINCT s.user_id) AS count FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE u.is_admin = 0 AND s.expires_at > $1 AND {ACTIVITY_MS_SQL} > $2"
        ),
        vec![now, online_cutoff],
    )
    .await?;
    let active_since = |cutoff: i64| {
        one(
            format!(
                "SELECT COUNT(DISTINCT s.user_id) AS count FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE {REGISTERED_USER_SQL} AND {ACTIVITY_MS_SQL} >= $1"
            ),
            vec![cutoff],
        )
    };
    let dau = active_since(dau_cutoff).await?;
    let wau = active_since(wau_cutoff).await?;
    let mau = active_since(mau_cutoff).await?;
    let signups_since = |cutoff: i64| {
        one(
            "SELECT COUNT(*) AS count FROM game_states gs JOIN users u ON u.id = gs.user_id
              WHERE u.is_admin = 0 AND gs.start_time >= $1"
                .to_string(),
            vec![cutoff],
        )
    };
    let signups_today = signups_since(today_start).await?;
    let signups_week = signups_since(week_start).await?;
    let signups_month = signups_since(month_start).await?;
    let total_accounts = one("SELECT COUNT(*) AS count FROM users".to_string(), vec![]).await?;
    let admin_accounts = one(
        "SELECT COUNT(*) AS count FROM users WHERE is_admin <> 0".to_string(),
        vec![],
    )
    .await?;
    let with_wallet = one(
        format!(
            "SELECT COUNT(*) AS count FROM users u
              WHERE {REGISTERED_USER_SQL} AND u.polygon_wallet IS NOT NULL AND BTRIM(u.polygon_wallet) <> ''"
        ),
        vec![],
    )
    .await?;
    let mining_now = one(
        format!(
            "SELECT COUNT(DISTINCT pr.user_id) AS count FROM placed_racks pr JOIN users u ON u.id = pr.user_id
              WHERE pr.is_on = 1 AND {REGISTERED_USER_SQL}"
        ),
        vec![],
    )
    .await?;

    let signup_series = c
        .query(
            "SELECT to_char((to_timestamp(gs.start_time / 1000.0) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                    COUNT(*)::int AS cnt
               FROM game_states gs JOIN users u ON u.id = gs.user_id
              WHERE u.is_admin = 0 AND gs.start_time >= $1 AND gs.start_time < $2
              GROUP BY day ORDER BY day",
            &[&series_start, &series_end_excl],
        )
        .await?;
    let active_series = c
        .query(
            &format!(
                "SELECT to_char((to_timestamp({ACTIVITY_MS_SQL} / 1000.0) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                        COUNT(DISTINCT s.user_id)::int AS cnt
                   FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE {REGISTERED_USER_SQL} AND {ACTIVITY_MS_SQL} >= $1 AND {ACTIVITY_MS_SQL} < $2
                  GROUP BY day ORDER BY day"
            ),
            &[&series_start, &series_end_excl],
        )
        .await?;

    let mut signup_by_day = std::collections::HashMap::new();
    for r in &signup_series {
        signup_by_day.insert(s(r, "day"), count_col(r, "cnt"));
    }
    let mut active_by_day = std::collections::HashMap::new();
    for r in &active_series {
        active_by_day.insert(s(r, "day"), count_col(r, "cnt"));
    }
    let mut daily_series = Vec::with_capacity(SERIES_DAYS as usize);
    for i in 0..SERIES_DAYS {
        let day_ms = series_start + i * MS_PER_DAY_I64;
        let date = utc_ymd(day_ms);
        daily_series.push(json!({
            "date": date.clone(),
            "signups": signup_by_day.get(&date).copied().unwrap_or(0),
            "activeUsers": active_by_day.get(&date).copied().unwrap_or(0),
        }));
    }

    Ok(json!({
        "generatedAtMs": now,
        "registeredUsers": registered,
        "deactivatedUsers": deactivated,
        "onlineUsers": online,
        "dau": dau,
        "wau": wau,
        "mau": mau,
        "signupsToday": signups_today,
        "signupsThisWeek": signups_week,
        "signupsThisMonth": signups_month,
        "totalAccounts": total_accounts,
        "adminAccounts": admin_accounts,
        "usersWithWallet": with_wallet,
        "usersMiningNow": mining_now,
        "dailySeries": daily_series,
    }))
}

// ===========================================================================
// ranking-exclusion + users/map
// ===========================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingExclusionRequest {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub excluded: bool,
}

pub async fn run_ranking_exclusion(
    pool: &Pool,
    req: RankingExclusionRequest,
) -> Result<Value, PlayerReadError> {
    let email = req.email.trim().to_string();
    if email.is_empty() {
        return Err(PlayerReadError::bad("Email inválido"));
    }
    let c = pool.get().await?;
    let row = c
        .query_opt(
            "SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
            &[&email],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError::not_found("Utilizador não encontrado."));
    };
    let uid: i32 = row.get("id");
    let flag: i32 = if req.excluded { 1 } else { 0 };
    c.execute(
        "UPDATE users SET ranking_excluded = $2 WHERE id = $1",
        &[&uid, &flag],
    )
    .await?;
    invalidate_dashboard_stats_cache();
    Ok(json!({ "ok": true }))
}

pub async fn run_users_map(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let rows = c
        .query(
            "SELECT u.id, u.username, u.polygon_wallet AS polygon_wallet, u.email FROM users u",
            &[],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<_, i32>("id"),
                "username": s(r, "username"),
                "polygonWallet": r.try_get::<_, Option<String>>("polygon_wallet").ok().flatten(),
                "email": s(r, "email"),
            })
        })
        .collect();
    Ok(json!({ "rows": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
        assert_eq!(DASHBOARD_STATS_PATH, "/v1/admin/dashboard/stats");
        assert_eq!(DASHBOARD_METRICS_PATH, "/v1/admin/dashboard/metrics");
    }

    #[test]
    fn utc_day_start_is_midnight() {
        // 2026-09-07T13:45:00Z -> 2026-09-07T00:00:00Z
        let ms = 1_788_262_700_000;
        assert_eq!(utc_ymd(utc_day_start_ms(ms)), utc_ymd(ms));
        assert_eq!(utc_day_start_ms(ms) % MS_PER_DAY_I64, 0);
    }
}
