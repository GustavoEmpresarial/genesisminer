//! Quests state — Node `getQuestsState` (seed + read; premium write-on-read included).

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::checkin::{
    is_premium_within_active_window, next_checkin_period_end_ms, utc_checkin_period_start_ms,
    utc_day_from_ms,
};
use genesis_core::time::MS_PER_DAY;
use genesis_core::utc_week_start_ms;
use serde_json::{json, Value};

use crate::support::LOCK_TIMEOUT_MS;

use super::{f64_cell, i32_cell, i64_cell, pg_user_id, string_cell, PlayerReadError};

/// Node `PREMIUM_CHECKIN_MIN_PROGRESS`.
const PREMIUM_CHECKIN_MIN_PROGRESS: i32 = 1;
const DAILY_CHECKIN_QUEST_ID: &str = "daily_checkin";
const DAYS_PER_WEEK: i64 = 7;
const ISO_DATE_LENGTH: usize = 10;

const _: () = assert!(PREMIUM_CHECKIN_MIN_PROGRESS == 1);
const _: () = assert!(DAYS_PER_WEEK == 7);
const _: () = assert!(ISO_DATE_LENGTH == 10);

struct Def {
    id: String,
    period: String,
    action_type: String,
    title: String,
    description: String,
    target_count: i32,
    reward_usdc: f64,
    sort_order: i32,
}

pub async fn run_quests_state(
    pool: &Pool,
    user_id: i64,
    now_ms: i64,
) -> Result<Value, PlayerReadError> {
    let mut conn = pool.get().await?;
    ensure_quest_schema(&conn, now_ms).await?;
    ensure_premium_credit(&mut conn, user_id, now_ms).await?;
    let defs = list_enabled(&conn).await?;
    let daily_start = utc_checkin_period_start_ms(now_ms);
    let daily_key = format!("d:{}", utc_day_from_ms(daily_start));
    let daily_end = next_checkin_period_end_ms(daily_start);
    let weekly_start = utc_week_start_ms(now_ms);
    let weekly_ymd = utc_day_from_ms(weekly_start);
    let weekly_key = format!(
        "w:{}",
        weekly_ymd.chars().take(ISO_DATE_LENGTH).collect::<String>()
    );
    let weekly_end = weekly_start + DAYS_PER_WEEK * MS_PER_DAY as i64;
    let uid = pg_user_id(user_id)?;
    let keys = vec![daily_key.clone(), weekly_key.clone()];
    let progress = conn
        .query(
            "SELECT quest_id, period_key, progress, completed_at, claimed_at
               FROM user_quest_progress
              WHERE user_id = $1 AND period_key = ANY($2::text[])",
            &[&uid, &keys],
        )
        .await?;
    let mut map = std::collections::HashMap::new();
    for r in &progress {
        map.insert(
            format!(
                "{}|{}",
                string_cell(r, "quest_id"),
                string_cell(r, "period_key")
            ),
            (
                i32_cell(r, "progress").max(0),
                opt_i64_pos(r, "completed_at"),
                opt_i64_pos(r, "claimed_at"),
            ),
        );
    }
    let mut daily = Vec::new();
    let mut weekly = Vec::new();
    for d in defs {
        let pk = if d.period == "daily" {
            daily_key.clone()
        } else {
            weekly_key.clone()
        };
        let p = map.get(&format!("{}|{}", d.id, pk));
        let progress_n = p.map(|x| x.0.min(d.target_count)).unwrap_or(0);
        let completed = progress_n >= d.target_count || p.and_then(|x| x.1).is_some();
        let claimed = p.and_then(|x| x.2).is_some();
        let item = json!({
            "id": d.id,
            "period": d.period,
            "actionType": d.action_type,
            "title": d.title,
            "description": d.description,
            "targetCount": d.target_count,
            "rewardUsdc": d.reward_usdc,
            "sortOrder": d.sort_order,
            "periodKey": pk,
            "progress": progress_n,
            "completed": completed,
            "claimed": claimed,
            "canClaim": completed && !claimed && d.reward_usdc > 0.0,
        });
        if d.period == "daily" {
            daily.push(item);
        } else {
            weekly.push(item);
        }
    }
    Ok(json!({
        "daily": daily,
        "weekly": weekly,
        "dailyPeriodKey": daily_key,
        "weeklyPeriodKey": weekly_key,
        "dailyPeriod": { "key": daily_key, "startMs": daily_start, "endMs": daily_end },
        "weeklyPeriod": { "key": weekly_key, "startMs": weekly_start, "endMs": weekly_end },
    }))
}

