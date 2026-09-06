//! `POST /v1/dashboard/state` — Node `buildDashboardStatePayload`.

use std::path::{Path, PathBuf};

use deadpool_postgres::Pool;
use genesis_core::calculator::nft::resolve_mining_coin_usd_rate;
use genesis_core::calculator::types::MiningCoinInput;
use genesis_core::ranking::{sum_general_ranking_power, RANK_HASH_ROUND_FACTOR};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::warn;

use crate::player_reads::header::run_header;
use crate::player_reads::{f64_cell, i32_cell, i64_cell, now_ms, pg_user_id, string_cell};
use crate::ranking::RankingService;

pub const DASHBOARD_STATE_PATH: &str = "/v1/dashboard/state";

/// Node `RANKING_TOP_LIMIT`.
const RANKING_TOP_LIMIT: usize = 10;
/// Node `NOTIFICATIONS_LIMIT`.
const NOTIFICATIONS_LIMIT: usize = 5;
/// Node `WALLET_TOKENS_LIMIT`.
const WALLET_TOKENS_LIMIT: usize = 5;
/// Node `NOTIFICATION_MESSAGE_MAX_CHARS`.
const NOTIFICATION_MESSAGE_MAX_CHARS: usize = 280;
/// Node `deps.ts` / genesis-api `DEFAULT_IMG_DIR`.
const DEFAULT_IMG_DIR: &str = "storage/media-seed";
const BLOCKMINER_REL: &str = "partner/blockminer.webp";
const BLOCKMINER_PUBLIC: &str = "/img/partner/blockminer.webp";

const _: () = assert!(RANKING_TOP_LIMIT == 10);
const _: () = assert!(NOTIFICATIONS_LIMIT == 5);
const _: () = assert!(WALLET_TOKENS_LIMIT == 5);
const _: () = assert!(NOTIFICATION_MESSAGE_MAX_CHARS == 280);
const _: () = assert!(RANK_HASH_ROUND_FACTOR as i64 == 100);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStateRequest {
    pub user_id: i64,
}

#[derive(Debug)]
pub struct DashboardError {
    pub http_status: u16,
    pub body: Value,
}

impl DashboardError {
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            http_status: 500,
            body: json!({ "error": msg.into() }),
        }
    }
}

pub async fn run_dashboard_state(
    pool: &Pool,
    ranking: &RankingService,
    user_id: i64,
) -> Result<Value, DashboardError> {
    let uid = pg_user_id(user_id).map_err(|e| DashboardError::internal(e.error))?;
    let conn = pool
        .get()
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;

    let u = conn
        .query_opt(
            "SELECT username, access_level_id::text AS access_level_id FROM users WHERE id = $1",
            &[&uid],
        )
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;
    let my_username = u.as_ref().and_then(|r| {
        let s = string_cell(r, "username");
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    });
    let access_level_id = u.as_ref().and_then(|r| {
        let s = string_cell(r, "access_level_id");
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    });
    drop(conn);

    let header = run_header(pool, user_id)
        .await
        .map_err(|e| DashboardError::internal(e.error))?;
    let total_hash = header
        .get("totalHash")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let hash_by = header
        .get("hashByCoinId")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let (wallet, miner, notifications, ranking_payload, ecosystem) = tokio::join!(
        build_wallet_summary(pool, uid),
        build_miner_state(pool, uid, total_hash, &hash_by, access_level_id.as_deref()),
        build_notifications(pool, uid),
        build_ranking(ranking, user_id, my_username.as_deref()),
        ecosystem_modules(),
    );

    Ok(json!({
        "ok": true,
        "serverTime": now_ms(),
        "miner": miner?,
        "wallet": wallet?,
        "ecosystemModules": ecosystem,
        "notifications": notifications?,
        "events": Value::Array(vec![]),
        "ranking": ranking_payload?,
        "quickAccess": quick_access(),
    }))
}

