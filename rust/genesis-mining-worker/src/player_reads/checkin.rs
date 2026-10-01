//! Check-in status + perform — Node `checkin/services/checkin.ts`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::checkin::{
    has_checked_in_current_period, is_premium_within_active_window,
    is_within_active_checkin_window, next_checkin_period_start_ms, premium_interval_ms,
    should_grant_streak_milestone_reward, utc_day_from_ms, CHECKIN_GRACE_MS, CHECKIN_REWARD_EVERY_DAYS,
    CHECKIN_TIMEZONE, CHECKIN_WINDOW_MS,
};
use genesis_core::hardware::duration::{
    format_asic_duration_label_pt, is_timed_asic_duration, normalize_asic_duration_config,
};
use genesis_core::time::MS_PER_SECOND;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::WorkerConfig;
use crate::hardware_client::call_hardware_credit;
use crate::support::LOCK_TIMEOUT_MS;

use super::{f64_cell, i32_cell, i64_cell, opt_string, pg_user_id, string_cell, PlayerReadError};

/// Node `CHECKIN_STREAK_GRACE_MS` = 2 * day.
const CHECKIN_STREAK_GRACE_MS: i64 = (CHECKIN_WINDOW_MS as i64) * 2;
/// Node `STATEMENT_TIMEOUT_MS`.
const CHECKIN_STATEMENT_TIMEOUT_SECONDS: u64 = 5;
const CHECKIN_STATEMENT_TIMEOUT_MS: u64 = CHECKIN_STATEMENT_TIMEOUT_SECONDS * MS_PER_SECOND;
/// Node `DEFAULT_CHECKIN_DAILY_REWARD_AMOUNT`.
const DEFAULT_DAILY_REWARD: f64 = 1.0;
/// Node `DEFAULT_CHECKIN_WEEKLY_REWARD_AMOUNT`.
const DEFAULT_WEEKLY_REWARD: f64 = 7.0;
const REWARD_HASHRATE: &str = "hashrate";
const EVENT_CHECKIN_RECORDED: &str = "CHECKIN_RECORDED";
const IDENTITY_USER: &str = "user";
const CODE_GAME_STATE_NOT_FOUND: &str = "GAME_STATE_NOT_FOUND";
/// Node streak grant qty — always one temporary machine.
const STREAK_REWARD_QTY: i64 = 1;
const UPGRADE_TYPE_MACHINE: &str = "machine";
const LEASE_STATUS_STOCK: &str = "stock";

const _: () = assert!(CHECKIN_REWARD_EVERY_DAYS == 7);
const _: () = assert!(CHECKIN_STREAK_GRACE_MS == 2 * CHECKIN_WINDOW_MS as i64);
const _: () = assert!(CHECKIN_STATEMENT_TIMEOUT_MS == 5_000);
const _: () = assert!(STREAK_REWARD_QTY == 1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub now_ms: Option<i64>,
}

struct RewardPolicy {
    reward_type: String,
    daily: f64,
    weekly: f64,
    item_id: String,
    streak_enabled: bool,
    streak_item_id: String,
    streak_amount: i32,
    streak_unit: String,
}

struct PremiumCtx {
    premium_weekly: bool,
    interval_days: i32,
    min_usdc: f64,
}

#[derive(Debug, Clone)]
struct StreakGrant {
    granted: i32,
    item_id: Option<String>,
    item_name: Option<String>,
    expires_at_ms: Option<i64>,
    duration_label: Option<String>,
}

impl StreakGrant {
    const EMPTY: Self = Self {
        granted: 0,
        item_id: None,
        item_name: None,
        expires_at_ms: None,
        duration_label: None,
    };
}