async fn ensure_quest_schema<C: GenericClient>(
    client: &C,
    now_ms: i64,
) -> Result<(), PlayerReadError> {
    for q in default_defs() {
        client
            .execute(
                "INSERT INTO quest_definitions (
                    id, period, action_type, title, description, target_count, reward_usdc, sort_order, enabled, updated_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)
                 ON CONFLICT (id) DO NOTHING",
                &[
                    &q.id,
                    &q.period,
                    &q.action_type,
                    &q.title,
                    &q.description,
                    &q.target_count,
                    &q.reward_usdc,
                    &q.sort_order,
                    &now_ms,
                ],
            )
            .await?;
        if q.action_type == "checkin" {
            client
                .execute(
                    "UPDATE quest_definitions SET description = $2, updated_at = $3
                      WHERE id = $1 AND description IS DISTINCT FROM $2",
                    &[&q.id, &q.description, &now_ms],
                )
                .await?;
        }
    }
    Ok(())
}

async fn ensure_premium_credit(
    conn: &mut deadpool_postgres::Object,
    user_id: i64,
    now_ms: i64,
) -> Result<(), PlayerReadError> {
    let Ok(uid) = pg_user_id(user_id) else {
        return Ok(());
    };
    let gs = conn
        .query_opt(
            "SELECT last_checkin_at_ms FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(gs) = gs else {
        return Ok(());
    };
    let last_at = {
        let v = i64_cell(&gs, "last_checkin_at_ms");
        if v > 0 {
            Some(v)
        } else {
            None
        }
    };
    let Some(last_at) = last_at else {
        return Ok(());
    };
    let setting_keys = vec![
        "checkin_premium_enabled".to_string(),
        "checkin_premium_min_usdc".to_string(),
        "checkin_premium_interval_days".to_string(),
    ];
    let srows = conn
        .query(
            "SELECT key, value FROM settings WHERE key = ANY($1)",
            &[&setting_keys],
        )
        .await?;
    let mut enabled = true;
    let mut min_usdc = genesis_core::checkin::DEFAULT_CHECKIN_PREMIUM_MIN_USDC;
    let mut interval_days = genesis_core::checkin::DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS;
    for r in &srows {
        match string_cell(r, "key").as_str() {
            "checkin_premium_enabled" => {
                let v = string_cell(r, "value");
                if !v.is_empty() {
                    enabled = v == "1";
                }
            }
            "checkin_premium_min_usdc" => {
                if let Ok(n) = string_cell(r, "value").parse::<f64>() {
                    if n.is_finite() && n >= 0.0 {
                        min_usdc = n;
                    }
                }
            }
            "checkin_premium_interval_days" => {
                if let Ok(n) = string_cell(r, "value").parse::<i32>() {
                    if n >= 1 {
                        interval_days = n;
                    }
                }
            }
            _ => {}
        }
    }
    if !enabled {
        return Ok(());
    }
    let eligible = conn
        .query_opt(
            "SELECT 1 FROM admin_upgrade_purchases p
              INNER JOIN admin_upgrades u ON u.id = p.upgrade_id
             WHERE p.user_id = $1 AND u.price_usdc >= $2 LIMIT 1",
            &[&uid, &min_usdc],
        )
        .await?
        .is_some();
    if !eligible || !is_premium_within_active_window(Some(last_at), now_ms, interval_days) {
        return Ok(());
    }
    let daily_key = format!("d:{}", utc_day_from_ms(utc_checkin_period_start_ms(now_ms)));
    let tx = conn.transaction().await?;
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await?;
    tx.execute(
        "INSERT INTO user_quest_progress (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
         VALUES ($1, $2, $3, 0, NULL, NULL, $4)
         ON CONFLICT (user_id, quest_id, period_key) DO NOTHING",
        &[&uid, &DAILY_CHECKIN_QUEST_ID, &daily_key, &now_ms],
    )
    .await?;
    let gate = tx
        .query_opt(
            "SELECT progress FROM user_quest_progress
              WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE",
            &[&uid, &DAILY_CHECKIN_QUEST_ID, &daily_key],
        )
        .await?;
    let already = gate.map(|r| i32_cell(&r, "progress")).unwrap_or(0);
    if already >= PREMIUM_CHECKIN_MIN_PROGRESS {
        tx.rollback().await?;
        return Ok(());
    }
    bump_checkin_progress(&tx, uid, now_ms).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn bump_checkin_progress<C: GenericClient>(
    client: &C,
    uid: i32,
    now_ms: i64,
) -> Result<(), PlayerReadError> {
    bump_quest_action(client, uid, now_ms, "checkin", 1).await
}

/// Advance every enabled quest with `action_type == action` (daily + weekly) by
/// `delta`, capped at `target_count`, setting `completed_at` on completion.
/// Mirrors Node `bumpQuestProgress(userId, action, delta)`.
pub(crate) async fn bump_quest_action<C: GenericClient>(
    client: &C,
    uid: i32,
    now_ms: i64,
    action: &str,
    delta: i32,
) -> Result<(), PlayerReadError> {
    if delta <= 0 {
        return Ok(());
    }
    let defs = list_enabled(client).await?;
    let matched: Vec<_> = defs
        .into_iter()
        .filter(|d| d.action_type == action)
        .collect();
    let daily_key = format!("d:{}", utc_day_from_ms(utc_checkin_period_start_ms(now_ms)));
    let weekly_start = utc_week_start_ms(now_ms);
    let weekly_key = format!(
        "w:{}",
        utc_day_from_ms(weekly_start)
            .chars()
            .take(ISO_DATE_LENGTH)
            .collect::<String>()
    );
    for d in matched {
        let pk = if d.period == "daily" {
            daily_key.clone()
        } else {
            weekly_key.clone()
        };
        client
            .execute(
                "INSERT INTO user_quest_progress (user_id, quest_id, period_key, progress, completed_at, claimed_at, updated_at)
                 VALUES ($1, $2, $3, 0, NULL, NULL, $4)
                 ON CONFLICT (user_id, quest_id, period_key) DO NOTHING",
                &[&uid, &d.id, &pk, &now_ms],
            )
            .await?;
        let row = client
            .query_opt(
                "SELECT progress, completed_at, claimed_at FROM user_quest_progress
                  WHERE user_id = $1 AND quest_id = $2 AND period_key = $3 FOR UPDATE",
                &[&uid, &d.id, &pk],
            )
            .await?;
        let Some(row) = row else {
            continue;
        };
        if opt_i64_pos(&row, "claimed_at").is_some() {
            continue;
        }
        let cur = i32_cell(&row, "progress").max(0);
        let next = cur.saturating_add(delta).min(d.target_count);
        let completed_at = if next >= d.target_count {
            Some(opt_i64_pos(&row, "completed_at").unwrap_or(now_ms))
        } else {
            None
        };
        client
            .execute(
                "UPDATE user_quest_progress SET progress = $4, completed_at = $5, updated_at = $6
                  WHERE user_id = $1 AND quest_id = $2 AND period_key = $3",
                &[&uid, &d.id, &pk, &next, &completed_at, &now_ms],
            )
            .await?;
    }
    Ok(())
}

async fn list_enabled<C: GenericClient>(client: &C) -> Result<Vec<Def>, PlayerReadError> {
    let rows = client
        .query(
            "SELECT id, period, action_type, title, description, target_count,
                    reward_usdc::double precision AS reward_usdc, sort_order
               FROM quest_definitions WHERE enabled = 1
              ORDER BY sort_order ASC, id ASC",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| Def {
            id: string_cell(r, "id"),
            period: string_cell(r, "period"),
            action_type: string_cell(r, "action_type"),
            title: string_cell(r, "title"),
            description: string_cell(r, "description"),
            target_count: i32_cell(r, "target_count"),
            reward_usdc: f64_cell(r, "reward_usdc"),
            sort_order: i32_cell(r, "sort_order"),
        })
        .collect())
}

