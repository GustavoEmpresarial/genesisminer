//! `POST /api/mining-coins` twin — Node `upsertMiningCoins`.
//!
//! The admin panel posts either one coin or the whole list; every numeric field
//! goes through `parseFloat(String(x ?? ''))` plus a clamp, so the coercion is
//! kept explicit in [`plan_mining_coin_row`].

use deadpool_postgres::Pool;
use genesis_core::time::{SECONDS_PER_DAY, SECONDS_PER_MINUTE};
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;

use crate::player_reads::PlayerReadError;

use super::js;

/// Node `Math.max(1_000_000, ...)` on `networkHashrate`.
const MIN_NETWORK_HASHRATE: f64 = 1_000_000.0;
/// Node `Math.min(86400, Math.max(1, ...))` on `blockTime` — seconds.
const MIN_BLOCK_TIME_SECONDS: f64 = 1.0;
const MAX_BLOCK_TIME_SECONDS: f64 = SECONDS_PER_DAY as f64;
/// Node `blockTimeParsed > 0 ? blockTimeParsed : 60`.
const DEFAULT_BLOCK_TIME_SECONDS: f64 = SECONDS_PER_MINUTE as f64;
/// Node `Math.max(1, ...)` on `difficulty` / `multiplier`.
const MIN_DIFFICULTY: f64 = 1.0;
const MIN_MULTIPLIER: f64 = 1.0;
/// Node `Math.max(0, ...)` floor shared by the remaining numeric fields.
const NON_NEGATIVE_FLOOR: f64 = 0.0;

/// Node `String(c.name || 'Unknown')` and friends.
const DEFAULT_COIN_NAME: &str = "Unknown";
const DEFAULT_COIN_ALGORITHM: &str = "Unknown";
const DEFAULT_COIN_COLOR: &str = "#ffffff";

const _: () = assert!(SECONDS_PER_DAY == 86_400);
const _: () = assert!(SECONDS_PER_MINUTE == 60);

