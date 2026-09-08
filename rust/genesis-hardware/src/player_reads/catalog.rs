//! Catalog GETs — Node `GET /api/{upgrades,mining-coins,access-levels,loot-boxes}`.

use deadpool_postgres::{GenericClient, Pool};
use genesis_core::catalog::TEMP_LEGACY_ID_PREFIX;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{f64_cell, i32_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError};

/// Node `DEFAULT_NETWORK_HASHRATE`.
const DEFAULT_NETWORK_HASHRATE: f64 = 100.0;
/// Node `RARITY_DEFAULT`.
const RARITY_DEFAULT: &str = "common";
/// Node `UPGRADES_CATALOG_META_ID`.
const UPGRADES_CATALOG_META_ID: i32 = 1;
const CAT_LEGACY_TEMP: &str = "legacy-temp";
const STATUS_LEGACY: &str = "legacy";
const STATUS_EXCLUSIVE: &str = "exclusive";
const STATUS_RETIRED: &str = "retired";
const ASIC_DURATION_NONE: &str = "none";

const _: () = assert!(DEFAULT_NETWORK_HASHRATE as i64 == 100);
const _: () = assert!(UPGRADES_CATALOG_META_ID == 1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogUserRequest {
    #[serde(default)]
    pub user_id: Option<i64>,
}

pub async fn run_catalog_upgrades(
    pool: &Pool,
    user_id: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    run_catalog_upgrades_on_client(&conn, user_id).await
}

pub async fn run_catalog_upgrades_on_client<C: GenericClient>(
    client: &C,
    user_id: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let is_admin = match user_id {
        Some(uid) if uid > 0 => {
            let row = client
                .query_opt(
                    "SELECT is_admin FROM users WHERE id = $1",
                    &[&crate::pg_types::pg_user_id(uid)?],
                )
                .await?;
            row.map(|r| i32_cell(&r, "is_admin") != 0).unwrap_or(false)
        }
        _ => false,
    };
    let upgrades = load_upgrades_for_bootstrap(client, is_admin).await?;
    let revision = read_upgrades_catalog_revision(client).await?;
    Ok(json!({ "catalogRevision": revision, "upgrades": upgrades }))
}

pub async fn run_catalog_mining_coins(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, name, symbol, description, color, algorithm,
                    multiplier::double precision AS multiplier,
                    difficulty::double precision AS difficulty,
                    min_proportion::double precision AS min_proportion,
                    usdc_rate::double precision AS usdc_rate,
                    is_active, network_hashrate::double precision AS network_hashrate,
                    block_reward::double precision AS block_reward,
                    block_time::double precision AS block_time,
                    price_usd::double precision AS price_usd,
                    target_daily_usd::double precision AS target_daily_usd,
                    distribution_mode,
                    distribution_usd_month::double precision AS distribution_usd_month,
                    is_internal,
                    show_in_exchange, nft_room_only
               FROM mining_coins ORDER BY name ASC",
            &[],
        )
        .await?;
    let coins: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut used_rate = f64_cell(r, "network_hashrate");
            if !used_rate.is_finite() || used_rate == 0.0 {
                used_rate = DEFAULT_NETWORK_HASHRATE;
            }
            let distribution_mode =
                if opt_string_cell(r, "distribution_mode").as_deref() == Some("usd_month") {
                    "usd_month"
                } else {
                    "legacy"
                };
            json!({
                "id": string_cell(r, "id"),
                "name": string_cell(r, "name"),
                "symbol": string_cell(r, "symbol"),
                "description": string_cell(r, "description"),
                "color": opt_string_cell(r, "color"),
                "algorithm": opt_string_cell(r, "algorithm"),
                "multiplier": f64_cell(r, "multiplier"),
                "difficulty": f64_cell(r, "difficulty"),
                "minProportion": f64_cell(r, "min_proportion"),
                "usdcRate": f64_cell(r, "usdc_rate"),
                "isActive": i32_cell(r, "is_active") != 0,
                "networkHashrate": used_rate,
                "blockReward": f64_cell(r, "block_reward"),
                "blockTime": f64_cell(r, "block_time"),
                "priceUSD": f64_cell(r, "price_usd"),
                "targetDailyUSD": f64_cell(r, "target_daily_usd"),
                "distributionMode": distribution_mode,
                "distributionUsdMonth": f64_cell(r, "distribution_usd_month"),
                "isInternal": i32_cell(r, "is_internal") == 1,
                "showInExchange": i32_cell(r, "show_in_exchange") != 0,
                "nftRoomOnly": i32_cell(r, "nft_room_only") == 1,
            })
        })
        .collect();
    Ok(json!(coins))
}