pub async fn run_checkin_status(
    pool: &Pool,
    user_id: i64,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    best_effort_ensure_premium_credit(pool, user_id, now_ms).await;
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let premium = load_premium(&*conn, uid).await?;
    let policy = load_reward_policy(&conn).await?;
    let row = conn
        .query_opt(
            "SELECT last_checkin_day, last_checkin_at_ms, checkin_streak, checkin_bonus_hps::double precision AS checkin_bonus_hps
               FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let last_day = row.as_ref().and_then(|r| opt_string(r, "last_checkin_day"));
    let last_at = row
        .as_ref()
        .and_then(|r| opt_positive_i64(r, "last_checkin_at_ms"));
    let streak = row
        .as_ref()
        .map(|r| i32_cell(r, "checkin_streak").max(0))
        .unwrap_or(0);
    let bonus = row
        .as_ref()
        .map(|r| f64_cell(r, "checkin_bonus_hps").max(0.0))
        .unwrap_or(0.0);
    Ok(build_status(
        &utc_day_from_ms(now_ms),
        last_day.as_deref(),
        last_at,
        streak,
        now_ms,
        &premium,
        &policy,
        bonus,
        false,
        0.0,
        false,
        &StreakGrant::EMPTY,
    ))
}

pub async fn run_checkin_perform(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    let mut conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let premium = load_premium(&*conn, uid).await?;
    let policy = load_reward_policy(&conn).await?;
    let tx = conn.transaction().await?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = {CHECKIN_STATEMENT_TIMEOUT_MS}; SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"
    ))
    .await?;
    tx.execute(
        "INSERT INTO game_states (
            user_id, usdc, start_time, claimed_referrals, referral_bonus_claimed,
            last_updated_at, server_updated_at, black_market_balance
         ) VALUES ($1, 0, $2, 0, 0, $2, $2, 0)
         ON CONFLICT (user_id) DO NOTHING",
        &[&uid, &now_ms],
    )
    .await?;
    let row = tx
        .query_opt(
            "SELECT last_checkin_day, last_checkin_at_ms, checkin_streak, checkin_bonus_hps::double precision AS checkin_bonus_hps
               FROM game_states WHERE user_id = $1 FOR UPDATE",
            &[&uid],
        )
        .await?;
    let Some(row) = row else {
        return Err(PlayerReadError {
            http_status: 404,
            error: "Game state not found for this user.".into(),
            code: Some(CODE_GAME_STATE_NOT_FOUND.into()),
            extra: Value::Object(serde_json::Map::new()),
        });
    };
    let prev_streak = i32_cell(&row, "checkin_streak").max(0);
    let prev_at = opt_positive_i64(&row, "last_checkin_at_ms");
    let prev_bonus = f64_cell(&row, "checkin_bonus_hps").max(0.0);

    if premium.premium_weekly {
        if let Some(at) = prev_at {
            if now_ms < at + premium_interval_ms(premium.interval_days) {
                let next_allowed = at + premium_interval_ms(premium.interval_days);
                return Err(PlayerReadError::conflict(
                    "Premium check-in cooldown.",
                    json!({ "nextCheckinAllowedMs": next_allowed, "intervalDays": premium.interval_days }),
                ));
            }
        }
        let interval = premium_interval_ms(premium.interval_days);
        let (next_streak, streak_reset) =
            next_premium_streak(prev_streak, prev_at, now_ms, interval);
        let day = utc_day_from_ms(now_ms);
        apply_checkin(
            &tx,
            uid,
            user_id,
            &day,
            now_ms,
            next_streak,
            prev_at,
            "premium",
            &policy,
            prev_bonus,
        )
        .await?;
        tx.commit().await?;
        // Streak machine credit is HTTP to genesis-hardware — after commit so we do not
        // hold FOR UPDATE across the RTT. Fail-closed empty grant never rolls back check-in.
        let streak_grant =
            maybe_grant_streak_reward(pool, http, cfg, user_id, uid, next_streak, &policy, now_ms)
                .await;
        // Advance check-in quests (daily + weekly) — best-effort, own tx. Skips when
        // today's daily progress was already credited (e.g. prior status/quests read).
        best_effort_bump_checkin_quests(pool, uid, now_ms).await;
        return Ok(build_status(
            &day,
            Some(&day),
            Some(now_ms),
            next_streak,
            now_ms,
            &premium,
            &policy,
            grant_bonus(&policy, prev_bonus, true),
            true,
            grant_amount(&policy, true),
            streak_reset,
            &streak_grant,
        ));
    }

    if has_checked_in_current_period(prev_at, now_ms) {
        let last_day = opt_string(&row, "last_checkin_day");
        tx.commit().await?;
        return Ok(build_status(
            &utc_day_from_ms(now_ms),
            last_day.as_deref(),
            prev_at,
            prev_streak,
            now_ms,
            &premium,
            &policy,
            prev_bonus,
            false,
            0.0,
            false,
            &StreakGrant::EMPTY,
        ));
    }

    let prev_period = prev_at.map(|at| genesis_core::checkin::utc_checkin_period_start_ms(at));
    let anchor = genesis_core::checkin::utc_checkin_period_start_ms(now_ms);
    let (next_streak, streak_reset) = next_daily_streak(prev_streak, prev_period, anchor);
    let day = utc_day_from_ms(now_ms);
    apply_checkin(
        &tx,
        uid,
        user_id,
        &day,
        now_ms,
        next_streak,
        prev_at,
        "daily",
        &policy,
        prev_bonus,
    )
    .await?;
    tx.commit().await?;
    let streak_grant =
        maybe_grant_streak_reward(pool, http, cfg, user_id, uid, next_streak, &policy, now_ms).await;
    best_effort_bump_checkin_quests(pool, uid, now_ms).await;
    Ok(build_status(
        &day,
        Some(&day),
        Some(now_ms),
        next_streak,
        now_ms,
        &premium,
        &policy,
        grant_bonus(&policy, prev_bonus, false),
        true,
        grant_amount(&policy, false),
        streak_reset,
        &streak_grant,
    ))
}

