//! `POST /api/mining-coins` twin — Node `upsertMiningCoins`.
//!
//! The admin panel posts either one coin or the whole list; every numeric field
//! goes through `parseFloat(String(x ?? ''))` plus a clamp, so the coercion is
//! kept explicit in [`plan_mining_coin_row`].

use deadpool_postgres::Pool;
use genesis_core::time::{SECONDS_PER_DAY, SECONDS_PER_MINUTE};
use serde_json::{json, Value};
use tokio_postgres::types::ToSql;

use crate::config::current_unix_ms;
use crate::player_reads::PlayerReadError;

use super::js;

/// Robust replacement for `js::parse_float_field` on the coin numeric inputs:
/// also accepts a comma decimal separator (`"0,11"`) — the admin panel used to
/// normalise this client-side; the server now owns it.
fn parse_num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => {
            let t = s.trim().replace(' ', "");
            let has_comma = t.contains(',');
            let has_dot = t.contains('.');
            let normalized = if has_comma && (!has_dot || t.rfind(',') > t.rfind('.')) {
                t.replace('.', "").replace(',', ".")
            } else {
                t.replace(',', "")
            };
            js::parse_float(&normalized)
        }
        other => js::parse_float_field(other),
    }
}

/// `#rgb` → `#rrggbb`, add leading `#`, lowercase; anything not resolving to a
/// 6-hex-digit colour falls back to `#ffffff`.
pub(crate) fn normalize_hex_color(raw: &str) -> String {
    let t = raw.trim().trim_start_matches('#').to_ascii_lowercase();
    let hex: String = t.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let full = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => hex,
        _ => return DEFAULT_COIN_COLOR.to_string(),
    };
    format!("#{full}")
}

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
        is_active, target_daily_usd, show_in_exchange, nft_room_only,
        price_source, price_updated_at, distribution_mode, distribution_usd_month)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::int4::int2,$18,$19,$20,$21,$22)
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
       nft_room_only = EXCLUDED.nft_room_only,
       price_source = EXCLUDED.price_source,
       price_updated_at = EXCLUDED.price_updated_at,
       distribution_mode = EXCLUDED.distribution_mode,
       distribution_usd_month = EXCLUDED.distribution_usd_month";

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
    /// `'manual'` — an admin edited the row; a future live-price job skips these.
    pub price_source: String,
    pub price_updated_at: i64,
    /// `'legacy'` | `'usd_month'`.
    pub distribution_mode: String,
    /// USD/month budget (rate) when `distribution_mode == 'usd_month'`.
    pub distribution_usd_month: f64,
}

const PRICE_SOURCE_MANUAL: &str = "manual";
const DIST_MODE_LEGACY: &str = "legacy";
const DIST_MODE_USD_MONTH: &str = "usd_month";