pub async fn run_catalog_access_levels(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, name, description, is_default, is_active,
                    price_usdc::double precision AS price_usdc,
                    contract_address, inactive_message, news_posting_enabled, allowed_pages
               FROM access_levels",
            &[],
        )
        .await?;
    let levels: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut obj = serde_json::Map::new();
            obj.insert("id".into(), json!(string_cell(r, "id")));
            obj.insert("name".into(), json!(string_cell(r, "name")));
            obj.insert("description".into(), json!(string_cell(r, "description")));
            obj.insert("isDefault".into(), json!(i32_cell(r, "is_default") != 0));
            obj.insert("isActive".into(), json!(i32_cell(r, "is_active") != 0));
            let price = r.try_get::<_, Option<f64>>("price_usdc").ok().flatten();
            if let Some(p) = price.filter(|v| v.is_finite()) {
                obj.insert("priceUsdc".into(), json!(p));
            }
            if let Some(c) = opt_string_cell(r, "contract_address") {
                obj.insert("contractAddress".into(), json!(c));
            }
            if let Some(m) = opt_string_cell(r, "inactive_message") {
                obj.insert("inactiveMessage".into(), json!(m));
            }
            obj.insert(
                "newsPostingEnabled".into(),
                json!(i32_cell(r, "news_posting_enabled") != 0),
            );
            obj.insert(
                "allowedPages".into(),
                json!(parse_allowed_pages(opt_string_cell(r, "allowed_pages"))),
            );
            Value::Object(obj)
        })
        .collect();
    Ok(json!(levels))
}