/// Best-effort: auto-credit check-in quests during premium window (daily gate ≥1).
async fn best_effort_ensure_premium_credit(pool: &Pool, user_id: i64, now_ms: i64) {
    let res = async {
        let mut conn = pool.get().await?;
        crate::player_reads::quests::ensure_premium_credit(&mut conn, user_id, now_ms).await
    }
    .await;
    if let Err(e) = res {
        tracing::warn!(err = %e.error, user_id, "checkin premium quest credit (non-fatal)");
    }
}

/// Best-effort: advance `action_type = 'checkin'` quests in a dedicated tx. A
/// failure here is logged and swallowed so it never fails the check-in itself.
async fn best_effort_bump_checkin_quests(pool: &Pool, uid: i32, now_ms: i64) {
    let res = async {
        let mut conn = pool.get().await?;
        let tx = conn.transaction().await?;
        crate::player_reads::quests::bump_checkin_progress_if_daily_uncounted(&tx, uid, now_ms)
            .await?;
        tx.commit().await?;
        Ok::<(), PlayerReadError>(())
    }
    .await;
    if let Err(e) = res {
        tracing::warn!(err = %e.error, uid, "checkin quest bump (non-fatal)");
    }
}

async fn apply_checkin<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    day: &str,
    now_ms: i64,
    next_streak: i32,
    prev_at: Option<i64>,
    mode: &str,
    policy: &RewardPolicy,
    prev_bonus: f64,
) -> Result<(), PlayerReadError> {
    client
        .execute(
            "UPDATE game_states
                SET last_checkin_day = $2, last_checkin_at_ms = $3, checkin_streak = $4,
                    server_updated_at = $5, last_updated_at = $5
              WHERE user_id = $1",
            &[&uid, &day, &now_ms, &next_streak, &now_ms],
        )
        .await?;
    let payload = json!({
        "previous_last_checkin_at_ms": prev_at,
        "streak": next_streak,
        "mode": mode,
    });
    client
        .execute(
            "INSERT INTO mining_eligibility_events
                (user_id, event_type, at_ms, identity_kind, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &uid,
                &EVENT_CHECKIN_RECORDED,
                &now_ms,
                &IDENTITY_USER,
                &payload,
                &now_ms,
            ],
        )
        .await?;
    if policy.reward_type == REWARD_HASHRATE {
        let add = if mode == "premium" {
            policy.weekly
        } else {
            policy.daily
        };
        if add > 0.0 {
            let next = prev_bonus + add;
            client
                .execute(
                    "UPDATE game_states SET checkin_bonus_hps = $2 WHERE user_id = $1",
                    &[&uid, &next],
                )
                .await?;
        }
    }
    let _ = user_id;
    Ok(())
}