/// Accept only the two known modes; anything else → `legacy`.
fn normalize_distribution_mode(raw: Option<&Value>) -> String {
    match raw.and_then(|v| v.as_str()).map(|s| s.trim().to_ascii_lowercase()) {
        Some(ref s) if s == DIST_MODE_USD_MONTH => DIST_MODE_USD_MONTH.to_string(),
        _ => DIST_MODE_LEGACY.to_string(),
    }
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

    let net_raw = parse_num(field("networkHashrate"));
    let net_base = if net_raw.is_finite() { net_raw } else { 0.0 };
    let network_hashrate = js::round8(net_base.max(NON_NEGATIVE_FLOOR)).max(MIN_NETWORK_HASHRATE);

    let block_time_parsed = parse_num(field("blockTime"));
    let block_time_base = if block_time_parsed.is_finite() && block_time_parsed > 0.0 {
        block_time_parsed
    } else {
        DEFAULT_BLOCK_TIME_SECONDS
    };
    let block_time =
        js::round8(block_time_base).clamp(MIN_BLOCK_TIME_SECONDS, MAX_BLOCK_TIME_SECONDS);

    let price_usd = js::round8(or_zero(parse_num(field("priceUSD"))).max(NON_NEGATIVE_FLOOR));

    MiningCoinRow {
        id: js::string_or(field("id"), generated_id),
        name: js::string_or(field("name"), DEFAULT_COIN_NAME),
        symbol: js::string_or(field("symbol"), "")
            .trim()
            .to_ascii_uppercase(),
        description: js::string_or(field("description"), ""),
        color: normalize_hex_color(&js::string_or(field("color"), DEFAULT_COIN_COLOR)),
        algorithm: js::string_or(field("algorithm"), DEFAULT_COIN_ALGORITHM),
        network_hashrate,
        block_reward: js::round8(or_zero(parse_num(field("blockReward"))).max(NON_NEGATIVE_FLOOR)),
        block_time,
        price_usd,
        difficulty: js::round8(
            or_fallback(parse_num(field("difficulty")), MIN_DIFFICULTY).max(MIN_DIFFICULTY),
        ),
        multiplier: js::round8(
            or_fallback(parse_num(field("multiplier")), MIN_MULTIPLIER).max(MIN_MULTIPLIER),
        ),
        min_proportion: js::round8(
            or_zero(parse_num(field("minProportion"))).max(NON_NEGATIVE_FLOOR),
        ),
        usdc_rate: js::round8(
            or_fallback(parse_num(field("usdcRate")), price_usd).max(NON_NEGATIVE_FLOOR),
        ),
        // Node `c.isActive === false || c.isActive === 0 ? 0 : 1`.
        is_active: i32::from(!is_explicitly_off(field("isActive"))),
        target_daily_usd: js::round8(
            or_zero(parse_num(field("targetDailyUSD"))).max(NON_NEGATIVE_FLOOR),
        ),
        show_in_exchange: i32::from(js::truthy(field("showInExchange"))),
        nft_room_only: i32::from(js::truthy(field("nftRoomOnly"))),
        price_source: PRICE_SOURCE_MANUAL.to_string(),
        price_updated_at: current_unix_ms(),
        distribution_mode: normalize_distribution_mode(field("distributionMode")),
        distribution_usd_month: js::round8(
            or_zero(parse_num(field("distributionUsdMonth"))).max(NON_NEGATIVE_FLOOR),
        ),
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
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    let mut upserts = 0i64;
    for coin in coin_entries(payload) {
        let generated_id = uuid::Uuid::new_v4().to_string();
        let row = plan_mining_coin_row(coin, &generated_id);

        // Guard against accidentally creating a second active coin with an
        // existing symbol (updates to an existing row are unaffected).
        let is_new = tx
            .query_opt("SELECT 1 FROM mining_coins WHERE id = $1", &[&row.id])
            .await?
            .is_none();
        if is_new && row.is_active == 1 && !row.symbol.is_empty() {
            let clash = tx
                .query_opt(
                    "SELECT id FROM mining_coins
                      WHERE is_active = 1 AND upper(btrim(symbol)) = $1 LIMIT 1",
                    &[&row.symbol],
                )
                .await?;
            if let Some(r) = clash {
                let existing: String = r.get("id");
                return Err(PlayerReadError::bad(format!(
                    "Já existe uma moeda ativa com o símbolo {} (id={}). Edite essa ou use outro símbolo.",
                    row.symbol, existing
                )));
            }
        }

        let params: [&(dyn ToSql + Sync); 22] = [
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
            &row.price_source,
            &row.price_updated_at,
            &row.distribution_mode,
            &row.distribution_usd_month,
        ];
        tx.execute(UPSERT_SQL, &params).await?;
        upserts += 1;
    }
    tx.commit().await?;
    Ok(json!({ "ok": true, "upserted": upserts }))
}

// ---------------------------------------------------------------------------
// `POST /api/mining-coins/set-active` — single-coin activate / deactivate.
// Replaces the old client-side "load whole list, flip is_active, re-POST" hack.
// ---------------------------------------------------------------------------

pub async fn run_set_mining_coin_active(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let obj = payload.as_object();
    let id = obj
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !coin_id_ok(&id) {
        return Err(PlayerReadError::bad("id da moeda é obrigatório."));
    }
    let active = match obj.and_then(|m| m.get("active")) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64() != Some(0),
        Some(Value::String(s)) => !matches!(s.as_str(), "0" | "false" | ""),
        _ => false,
    };
    let flag: i32 = i32::from(active);

    let conn = pool.get().await?;
    let n = conn
        .execute(
            "UPDATE mining_coins SET is_active = $2 WHERE id = $1",
            &[&id, &flag],
        )
        .await?;
    if n == 0 {
        return Err(PlayerReadError::bad("Moeda não encontrada."));
    }
    // Informational: miners currently pointed at this coin.
    let miners: i64 = conn
        .query_one(
            "SELECT COUNT(DISTINCT user_id)::bigint AS c FROM placed_racks WHERE selected_coin_id = $1",
            &[&id],
        )
        .await
        .map(|r| r.get::<_, i64>("c"))
        .unwrap_or(0);
    Ok(json!({ "ok": true, "id": id, "active": active, "activeMiners": miners }))
}

// ---------------------------------------------------------------------------
// `POST /api/admin/economy-settings` twin — per-coin hashrate/reward update.
// Ports `server/modules/admin/economy-stats/controllers/coin-economy.controller.ts`.
// ---------------------------------------------------------------------------

fn coin_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

