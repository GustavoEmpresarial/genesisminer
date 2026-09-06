//! Napi-rs bindings: merge (phase 1) + auth (login / signup domain).

use genesis_core::{
    accept_heartbeat, assert_public_signup_email_allowed, build_game_nav_items,
    build_signed_email_verification_token, build_signed_password_reset_token,
    compute_calculator_snapshot, compute_merge_result_stats, compute_transparency_health,
    generate_referral_code, get_email_verification_flags, has_checked_in_current_period,
    hash_token_sha256, is_within_active_checkin_window, lockout_status,
    lucky_boxes_roll_grant_all, lucky_boxes_roll_independent,
    market_band_reference_usd as core_market_band_reference_usd, market_clamp_limit,
    market_clamp_offset, market_clamp_tax_percent as core_market_clamp_tax_percent,
    market_compute_reserved_until, market_is_reservation_active, merge_source_catalogs_equivalent,
    mining_assert_tick_history_matches_economy, mining_build_block_history_rows,
    mining_build_yield_history_rows, mining_calculate_integrated_yield,
    mining_consolidate_block_history_rows,
    mining_credit_cap_now_ms as core_mining_credit_cap_now_ms,
    mining_effective_network_hashrate_for_coin,
    mining_last_completed_ten_min_grid as core_mining_last_completed_ten_min_grid,
    mining_list_credit_history_windows, mining_list_pending_boundaries,
    mining_network_hashrate_from_yield_per_hash,
    mining_utc_midnight_ms as core_mining_utc_midnight_ms, normalize_merge_rarity,
    parse_desk_liquidation_percentage_points, parse_signed_email_verification_token,
    parse_signed_password_reset_token, sanitize_device_fingerprint, session_config,
    timing_safe_token_hash_equal, user_requires_email_verification, utc_checkin_period_start_ms,
    utc_day_from_ms, validate_login_email, validate_login_fields_present, validate_login_password,
    validate_optional_polygon_wallet, validate_optional_referral_code_input,
    validate_password_strength_policy, validate_signup_password, validate_signup_username,
    wallet_fraction_allowed, CalculatorComputeInput, CatalogType, CatalogWriteError,
    CatalogUpgradeWriteRow, GameNavBuildInput, LootBoxItem, MergeRarity, MergeRuntimeSettings,
    MergeSourceCatalog, MiningBuildHistoryRowsOpts, MiningBlockHistoryInsertRow,
    MiningCoinYieldInput, MiningYieldHistPoint, PlayerCashFlows, TransparencyHealthEntry,
    WalletValidation, CATALOG_HTTP_BAD_REQUEST, CHECKIN_GRACE_MS, MINING_TEN_MIN_MS,
    aggregate_header_hash, catalog_assert_canonical_ids_immutable,
    catalog_is_protected_upgrade_row, catalog_parse_upgrade_write_rows, HeaderHashEntry,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;

fn map_rarity(r: MergeRarity) -> String {
    r.as_str().to_string()
}

fn parse_rarity(raw: &str) -> MergeRarity {
    normalize_merge_rarity(raw)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeSettingsInput {
    gain_percent: f64,
    cost_pct_by_rarity: CostPctInput,
    rack_hs_bonus_pct_by_rarity: RackHsBonusInput,
}

#[derive(Debug, Deserialize)]
struct CostPctInput {
    common: f64,
    uncommon: f64,
    rare: f64,
    epic: f64,
    legendary: f64,
}

#[derive(Debug, Deserialize)]
struct RackHsBonusInput {
    common: f64,
    uncommon: f64,
    rare: f64,
    epic: f64,
    legendary: f64,
    supreme: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeSourceInput {
    id: String,
    name: String,
    category: String,
    #[serde(rename = "type")]
    catalog_type: String,
    rarity: String,
    base_cost: f64,
    base_production: f64,
    power_consumption: Option<f64>,
    multiplier: Option<f64>,
    slots_capacity: Option<i32>,
    ai_slots_capacity: Option<i32>,
}

fn parse_source(input: MergeSourceInput) -> Result<MergeSourceCatalog> {
    let catalog_type = CatalogType::parse(&input.catalog_type)
        .ok_or_else(|| Error::from_reason(format!("invalid merge catalog type: {}", input.catalog_type)))?;
    Ok(MergeSourceCatalog {
        id: input.id,
        name: input.name,
        category: input.category,
        catalog_type,
        rarity: parse_rarity(&input.rarity),
        base_cost: input.base_cost,
        base_production: input.base_production,
        power_consumption: input.power_consumption,
        multiplier: input.multiplier,
        slots_capacity: input.slots_capacity,
        ai_slots_capacity: input.ai_slots_capacity,
    })
}

fn parse_settings(input: MergeSettingsInput) -> MergeRuntimeSettings {
    MergeRuntimeSettings {
        gain_percent: input.gain_percent,
        cost_pct_by_rarity: genesis_core::MergeCostPct {
            common: input.cost_pct_by_rarity.common,
            uncommon: input.cost_pct_by_rarity.uncommon,
            rare: input.cost_pct_by_rarity.rare,
            epic: input.cost_pct_by_rarity.epic,
            legendary: input.cost_pct_by_rarity.legendary,
        },
        rack_hs_bonus_pct_by_rarity: genesis_core::RackHsBonusPct {
            common: input.rack_hs_bonus_pct_by_rarity.common,
            uncommon: input.rack_hs_bonus_pct_by_rarity.uncommon,
            rare: input.rack_hs_bonus_pct_by_rarity.rare,
            epic: input.rack_hs_bonus_pct_by_rarity.epic,
            legendary: input.rack_hs_bonus_pct_by_rarity.legendary,
            supreme: input.rack_hs_bonus_pct_by_rarity.supreme,
        },
    }
}

#[napi]
pub fn merge_normalize_rarity(raw: String) -> String {
    map_rarity(parse_rarity(&raw))
}

#[napi]
pub fn merge_source_catalogs_equivalent_json(left: String, right: String) -> Result<bool> {
    let left: MergeSourceInput = serde_json::from_str(&left)
        .map_err(|e| Error::from_reason(format!("left JSON invalid: {e}")))?;
    let right: MergeSourceInput = serde_json::from_str(&right)
        .map_err(|e| Error::from_reason(format!("right JSON invalid: {e}")))?;
    Ok(merge_source_catalogs_equivalent(
        &parse_source(left)?,
        &parse_source(right)?,
    ))
}

#[napi]
pub fn merge_compute_result_stats_json(source_json: String, settings_json: String) -> Result<Option<String>> {
    let source: MergeSourceInput = serde_json::from_str(&source_json)
        .map_err(|e| Error::from_reason(format!("source JSON invalid: {e}")))?;
    let settings: MergeSettingsInput = serde_json::from_str(&settings_json)
        .map_err(|e| Error::from_reason(format!("settings JSON invalid: {e}")))?;
    let stats = compute_merge_result_stats(&parse_source(source)?, &parse_settings(settings));
    match stats {
        Some(s) => {
            #[derive(serde::Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Out {
                result_rarity: String,
                name: String,
                base_cost: f64,
                base_production: f64,
                power_consumption: Option<f64>,
                multiplier: Option<f64>,
                slots_capacity: Option<i32>,
                ai_slots_capacity: Option<i32>,
                fee_usdc: f64,
                cost_pct: f64,
                gain_percent: f64,
            }
            let out = Out {
                result_rarity: map_rarity(s.result_rarity),
                name: s.name,
                base_cost: s.base_cost,
                base_production: s.base_production,
                power_consumption: s.power_consumption,
                multiplier: s.multiplier,
                slots_capacity: s.slots_capacity,
                ai_slots_capacity: s.ai_slots_capacity,
                fee_usdc: s.fee_usdc,
                cost_pct: s.cost_pct,
                gain_percent: s.gain_percent,
            };
            Ok(Some(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?))
        }
        None => Ok(None),
    }
}

#[napi]
pub fn merge_ping() -> String {
    "genesis-rust-ok".into()
}

// --- Auth (login / signup validation, tokens, lockout) ---

#[napi]
pub fn auth_ping() -> String {
    "genesis-auth-ok".into()
}

#[napi]
pub fn auth_validate_login_fields_json(email: Option<String>, password: Option<String>) -> Result<String> {
    let r = validate_login_fields_present(email.as_deref(), password.as_deref());
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_login_email_json(email: Option<String>) -> Result<String> {
    let r = validate_login_email(email.as_deref());
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_login_password_json(password: Option<String>) -> Result<String> {
    let r = validate_login_password(password.as_deref());
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_password_strength_json(password: String) -> Result<String> {
    let r = validate_password_strength_policy(&password);
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_assert_signup_email_json(email: String) -> Result<String> {
    let r = assert_public_signup_email_allowed(&email);
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_username_json(username: Option<String>) -> Result<String> {
    let r = validate_signup_username(username.as_deref());
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_signup_password_json(password: Option<String>, required: bool) -> Result<String> {
    let r = validate_signup_password(password.as_deref(), required);
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_referral_json(code: Option<String>) -> Result<String> {
    let r = validate_optional_referral_code_input(code.as_deref());
    Ok(serde_json::to_string(&r).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_validate_wallet_json(wallet: Option<String>) -> Result<String> {
    match validate_optional_polygon_wallet(wallet.as_deref()) {
        WalletValidation::Null => Ok("null".into()),
        WalletValidation::Address(a) => Ok(serde_json::to_string(&a).map_err(|e| Error::from_reason(e.to_string()))?),
        WalletValidation::Err { error } => Ok(serde_json::to_string(&serde_json::json!({ "error": error }))
            .map_err(|e| Error::from_reason(e.to_string()))?),
    }
}

#[napi]
pub fn auth_generate_referral_code(username: String) -> String {
    generate_referral_code(&username)
}

#[napi]
pub fn auth_build_signed_token_json(
    purpose: String,
    email: String,
    expiry_ms: f64,
    secret: String,
) -> Result<String> {
    let expiry = expiry_ms as i64;
    let token = match purpose.as_str() {
        "password_reset" => build_signed_password_reset_token(&email, expiry, &secret),
        "email_verification" => build_signed_email_verification_token(&email, expiry, &secret),
        other => {
            return Err(Error::from_reason(format!("unknown auth token purpose: {other}")));
        }
    };
    Ok(token)
}

#[napi]
pub fn auth_parse_signed_token_json(
    purpose: String,
    token: String,
    secret: String,
    now_ms: f64,
) -> Result<String> {
    match purpose.as_str() {
        "password_reset" => match parse_signed_password_reset_token(&token, &secret, now_ms as i64) {
            Ok(p) => Ok(serde_json::to_string(&p).map_err(|e| Error::from_reason(e.to_string()))?),
            Err(f) => Ok(serde_json::to_string(&f).map_err(|e| Error::from_reason(e.to_string()))?),
        },
        "email_verification" => match parse_signed_email_verification_token(&token, &secret) {
            Some(p) => Ok(serde_json::to_string(&p).map_err(|e| Error::from_reason(e.to_string()))?),
            None => Ok("null".into()),
        },
        other => Err(Error::from_reason(format!("unknown auth token purpose: {other}"))),
    }
}

#[napi]
pub fn auth_hash_token_sha256(token: String) -> String {
    hash_token_sha256(&token)
}

#[napi]
pub fn auth_timing_safe_hex_equal(a: String, b: String) -> bool {
    timing_safe_token_hash_equal(&a, &b)
}

#[napi]
pub fn auth_lockout_status_json(locked_until_ms: Option<f64>, now_ms: f64) -> Result<String> {
    let until = locked_until_ms.map(|v| v as i64);
    let st = lockout_status(until, now_ms as i64);
    Ok(serde_json::to_string(&st).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn auth_email_flags_json(email_verified: f64, email_verification_required: f64) -> Result<String> {
    let ev = email_verified as i64;
    let er = email_verification_required as i64;
    let flags = get_email_verification_flags(ev, er);
    let out = serde_json::json!({
        "emailVerified": flags.email_verified,
        "emailVerificationRequired": flags.email_verification_required,
        "requiresVerification": user_requires_email_verification(ev, er),
    });
    Ok(out.to_string())
}

#[napi]
pub fn auth_sanitize_fingerprint_json(raw_json: String) -> Result<Option<String>> {
    let raw: serde_json::Value = serde_json::from_str(&raw_json)
        .map_err(|e| Error::from_reason(format!("fingerprint JSON invalid: {e}")))?;
    match sanitize_device_fingerprint(&raw) {
        Some(s) => Ok(Some(
            serde_json::to_string(&s).map_err(|e| Error::from_reason(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

// --- Transparency portal health ---

#[napi]
pub fn transparency_ping() -> String {
    "genesis-transparency-ok".into()
}

#[napi]
pub fn transparency_compute_health_json(
    entries_json: String,
    now_ms: f64,
    cash_json: Option<String>,
) -> Result<String> {
    let entries: Vec<TransparencyHealthEntry> = serde_json::from_str(&entries_json)
        .map_err(|e| Error::from_reason(format!("entries JSON invalid: {e}")))?;
    let cash: PlayerCashFlows = match cash_json.as_deref() {
        None | Some("") => PlayerCashFlows::default(),
        Some(raw) => serde_json::from_str(raw)
            .map_err(|e| Error::from_reason(format!("cash JSON invalid: {e}")))?,
    };
    let snap = compute_transparency_health(&entries, now_ms as i64, &cash);
    Ok(serde_json::to_string(&snap).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Player calculator ---

#[napi]
pub fn calculator_ping() -> String {
    "genesis-calculator-ok".into()
}

#[napi]
pub fn calculator_compute_snapshot_json(input_json: String) -> Result<String> {
    let input: CalculatorComputeInput = serde_json::from_str(&input_json)
        .map_err(|e| Error::from_reason(format!("calculator input JSON invalid: {e}")))?;
    let snap = compute_calculator_snapshot(&input);
    Ok(serde_json::to_string(&snap).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Game nav (sidebar allowlist) ---

#[napi]
pub fn game_nav_ping() -> String {
    "genesis-game-nav-ok".into()
}

#[napi]
pub fn game_nav_build_json(input_json: String) -> Result<String> {
    let input: GameNavBuildInput = serde_json::from_str(&input_json)
        .map_err(|e| Error::from_reason(format!("game-nav input JSON invalid: {e}")))?;
    let out = build_game_nav_items(&input);
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Check-in (UTC day + 48h grace) ---

#[napi]
pub fn checkin_ping() -> String {
    "genesis-checkin-ok".into()
}

#[napi]
pub fn checkin_utc_day_from_ms(ms: f64) -> String {
    utc_day_from_ms(ms as i64)
}

#[napi]
pub fn checkin_period_start_ms(now_ms: f64) -> f64 {
    utc_checkin_period_start_ms(now_ms as i64) as f64
}

#[napi]
pub fn checkin_window_json(last_checkin_at_ms: Option<f64>, now_ms: f64) -> Result<String> {
    let last = last_checkin_at_ms.map(|v| v as i64);
    let now = now_ms as i64;
    let within = is_within_active_checkin_window(last, now);
    let checked_today = has_checked_in_current_period(last, now);
    let out = serde_json::json!({
        "withinWindow": within,
        "frozen": !within,
        "todayCheckedIn": checked_today,
        "canCheckinNow": !checked_today,
        "graceMs": CHECKIN_GRACE_MS,
        "periodStartMs": utc_checkin_period_start_ms(now),
        "today": utc_day_from_ms(now),
    });
    Ok(out.to_string())
}

// --- Mining engine (domain math — network / grid / accrual / yield) ---

#[napi]
pub fn mining_ping() -> String {
    "genesis-mining-ok".into()
}

#[napi]
pub fn mining_ten_min_ms() -> f64 {
    MINING_TEN_MIN_MS as f64
}

#[napi]
pub fn mining_effective_network_json(
    coin_id: String,
    db_network_hashrate: f64,
    runtime_json: String,
    implied_json: String,
    independent_pool: bool,
) -> Result<f64> {
    let runtime: std::collections::HashMap<String, f64> = serde_json::from_str(&runtime_json)
        .map_err(|e| Error::from_reason(format!("runtime JSON invalid: {e}")))?;
    let implied: std::collections::HashMap<String, f64> = serde_json::from_str(&implied_json)
        .map_err(|e| Error::from_reason(format!("implied JSON invalid: {e}")))?;
    Ok(mining_effective_network_hashrate_for_coin(
        &coin_id,
        db_network_hashrate,
        &runtime,
        &implied,
        independent_pool,
    ))
}

#[napi]
pub fn mining_network_from_yield_per_hash(
    yield_per_hash: f64,
    block_reward: f64,
    block_time_sec: f64,
) -> f64 {
    mining_network_hashrate_from_yield_per_hash(yield_per_hash, block_reward, block_time_sec)
}

#[napi]
pub fn mining_utc_midnight_ms(ts: f64) -> f64 {
    core_mining_utc_midnight_ms(ts as i64) as f64
}

#[napi]
pub fn mining_last_completed_ten_min_grid(ts: f64) -> f64 {
    core_mining_last_completed_ten_min_grid(ts as i64) as f64
}

#[napi]
pub fn mining_credit_cap_now_ms(now_ms: f64, grid_enabled: bool) -> f64 {
    core_mining_credit_cap_now_ms(now_ms as i64, grid_enabled) as f64
}

#[napi]
pub fn mining_list_pending_boundaries_json(checkpoint_ms: f64, cap_ms: f64) -> Result<String> {
    let v = mining_list_pending_boundaries(checkpoint_ms, cap_ms);
    Ok(serde_json::to_string(&v).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn mining_list_credit_windows_json(start_ms: f64, end_ms: f64) -> Result<String> {
    let v = mining_list_credit_history_windows(start_ms, end_ms);
    Ok(serde_json::to_string(&v).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn mining_calculate_integrated_yield_json(
    start_ms: f64,
    end_ms: f64,
    history_json: String,
) -> Result<f64> {
    let hist: Vec<MiningYieldHistPoint> = serde_json::from_str(&history_json)
        .map_err(|e| Error::from_reason(format!("history JSON invalid: {e}")))?;
    Ok(mining_calculate_integrated_yield(start_ms, end_ms, &hist))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildHistoryNapiOpts {
    coin_id: String,
    room_id: Option<String>,
    interval_start_ms: f64,
    interval_end_ms: f64,
    sorted_coin_history: Vec<MiningYieldHistPoint>,
    use_history_integration: bool,
    fallback_yield_per_hash: f64,
    effective_hash: f64,
    usd_rate: f64,
    network_hashrate: f64,
    block_reward: f64,
    block_time: f64,
}

#[napi]
pub fn mining_build_block_history_rows_json(opts_json: String) -> Result<String> {
    let opts: BuildHistoryNapiOpts = serde_json::from_str(&opts_json)
        .map_err(|e| Error::from_reason(format!("build history opts JSON invalid: {e}")))?;
    let rows = mining_build_block_history_rows(MiningBuildHistoryRowsOpts {
        coin_id: &opts.coin_id,
        room_id: opts.room_id.as_deref(),
        interval_start_ms: opts.interval_start_ms,
        interval_end_ms: opts.interval_end_ms,
        sorted_coin_history: &opts.sorted_coin_history,
        use_history_integration: opts.use_history_integration,
        fallback_yield_per_hash: opts.fallback_yield_per_hash,
        effective_hash: opts.effective_hash,
        usd_rate: opts.usd_rate,
        network_hashrate: opts.network_hashrate,
        block_reward: opts.block_reward,
        block_time: opts.block_time,
    });
    Ok(serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn mining_consolidate_block_history_json(rows_json: String) -> Result<String> {
    let rows: Vec<MiningBlockHistoryInsertRow> = serde_json::from_str(&rows_json)
        .map_err(|e| Error::from_reason(format!("history rows JSON invalid: {e}")))?;
    let out = mining_consolidate_block_history_rows(&rows);
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn mining_assert_tick_economy_json(total_gained_json: String, rows_json: String) -> Result<()> {
    let total: std::collections::HashMap<String, f64> = serde_json::from_str(&total_gained_json)
        .map_err(|e| Error::from_reason(format!("totalGained JSON invalid: {e}")))?;
    let rows: Vec<MiningBlockHistoryInsertRow> = serde_json::from_str(&rows_json)
        .map_err(|e| Error::from_reason(format!("history rows JSON invalid: {e}")))?;
    mining_assert_tick_history_matches_economy(&total, &rows)
        .map_err(|e| Error::from_reason(e))
}

#[napi]
pub fn mining_build_yield_boundary_json(
    coins_json: String,
    real_network_json: String,
    effective_at_ms: f64,
) -> Result<String> {
    let coins: Vec<MiningCoinYieldInput> = serde_json::from_str(&coins_json)
        .map_err(|e| Error::from_reason(format!("coins JSON invalid: {e}")))?;
    let real: std::collections::HashMap<String, f64> = serde_json::from_str(&real_network_json)
        .map_err(|e| Error::from_reason(format!("realNetwork JSON invalid: {e}")))?;
    let rows = mining_build_yield_history_rows(&coins, &real, effective_at_ms);
    Ok(serde_json::to_string(&rows).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Partner Games (BlockMiner hub session / heartbeat) ---

#[napi]
pub fn partner_games_ping() -> String {
    "genesis-partner-games-ok".into()
}

#[napi]
pub fn partner_games_session_config_json() -> Result<String> {
    let cfg = session_config();
    Ok(serde_json::to_string(&cfg).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn partner_games_accept_heartbeat_json(
    last_ms: Option<f64>,
    now_ms: f64,
) -> Result<String> {
    let last = last_ms.map(|v| v as i64);
    let decision = accept_heartbeat(last, now_ms as i64);
    Ok(serde_json::to_string(&decision).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Market (black-market / P2P helpers) ---

#[napi]
pub fn market_ping() -> String {
    "genesis-market-ok".into()
}

#[napi]
pub fn market_clamp_page_json(limit: Option<f64>, offset: Option<f64>) -> Result<String> {
    let lim = limit.and_then(|v| {
        if v.is_finite() {
            Some(v.floor() as i64)
        } else {
            None
        }
    });
    let off = offset.and_then(|v| {
        if v.is_finite() {
            Some(v.floor() as i64)
        } else {
            None
        }
    });
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out {
        limit: i64,
        offset: i64,
    }
    let out = Out {
        limit: market_clamp_limit(lim),
        offset: market_clamp_offset(off),
    };
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn market_clamp_tax_percent(raw: f64) -> f64 {
    core_market_clamp_tax_percent(raw)
}

#[napi]
pub fn market_reserved_until(now_ms: f64) -> f64 {
    market_compute_reserved_until(now_ms as i64) as f64
}

#[napi]
pub fn market_reservation_active(reserved_until_ms: Option<f64>, now_ms: f64) -> bool {
    let until = reserved_until_ms.and_then(|v| {
        if v.is_finite() {
            Some(v as i64)
        } else {
            None
        }
    });
    market_is_reservation_active(until, now_ms as i64)
}

#[napi]
pub fn market_band_reference_usd(base_cost: f64, book_fallback: Option<f64>) -> f64 {
    core_market_band_reference_usd(base_cost, book_fallback)
}

// --- Lucky boxes (loot rolls) ---

#[napi]
pub fn lucky_boxes_ping() -> String {
    "genesis-lucky-boxes-ok".into()
}

#[napi]
pub fn lucky_boxes_roll_independent_json(items_json: String, samples_json: String) -> Result<String> {
    let items: Vec<LootBoxItem> = serde_json::from_str(&items_json)
        .map_err(|e| Error::from_reason(format!("items JSON invalid: {e}")))?;
    let samples: Vec<f64> = serde_json::from_str(&samples_json)
        .map_err(|e| Error::from_reason(format!("samples JSON invalid: {e}")))?;
    let out = lucky_boxes_roll_independent(&items, &samples)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

#[napi]
pub fn lucky_boxes_roll_grant_all_json(items_json: String, samples_json: String) -> Result<String> {
    let items: Vec<LootBoxItem> = serde_json::from_str(&items_json)
        .map_err(|e| Error::from_reason(format!("items JSON invalid: {e}")))?;
    let samples: Vec<f64> = serde_json::from_str(&samples_json)
        .map_err(|e| Error::from_reason(format!("samples JSON invalid: {e}")))?;
    let out = lucky_boxes_roll_grant_all(&items, &samples)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Wallet (desk percent / fraction helpers) ---

#[napi]
pub fn wallet_ping() -> String {
    "genesis-wallet-ok".into()
}

#[napi]
pub fn wallet_parse_desk_percent(raw: f64) -> Option<u32> {
    parse_desk_liquidation_percentage_points(raw)
}

#[napi]
pub fn wallet_fraction_allowed_json(fraction: f64, mode: String) -> Result<String> {
    #[derive(serde::Serialize)]
    struct Out {
        allowed: bool,
    }
    let out = Out {
        allowed: wallet_fraction_allowed(fraction, &mode),
    };
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Player-game header hash aggregation ---

#[napi]
pub fn header_ping() -> String {
    "genesis-header-ok".into()
}

#[napi]
pub fn header_aggregate_hash_json(entries_json: String) -> Result<String> {
    let entries: Vec<HeaderHashEntry> = serde_json::from_str(&entries_json)
        .map_err(|e| Error::from_reason(format!("header entries JSON invalid: {e}")))?;
    let out = aggregate_header_hash(&entries);
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

// --- Catalog / Shop hardware write validate ---

fn catalog_err_json(err: &CatalogWriteError) -> Result<String> {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out<'a> {
        ok: bool,
        status_code: u16,
        code: &'a str,
        error: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        previous_id: &'a Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempted_id: &'a Option<String>,
    }
    let out = Out {
        ok: false,
        status_code: err.status_code,
        code: &err.code,
        error: &err.error,
        previous_id: &err.previous_id,
        attempted_id: &err.attempted_id,
    };
    Ok(serde_json::to_string(&out).map_err(|e| Error::from_reason(e.to_string()))?)
}

fn catalog_row_to_value(row: &CatalogUpgradeWriteRow) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), serde_json::Value::String(row.id.clone()));
    m.insert("name".into(), serde_json::Value::String(row.name.clone()));
    if let Some(prev) = &row.previous_id {
        m.insert(
            "previousId".into(),
            serde_json::Value::String(prev.clone()),
        );
    }
    for (k, v) in &row.fields {
        m.insert(k.clone(), v.clone());
    }
    serde_json::Value::Object(m)
}

#[napi]
pub fn catalog_ping() -> String {
    "genesis-catalog-ok".into()
}

/// Parse + allowlist catalog write rows. Returns `{ ok:true, rows }` or `{ ok:false, …error }`.
#[napi]
pub fn catalog_parse_upgrade_write_rows_json(raw_list_json: String) -> Result<String> {
    let raw: serde_json::Value = serde_json::from_str(&raw_list_json)
        .map_err(|e| Error::from_reason(format!("catalog write JSON invalid: {e}")))?;
    let Some(arr) = raw.as_array() else {
        return catalog_err_json(&CatalogWriteError {
            status_code: CATALOG_HTTP_BAD_REQUEST,
            code: "CATALOG_PAYLOAD_INVALID".into(),
            error: "Payload inválido.".into(),
            previous_id: None,
            attempted_id: None,
        });
    };
    match catalog_parse_upgrade_write_rows(arr) {
        Ok(rows) => {
            let rows_json: Vec<serde_json::Value> = rows.iter().map(catalog_row_to_value).collect();
            #[derive(serde::Serialize)]
            struct Out {
                ok: bool,
                rows: Vec<serde_json::Value>,
            }
            Ok(serde_json::to_string(&Out {
                ok: true,
                rows: rows_json,
            })
            .map_err(|e| Error::from_reason(e.to_string()))?)
        }
        Err(err) => catalog_err_json(&err),
    }
}

/// Identity immutability check on already-parsed rows JSON.
#[napi]
pub fn catalog_assert_canonical_ids_immutable_json(rows_json: String) -> Result<String> {
    let raw: serde_json::Value = serde_json::from_str(&rows_json)
        .map_err(|e| Error::from_reason(format!("catalog rows JSON invalid: {e}")))?;
    let Some(arr) = raw.as_array() else {
        return catalog_err_json(&CatalogWriteError {
            status_code: CATALOG_HTTP_BAD_REQUEST,
            code: "CATALOG_PAYLOAD_INVALID".into(),
            error: "Payload inválido.".into(),
            previous_id: None,
            attempted_id: None,
        });
    };
    let mut rows: Vec<CatalogUpgradeWriteRow> = Vec::with_capacity(arr.len());
    for item in arr {
        let obj = match item.as_object() {
            Some(m) => m,
            None => {
                return catalog_err_json(&CatalogWriteError {
                    status_code: CATALOG_HTTP_BAD_REQUEST,
                    code: "CATALOG_ROW_INVALID".into(),
                    error: "Cada item do catálogo deve ser um objeto.".into(),
                    previous_id: None,
                    attempted_id: None,
                });
            }
        };
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let previous_id = obj
            .get("previousId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let mut fields = serde_json::Map::new();
        for (k, v) in obj {
            if k == "id" || k == "name" || k == "previousId" {
                continue;
            }
            fields.insert(k.clone(), v.clone());
        }
        rows.push(CatalogUpgradeWriteRow {
            id,
            name,
            previous_id,
            fields,
        });
    }
    match catalog_assert_canonical_ids_immutable(&rows) {
        Ok(()) => Ok(r#"{"ok":true}"#.into()),
        Err(err) => catalog_err_json(&err),
    }
}

#[napi]
pub fn catalog_is_protected_upgrade_row_json(
    id: String,
    category: Option<String>,
    row_type: Option<String>,
) -> bool {
    catalog_is_protected_upgrade_row(&id, category.as_deref(), row_type.as_deref())
}