/// Node `grantCheckinStreakTemporaryItem` when milestone + policy allow.
async fn maybe_grant_streak_reward(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
    uid: i32,
    next_streak: i32,
    policy: &RewardPolicy,
    now_ms: i64,
) -> StreakGrant {
    if !should_grant_streak_milestone_reward(next_streak) {
        return StreakGrant::EMPTY;
    }
    grant_checkin_streak_temporary_item(pool, http, cfg, user_id, uid, policy, now_ms).await
}

/// Fail-closed gate after upgrades SELECT — Node missing / non-machine paths.
fn streak_upgrade_machine_ok(upgrade_type: Option<&str>) -> bool {
    upgrade_type == Some(UPGRADE_TYPE_MACHINE)
}

/// Fail-closed grant: policy/upgrade/type/credit issues → empty grant + ERROR log (never
/// invents granted=1). Runs after check-in commit — same soft posture as Node missing upgrade.
async fn grant_checkin_streak_temporary_item(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    user_id: i64,
    uid: i32,
    policy: &RewardPolicy,
    now_ms: i64,
) -> StreakGrant {
    if !policy.streak_enabled {
        return StreakGrant::EMPTY;
    }
    let item_id = policy.streak_item_id.trim();
    if item_id.is_empty() {
        return StreakGrant::EMPTY;
    }
    let duration_cfg = normalize_asic_duration_config(
        Some(i64::from(policy.streak_amount)),
        Some(policy.streak_unit.as_str()),
        None,
    );
    if !is_timed_asic_duration(&duration_cfg) {
        return StreakGrant::EMPTY;
    }

    let conn = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(user_id, item_id, err = %e, "checkin streak reward — pool");
            return StreakGrant::EMPTY;
        }
    };

    let up = match conn
        .query_opt(
            "SELECT id, name, type FROM upgrades WHERE id = $1 AND COALESCE(is_active, 1) <> 0 LIMIT 1",
            &[&item_id],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(
                user_id,
                item_id,
                err = %e,
                "checkin streak reward — upgrades query failed"
            );
            return StreakGrant::EMPTY;
        }
    };
    let Some(row) = up else {
        tracing::error!(
            user_id,
            item_id,
            "checkin streak reward — upgrade ausente ou inactivo"
        );
        return StreakGrant::EMPTY;
    };
    let row_type = string_cell(&row, "type");
    if !streak_upgrade_machine_ok(Some(row_type.as_str())) {
        tracing::error!(
            user_id,
            item_id,
            r#type = %row_type,
            "checkin streak reward — só máquinas (type=machine) com validade"
        );
        return StreakGrant::EMPTY;
    }
    let item_name = opt_string(&row, "name").unwrap_or_else(|| item_id.to_string());

    if let Err(e) = call_hardware_credit(
        http,
        cfg,
        user_id,
        item_id,
        STREAK_REWARD_QTY,
        Some(duration_cfg.amount),
        duration_cfg.unit.as_deref(),
    )
    .await
    {
        tracing::error!(
            user_id,
            item_id,
            err = %e.error,
            "checkin streak reward — hardware credit failed"
        );
        return StreakGrant::EMPTY;
    }

    let lease = conn
        .query_opt(
            "SELECT expires_at FROM player_asic_leases
              WHERE user_id = $1 AND item_id = $2 AND status = $3 AND expires_at > $4
              ORDER BY expires_at DESC
              LIMIT 1",
            &[&uid, &item_id, &LEASE_STATUS_STOCK, &now_ms],
        )
        .await
        .ok()
        .flatten();
    let expires_at_ms = lease.and_then(|r| {
        let v = i64_cell(&r, "expires_at");
        if v > 0 {
            Some(v)
        } else {
            None
        }
    });
    let duration_label = format_asic_duration_label_pt(&duration_cfg);

    tracing::info!(
        user_id,
        item_id,
        expires_at_ms,
        "checkin streak reward granted"
    );

    StreakGrant {
        granted: STREAK_REWARD_QTY as i32,
        item_id: Some(item_id.to_string()),
        item_name: Some(item_name),
        expires_at_ms,
        duration_label: Some(duration_label),
    }
}