async fn build_wallet_summary(pool: &Pool, uid: i32) -> Result<Value, DashboardError> {
    let conn = pool
        .get()
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;
    let gs = conn
        .query_opt(
            "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;
    let usdc = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);
    let coins = conn
        .query(
            "SELECT c.id, c.name, c.symbol, c.usdc_rate::double precision AS usdc_rate,
                    c.price_usd::double precision AS price_usd,
                    COALESCE(b.amount, 0)::double precision AS amount
               FROM mining_coins c
               LEFT JOIN coin_balances b ON b.coin_id = c.id AND b.user_id = $1
              WHERE c.is_active = 1",
            &[&uid],
        )
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;

    let mut tokens: Vec<(f64, Value)> = Vec::new();
    for r in &coins {
        let amount = f64_cell(r, "amount");
        if !(amount > 0.0) {
            continue;
        }
        let id = string_cell(r, "id");
        let symbol = string_cell(r, "symbol");
        let name = string_cell(r, "name");
        let rate = resolve_mining_coin_usd_rate(&MiningCoinInput {
            id: id.clone(),
            symbol: symbol.clone(),
            name: name.clone(),
            network_hashrate: 0.0,
            block_reward: 0.0,
            block_time: 0.0,
            price_usd: f64_cell(r, "price_usd"),
            usdc_rate: f64_cell(r, "usdc_rate"),
            nft_room_only: false,
        });
        let sort_key = amount * rate;
        tokens.push((
            sort_key,
            json!({
                "coinId": id,
                "symbol": if symbol.is_empty() { name.clone() } else { symbol },
                "name": if name.is_empty() { string_cell(r, "symbol") } else { name },
                "amount": amount,
                "usdcRate": rate,
            }),
        ));
    }
    tokens.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let tokens: Vec<Value> = tokens
        .into_iter()
        .take(WALLET_TOKENS_LIMIT)
        .map(|(_, v)| v)
        .collect();

    Ok(json!({ "usdc": usdc, "tokens": tokens }))
}

async fn build_miner_state(
    pool: &Pool,
    uid: i32,
    hash_total: f64,
    hash_by_coin_id: &Value,
    access_level_id: Option<&str>,
) -> Result<Value, DashboardError> {
    let conn = pool
        .get()
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;

    let mut level_label: Option<String> = None;
    if let Some(al) = access_level_id.filter(|s| !s.is_empty()) {
        match conn
            .query_opt("SELECT name FROM access_levels WHERE id = $1", &[&al])
            .await
        {
            Ok(Some(r)) => {
                let n = string_cell(&r, "name");
                if !n.is_empty() {
                    level_label = Some(n);
                }
            }
            Ok(None) => {}
            Err(e) => warn!(err = %e, "dashboard access_levels"),
        }
    }

    let mut rigs_online = 0i64;
    let mut rigs_total = 0i64;
    match conn
        .query(
            "SELECT is_on, battery_id FROM placed_racks WHERE user_id = $1",
            &[&uid],
        )
        .await
    {
        Ok(rows) => {
            rigs_total = rows.len() as i64;
            for r in &rows {
                let is_on = i32_cell(r, "is_on");
                let has_battery = match r.try_get::<_, Option<String>>("battery_id") {
                    Ok(Some(s)) if !s.trim().is_empty() => true,
                    Ok(Some(_)) | Ok(None) => false,
                    Err(_) => match r.try_get::<_, String>("battery_id") {
                        Ok(s) if !s.trim().is_empty() => true,
                        _ => false,
                    },
                };
                if is_on == 1 && has_battery {
                    rigs_online += 1;
                }
            }
        }
        Err(e) => warn!(err = %e, "dashboard placed_racks"),
    }

    let mut safe_hash = serde_json::Map::new();
    if let Some(obj) = hash_by_coin_id.as_object() {
        for (k, v) in obj {
            if k.is_empty() {
                continue;
            }
            let n = v.as_f64().unwrap_or(0.0);
            if n > 0.0 {
                safe_hash.insert(k.clone(), json!(n));
            }
        }
    }

    let status = if hash_total > 0.0 {
        "online"
    } else if rigs_total > 0 {
        "idle"
    } else {
        "offline"
    };

    Ok(json!({
        "status": status,
        "levelLabel": level_label,
        "accessLevelId": access_level_id,
        "hashTotal": hash_total,
        "hashByCoinId": Value::Object(safe_hash),
        "energyPercent": Value::Null,
        "energyChargeWh": Value::Null,
        "energyCapacityWh": Value::Null,
        "rigsOnline": rigs_online,
        "rigsTotal": rigs_total,
    }))
}