const UPSERT_SQL: &str = "INSERT INTO mining_coins
       (id, name, symbol, description, color, algorithm, network_hashrate, block_reward,
        block_time, price_usd, difficulty, multiplier, min_proportion, usdc_rate,
        is_active, target_daily_usd, show_in_exchange, nft_room_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       symbol = EXCLUDED.symbol,
       description = EXCLUDED.description,
       color = EXCLUDED.color,
       algorithm = EXCLUDED.algorithm,
       network_hashrate = EXCLUDED.network_hashrate,
       block_reward = EXCLUDED.block_reward,
       block_time = EXCLUDED.block_time,
       price_usd = EXCLUDED.price_usd,
       difficulty = EXCLUDED.difficulty,
       multiplier = EXCLUDED.multiplier,
       min_proportion = EXCLUDED.min_proportion,
       usdc_rate = EXCLUDED.usdc_rate,
       is_active = EXCLUDED.is_active,
       target_daily_usd = EXCLUDED.target_daily_usd,
       show_in_exchange = EXCLUDED.show_in_exchange,
       nft_room_only = EXCLUDED.nft_room_only";

#[derive(Debug, Clone, PartialEq)]
pub struct MiningCoinRow {
    pub id: String,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub color: String,
    pub algorithm: String,
    pub network_hashrate: f64,
    pub block_reward: f64,
    pub block_time: f64,
    pub price_usd: f64,
    pub difficulty: f64,
    pub multiplier: f64,
    pub min_proportion: f64,
    pub usdc_rate: f64,
    pub is_active: i32,
    pub target_daily_usd: f64,
    pub show_in_exchange: i32,
    pub nft_room_only: i32,
}

/// Node `Array.isArray(payload) ? payload : [payload]`, then
/// `if (!raw || typeof raw !== 'object') continue`.
pub fn coin_entries(payload: &Value) -> Vec<&Value> {
    let entries: Vec<&Value> = match payload {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    entries.into_iter().filter(|v| v.is_object()).collect()
}

/// `id` falls back to a fresh UUID exactly like Node's `crypto.randomUUID()`.
pub fn plan_mining_coin_row(coin: &Value, generated_id: &str) -> MiningCoinRow {
    let obj = coin.as_object();
    let field = |key: &str| obj.and_then(|m| m.get(key));

    let net_raw = js::parse_float_field(field("networkHashrate"));
    let net_base = if net_raw.is_finite() { net_raw } else { 0.0 };
    let network_hashrate = js::round8(net_base.max(NON_NEGATIVE_FLOOR)).max(MIN_NETWORK_HASHRATE);

    let block_time_parsed = js::parse_float_field(field("blockTime"));
    let block_time_base = if block_time_parsed.is_finite() && block_time_parsed > 0.0 {
        block_time_parsed
    } else {
        DEFAULT_BLOCK_TIME_SECONDS
    };
    let block_time =
        js::round8(block_time_base).clamp(MIN_BLOCK_TIME_SECONDS, MAX_BLOCK_TIME_SECONDS);

    let price_usd =
        js::round8(or_zero(js::parse_float_field(field("priceUSD"))).max(NON_NEGATIVE_FLOOR));

    MiningCoinRow {
        id: js::string_or(field("id"), generated_id),
        name: js::string_or(field("name"), DEFAULT_COIN_NAME),
        symbol: js::string_or(field("symbol"), ""),
        description: js::string_or(field("description"), ""),
        color: js::string_or(field("color"), DEFAULT_COIN_COLOR),
        algorithm: js::string_or(field("algorithm"), DEFAULT_COIN_ALGORITHM),
        network_hashrate,
        block_reward: js::round8(
            or_zero(js::parse_float_field(field("blockReward"))).max(NON_NEGATIVE_FLOOR),
        ),
        block_time,
        price_usd,
        difficulty: js::round8(
            or_fallback(js::parse_float_field(field("difficulty")), MIN_DIFFICULTY)
                .max(MIN_DIFFICULTY),
        ),
        multiplier: js::round8(
            or_fallback(js::parse_float_field(field("multiplier")), MIN_MULTIPLIER)
                .max(MIN_MULTIPLIER),
        ),
        min_proportion: js::round8(
            or_zero(js::parse_float_field(field("minProportion"))).max(NON_NEGATIVE_FLOOR),
        ),
        usdc_rate: js::round8(
            or_fallback(js::parse_float_field(field("usdcRate")), price_usd)
                .max(NON_NEGATIVE_FLOOR),
        ),
        // Node `c.isActive === false || c.isActive === 0 ? 0 : 1`.
        is_active: i32::from(!is_explicitly_off(field("isActive"))),
        target_daily_usd: js::round8(
            or_zero(js::parse_float_field(field("targetDailyUSD"))).max(NON_NEGATIVE_FLOOR),
        ),
        show_in_exchange: i32::from(js::truthy(field("showInExchange"))),
        nft_room_only: i32::from(js::truthy(field("nftRoomOnly"))),
    }
}

/// JS `parseFloat(...) || 0`.
fn or_zero(n: f64) -> f64 {
    or_fallback(n, 0.0)
}

/// JS `parseFloat(...) || fallback` — `NaN` and `0` both take the fallback.
fn or_fallback(n: f64, fallback: f64) -> f64 {
    if n.is_nan() || n == 0.0 {
        fallback
    } else {
        n
    }
}

/// Node `c.isActive === false || c.isActive === 0` — strict equality, so `'0'`
/// and `null` stay active.
fn is_explicitly_off(raw: Option<&Value>) -> bool {
    match raw {
        Some(Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

pub async fn run_upsert_mining_coins(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    for coin in coin_entries(payload) {
        let generated_id = uuid::Uuid::new_v4().to_string();
        let row = plan_mining_coin_row(coin, &generated_id);
        let params: [&(dyn ToSql + Sync); 18] = [
            &row.id,
            &row.name,
            &row.symbol,
            &row.description,
            &row.color,
            &row.algorithm,
            &row.network_hashrate,
            &row.block_reward,
            &row.block_time,
            &row.price_usd,
            &row.difficulty,
            &row.multiplier,
            &row.min_proportion,
            &row.usdc_rate,
            &row.is_active,
            &row.target_daily_usd,
            &row.show_in_exchange,
            &row.nft_room_only,
        ];
        conn.execute(UPSERT_SQL, &params).await?;
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATED: &str = "generated-uuid";

    #[test]
    fn single_object_and_array_payloads_both_yield_entries() {
        assert_eq!(coin_entries(&json!({ "id": "btc" })).len(), 1);
        assert_eq!(
            coin_entries(&json!([{ "id": "a" }, { "id": "b" }])).len(),
            2
        );
        assert!(coin_entries(&json!(null)).is_empty());
        assert!(coin_entries(&json!("x")).is_empty());
        assert_eq!(coin_entries(&json!([{ "id": "a" }, 7, null])).len(), 1);
    }

    #[test]
    fn defaults_match_node_when_payload_is_bare() {
        let row = plan_mining_coin_row(&json!({}), GENERATED);
        assert_eq!(row.id, GENERATED);
        assert_eq!(row.name, DEFAULT_COIN_NAME);
        assert_eq!(row.symbol, "");
        assert_eq!(row.color, DEFAULT_COIN_COLOR);
        assert_eq!(row.algorithm, DEFAULT_COIN_ALGORITHM);
        assert_eq!(row.network_hashrate, MIN_NETWORK_HASHRATE);
        assert_eq!(row.block_time, DEFAULT_BLOCK_TIME_SECONDS);
        assert_eq!(row.block_reward, 0.0);
        assert_eq!(row.price_usd, 0.0);
        assert_eq!(row.difficulty, MIN_DIFFICULTY);
        assert_eq!(row.multiplier, MIN_MULTIPLIER);
        assert_eq!(row.min_proportion, 0.0);
        assert_eq!(row.usdc_rate, 0.0);
        assert_eq!(row.is_active, 1);
        assert_eq!(row.show_in_exchange, 0);
        assert_eq!(row.nft_room_only, 0);
    }

    #[test]
    fn network_hashrate_and_block_time_are_clamped() {
        let row = plan_mining_coin_row(
            &json!({ "networkHashrate": 5, "blockTime": 999_999 }),
            GENERATED,
        );
        assert_eq!(row.network_hashrate, MIN_NETWORK_HASHRATE);
        assert_eq!(row.block_time, MAX_BLOCK_TIME_SECONDS);

        let row = plan_mining_coin_row(&json!({ "blockTime": -3 }), GENERATED);
        assert_eq!(row.block_time, DEFAULT_BLOCK_TIME_SECONDS);

        let row = plan_mining_coin_row(&json!({ "blockTime": 0.2 }), GENERATED);
        assert_eq!(row.block_time, MIN_BLOCK_TIME_SECONDS);
    }

    #[test]
    fn usdc_rate_falls_back_to_price() {
        let row = plan_mining_coin_row(&json!({ "priceUSD": "2.5" }), GENERATED);
        assert_eq!(row.price_usd, 2.5);
        assert_eq!(row.usdc_rate, 2.5);

        let row = plan_mining_coin_row(&json!({ "priceUSD": 2.5, "usdcRate": 1.25 }), GENERATED);
        assert_eq!(row.usdc_rate, 1.25);
    }

    #[test]
    fn is_active_only_off_for_strict_false_or_zero() {
        for raw in [json!(false), json!(0)] {
            let row = plan_mining_coin_row(&json!({ "isActive": raw }), GENERATED);
            assert_eq!(row.is_active, 0);
        }
        for raw in [json!("0"), json!(null), json!(true), json!(1)] {
            let row = plan_mining_coin_row(&json!({ "isActive": raw }), GENERATED);
            assert_eq!(row.is_active, 1, "{raw}");
        }
        let row = plan_mining_coin_row(&json!({}), GENERATED);
        assert_eq!(row.is_active, 1);
    }

    #[test]
    fn values_are_rounded_to_eight_decimals() {
        let row = plan_mining_coin_row(&json!({ "blockReward": 0.123_456_789_9 }), GENERATED);
        assert_eq!(row.block_reward, 0.123_456_79);
    }

    #[test]
    fn falsy_string_id_falls_back_to_generated_uuid() {
        let row = plan_mining_coin_row(&json!({ "id": "" }), GENERATED);
        assert_eq!(row.id, GENERATED);
        let row = plan_mining_coin_row(&json!({ "id": "gemt" }), GENERATED);
        assert_eq!(row.id, "gemt");
    }
}