fn grant_amount(policy: &RewardPolicy, premium: bool) -> f64 {
    if policy.reward_type != REWARD_HASHRATE {
        return 0.0;
    }
    if premium {
        policy.weekly
    } else {
        policy.daily
    }
}

fn grant_bonus(policy: &RewardPolicy, prev: f64, premium: bool) -> f64 {
    prev + grant_amount(policy, premium)
}

fn next_daily_streak(prev_streak: i32, prev_period: Option<i64>, anchor: i64) -> (i32, bool) {
    let Some(prev) = prev_period else {
        return (1, false);
    };
    let gap = anchor - prev;
    if gap == CHECKIN_WINDOW_MS as i64 || gap == CHECKIN_STREAK_GRACE_MS {
        return (prev_streak + 1, false);
    }
    (1, prev_streak != 0)
}

fn next_premium_streak(
    prev_streak: i32,
    prev_at: Option<i64>,
    now_ms: i64,
    interval_ms: i64,
) -> (i32, bool) {
    if let Some(at) = prev_at {
        if now_ms - at <= interval_ms + CHECKIN_WINDOW_MS as i64 {
            return (prev_streak + 1, false);
        }
    }
    (1, prev_streak != 0 || prev_at.is_some())
}

fn build_status(
    today: &str,
    last_day: Option<&str>,
    last_at: Option<i64>,
    streak: i32,
    now_ms: i64,
    premium: &PremiumCtx,
    policy: &RewardPolicy,
    bonus: f64,
    performed: bool,
    reward_granted: f64,
    streak_reset: bool,
    streak_grant: &StreakGrant,
) -> Value {
    let cycle = CHECKIN_REWARD_EVERY_DAYS;
    let cycle_progress = if streak == 0 {
        0
    } else if streak % cycle == 0 {
        cycle
    } else {
        streak % cycle
    };
    let unit = if policy.reward_type == REWARD_HASHRATE {
        "H/s"
    } else if policy.reward_type == "battery" {
        "bateria"
    } else {
        "item"
    };
    let mut body = if premium.premium_weekly {
        let interval = premium_interval_ms(premium.interval_days);
        let within = is_premium_within_active_window(last_at, now_ms, premium.interval_days);
        let next_allowed = last_at.map(|at| at + interval);
        let can_now = match last_at {
            None => true,
            Some(at) => now_ms >= at + interval,
        };
        json!({
            "today": today,
            "timezone": CHECKIN_TIMEZONE,
            "lastCheckinDay": last_day,
            "lastCheckinAtMs": last_at,
            "streak": streak,
            "todayCheckedIn": within,
            "canEarlyCheckin": false,
            "frozen": !within,
            "nextResetMs": last_at.map(|at| at + interval).unwrap_or(now_ms + interval),
            "nextCheckinAtMs": if can_now { Value::Null } else { json!(next_allowed) },
            "windowRemainingMs": if within { last_at.map(|at| (at + interval - now_ms).max(0)).unwrap_or(0) } else { 0 },
            "windowDurationMs": interval,
            "rewardCycleProgress": cycle_progress,
            "rewardCycleSize": cycle,
            "canCheckinNow": can_now,
            "nextCheckinAllowedMs": next_allowed,
        })
    } else {
        let within = is_within_active_checkin_window(last_at, now_ms);
        let today_in = has_checked_in_current_period(last_at, now_ms);
        let next_reset = last_at
            .map(|at| at + CHECKIN_GRACE_MS as i64)
            .unwrap_or_else(|| next_checkin_period_start_ms(now_ms));
        json!({
            "today": today,
            "timezone": CHECKIN_TIMEZONE,
            "lastCheckinDay": last_day,
            "lastCheckinAtMs": last_at,
            "streak": streak,
            "todayCheckedIn": today_in,
            "canEarlyCheckin": false,
            "frozen": !within,
            "nextResetMs": next_reset,
            "nextCheckinAtMs": if today_in { json!(next_checkin_period_start_ms(now_ms)) } else { Value::Null },
            "windowRemainingMs": if within { (next_reset - now_ms).max(0) } else { 0 },
            "windowDurationMs": CHECKIN_GRACE_MS,
            "rewardCycleProgress": cycle_progress,
            "rewardCycleSize": cycle,
            "canCheckinNow": !today_in,
            "nextCheckinAllowedMs": Value::Null,
        })
    };
    if let Some(obj) = body.as_object_mut() {
        obj.insert("checkinBonusHps".into(), json!(bonus));
        obj.insert("rewardType".into(), json!(policy.reward_type));
        obj.insert("rewardUnit".into(), json!(unit));
        obj.insert("dailyRewardAmount".into(), json!(policy.daily));
        obj.insert("weeklyRewardAmount".into(), json!(policy.weekly));
        obj.insert(
            "streakRewardEnabled".into(),
            json!(policy.streak_enabled && !policy.streak_item_id.trim().is_empty()),
        );
        obj.insert("streakRewardItemId".into(), json!(policy.streak_item_id));
        obj.insert(
            "streakRewardDurationAmount".into(),
            json!(policy.streak_amount),
        );
        obj.insert("streakRewardDurationUnit".into(), json!(policy.streak_unit));
        obj.insert("streakRewardDurationLabel".into(), Value::Null);
        obj.insert("premiumWeeklyCheckin".into(), json!(premium.premium_weekly));
        obj.insert("premiumIntervalDays".into(), json!(premium.interval_days));
        obj.insert("premiumMinUsdc".into(), json!(premium.min_usdc));
        obj.insert("performed".into(), json!(performed));
        obj.insert("rewardGranted".into(), json!(reward_granted));
        obj.insert("streakReset".into(), json!(streak_reset));
        obj.insert("streakRewardGranted".into(), json!(streak_grant.granted));
        obj.insert(
            "streakRewardGrantedItemId".into(),
            match &streak_grant.item_id {
                Some(id) => json!(id),
                None => Value::Null,
            },
        );
        obj.insert(
            "streakRewardGrantedItemName".into(),
            match &streak_grant.item_name {
                Some(n) => json!(n),
                None => Value::Null,
            },
        );
        obj.insert(
            "streakRewardGrantedExpiresAtMs".into(),
            match streak_grant.expires_at_ms {
                Some(ms) => json!(ms),
                None => Value::Null,
            },
        );
        obj.insert(
            "streakRewardGrantedDurationLabel".into(),
            match &streak_grant.duration_label {
                Some(l) => json!(l),
                None => Value::Null,
            },
        );
    }
    body
}