async fn build_notifications(pool: &Pool, uid: i32) -> Result<Value, DashboardError> {
    let conn = pool
        .get()
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;
    let mut out: Vec<Value> = Vec::new();

    match conn
        .query(
            "SELECT id, text, link, author_name, created_at
               FROM system_news
              WHERE active = 1
              ORDER BY created_at DESC
              LIMIT $1",
            &[&(NOTIFICATIONS_LIMIT as i64)],
        )
        .await
    {
        Ok(news) => {
            for n in &news {
                let author = string_cell(n, "author_name");
                let title = if author.is_empty() {
                    "Comunicado".to_string()
                } else {
                    author
                };
                let message = string_cell(n, "text");
                let message: String = message
                    .chars()
                    .take(NOTIFICATION_MESSAGE_MAX_CHARS)
                    .collect();
                let link = match n.try_get::<_, Option<String>>("link") {
                    Ok(Some(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                    _ => None,
                };
                let created = i64_cell(n, "created_at");
                out.push(json!({
                    "id": format!("news_{}", string_cell(n, "id")),
                    "type": "system",
                    "title": title,
                    "message": message,
                    "link": link,
                    "createdAt": if created > 0 { created } else { now_ms() },
                    "read": false,
                }));
            }
        }
        Err(e) => warn!(err = %e, "dashboard system_news"),
    }

    match conn
        .query_opt(
            "SELECT COALESCE(SUM(qty), 0)::bigint AS total FROM unopened_boxes WHERE user_id = $1",
            &[&uid],
        )
        .await
    {
        Ok(Some(r)) => {
            let total = i64_cell(&r, "total");
            if total > 0 {
                let message = if total == 1 {
                    "Você tem 1 caixa pronta para abrir em \"Caixas da Sorte\".".to_string()
                } else {
                    format!("Você tem {total} caixas prontas para abrir em \"Caixas da Sorte\".")
                };
                out.insert(
                    0,
                    json!({
                        "id": "unopened_boxes",
                        "type": "reward",
                        "title": "Caixas disponíveis",
                        "message": message,
                        "link": "lucky_store",
                        "createdAt": now_ms(),
                        "read": false,
                    }),
                );
            }
        }
        Ok(None) => {}
        Err(e) => warn!(err = %e, "dashboard unopened_boxes"),
    }

    out.truncate(NOTIFICATIONS_LIMIT);
    Ok(Value::Array(out))
}

async fn build_ranking(
    ranking: &RankingService,
    user_id: i64,
    my_username: Option<&str>,
) -> Result<Value, DashboardError> {
    let payload = ranking
        .get_public(false)
        .await
        .map_err(|e| DashboardError::internal(e.to_string()))?;

    let mut all: Vec<(i64, String, f64)> = payload
        .ranking
        .iter()
        .map(|r| {
            let total = sum_general_ranking_power(&r.general_coins);
            (r.user_id, r.username.clone(), total)
        })
        .filter(|(_, _, t)| *t > 0.0)
        .collect();
    all.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let round_hash = |t: f64| (t * RANK_HASH_ROUND_FACTOR).round() / RANK_HASH_ROUND_FACTOR;

    let mut top: Vec<Value> = all
        .iter()
        .take(RANKING_TOP_LIMIT)
        .enumerate()
        .map(|(idx, (uid, username, total))| {
            json!({
                "position": idx + 1,
                "username": username,
                "hash": round_hash(*total),
                "hashUnit": "H/s",
                "isMe": *uid == user_id,
            })
        })
        .collect();

    let mut my_position: Option<usize> = None;
    let mut my_hash = 0.0;
    if let Some(me_idx) = all.iter().position(|(uid, _, _)| *uid == user_id) {
        my_position = Some(me_idx + 1);
        my_hash = round_hash(all[me_idx].2);
    }

    let has_me = top.iter().any(|t| t.get("isMe") == Some(&json!(true)));
    if let (Some(pos), Some(uname)) = (my_position, my_username) {
        if !has_me {
            let me_entry = json!({
                "position": pos,
                "username": uname,
                "hash": my_hash,
                "hashUnit": "H/s",
                "isMe": true,
            });
            if top.is_empty() || top.len() < RANKING_TOP_LIMIT {
                top.push(me_entry);
            } else if let Some(last) = top.last_mut() {
                *last = me_entry;
            }
        }
    }

    Ok(json!({
        "top": top,
        "myPosition": my_position,
        "myHash": my_hash,
    }))
}

fn resolve_img_dir() -> PathBuf {
    std::env::var("IMG_DIR")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_IMG_DIR.to_string())
        .into()
}

async fn blockminer_image_url() -> String {
    let img_dir = resolve_img_dir();
    let abs = if img_dir.is_absolute() {
        img_dir.join(BLOCKMINER_REL)
    } else {
        Path::new(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
            .join(&img_dir)
            .join(BLOCKMINER_REL)
    };
    match tokio::fs::metadata(&abs).await {
        Ok(meta) => {
            let v = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            format!("{BLOCKMINER_PUBLIC}?v={v}")
        }
        Err(_) => BLOCKMINER_PUBLIC.to_string(),
    }
}

async fn ecosystem_modules() -> Value {
    let blockminer_url = blockminer_image_url().await;
    json!([
        {
            "id": "workerrealm",
            "title": "WorkerRealm",
            "subtitle": "Dungeons",
            "imageUrl": Value::Null,
            "href": "https://workerrealm.com",
            "external": true,
            "status": "coming_soon"
        },
        {
            "id": "blockminer",
            "title": "BlockMiner",
            "subtitle": "Faucets & Tasks",
            "imageUrl": blockminer_url,
            "href": "https://blockminer.space",
            "external": true,
            "status": "available"
        },
        {
            "id": "minecore",
            "title": "MineCore",
            "subtitle": "Fazendinha & Miner",
            "imageUrl": Value::Null,
            "href": "https://minecore.app",
            "external": true,
            "status": "coming_soon"
        },
        {
            "id": "masterleague",
            "title": "Master League",
            "subtitle": "Futebol Miner",
            "imageUrl": Value::Null,
            "href": "https://masterleague.app",
            "external": true,
            "status": "coming_soon"
        },
        {
            "id": "reworth",
            "title": "Reworth Games",
            "subtitle": "Survivor P2E",
            "imageUrl": Value::Null,
            "href": "https://reworthgames.com",
            "external": true,
            "status": "coming_soon"
        }
    ])
}

fn quick_access() -> Value {
    json!([
        { "id": "miner-shop", "title": "Lojinha Miner", "viewId": "hardware_store", "href": "/miner-shop", "icon": "shop" },
        { "id": "black-market", "title": "Mercado Negro", "viewId": "black_market", "href": "/black-market", "icon": "mask" },
        { "id": "lucky-boxes", "title": "Caixas da Sorte", "viewId": "lucky_store", "href": "/lucky-boxes", "icon": "gift" },
        { "id": "wheel", "title": "Roleta", "viewId": "roleta", "href": "/wheel", "icon": "compass" },
        { "id": "upgrades", "title": "Upgrades", "viewId": "upgrade", "href": "/upgrades", "icon": "rocket" },
        { "id": "transparency", "title": "Transparência", "viewId": "transparency", "href": "/transparency", "icon": "eye" },
        { "id": "wallet", "title": "Carteira", "viewId": "wallet", "href": "/wallet", "icon": "wallet" }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matches_contract() {
        assert_eq!(DASHBOARD_STATE_PATH, "/v1/dashboard/state");
    }
}