pub async fn run_economy_settings_coin(
    pool: &Pool,
    payload: &Value,
) -> Result<Value, PlayerReadError> {
    let obj = payload.as_object();
    let field = |k: &str| obj.and_then(|m| m.get(k));

    let coin_id = field("coinId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !coin_id_ok(&coin_id) {
        return Err(PlayerReadError::bad("Invalid coinId."));
    }

    let conn = pool.get().await?;

    // --- usd_month mode: single $/month budget; legacy knobs untouched. ---
    if normalize_distribution_mode(field("distributionMode")) == DIST_MODE_USD_MONTH {
        let usd_month = js::parse_float_field(field("distributionUsdMonth"));
        if !usd_month.is_finite() || usd_month < 0.0 {
            return Err(PlayerReadError::bad("Invalid distributionUsdMonth."));
        }
        let usd_month = js::round8(usd_month);

        let coin = conn
            .query_opt(
                "SELECT symbol, price_usd FROM mining_coins WHERE id = $1",
                &[&coin_id],
            )
            .await?
            .ok_or_else(|| PlayerReadError::bad("Coin not found."))?;
        let symbol: String = coin
            .try_get::<_, Option<String>>("symbol")
            .ok()
            .flatten()
            .unwrap_or_default()
            .trim()
            .to_ascii_uppercase();
        let price_usd = coin
            .try_get::<_, Option<f64>>("price_usd")
            .ok()
            .flatten()
            .unwrap_or(0.0);
        let is_stable =
            genesis_core::calculator::constants::NFT_STABLE_USD_SYMBOLS.contains(&symbol.as_str());
        if usd_month > 0.0 && (!price_usd.is_finite() || price_usd <= 0.0) && !is_stable {
            return Err(PlayerReadError::bad(
                "price_usd da moeda é 0 — defina o preço antes de usar Distribuição USD mensal.",
            ));
        }

        let n = conn
            .execute(
                "UPDATE mining_coins
                    SET distribution_mode = 'usd_month', distribution_usd_month = $2
                  WHERE id = $1",
                &[&coin_id, &usd_month],
            )
            .await?;
        if n == 0 {
            return Err(PlayerReadError::bad("Coin not found."));
        }
        return Ok(json!({
            "ok": true,
            "coinId": coin_id,
            "distributionMode": "usd_month",
            "distributionUsdMonth": usd_month,
        }));
    }

    // --- legacy mode ---
    let net = js::parse_float_field(field("networkHashrate"));
    if !net.is_finite() || net <= 0.0 {
        return Err(PlayerReadError::bad("Invalid networkHashrate."));
    }
    let reward = js::parse_float_field(field("blockReward"));
    if !reward.is_finite() || reward < 0.0 {
        return Err(PlayerReadError::bad("Invalid blockReward."));
    }
    let network_hashrate = js::round8(net).max(MIN_NETWORK_HASHRATE);
    let block_reward = js::round8(reward);

    let n = conn
        .execute(
            "UPDATE mining_coins
                SET network_hashrate = $2, block_reward = $3, distribution_mode = 'legacy'
              WHERE id = $1",
            &[&coin_id, &network_hashrate, &block_reward],
        )
        .await?;
    if n == 0 {
        return Err(PlayerReadError::bad("Coin not found."));
    }
    Ok(json!({
        "ok": true,
        "coinId": coin_id,
        "networkHashrate": network_hashrate,
        "blockReward": block_reward,
    }))
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
    fn distribution_mode_defaults_and_maps() {
        let bare = plan_mining_coin_row(&json!({}), GENERATED);
        assert_eq!(bare.distribution_mode, "legacy");
        assert_eq!(bare.distribution_usd_month, 0.0);

        let usd = plan_mining_coin_row(
            &json!({ "distributionMode": "usd_month", "distributionUsdMonth": "123.5" }),
            GENERATED,
        );
        assert_eq!(usd.distribution_mode, "usd_month");
        assert_eq!(usd.distribution_usd_month, 123.5);

        // junk mode → legacy; negative budget → 0
        let junk = plan_mining_coin_row(
            &json!({ "distributionMode": "banana", "distributionUsdMonth": -9 }),
            GENERATED,
        );
        assert_eq!(junk.distribution_mode, "legacy");
        assert_eq!(junk.distribution_usd_month, 0.0);
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
    fn hex_color_is_normalized() {
        assert_eq!(normalize_hex_color("fff"), "#ffffff");
        assert_eq!(normalize_hex_color("#ABC"), "#aabbcc");
        assert_eq!(normalize_hex_color("  #00FF88 "), "#00ff88");
        assert_eq!(normalize_hex_color("red"), "#ffffff");
        assert_eq!(normalize_hex_color("#12345"), "#ffffff");
        let row = plan_mining_coin_row(&json!({ "color": "0F0" }), GENERATED);
        assert_eq!(row.color, "#00ff00");
    }

    #[test]
    fn symbol_is_trimmed_and_uppercased() {
        let row = plan_mining_coin_row(&json!({ "symbol": " doge " }), GENERATED);
        assert_eq!(row.symbol, "DOGE");
    }

    #[test]
    fn comma_decimal_is_accepted() {
        let row = plan_mining_coin_row(&json!({ "priceUSD": "0,11", "blockReward": "1.234,50" }), GENERATED);
        assert_eq!(row.price_usd, 0.11);
        assert_eq!(row.block_reward, 1234.5);
    }

    #[test]
    fn admin_upsert_marks_price_source_manual() {
        let row = plan_mining_coin_row(&json!({ "id": "bnb", "priceUSD": 700 }), GENERATED);
        assert_eq!(row.price_source, "manual");
        assert!(row.price_updated_at > 0);
    }

    #[test]
    fn falsy_string_id_falls_back_to_generated_uuid() {
        let row = plan_mining_coin_row(&json!({ "id": "" }), GENERATED);
        assert_eq!(row.id, GENERATED);
        let row = plan_mining_coin_row(&json!({ "id": "gemt" }), GENERATED);
        assert_eq!(row.id, "gemt");
    }
}