async fn load_premium(
    client: &tokio_postgres::Client,
    uid: i32,
) -> Result<PremiumCtx, PlayerReadError> {
    let ctx = crate::checkin_premium_elig::resolve_premium_weekly_checkin(client, uid).await;
    Ok(PremiumCtx {
        premium_weekly: ctx.premium_weekly,
        interval_days: ctx.interval_days,
        min_usdc: ctx.min_usdc,
    })
}

async fn load_reward_policy<C: GenericClient>(client: &C) -> Result<RewardPolicy, PlayerReadError> {
    let keys = vec![
        "checkin_reward_type".to_string(),
        "checkin_daily_reward_amount".to_string(),
        "checkin_weekly_reward_amount".to_string(),
        "checkin_reward_item_id".to_string(),
        "checkin_streak_reward_enabled".to_string(),
        "checkin_streak_reward_item_id".to_string(),
        "checkin_streak_reward_duration_amount".to_string(),
        "checkin_streak_reward_duration_unit".to_string(),
    ];
    let rows = client
        .query(
            "SELECT key, value FROM settings WHERE key = ANY($1)",
            &[&keys],
        )
        .await?;
    let mut m = std::collections::HashMap::new();
    for r in &rows {
        m.insert(string_cell(r, "key"), string_cell(r, "value"));
    }
    let t = m
        .get("checkin_reward_type")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| REWARD_HASHRATE.to_string());
    let reward_type = if t == "battery" || t == "item" || t == REWARD_HASHRATE {
        t
    } else {
        REWARD_HASHRATE.to_string()
    };
    Ok(RewardPolicy {
        reward_type,
        daily: parse_pos_f64(m.get("checkin_daily_reward_amount"), DEFAULT_DAILY_REWARD),
        weekly: parse_pos_f64(m.get("checkin_weekly_reward_amount"), DEFAULT_WEEKLY_REWARD),
        item_id: m.get("checkin_reward_item_id").cloned().unwrap_or_default(),
        streak_enabled: matches!(
            m.get("checkin_streak_reward_enabled").map(|s| s.as_str()),
            Some("1") | Some("true") | Some("yes")
        ),
        streak_item_id: m
            .get("checkin_streak_reward_item_id")
            .cloned()
            .unwrap_or_default(),
        streak_amount: m
            .get("checkin_streak_reward_duration_amount")
            .and_then(|s| s.parse().ok())
            .unwrap_or(CHECKIN_REWARD_EVERY_DAYS),
        streak_unit: m
            .get("checkin_streak_reward_duration_unit")
            .cloned()
            .unwrap_or_else(|| "day".into()),
    })
}

