//! Pure domain logic for Genesis Miner (no Node / no I/O).

pub mod auth;
pub mod calculator;
pub mod catalog;
pub mod checkin;
pub mod game_nav;
pub mod gerente;
pub mod hardware;
pub mod header;
pub mod image_paths;
pub mod lucky_boxes;
pub mod market;
pub mod merge;
pub mod mining;
pub mod partner_games;
pub mod ranking;
pub mod time;
pub mod transparency;
pub mod utc_week;
pub mod wallet;

pub use auth::{
    account_lock_remaining_seconds, assert_public_signup_email_allowed,
    build_signed_email_verification_token, build_signed_password_reset_token,
    generate_referral_code, get_email_verification_flags, hash_token_sha256, is_account_locked,
    is_reserved_profile_username, lockout_status, parse_signed_email_verification_token,
    parse_signed_password_reset_token, sanitize_device_fingerprint, strip_invisible_username_chars,
    timing_safe_token_hash_equal, user_requires_email_verification, validate_login_email,
    validate_login_fields_present, validate_login_password, validate_optional_polygon_wallet,
    validate_optional_referral_code_input, validate_password_strength_policy,
    validate_signup_password, validate_signup_username, EmailVerificationFlags, LockoutStatus,
    ParseTokenFail, ParsedAuthToken, PolicyResult, ReferralCodeValidation, SanitizedFingerprint,
    UsernameValidation, WalletValidation,
};

pub use calculator::{
    compute_snapshot as compute_calculator_snapshot, CalculatorComputeInput,
    PlayerCalculatorSnapshot,
};

pub use checkin::{
    can_early_checkin_for_next_period, has_checked_in_current_period, is_checkin_frozen_at_ms,
    is_checkin_frozen_for_mining, is_premium_within_active_window, is_within_active_checkin_window,
    next_checkin_period_end_ms, next_checkin_period_start_ms, premium_interval_ms,
    utc_checkin_period_start_ms, utc_day_from_ms, CHECKIN_GRACE_MS, CHECKIN_TIMEZONE,
    CHECKIN_WINDOW_MS, DEFAULT_CHECKIN_PREMIUM_INTERVAL_DAYS, DEFAULT_CHECKIN_PREMIUM_MIN_USDC,
};

pub use mining::{
    amounts_almost_equal as mining_amounts_almost_equal,
    assert_tick_history_matches_economy as mining_assert_tick_history_matches_economy,
    build_mining_block_history_rows_for_credit as mining_build_block_history_rows,
    build_yield_history_rows_for_boundary as mining_build_yield_history_rows,
    calculate_integrated_yield as mining_calculate_integrated_yield,
    consolidate_mining_block_history_rows as mining_consolidate_block_history_rows,
    effective_network_hashrate_for_coin as mining_effective_network_hashrate_for_coin,
    last_completed_ten_minute_utc_grid as mining_last_completed_ten_min_grid,
    list_credit_history_windows as mining_list_credit_history_windows,
    list_pending_ten_minute_boundaries as mining_list_pending_boundaries, mining_credit_cap_now_ms,
    network_hashrate_from_yield_per_hash as mining_network_hashrate_from_yield_per_hash,
    utc_midnight_ms as mining_utc_midnight_ms, BuildHistoryRowsOpts as MiningBuildHistoryRowsOpts,
    CoinYieldInput as MiningCoinYieldInput, CreditHistoryWindow as MiningCreditHistoryWindow,
    MiningBlockHistoryInsertRow, YieldHistPoint as MiningYieldHistPoint,
    YieldHistoryBoundaryRows as MiningYieldHistoryBoundaryRows,
    MIN_NETWORK_HASHRATE as MINING_MIN_NETWORK_HASHRATE, TEN_MIN_MS as MINING_TEN_MIN_MS,
};

pub use game_nav::{
    build_game_nav_items, resolve_allowed_pages, GameNavBuildInput, GameNavBuildOutput,
};

pub use partner_games::{
    accept_heartbeat, build_session_event, session_config, HeartbeatDecision, SessionConfig,
    SessionEvent, SessionReason, CREDITED_MINUTES_PER_HEARTBEAT, EMBED_PATH, HEARTBEAT_INTERVAL_MS,
    PUBLIC_URL, SESSION_KIND,
};

pub use market::{
    clamp_limit as market_clamp_limit, clamp_offset as market_clamp_offset,
    clamp_price_band_percent as market_clamp_price_band_percent,
    clamp_tax_percent as market_clamp_tax_percent,
    compute_p2p_band_reference_usd as market_band_reference_usd,
    compute_reserved_until as market_compute_reserved_until,
    is_reservation_active as market_is_reservation_active, BLACK_MARKET_DEFAULT_LIMIT,
    BLACK_MARKET_MAX_OFFSET, BLACK_MARKET_MAX_PAGE, MARKET_RESERVE_MINUTES, MARKET_RESERVE_MS,
    PRICE_BAND_DEFAULT_PERCENT, PRICE_BAND_MAX_PERCENT, PRICE_BAND_MIN_PERCENT, TAX_PERCENT_MAX,
    TAX_PERCENT_MIN,
};