fn default_defs() -> Vec<Def> {
    vec![
        Def {
            id: "daily_checkin".into(),
            period: "daily".into(),
            action_type: "checkin".into(),
            title: "Check-in diário".into(),
            description: "Faz o check-in do dia (ciclo 00:00 UTC). Com passe premium, conta automaticamente em cada dia da janela activa.".into(),
            target_count: 1,
            reward_usdc: 0.05,
            sort_order: 10,
        },
        Def {
            id: "daily_merge".into(),
            period: "daily".into(),
            action_type: "merge".into(),
            title: "Forge 1 merge".into(),
            description: "Completa 1 merge na Merge Station.".into(),
            target_count: 1,
            reward_usdc: 0.1,
            sort_order: 20,
        },
        Def {
            id: "daily_offerwall".into(),
            period: "daily".into(),
            action_type: "offerwall".into(),
            title: "Offerwall do dia".into(),
            description: "Recebe 1 crédito do Offerwall (ZERads).".into(),
            target_count: 1,
            reward_usdc: 0.15,
            sort_order: 30,
        },
        Def {
            id: "weekly_checkin".into(),
            period: "weekly".into(),
            action_type: "checkin".into(),
            title: "Check-in da semana".into(),
            description: "Faz check-in em 5 dias diferentes nesta semana. Com passe premium, cada dia da janela activa conta 1.".into(),
            target_count: 5,
            reward_usdc: 0.5,
            sort_order: 110,
        },
        Def {
            id: "weekly_merge".into(),
            period: "weekly".into(),
            action_type: "merge".into(),
            title: "Forge da semana".into(),
            description: "Completa 10 merges na Merge Station.".into(),
            target_count: 10,
            reward_usdc: 1.0,
            sort_order: 120,
        },
        Def {
            id: "weekly_offerwall".into(),
            period: "weekly".into(),
            action_type: "offerwall".into(),
            title: "Offerwall da semana".into(),
            description: "Recebe 5 créditos do Offerwall nesta semana.".into(),
            target_count: 5,
            reward_usdc: 1.0,
            sort_order: 130,
        },
    ]
}

fn opt_i64_pos(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    let v = i64_cell(row, col);
    if v > 0 {
        Some(v)
    } else {
        None
    }
}