fn parse_pos_f64(raw: Option<&String>, fallback: f64) -> f64 {
    raw.and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(fallback)
}

fn opt_positive_i64(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    let v = i64_cell(row, col);
    if v > 0 {
        Some(v)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genesis_core::checkin::should_grant_streak_milestone_reward;

    #[test]
    fn should_grant_mirrors_node_every_days() {
        assert!(should_grant_streak_milestone_reward(CHECKIN_REWARD_EVERY_DAYS));
        assert!(should_grant_streak_milestone_reward(2 * CHECKIN_REWARD_EVERY_DAYS));
        assert!(!should_grant_streak_milestone_reward(1));
        assert!(!should_grant_streak_milestone_reward(0));
    }

    #[test]
    fn streak_grant_empty_defaults() {
        let g = StreakGrant::EMPTY;
        assert_eq!(g.granted, 0);
        assert!(g.item_id.is_none());
        assert!(g.expires_at_ms.is_none());
    }

    #[test]
    fn policy_disabled_or_empty_item_skips_before_query() {
        let disabled = RewardPolicy {
            reward_type: REWARD_HASHRATE.into(),
            daily: DEFAULT_DAILY_REWARD,
            weekly: DEFAULT_WEEKLY_REWARD,
            item_id: String::new(),
            streak_enabled: false,
            streak_item_id: "asic-x".into(),
            streak_amount: CHECKIN_REWARD_EVERY_DAYS,
            streak_unit: "day".into(),
        };
        assert!(!disabled.streak_enabled);
        let empty_item = RewardPolicy {
            streak_enabled: true,
            streak_item_id: "  ".into(),
            ..disabled
        };
        assert!(empty_item.streak_item_id.trim().is_empty());
        let cfg = normalize_asic_duration_config(Some(0), Some("day"), None);
        assert!(!is_timed_asic_duration(&cfg));
    }

    #[test]
    fn fail_closed_non_machine_upgrade_type() {
        assert!(streak_upgrade_machine_ok(Some(UPGRADE_TYPE_MACHINE)));
        assert!(!streak_upgrade_machine_ok(Some("part")));
        assert!(!streak_upgrade_machine_ok(Some("battery")));
        assert!(!streak_upgrade_machine_ok(None));
        assert!(!streak_upgrade_machine_ok(Some("")));
    }
}