pub use lucky_boxes::{
    roll_grant_all as lucky_boxes_roll_grant_all, roll_independent as lucky_boxes_roll_independent,
    BundleGrant as LuckyBoxBundleGrant, LootBoxItem, LootRewardGrant,
    RollError as LuckyBoxRollError, RolledLootPayload,
    PROBABILITY_MAX as LUCKY_BOX_PROBABILITY_MAX,
};

pub use wallet::{
    desk_percent_to_fraction, fraction_allowed as wallet_fraction_allowed,
    parse_desk_liquidation_percentage_points, DESK_FRACTION_100PCT, DESK_FRACTION_10PCT,
    DESK_FRACTION_50PCT, DESK_PERCENT_10, DESK_PERCENT_100, DESK_PERCENT_50,
    FRACTION_MODE_DESK_SHORTCUTS, FRACTION_MODE_LEGACY,
};

pub use merge::{
    compute_merge_result_stats, merge_result_display_name, merge_source_catalogs_equivalent,
    normalize_merge_rarity, stats_match_existing, CatalogType, MergeCatalogStats, MergeCostPct,
    MergeRarity, MergeResultStats, MergeRuntimeSettings, MergeSourceCatalog, RackHsBonusPct,
    DEFAULT_MERGE_GAIN_PERCENT, MERGE_MAX_COUNT, MIN_MERGE_QTY,
};

pub use ranking::{
    accumulate_admin_ranking_power_from_racks, accumulate_ranking_power_from_racks,
    filter_admin_ranking_users, my_global_mining_rank_from_payload, sum_general_ranking_power,
    AdminMiningRankingPayload, AdminRankingUser, CoinLite, MyGlobalMiningRank,
    PublicMiningRankingPayload, PublicRankingUser, RankingRackInput, RANK_HASH_ROUND_FACTOR,
};

pub use gerente::{
    ACCOUNT_MANAGER_FIRE_LOCK_DAYS, ACCOUNT_MANAGER_PERCENT_MULTIPLIER, ACCOUNT_MANAGER_SHARE,
    ACCOUNT_MANAGER_STATUS_ACTIVE, ACCOUNT_MANAGER_STATUS_APPLIED, ACCOUNT_MANAGER_STATUS_ENDED,
    ACCOUNT_MANAGER_STATUS_PENDING,
};

pub use header::{aggregate_header_hash, HeaderHashAggregate, HeaderHashEntry};

pub use utc_week::{
    previous_utc_week_start_ms, utc_week_start_ms, DAYS_FROM_SUNDAY_TO_MONDAY, DAYS_PER_WEEK,
    UTC_WEEKDAY_MONDAY, UTC_WEEKDAY_SUNDAY,
};

pub use catalog::{
    apply_infrastructure_shared_fields_from_merge_roots as catalog_apply_infrastructure_shared_fields,
    assert_canonical_ids_immutable as catalog_assert_canonical_ids_immutable,
    is_protected_upgrade_id as catalog_is_protected_upgrade_id,
    is_protected_upgrade_row as catalog_is_protected_upgrade_row,
    is_soft_retire_eligible_row as catalog_is_soft_retire_eligible_row,
    is_valid_shop_product_id as catalog_is_valid_shop_product_id,
    normalize_upgrade_rarity as catalog_normalize_upgrade_rarity,
    parse_upgrade_write_rows as catalog_parse_upgrade_write_rows,
    read_identity_previous_id as catalog_read_identity_previous_id,
    resolve_asic_duration_upsert_fields as catalog_resolve_asic_duration_upsert_fields,
    CatalogWriteError, UpgradeWriteRow as CatalogUpgradeWriteRow,
    ASIC_DURATION_KIND_NONE as CATALOG_ASIC_DURATION_KIND_NONE,
    HTTP_BAD_REQUEST as CATALOG_HTTP_BAD_REQUEST, HTTP_CONFLICT as CATALOG_HTTP_CONFLICT,
    LEGACY_TEMP_MARKER as CATALOG_LEGACY_TEMP_MARKER, RARITY_DEFAULT as CATALOG_RARITY_DEFAULT,
    SHOP_PRODUCT_ID_MAX_LEN as CATALOG_SHOP_PRODUCT_ID_MAX_LEN,
    TEMP_LEGACY_ID_PREFIX as CATALOG_TEMP_LEGACY_ID_PREFIX,
    UPGRADE_DEFAULT_ICON as CATALOG_UPGRADE_DEFAULT_ICON,
    UPGRADE_STATUS_RETIRED as CATALOG_UPGRADE_STATUS_RETIRED,
};

pub use transparency::{
    clamp_health, compute_transparency_health, health_band, normalize_health_category,
    score_inflow, score_published_ledger, score_rent, HealthBand, PlayerCashFlows,
    TransparencyHealthCategory, TransparencyHealthEntry, TransparencyHealthSnapshot,
    HEALTH_WEIGHT_INFLOW, HEALTH_WEIGHT_LEDGER, HEALTH_WEIGHT_RENT, TRANSPARENCY_HEALTH_CEILING,
    TRANSPARENCY_HEALTH_FLOOR,
};