pub async fn run_catalog_loot_boxes(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let boxes = conn
        .query(
            "SELECT id, name, description, price::double precision AS price, trigger, icon, is_active
               FROM loot_boxes
              ORDER BY is_active DESC, trigger ASC, name ASC, id ASC",
            &[],
        )
        .await?;
    let box_ids: Vec<String> = boxes.iter().map(|r| string_cell(r, "id")).collect();
    let item_rows = if box_ids.is_empty() {
        Vec::new()
    } else {
        conn.query(
            "SELECT box_id, item_id, item_type, min_qty, max_qty, probability::double precision AS probability
               FROM loot_box_items WHERE box_id = ANY($1::text[])",
            &[&box_ids],
        )
        .await?
    };
    let mut item_map: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for it in &item_rows {
        item_map
            .entry(string_cell(it, "box_id"))
            .or_default()
            .push(json!({
                "id": string_cell(it, "item_id"),
                "type": string_cell(it, "item_type"),
                "minQty": i32_cell(it, "min_qty"),
                "maxQty": i32_cell(it, "max_qty"),
                "probability": f64_cell(it, "probability"),
            }));
    }
    let out: Vec<Value> = boxes
        .iter()
        .map(|b| {
            let id = string_cell(b, "id");
            let is_active = opt_i32_cell(b, "is_active");
            json!({
                "id": id,
                "name": string_cell(b, "name"),
                "description": string_cell(b, "description"),
                "price": f64_cell(b, "price"),
                "trigger": string_cell(b, "trigger"),
                "icon": opt_string_cell(b, "icon"),
                "isActive": is_active.is_none() || is_active != Some(0),
                "items": item_map.get(&string_cell(b, "id")).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Ok(json!(out))
}

async fn load_upgrades_for_bootstrap<C: GenericClient>(
    client: &C,
    is_admin: bool,
) -> Result<Vec<Value>, PlayerReadError> {
    let rows = if is_admin {
        client
            .query(
                "SELECT id, name, category, type,
                        base_cost::double precision AS base_cost,
                        base_production::double precision AS base_production,
                        power_consumption::double precision AS power_consumption,
                        power_capacity::double precision AS power_capacity,
                        multiplier::double precision AS multiplier,
                        slots_capacity::double precision AS slots_capacity,
                        ai_slots_capacity::double precision AS ai_slots_capacity,
                        description, icon, status, is_nft, nft_contract, nft_token_id,
                        max_global_stock, total_sold, image, layout,
                        reward_wh::double precision AS reward_wh,
                        sell_in_hardware_market, sell_in_black_market, is_active,
                        nft_mining_coin_id, asic_duration_kind, asic_duration_amount, asic_duration_unit,
                        rarity, rack_room_affinity
                   FROM upgrades
                  WHERE id NOT LIKE $1 AND category <> $2 AND type <> $2",
                &[&format!("{TEMP_LEGACY_ID_PREFIX}%"), &CAT_LEGACY_TEMP],
            )
            .await?
    } else {
        client
            .query(
                "SELECT id, name, category, type,
                        base_cost::double precision AS base_cost,
                        base_production::double precision AS base_production,
                        power_consumption::double precision AS power_consumption,
                        power_capacity::double precision AS power_capacity,
                        multiplier::double precision AS multiplier,
                        slots_capacity::double precision AS slots_capacity,
                        ai_slots_capacity::double precision AS ai_slots_capacity,
                        description, icon, status, is_nft, nft_contract, nft_token_id,
                        max_global_stock, total_sold, image, layout,
                        reward_wh::double precision AS reward_wh,
                        sell_in_hardware_market, sell_in_black_market, is_active,
                        nft_mining_coin_id, asic_duration_kind, asic_duration_amount, asic_duration_unit,
                        rarity, rack_room_affinity
                   FROM upgrades
                  WHERE is_active = 1 AND COALESCE(status, '') NOT IN ($1, $2, $3)",
                &[&STATUS_LEGACY, &STATUS_EXCLUSIVE, &STATUS_RETIRED],
            )
            .await?
    };
    let compat = client
        .query("SELECT upgrade_id, rack_id FROM upgrade_compat_racks", &[])
        .await?;
    let mut compat_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &compat {
        compat_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push(string_cell(r, "rack_id"));
    }
    Ok(rows
        .iter()
        .map(|r| {
            map_upgrade_row_to_api(
                r,
                compat_map
                    .get(&string_cell(r, "id"))
                    .cloned()
                    .unwrap_or_default(),
            )
        })
        .collect())
}

fn map_upgrade_row_to_api(r: &tokio_postgres::Row, compatible_racks: Vec<String>) -> Value {
    let layout = opt_string_cell(r, "layout").and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let rarity = opt_string_cell(r, "rarity")
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RARITY_DEFAULT.to_string());
    let asic_kind = opt_string_cell(r, "asic_duration_kind")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ASIC_DURATION_NONE.to_string());
    json!({
        "id": string_cell(r, "id"),
        "name": string_cell(r, "name"),
        "category": string_cell(r, "category"),
        "type": string_cell(r, "type"),
        "baseCost": f64_cell(r, "base_cost"),
        "baseProduction": f64_cell(r, "base_production"),
        "powerConsumption": opt_f64(r, "power_consumption"),
        "powerCapacity": opt_f64(r, "power_capacity"),
        "multiplier": opt_f64(r, "multiplier"),
        "slotsCapacity": opt_f64(r, "slots_capacity"),
        "aiSlotsCapacity": opt_f64(r, "ai_slots_capacity"),
        "description": string_cell(r, "description"),
        "icon": string_cell(r, "icon"),
        "status": opt_string_cell(r, "status"),
        "isNft": i32_cell(r, "is_nft") != 0,
        "nftContract": opt_string_cell(r, "nft_contract"),
        "nftTokenId": opt_string_cell(r, "nft_token_id"),
        "maxGlobalStock": opt_i32_cell(r, "max_global_stock"),
        "totalSold": i32_cell(r, "total_sold"),
        "image": opt_string_cell(r, "image"),
        "layout": layout,
        "compatibleRacks": compatible_racks,
        "rewardWh": f64_cell(r, "reward_wh"),
        "sellInHardwareMarket": i32_cell(r, "sell_in_hardware_market") != 0,
        "sellInBlackMarket": i32_cell(r, "sell_in_black_market") != 0,
        "isActive": i32_cell(r, "is_active") != 0,
        "nftMiningCoinId": opt_string_cell(r, "nft_mining_coin_id"),
        "asicDurationKind": asic_kind,
        "asicDurationAmount": i32_cell(r, "asic_duration_amount").max(0),
        "asicDurationUnit": opt_string_cell(r, "asic_duration_unit"),
        "rarity": rarity,
        "rackRoomAffinity": opt_string_cell(r, "rack_room_affinity"),
    })
}

fn opt_f64(row: &tokio_postgres::Row, col: &str) -> Option<f64> {
    if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(col) {
        if v.is_finite() {
            return Some(v);
        }
    }
    if let Ok(v) = row.try_get::<_, f64>(col) {
        if v.is_finite() {
            return Some(v);
        }
    }
    None
}

fn parse_allowed_pages(raw: Option<String>) -> Vec<String> {
    let Some(s) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&s) {
        Ok(Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

async fn read_upgrades_catalog_revision<C: GenericClient>(
    client: &C,
) -> Result<i64, PlayerReadError> {
    client
        .execute(
            "INSERT INTO upgrades_catalog_meta (id, revision) VALUES ($1, 0) ON CONFLICT (id) DO NOTHING",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await?;
    let row = client
        .query_opt(
            "SELECT revision FROM upgrades_catalog_meta WHERE id = $1",
            &[&UPGRADES_CATALOG_META_ID],
        )
        .await?;
    Ok(row
        .map(|r| i64::from(i32_cell(&r, "revision")))
        .unwrap_or(0))
}
