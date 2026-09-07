//! Public player HTTP facades → mining / hardware / wallet twins.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Query, State};
use axum::http::{HeaderMap, Request};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::client_ip::get_client_ip;
use crate::config::AppState;
use crate::config::{
    MINING_WORKER_PROGRESS_TIMEOUT_MS, MINING_WORKER_SUPPORT_TIMEOUT_MS, TICKET_ID_MAX_LENGTH,
};
use crate::facade::{
    forward_hardware, forward_hardware_bm_listings, forward_hardware_bm_state,
    forward_hardware_items, forward_mining, forward_wallet, merge_user_id, worker_to_response,
};
use crate::owned::GAME_STATE_ME_PATH;
use crate::rate_limit::{
    enforce, profile_rate_key, scoped_actor_key, PARTNER_GAMES_WINDOW_MS,
    PROFILE_IDENTITY_LIMIT_MAX, PROFILE_PASSWORD_LIMIT_MAX, PROFILE_RATE_LIMIT_WINDOW_MS,
    SCOPE_PROFILE_IDENTITY, SCOPE_PROFILE_PASSWORD,
};
use crate::session::{json_status, require_player};
use crate::workers::{get_mining, post_hardware, post_mining_multipart, WorkerJson};

/// Node `profile.controller.ts` identity limiter message.
const PROFILE_IDENTITY_RATE_MSG: &str = "Demasiadas alterações de nome. Tente mais tarde.";
/// Node `profile.controller.ts` password limiter message.
const PROFILE_PASSWORD_RATE_MSG: &str = "Demasiadas tentativas de alteração de senha.";

const CHAT_HISTORY_PATH: &str = "/v1/chat/history";
const CHAT_PEERS_PATH: &str = "/v1/chat/peers";
const CHAT_MENTIONS_SEARCH_PATH: &str = "/v1/chat/mentions-search";
const CHAT_CAN_ACCESS_PATH: &str = "/v1/chat/can-access";
const CHAT_RATE_LIMIT_PATH: &str = "/v1/chat/rate-limit";
const CHAT_SENDER_PATH: &str = "/v1/chat/sender";
const CHAT_INSERT_PATH: &str = "/v1/chat/insert";
const CHAT_EDIT_PATH: &str = "/v1/chat/edit";
const CHAT_DELETE_PATH: &str = "/v1/chat/delete";
const SUPPORT_STATE_PATH: &str = "/v1/support/state";
const SUPPORT_LIST_MINE_PATH: &str = "/v1/support/list-mine";
const SUPPORT_GET_PATH: &str = "/v1/support/get";
const SUPPORT_SUBMIT_PATH: &str = "/v1/support/submit";
const SUPPORT_REPLY_PATH: &str = "/v1/support/reply";
const SUPPORT_ARCHIVE_PATH: &str = "/v1/support/archive";
const SUPPORT_REOPEN_PATH: &str = "/v1/support/reopen";
const ANNOUNCEMENTS_PENDING_PATH: &str = "/v1/announcements/pending";
const ANNOUNCEMENTS_MINI_BLOG_PATH: &str = "/v1/announcements/mini-blog";
const ANNOUNCEMENTS_MARK_READ_PATH: &str = "/v1/announcements/mark-read";
const CALCULATOR_SNAPSHOT_PATH: &str = "/v1/calculator/snapshot";
const CALCULATOR_AI_ANALYZE_PATH: &str = "/v1/calculator/ai-analyze";
/// Calculator AI analysis: per-user fixed window (LLM calls are expensive).
const CALCULATOR_AI_RATE_MAX: u64 = 6;
const CALCULATOR_AI_RATE_SCOPE: &str = "calculator_ai";
const CALCULATOR_AI_RATE_MSG: &str = "Demasiados pedidos de IA. Aguarda um minuto.";
const RANKING_PUBLIC_PATH: &str = "/v1/ranking/public";
const RANKING_ME_PATH: &str = "/v1/ranking/me";
const MARKET_STATE_PATH: &str = "/v1/market/state";
const MARKET_LISTINGS_PATH: &str = "/v1/market/listings";
const MARKET_MY_LISTINGS_PATH: &str = "/v1/market/my-listings";
const MARKET_CUSTODY_PATH: &str = "/v1/market/custody";
const MARKET_HISTORY_PATH: &str = "/v1/market/history";
const MARKET_SELL_PATH: &str = "/v1/market/sell";
const MARKET_CANCEL_PATH: &str = "/v1/market/cancel";
const MARKET_RESERVE_PATH: &str = "/v1/market/reserve";
const MARKET_CANCEL_RESERVE_PATH: &str = "/v1/market/cancel-reserve";
const MARKET_BUY_PATH: &str = "/v1/market/buy";
const MARKET_CLAIM_PROCEEDS_PATH: &str = "/v1/market/claim-proceeds";
const MARKET_CLAIM_ALL_PATH: &str = "/v1/market/claim-all";
const MARKET_CLAIM_ITEM_PATH: &str = "/v1/market/claim-item";
const HARDWARE_INTENT_PATH: &str = "/v1/hardware/intent";
const HARDWARE_BULK_BATTERIES_PATH: &str = "/v1/hardware/bulk-batteries";
const HARDWARE_RACKS_POWER_PATH: &str = "/v1/hardware/racks-power";
const SHOP_CHECKOUT_PATH: &str = "/v1/shop/checkout";
const MERGE_EXECUTE_PATH: &str = "/v1/merge/execute";
const UPGRADES_PURCHASE_PATH: &str = "/v1/upgrades/purchase";
const ROOMS_PURCHASE_SLOT_PATH: &str = "/v1/rooms/purchase-slot";
const LUCKY_BOX_BUY_PATH: &str = "/v1/lucky-boxes/buy";
const LUCKY_BOX_OPEN_PATH: &str = "/v1/lucky-boxes/open";
const LUCKY_BOX_PROMO_REDEEM_PATH: &str = "/v1/lucky-boxes/promocodes/redeem";
const WHEEL_PAID_SPIN_PATH: &str = "/v1/wheel/paid-spin";
const WHEEL_REDEEM_CODE_PATH: &str = "/v1/wheel/redeem-code";
const WHEEL_ROLL_PATH: &str = "/v1/wheel/roll";
const ROLETA_CLAIM_PATH: &str = "/v1/roleta/claim";
const WALLET_LIQUIDATE_PATH: &str = "/v1/wallet/exchange/liquidate";
const WALLET_WITHDRAW_PATH: &str = "/v1/wallet/withdraw/request";
const WALLET_QUEST_CLAIM_PATH: &str = "/v1/wallet/quests/claim";
const WALLET_DEPOSIT_VERIFY_PATH: &str = "/v1/wallet/deposit/verify";
const UPLOAD_CHAT_AUDIO_PATH: &str = "/v1/uploads/chat-audio";
const UPLOAD_SUPPORT_ATTACHMENT_PATH: &str = "/v1/uploads/support-attachment";
const ZERADS_TOKEN_PATH: &str = "/v1/wallet/offerwall/token";
const ZERADS_STATS_PATH: &str = "/v1/wallet/offerwall/stats";
const ZERADS_CALLBACK_PATH: &str = "/v1/wallet/offerwall/callback";
const EXCHANGE_LIQUIDATE_SCOPE: &str = "wallet_exchange_liquidate";
const CHAT_CHANNEL_GLOBAL: &str = "global";
/// Node `CHAT_KIND_AUDIO`.
const CHAT_KIND_AUDIO: &str = "audio";
/// Node `CHAT_AUDIO_MAX_DURATION_MS`.
const CHAT_AUDIO_MAX_DURATION_MS: i64 = 30_000;
/// Node `AUDIO_DURATION_MIN_MS`.
const AUDIO_DURATION_MIN_MS: i64 = 400;
/// Node `AUDIO_DURATION_GRACE_MS`.
const AUDIO_DURATION_GRACE_MS: i64 = 500;
/// Node `AUDIO_DURATION_FLOOR_MS`.
const AUDIO_DURATION_FLOOR_MS: i64 = 1;
/// Node `CHAT_AUDIO_MAX_BYTES`.
const CHAT_AUDIO_MAX_BYTES: usize = 1_500_000;
/// Node `SUPPORT_UPLOAD_MAX_MB`.
const SUPPORT_UPLOAD_MAX_MB: usize = 12;
const BYTES_PER_KB: usize = 1024;
const KB_PER_MB: usize = 1024;
const SUPPORT_UPLOAD_MAX_BYTES: usize = SUPPORT_UPLOAD_MAX_MB * KB_PER_MB * BYTES_PER_KB;
/// Node `SUPPORT_UPLOAD_MAX_FILES`.
const SUPPORT_UPLOAD_MAX_FILES: usize = 5;
/// Node `ORIGINAL_NAME_MAX_LEN`.
const ORIGINAL_NAME_MAX_LEN: usize = 200;
/// Node `MIME_MAX_LEN`.
const MIME_MAX_LEN: usize = 120;
/// Multipart envelope slack — same formula as mining-worker `UPLOAD_HTTP_BODY_LIMIT_BYTES`.
const UPLOAD_HTTP_BODY_LIMIT_BYTES: usize = SUPPORT_UPLOAD_MAX_BYTES + CHAT_AUDIO_MAX_BYTES;
pub(crate) const SUPPORT_MULTIPART_BODY_LIMIT_BYTES: usize =
    SUPPORT_UPLOAD_MAX_FILES * SUPPORT_UPLOAD_MAX_BYTES + CHAT_AUDIO_MAX_BYTES;
/// Node `MIN_DEFAULT` / `FEE_DEFAULT` for exchange GET.
const EXCHANGE_MIN_DEFAULT: f64 = 0.1;
const EXCHANGE_FEE_DEFAULT: f64 = 0.0;
const INVENTORY_STATE_PATH: &str = "/v1/inventory/state";
const INVENTORY_ME_PATH: &str = "/v1/inventory/me";
const SHOP_STATE_PATH: &str = "/v1/shop/state";
const SHOP_PRODUCTS_PATH: &str = "/v1/shop/products";
const SHOP_CART_SET_PATH: &str = "/v1/shop/cart/set";
const SHOP_CART_SET_LINE_PATH: &str = "/v1/shop/cart/set-line";
const SHOP_CART_DELETE_LINE_PATH: &str = "/v1/shop/cart/delete-line";
const SHOP_CART_CLEAR_PATH: &str = "/v1/shop/cart/clear";
const CATALOG_UPGRADES_PATH: &str = "/v1/catalog/upgrades";
const CATALOG_MINING_COINS_PATH: &str = "/v1/catalog/mining-coins";
const CATALOG_ACCESS_LEVELS_PATH: &str = "/v1/catalog/access-levels";
const CATALOG_LOOT_BOXES_PATH: &str = "/v1/catalog/loot-boxes";
const SERVERS_STATE_PATH: &str = "/v1/servers/state";
const GAME_STATE_ME_WORKER_PATH: &str = "/v1/game-state/me";
const LUCKY_STATE_PATH: &str = "/v1/lucky-boxes/state";
const LUCKY_SHOP_PATH: &str = "/v1/lucky-boxes/shop";
const LUCKY_INVENTORY_PATH: &str = "/v1/lucky-boxes/inventory";
const LUCKY_HISTORY_PATH: &str = "/v1/lucky-boxes/history";
const LUCKY_OPENING_PATH: &str = "/v1/lucky-boxes/opening";
const LUCKY_DISCARD_PATH: &str = "/v1/lucky-boxes/discard";
const WHEEL_STATE_PATH: &str = "/v1/wheel/state";
const WHEEL_HISTORY_PATH: &str = "/v1/wheel/history";
const WALLET_STATE_PATH: &str = "/v1/wallet/state";
const WALLET_HISTORY_PATH: &str = "/v1/wallet/history";
const WITHDRAWALS_HISTORY_PATH: &str = "/v1/withdrawals/history";
const DEPOSITS_HISTORY_PATH: &str = "/v1/deposits/history";
const WEB3_SETTINGS_PATH: &str = "/v1/web3-settings";
const CHECKIN_STATUS_PATH: &str = "/v1/checkin/status";
const CHECKIN_PERFORM_PATH: &str = "/v1/checkin/perform";
const QUESTS_STATE_PATH: &str = "/v1/quests/state";
const HEADER_PATH: &str = "/v1/player-game/header";
const HEADER_HIGHLIGHT_PATH: &str = "/v1/player-game/header/highlight";
const NAV_PATH: &str = "/v1/player-game/nav";
const ECONOMY_SETTINGS_PATH: &str = "/v1/settings/economy";
const EXCHANGE_SETTINGS_PATH: &str = "/v1/settings/exchange";
const MONETIZATION_SETTINGS_PATH: &str = "/v1/settings/monetization";
const DISPLAY_LABELS_PATH: &str = "/v1/settings/display-labels";
const PROFILE_STATE_PATH: &str = "/v1/profile/state";
const PROFILE_IDENTITY_PATH: &str = "/v1/profile/identity";
const PROFILE_PASSWORD_CHANGE_PATH: &str = "/v1/profile/password/change";
const PROFILE_SECURITY_EVENTS_PATH: &str = "/v1/profile/security-events";
const PROFILE_WALLET_CHALLENGE_PATH: &str = "/v1/profile/wallet/connect/challenge";
const PROFILE_WALLET_VERIFY_PATH: &str = "/v1/profile/wallet/connect/verify";
const PROFILE_WALLET_GET_PATH: &str = "/v1/profile/wallet";
const PROFILE_WALLET_REMOVE_PATH: &str = "/v1/profile/wallet/remove";
const PROFILE_REFERRAL_BIND_PATH: &str = "/v1/profile/referral/bind";
const PROFILE_REFERRAL_STATE_PATH: &str = "/v1/profile/referral/state";
const PROFILE_REFERRAL_OVERVIEW_PATH: &str = "/v1/profile/referral/overview";
/// Node `SECURITY_EVENTS_LIMIT` in profile.controller.
const PROFILE_SECURITY_EVENTS_LIMIT: i64 = 50;
/// Node `OVERVIEW_HISTORY_LIMIT` in referral.controller.
const PROFILE_OVERVIEW_HISTORY_LIMIT: i64 = 80;
/// Node `WALLET_HISTORY_LIMIT_DEFAULT`.
const PROFILE_WALLET_HISTORY_LIMIT_DEFAULT: i64 = 100;
/// Node `WALLET_HISTORY_LIMIT_MAX`.
const PROFILE_WALLET_HISTORY_LIMIT_MAX: i64 = 200;
/// Node `REQUEST_ID_MAX_CHARS`.
const PROFILE_REQUEST_ID_MAX_CHARS: usize = 64;
const NEWS_LIST_PATH: &str = "/v1/catalog/news";
const NEWS_FEE_PATH: &str = "/v1/catalog/news-fee";
const NEWS_EXPIRE_DAYS_PATH: &str = "/v1/catalog/news-expire-days";
const SEASON_PASSES_PATH: &str = "/v1/catalog/season-passes";
const GUIDE_PATH: &str = "/v1/guide";
const ROADMAP_PATH: &str = "/v1/roadmap";
const TRANSPARENCY_PATH: &str = "/v1/transparency";
const TRANSPARENCY_HEALTH_PATH: &str = "/v1/transparency/health";
const RIG_ROOMS_PATH: &str = "/v1/rooms/list";
const MY_RIG_ROOMS_PATH: &str = "/v1/rooms/mine";
const MERGE_CONFIG_PATH: &str = "/v1/merge/config";
const MERGE_INVENTORY_PATH: &str = "/v1/merge/inventory";
const MERGE_HISTORY_PATH: &str = "/v1/merge/history";
const UPGRADES_STATE_PATH: &str = "/v1/upgrades/state";
const UPGRADES_PURCHASES_PATH: &str = "/v1/upgrades/purchases";
const SHOP_ORDER_PATH: &str = "/v1/shop/order";
const WHEEL_SPIN_PATH: &str = "/v1/wheel/spin";
const ROLETA_PENDING_CODE_PATH: &str = "/v1/roleta/pending-code";
/// Node `EMAIL_MAX` in my-rig-rooms.controller.ts (RFC 5321).
const EMAIL_MAX: usize = 254;
/// Node `MINING_ECONOMY_PUBLIC_META.source`.
const MINING_ECONOMY_SOURCE: &str = "catalog";
const HTTP_OK: u16 = 200;
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_NOT_FOUND: u16 = 404;
const LUCKY_STATE_VERSION: i64 = 1;
/// Node `HISTORY_PAGE_SIZE` in lucky-boxes state.
const LUCKY_HISTORY_PAGE_SIZE: i64 = 30;
/// Node shop `STATE_VERSION`.
const SHOP_STATE_VERSION: i64 = 1;

const _: () = assert!(LUCKY_HISTORY_PAGE_SIZE == 30);
const _: () = assert!(SHOP_STATE_VERSION == 1);
const _: () = assert!(EMAIL_MAX == 254);
const _: () = assert!(CHAT_AUDIO_MAX_DURATION_MS == 30_000);
const _: () = assert!(AUDIO_DURATION_MIN_MS == 400);
const _: () = assert!(CHAT_AUDIO_MAX_BYTES == 1_500_000);
const _: () = assert!(SUPPORT_UPLOAD_MAX_BYTES == 12_582_912);
const _: () = assert!(SUPPORT_UPLOAD_MAX_FILES == 5);
const _: () = assert!(PROFILE_SECURITY_EVENTS_LIMIT == 50);
const _: () = assert!(PROFILE_OVERVIEW_HISTORY_LIMIT == 80);
const _: () = assert!(PROFILE_WALLET_HISTORY_LIMIT_DEFAULT == 100);
const _: () = assert!(PROFILE_WALLET_HISTORY_LIMIT_MAX == 200);
const _: () = assert!((EXCHANGE_MIN_DEFAULT * 10.0) as i64 == 1);

#[derive(Deserialize, Default)]
struct LimitCursorQ {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

#[derive(Deserialize, Default)]
struct ChatHistoryQ {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    channel: Option<String>,
}

#[derive(Deserialize, Default)]
struct MentionsQ {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize, Default)]
struct ScopeQ {
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize, Default)]
struct FreshQ {
    #[serde(default)]
    fresh: Option<String>,
}

#[derive(Deserialize, Default)]
struct ManagingQ {
    #[serde(default)]
    managing: Option<String>,
}

#[derive(Deserialize, Default)]
struct LegacyQ {
    #[serde(default)]
    legacy: Option<String>,
}

#[derive(Deserialize, Default)]
struct ZeradsCallbackQ {
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    amount: Option<String>,
    #[serde(default)]
    clicks: Option<String>,
    #[serde(default)]
    pwd: Option<String>,
}

#[derive(Deserialize, Default)]
struct ListingsQ {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(rename = "type", default)]
    type_filter: Option<String>,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

fn truthy_flag(raw: Option<&str>) -> bool {
    let s = raw.unwrap_or("").trim().to_ascii_lowercase();
    s == "1" || s == "true" || s == "yes"
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(GAME_STATE_ME_PATH, get(get_game_state_me))
        .route("/api/inventory/state", get(inventory_state))
        .route("/api/inventory/me", get(inventory_me))
        .route("/api/shop/state", get(shop_state))
        .route("/api/shop/products", get(shop_products))
        .route("/api/shop/products/{product_id}", get(shop_product_one))
        .route("/api/shop/cart/items", post(shop_cart_set))
        .route(
            "/api/shop/cart/items/{line_id}",
            patch(shop_cart_set_line).delete(shop_cart_delete_line),
        )
        .route("/api/shop/cart", delete(shop_cart_clear))
        .route("/api/wallet/state", get(wallet_state))
        .route("/api/wallet/history", get(wallet_history))
        .route("/api/withdrawals/history", get(withdrawals_history))
        .route("/api/deposits/history", get(deposits_history))
        .route("/api/web3-settings", get(web3_settings))
        .route("/api/checkin/status", get(checkin_status))
        .route("/api/checkin", post(checkin_perform))
        .route("/api/quests/state", get(quests_state))
        .route("/api/quests/claim", post(quests_claim))
        .route("/api/lucky-boxes/state", get(lucky_state))
        .route("/api/lucky-boxes/shop", get(lucky_shop))
        .route("/api/lucky-boxes/inventory", get(lucky_inventory))
        .route("/api/lucky-boxes/history", get(lucky_history))
        .route("/api/lucky-boxes/openings/{opening_id}", get(lucky_opening))
        .route("/api/lucky-boxes/discard", post(lucky_discard))
        .route("/api/wheel/state", get(wheel_state))
        .route("/api/wheel/history", get(wheel_history))
        .route("/api/servers/state", get(servers_state))
        .route("/api/player-game/header", get(player_game_header))
        .route(
            "/api/player-game/header/highlight",
            patch(player_game_header_highlight),
        )
        .route("/api/player-game/nav", get(player_game_nav))
        .route("/api/upgrades", get(catalog_upgrades))
        .route("/api/mining-coins", get(catalog_mining_coins))
        .route("/api/access-levels", get(catalog_access_levels))
        .route("/api/loot-boxes", get(catalog_loot_boxes))
        .route("/api/economy-settings", get(economy_settings))
        .route("/api/exchange-settings", get(exchange_settings))
        .route("/api/monetization-settings", get(monetization_settings))
        .route("/api/display-labels", get(display_labels))
        .route("/api/news", get(news_list))
        .route("/api/news-fee", get(news_fee))
        .route("/api/news-expire-days", get(news_expire_days))
        .route("/api/season-passes", get(season_passes))
        .route("/api/guide", get(guide))
        .route("/api/roadmap", get(roadmap))
        .route("/api/transparency", get(transparency))
        .route("/api/transparency/health", get(transparency_health))
        .route("/api/rig-rooms", get(rig_rooms))
        .route("/api/my-rig-rooms/{email}", get(my_rig_rooms))
        .route("/api/merge/config", get(merge_config))
        .route("/api/merge/inventory", get(merge_inventory))
        .route("/api/merge/history", get(merge_history))
        .route("/api/upgrades/state", get(upgrades_state))
        .route("/api/upgrades/purchases", get(upgrades_purchases))
        .route("/api/shop/orders/{order_id}", get(shop_order))
        .route("/api/wheel/spins/{spin_id}", get(wheel_spin))
        .route("/api/roleta/pending-code", get(roleta_pending_code))
        .route("/api/profile/state", get(profile_state))
        .route("/api/profile/identity", patch(profile_identity))
        .route(
            "/api/profile/password/change",
            post(profile_password_change),
        )
        .route("/api/profile/security-events", get(profile_security_events))
        .route(
            "/api/profile/wallet/connect/challenge",
            post(profile_wallet_challenge),
        )
        .route(
            "/api/profile/wallet/connect/verify",
            post(profile_wallet_verify),
        )
        .route(
            "/api/profile/wallet",
            get(profile_wallet_get).delete(profile_wallet_remove),
        )
        .route("/api/profile/wallet/remove", post(profile_wallet_remove))
        .route("/api/profile/referral/bind", post(profile_referral_bind))
        .route("/api/profile/referral/state", get(profile_referral_state))
        .route(
            "/api/profile/referral/overview",
            get(profile_referral_overview),
        )
        .route("/api/chat/peers", get(chat_peers))
        .route("/api/chat/history", get(chat_history))
        .route("/api/chat/mentions", get(chat_mentions))
        .route("/api/chat/messages", post(chat_insert))
        .route(
            "/api/chat/messages/{id}",
            patch(chat_edit).delete(chat_delete),
        )
        .route(
            "/api/chat/audio",
            post(chat_audio).layer(DefaultBodyLimit::max(UPLOAD_HTTP_BODY_LIMIT_BYTES)),
        )
        .route("/api/support/state", get(support_state))
        .route(
            "/api/support/tickets",
            get(support_list)
                .post(support_submit)
                .layer(DefaultBodyLimit::max(SUPPORT_MULTIPART_BODY_LIMIT_BYTES)),
        )
        .route("/api/support/tickets/{ticket_id}", get(support_get))
        .route(
            "/api/support/tickets/{ticket_id}/messages",
            post(support_reply).layer(DefaultBodyLimit::max(SUPPORT_MULTIPART_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/support/tickets/{ticket_id}/archive",
            post(support_archive),
        )
        .route(
            "/api/support/tickets/{ticket_id}/reopen",
            post(support_reopen),
        )
        .route("/api/announcements/pending", get(announcements_pending))
        .route(
            "/api/in-app-announcements/pending",
            get(announcements_pending),
        )
        .route("/api/mini-blog", get(mini_blog))
        .route(
            "/api/announcements/{id}/dismiss",
            post(announcements_dismiss),
        )
        .route(
            "/api/in-app-announcements/{id}/dismiss",
            post(announcements_dismiss),
        )
        .route("/api/ranking/public", get(ranking_public))
        .route("/api/ranking/me", get(ranking_me))
        .route("/api/calculator/me", get(calculator_me))
        .route("/api/calculator/ai-analyze", post(calculator_ai_analyze))
        .route("/api/black-market/state", get(bm_state))
        .route("/api/black-market/listings", get(bm_listings))
        .route("/api/black-market/my-listings", get(bm_my_listings))
        .route("/api/black-market/escrow", get(bm_escrow))
        .route("/api/black-market/history", get(bm_history))
        .route("/api/black-market/sell", post(bm_sell))
        .route("/api/black-market/cancel", post(bm_cancel))
        .route("/api/black-market/reserve", post(bm_reserve))
        .route("/api/black-market/cancel-reserve", post(bm_cancel_reserve))
        .route("/api/black-market/buy", post(bm_buy))
        .route("/api/black-market/claim", post(bm_claim))
        .route("/api/black-market/claim-all", post(bm_claim_all))
        .route("/api/black-market/claim-item", post(bm_claim_item))
        .route("/api/servers/racks/place", post(intent_place))
        .route("/api/servers/racks/{rack_id}/remove", post(intent_remove))
        .route(
            "/api/servers/racks/{rack_id}/miners/equip",
            post(intent_miner_equip),
        )
        .route(
            "/api/servers/racks/{rack_id}/miners/unequip",
            post(intent_miner_unequip),
        )
        .route(
            "/api/servers/racks/{rack_id}/aux/equip",
            post(intent_aux_equip),
        )
        .route(
            "/api/servers/racks/{rack_id}/aux/unequip",
            post(intent_aux_unequip),
        )
        .route(
            "/api/servers/rigs/{rig_id}/slots/{slot_id}/equip-battery",
            post(intent_equip_battery),
        )
        .route(
            "/api/servers/rigs/{rig_id}/slots/{slot_id}/remove-battery",
            post(intent_remove_battery),
        )
        .route("/api/game/save-servers", post(save_servers))
        .route("/api/server-room/room-coins", post(room_coins))
        .route("/api/server-room/bulk-batteries", post(bulk_batteries))
        .route("/api/shop/checkout", post(shop_checkout))
        .route("/api/merge/execute", post(merge_execute))
        .route("/api/upgrades/purchase", post(upgrades_purchase))
        .route("/api/rig-rooms/purchase-slot", post(rooms_purchase_slot))
        .route("/api/lucky-boxes/purchase", post(lucky_buy))
        .route("/api/lucky-boxes/open", post(lucky_open))
        .route(
            "/api/lucky-boxes/promocodes/redeem",
            post(lucky_promo_redeem),
        )
        .route("/api/wheel/spin", post(wheel_paid_spin))
        .route("/api/wheel/redeem-code", post(wheel_redeem_code))
        .route("/api/wheel/roll", post(wheel_roll))
        .route("/api/roleta/claim", post(roleta_claim))
        .route("/api/wallet/exchange/liquidate", post(wallet_liquidate))
        .route("/api/withdraw", post(wallet_withdraw))
        .route("/api/deposit/verify", post(deposit_verify))
        .route(
            "/zeradsptc.php",
            get(offerwall_callback).post(offerwall_callback),
        )
        .route("/api/zerads/me/token", get(zerads_me_token))
        .route("/api/zerads/me/stats", get(zerads_me_stats))
}

async fn require_uid(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<i64, axum::response::Response> {
    require_player(state, headers).await
}

async fn get_game_state_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, GAME_STATE_ME_WORKER_PATH, json!({ "userId": uid })).await
}

async fn inventory_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, INVENTORY_STATE_PATH, json!({ "userId": uid })).await
}

async fn inventory_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, INVENTORY_ME_PATH, json!({ "userId": uid })).await
}

async fn shop_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, SHOP_STATE_PATH, json!({ "userId": uid })).await
}

async fn shop_products(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        SHOP_STATE_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => json_status(
            HTTP_OK,
            json!({
                "version": r.body.get("version").cloned().unwrap_or(json!(SHOP_STATE_VERSION)),
                "products": r.body.get("products").cloned().unwrap_or(json!([])),
                "hardwareMarketEnabled": r.body.get("hardwareMarketEnabled").cloned().unwrap_or(json!(true)),
            }),
        ),
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware(&state, SHOP_PRODUCTS_PATH, json!({ "userId": uid })).await,
    }
}

async fn shop_product_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(product_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        SHOP_STATE_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let products = r.body.get("products").and_then(|v| v.as_array()).cloned();
            if let Some(found) = products.and_then(|ps| {
                ps.into_iter()
                    .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(product_id.as_str()))
            }) {
                json_status(HTTP_OK, found)
            } else {
                json_status(
                    HTTP_NOT_FOUND,
                    json!({ "error": "Product not found.", "code": "NOT_FOUND" }),
                )
            }
        }
        Ok(r) => worker_to_response(r),
        Err(_) => {
            crate::facade::forward_hardware(&state, SHOP_STATE_PATH, json!({ "userId": uid })).await
        }
    }
}

async fn shop_cart_set(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, SHOP_CART_SET_PATH, merge_user_id(body, uid)).await
}

async fn shop_cart_set_line(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut payload = merge_user_id(body, uid);
    if let Value::Object(ref mut m) = payload {
        m.insert("lineId".into(), json!(line_id));
    }
    forward_hardware(&state, SHOP_CART_SET_LINE_PATH, payload).await
}

async fn shop_cart_delete_line(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        SHOP_CART_DELETE_LINE_PATH,
        json!({ "userId": uid, "lineId": line_id }),
    )
    .await
}

async fn shop_cart_clear(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, SHOP_CART_CLEAR_PATH, json!({ "userId": uid })).await
}

async fn wallet_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_wallet(&state, WALLET_STATE_PATH, json!({ "userId": uid })).await
}

async fn wallet_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = body {
            m.insert("limit".into(), json!(lim));
        }
    }
    forward_wallet(&state, WALLET_HISTORY_PATH, body).await
}

async fn withdrawals_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = body {
            m.insert("limit".into(), json!(lim));
        }
    }
    forward_wallet(&state, WITHDRAWALS_HISTORY_PATH, body).await
}

async fn deposits_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = body {
            m.insert("limit".into(), json!(lim));
        }
    }
    forward_wallet(&state, DEPOSITS_HISTORY_PATH, body).await
}

async fn web3_settings(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_wallet(&state, WEB3_SETTINGS_PATH, json!({})).await
}

async fn checkin_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(&state, CHECKIN_STATUS_PATH, json!({ "userId": uid })).await
}

async fn checkin_perform(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(&state, CHECKIN_PERFORM_PATH, json!({ "userId": uid })).await
}

async fn quests_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(&state, QUESTS_STATE_PATH, json!({ "userId": uid })).await
}

async fn quests_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let quest_id = body
        .get("questId")
        .or_else(|| body.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    match crate::workers::post_wallet(
        &state.cfg,
        &state.http,
        WALLET_QUEST_CLAIM_PATH,
        &json!({ "userId": uid, "questId": quest_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => json_status(
            HTTP_OK,
            json!({
                "ok": true,
                "rewardUsdc": r.body.get("rewardUsdc").cloned().unwrap_or(json!(0.0)),
                "newUsdc": r.body.get("newUsdc").cloned().unwrap_or(json!(0.0)),
                "questId": quest_id
            }),
        ),
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err_response(e),
    }
}

async fn lucky_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, LUCKY_STATE_PATH, json!({ "userId": uid })).await
}

async fn lucky_shop(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        LUCKY_SHOP_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let mut body = r.body;
            if let Value::Object(ref mut m) = body {
                m.entry("version").or_insert(json!(LUCKY_STATE_VERSION));
            }
            json_status(HTTP_OK, body)
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware(&state, LUCKY_SHOP_PATH, json!({ "userId": uid })).await,
    }
}

async fn lucky_inventory(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        LUCKY_INVENTORY_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let mut body = r.body;
            if let Value::Object(ref mut m) = body {
                m.entry("version").or_insert(json!(LUCKY_STATE_VERSION));
            }
            json_status(HTTP_OK, body)
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware(&state, LUCKY_INVENTORY_PATH, json!({ "userId": uid })).await,
    }
}

async fn lucky_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut payload = json!({ "userId": uid });
    if let Some(c) = q.cursor.as_deref().filter(|s| !s.is_empty()) {
        if let Value::Object(ref mut m) = payload {
            m.insert("cursor".into(), json!(c));
        }
    }
    match crate::workers::post_hardware(&state.cfg, &state.http, LUCKY_HISTORY_PATH, &payload).await
    {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            let limit = r
                .body
                .get("limit")
                .cloned()
                .unwrap_or(json!(LUCKY_HISTORY_PAGE_SIZE));
            let next = r.body.get("nextCursor").cloned().unwrap_or(Value::Null);
            json_status(
                HTTP_OK,
                json!({
                    "version": LUCKY_STATE_VERSION,
                    "items": items,
                    "limit": limit,
                    "offset": 0,
                    "hasMore": !next.is_null(),
                    "nextCursor": next,
                }),
            )
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware(&state, LUCKY_HISTORY_PATH, payload).await,
    }
}

async fn lucky_opening(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(opening_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        LUCKY_OPENING_PATH,
        json!({ "userId": uid, "openingId": opening_id }),
    )
    .await
}

async fn lucky_discard(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, LUCKY_DISCARD_PATH, merge_user_id(body, uid)).await
}

async fn wheel_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, WHEEL_STATE_PATH, json!({ "userId": uid })).await
}

async fn wheel_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut payload = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = payload {
            m.insert("limit".into(), json!(lim));
        }
    }
    match crate::workers::post_hardware(&state.cfg, &state.http, WHEEL_HISTORY_PATH, &payload).await
    {
        Ok(r) if r.status == HTTP_OK => {
            let items = r
                .body
                .get("items")
                .cloned()
                .or_else(|| r.body.get("history").cloned())
                .unwrap_or(json!([]));
            json_status(
                HTTP_OK,
                json!({
                    "ok": true,
                    "items": items,
                    "nextCursor": r.body.get("nextCursor").cloned().unwrap_or(Value::Null),
                }),
            )
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware(&state, WHEEL_HISTORY_PATH, payload).await,
    }
}

const MINING_PROGRESS_PATH: &str = "/v1/mining/progress";

async fn servers_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    // Node `state-snapshot.ts` credits mining progress before building the
    // snapshot (`computeProgressForUser` → `/v1/mining/progress`). Best-effort:
    // the worker is idempotent per commit bucket; a failure just means this
    // snapshot is slightly behind.
    if let Err(e) = crate::workers::post_mining(
        &state.cfg,
        &state.http,
        MINING_PROGRESS_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        tracing::warn!(err = %e.message(), uid, "servers/state mining progress credit (non-fatal)");
    }
    forward_hardware(&state, SERVERS_STATE_PATH, json!({ "userId": uid })).await
}

async fn player_game_header(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        HEADER_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let mut body = r.body;
            if let Value::Object(ref mut m) = body {
                m.insert("ok".into(), json!(true));
                m.entry("miningCoins").or_insert(json!([]));
                m.entry("headerHighlightCoinId").or_insert(json!(""));
            }
            json_status(HTTP_OK, body)
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_mining(&state, HEADER_PATH, json!({ "userId": uid })).await,
    }
}

async fn player_game_header_highlight(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let coin_id = body
        .get("coinId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    forward_mining(
        &state,
        HEADER_HIGHLIGHT_PATH,
        json!({ "userId": uid, "coinId": coin_id }),
    )
    .await
}

async fn player_game_nav(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ManagingQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let managing = truthy_flag(q.managing.as_deref());
    forward_mining(
        &state,
        NAV_PATH,
        json!({ "userId": uid, "managing": managing }),
    )
    .await
}

async fn catalog_upgrades(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let cookies = crate::session::cookies_from_req(&headers);
    let uid = match crate::session::resolve_user_id(&state, &cookies).await {
        Ok(Some((id, _))) => Some(id),
        Ok(None) => None,
        Err(e) => return e,
    };
    let mut body = json!({});
    if let Some(id) = uid {
        body = json!({ "userId": id });
    }
    forward_hardware(&state, CATALOG_UPGRADES_PATH, body).await
}

async fn catalog_mining_coins(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LegacyQ>,
) -> axum::response::Response {
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        CATALOG_MINING_COINS_PATH,
        &json!({}),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            if truthy_flag(q.legacy.as_deref()) {
                json_status(HTTP_OK, items)
            } else {
                json_status(
                    HTTP_OK,
                    json!({
                        "coins": items,
                        "economy": { "source": MINING_ECONOMY_SOURCE, "livePrices": false },
                        "livePricesError": Value::Null,
                    }),
                )
            }
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_hardware_items(&state, CATALOG_MINING_COINS_PATH, json!({})).await,
    }
}

async fn catalog_access_levels(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware_items(&state, CATALOG_ACCESS_LEVELS_PATH, json!({})).await
}

async fn catalog_loot_boxes(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware_items(&state, CATALOG_LOOT_BOXES_PATH, json!({})).await
}

async fn economy_settings(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, ECONOMY_SETTINGS_PATH, json!({})).await
}

async fn exchange_settings(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, EXCHANGE_SETTINGS_PATH, json!({})).await
}

async fn monetization_settings(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, MONETIZATION_SETTINGS_PATH, json!({})).await
}

async fn display_labels(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, DISPLAY_LABELS_PATH, json!({})).await
}

async fn news_list(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware_items(&state, NEWS_LIST_PATH, json!({})).await
}

async fn news_fee(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware(&state, NEWS_FEE_PATH, json!({})).await
}

async fn news_expire_days(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware(&state, NEWS_EXPIRE_DAYS_PATH, json!({})).await
}

async fn season_passes(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware_items(&state, SEASON_PASSES_PATH, json!({})).await
}

async fn guide(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, GUIDE_PATH, json!({})).await
}

async fn roadmap(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, ROADMAP_PATH, json!({})).await
}

async fn transparency(State(state): State<Arc<AppState>>) -> axum::response::Response {
    match crate::workers::post_mining(&state.cfg, &state.http, TRANSPARENCY_PATH, &json!({})).await
    {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, items)
        }
        Ok(r) => worker_to_response(r),
        Err(_) => forward_mining(&state, TRANSPARENCY_PATH, json!({})).await,
    }
}

async fn transparency_health(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_mining(&state, TRANSPARENCY_HEALTH_PATH, json!({})).await
}

async fn rig_rooms(State(state): State<Arc<AppState>>) -> axum::response::Response {
    forward_hardware_items(&state, RIG_ROOMS_PATH, json!({})).await
}

async fn my_rig_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(email): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let email = email.trim().to_lowercase();
    if !is_valid_my_rooms_email(&email) {
        return json_status(
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid email.", "code": "VALIDATION" }),
        );
    }
    match crate::workers::post_hardware(
        &state.cfg,
        &state.http,
        MY_RIG_ROOMS_PATH,
        &json!({ "userId": uid, "email": email }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, items)
        }
        Ok(r) if r.status == HTTP_FORBIDDEN => json_status(
            HTTP_FORBIDDEN,
            json!({ "error": "Access denied.", "code": "FORBIDDEN" }),
        ),
        Ok(r) => worker_to_response(r),
        Err(_) => {
            forward_hardware(
                &state,
                MY_RIG_ROOMS_PATH,
                json!({ "userId": uid, "email": email }),
            )
            .await
        }
    }
}

fn is_valid_my_rooms_email(email: &str) -> bool {
    if email.is_empty() || email.len() > EMAIL_MAX {
        return false;
    }
    !email.bytes().any(|b| b < 0x20 || b == b'<' || b == b'>')
}

async fn merge_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    if let Err(e) = require_uid(&state, &headers).await {
        return e;
    }
    forward_hardware(&state, MERGE_CONFIG_PATH, json!({})).await
}

async fn merge_inventory(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, MERGE_INVENTORY_PATH, json!({ "userId": uid })).await
}

async fn merge_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = body {
            m.insert("limit".into(), json!(lim));
        }
    }
    forward_hardware(&state, MERGE_HISTORY_PATH, body).await
}

async fn upgrades_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, UPGRADES_STATE_PATH, json!({ "userId": uid })).await
}

async fn upgrades_purchases(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        if let Value::Object(ref mut m) = body {
            m.insert("limit".into(), json!(lim));
        }
    }
    forward_hardware(&state, UPGRADES_PURCHASES_PATH, body).await
}

async fn shop_order(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(order_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        SHOP_ORDER_PATH,
        json!({ "userId": uid, "orderId": order_id }),
    )
    .await
}

async fn wheel_spin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(spin_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        WHEEL_SPIN_PATH,
        json!({ "userId": uid, "spinId": spin_id }),
    )
    .await
}

async fn roleta_pending_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, ROLETA_PENDING_CODE_PATH, json!({ "userId": uid })).await
}

async fn profile_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_STATE_PATH,
        json!({ "userId": uid, "inviteBaseUrl": invite_base_url_from_headers(&headers) }),
    )
    .await
}

fn invite_base_url_from_headers(headers: &HeaderMap) -> String {
    for key in ["FRONTEND_URL", "PUBLIC_URL", "SITE_URL", "VITE_APP_URL"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| {
            let lower = s.to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        })
        .unwrap_or("")
        .to_string()
}

fn profile_request_id(headers: &HeaderMap) -> String {
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(PROFILE_REQUEST_ID_MAX_CHARS).collect())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

async fn profile_identity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = profile_rate_key(&ip, SCOPE_PROFILE_IDENTITY, uid);
    if let Some(limited) = enforce(
        &state,
        &key,
        PROFILE_IDENTITY_LIMIT_MAX,
        PROFILE_RATE_LIMIT_WINDOW_MS,
        PROFILE_IDENTITY_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    let username = body
        .get("username")
        .cloned()
        .or_else(|| body.get("displayName").cloned())
        .unwrap_or(Value::Null);
    forward_mining(
        &state,
        PROFILE_IDENTITY_PATH,
        json!({
            "userId": uid,
            "username": username,
            "requestId": profile_request_id(&headers),
            "route": "/api/profile/identity"
        }),
    )
    .await
}

async fn profile_password_change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = profile_rate_key(&ip, SCOPE_PROFILE_PASSWORD, uid);
    if let Some(limited) = enforce(
        &state,
        &key,
        PROFILE_PASSWORD_LIMIT_MAX,
        PROFILE_RATE_LIMIT_WINDOW_MS,
        PROFILE_PASSWORD_RATE_MSG,
    )
    .await
    {
        return limited;
    }
    forward_mining(
        &state,
        PROFILE_PASSWORD_CHANGE_PATH,
        json!({
            "userId": uid,
            "currentPassword": body.get("currentPassword"),
            "newPassword": body.get("newPassword"),
            "confirmPassword": body.get("confirmPassword"),
            "requestId": profile_request_id(&headers),
            "route": "/api/profile/password/change"
        }),
    )
    .await
}

async fn profile_security_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_SECURITY_EVENTS_PATH,
        json!({ "userId": uid, "limit": PROFILE_SECURITY_EVENTS_LIMIT }),
    )
    .await
}

async fn profile_wallet_challenge(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_WALLET_CHALLENGE_PATH,
        json!({ "userId": uid }),
    )
    .await
}

async fn profile_wallet_verify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    forward_mining(
        &state,
        PROFILE_WALLET_VERIFY_PATH,
        json!({
            "userId": uid,
            "challengeId": body.get("challengeId"),
            "address": body.get("address"),
            "signature": body.get("signature"),
            "chainId": body.get("chainId"),
            "requestId": profile_request_id(&headers),
            "route": "/api/profile/wallet/connect/verify",
            "clientIp": get_client_ip(&state.cfg, &headers, None),
            "userAgent": ua
        }),
    )
    .await
}

#[derive(Deserialize, Default)]
struct ProfileWalletLimitQ {
    #[serde(default)]
    limit: Option<String>,
}

async fn profile_wallet_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ProfileWalletLimitQ>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let lim = q
        .limit
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(PROFILE_WALLET_HISTORY_LIMIT_DEFAULT)
        .clamp(1, PROFILE_WALLET_HISTORY_LIMIT_MAX);
    forward_mining(
        &state,
        PROFILE_WALLET_GET_PATH,
        json!({ "userId": uid, "historyLimit": lim }),
    )
    .await
}

async fn profile_wallet_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    req: Request<Body>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let route = if req.method() == axum::http::Method::DELETE {
        "DELETE /api/profile/wallet"
    } else {
        "POST /api/profile/wallet/remove"
    };
    let ua = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    forward_mining(
        &state,
        PROFILE_WALLET_REMOVE_PATH,
        json!({
            "userId": uid,
            "requestId": profile_request_id(&headers),
            "route": route,
            "clientIp": get_client_ip(&state.cfg, &headers, None),
            "userAgent": ua
        }),
    )
    .await
}

async fn profile_referral_bind(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_REFERRAL_BIND_PATH,
        json!({
            "userId": uid,
            "code": body.get("code"),
            "requestId": profile_request_id(&headers),
            "route": "/api/profile/referral/bind"
        }),
    )
    .await
}

async fn profile_referral_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_REFERRAL_STATE_PATH,
        json!({
            "userId": uid,
            "inviteBaseUrl": invite_base_url_from_headers(&headers)
        }),
    )
    .await
}

async fn profile_referral_overview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_uid(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        PROFILE_REFERRAL_OVERVIEW_PATH,
        json!({
            "userId": uid,
            "inviteBaseUrl": invite_base_url_from_headers(&headers),
            "historyLimit": PROFILE_OVERVIEW_HISTORY_LIMIT
        }),
    )
    .await
}

async fn chat_peers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(&state, CHAT_PEERS_PATH, json!({ "userId": uid })).await
}

async fn chat_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ChatHistoryQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let channel = q
        .channel
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(CHAT_CHANNEL_GLOBAL);
    let access = crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_CAN_ACCESS_PATH,
        &json!({ "userId": uid, "channel": channel }),
    )
    .await;
    match access {
        Ok(r) if r.body["ok"] == true && r.body["allowed"] == true => {}
        Ok(r) if r.body["ok"] == true => {
            return json_status(
                403,
                json!({ "error": "No access to this channel.", "code": "FORBIDDEN" }),
            );
        }
        Ok(r) => return worker_to_response(r),
        Err(e) => {
            return json_status(
                crate::workers::worker_infra_status(&e),
                crate::workers::worker_unavailable_body(&e),
            );
        }
    }
    let mut body = json!({ "channel": channel });
    if let Some(lim) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        body["limit"] = json!(lim);
    }
    forward_mining(&state, CHAT_HISTORY_PATH, body).await
}

async fn chat_mentions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<MentionsQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let query = q.q.clone().or(q.query).unwrap_or_default();
    forward_mining(
        &state,
        CHAT_MENTIONS_SEARCH_PATH,
        json!({ "q": query, "excludeUserId": uid }),
    )
    .await
}

async fn chat_insert(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let channel = body
        .get("channel")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(CHAT_CHANNEL_GLOBAL);
    let text = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if text.is_empty() {
        return json_status(400, json!({ "error": "Empty message.", "code": "EMPTY" }));
    }
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_CAN_ACCESS_PATH,
        &json!({ "userId": uid, "channel": channel }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true && r.body["allowed"] == true => {}
        Ok(r) if r.body["ok"] == true => {
            return json_status(
                403,
                json!({ "error": "No access to this channel.", "code": "FORBIDDEN" }),
            );
        }
        Ok(r) => return worker_to_response(r),
        Err(e) => {
            return json_status(
                crate::workers::worker_infra_status(&e),
                crate::workers::worker_unavailable_body(&e),
            );
        }
    }
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_RATE_LIMIT_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => {}
        Ok(r) => return worker_to_response(r),
        Err(e) => {
            return json_status(
                crate::workers::worker_infra_status(&e),
                crate::workers::worker_unavailable_body(&e),
            );
        }
    }
    let sender = match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_SENDER_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            return json_status(
                crate::workers::worker_infra_status(&e),
                crate::workers::worker_unavailable_body(&e),
            );
        }
    };
    let username = sender.body["username"]
        .as_str()
        .or_else(|| sender.body["sender"]["username"].as_str())
        .unwrap_or("")
        .to_string();
    if username.is_empty() {
        return json_status(401, json!({ "error": "Invalid user." }));
    }
    forward_mining(
        &state,
        CHAT_INSERT_PATH,
        json!({
            "userId": uid,
            "username": username,
            "body": text,
            "channel": channel
        }),
    )
    .await
}

async fn chat_edit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let text = body
        .get("body")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    forward_mining(
        &state,
        CHAT_EDIT_PATH,
        merge_user_id(json!({ "messageId": id, "body": text }), uid),
    )
    .await
}

async fn chat_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        CHAT_DELETE_PATH,
        merge_user_id(json!({ "messageId": id }), uid),
    )
    .await
}

pub(crate) fn is_multipart(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase()
        .starts_with("multipart/")
}

fn worker_err_response(e: crate::workers::WorkerCallError) -> axum::response::Response {
    json_status(
        crate::workers::worker_infra_status(&e),
        crate::workers::worker_unavailable_body(&e),
    )
}

async fn chat_gate_access(
    state: &AppState,
    uid: i64,
    channel: &str,
) -> Result<(), axum::response::Response> {
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_CAN_ACCESS_PATH,
        &json!({ "userId": uid, "channel": channel }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true && r.body["allowed"] == true => Ok(()),
        Ok(r) if r.body["ok"] == true => Err(json_status(
            403,
            json!({ "error": "No access to this channel.", "code": "FORBIDDEN" }),
        )),
        Ok(r) => Err(worker_to_response(r)),
        Err(e) => Err(worker_err_response(e)),
    }
}

async fn chat_gate_rate(state: &AppState, uid: i64) -> Result<(), axum::response::Response> {
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_RATE_LIMIT_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) if r.body["ok"] == true => Ok(()),
        Ok(r) => Err(worker_to_response(r)),
        Err(e) => Err(worker_err_response(e)),
    }
}

async fn chat_load_username(
    state: &AppState,
    uid: i64,
) -> Result<String, axum::response::Response> {
    let sender = match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_SENDER_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return Err(worker_err_response(e)),
    };
    let username = sender.body["username"]
        .as_str()
        .or_else(|| sender.body["sender"]["username"].as_str())
        .unwrap_or("")
        .to_string();
    if username.is_empty() {
        return Err(json_status(401, json!({ "error": "Invalid user." })));
    }
    Ok(username)
}

fn chat_message_from_insert(body: &Value) -> Value {
    if let Some(row) = body.get("row").cloned().filter(|v| !v.is_null()) {
        let username = row
            .get("username")
            .cloned()
            .or_else(|| row.get("usernameSnapshot").cloned())
            .unwrap_or(json!(""));
        let mut msg = row;
        if let Value::Object(ref mut m) = msg {
            m.entry("username".to_string()).or_insert(username);
        }
        return msg;
    }
    body.get("message").cloned().unwrap_or_else(|| body.clone())
}

async fn chat_audio(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut audio_bytes: Option<bytes::Bytes> = None;
    let mut original_name = String::from("audio.webm");
    let mut mime = String::new();
    let mut channel = CHAT_CHANNEL_GLOBAL.to_string();
    let mut duration_raw: Option<i64> = None;
    while let Some(field) = match multipart.next_field().await {
        Ok(f) => f,
        Err(e) => {
            return json_status(400, json!({ "error": e.to_string(), "code": "UPLOAD" }));
        }
    } {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "audio" | "file" => {
                if let Some(fnm) = field.file_name() {
                    original_name = fnm.to_string();
                }
                if let Some(ct) = field.content_type() {
                    mime = ct.to_string();
                }
                match field.bytes().await {
                    Ok(b) => audio_bytes = Some(b),
                    Err(e) => {
                        return json_status(
                            400,
                            json!({ "error": e.to_string(), "code": "UPLOAD" }),
                        );
                    }
                }
            }
            "channel" => {
                if let Ok(t) = field.text().await {
                    let c = t.trim();
                    if !c.is_empty() {
                        channel = c.to_string();
                    }
                }
            }
            "durationMs" => {
                if let Ok(t) = field.text().await {
                    duration_raw = t.trim().parse().ok();
                }
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    let Some(audio) = audio_bytes.filter(|b| !b.is_empty()) else {
        return json_status(
            400,
            json!({ "error": "Audio file missing.", "code": "EMPTY" }),
        );
    };
    if let Err(e) = chat_gate_access(&state, uid, &channel).await {
        return e;
    }
    let Some(raw) = duration_raw else {
        return json_status(
            400,
            json!({ "error": "Audio too short.", "code": "DURATION" }),
        );
    };
    if raw < AUDIO_DURATION_MIN_MS {
        return json_status(
            400,
            json!({ "error": "Audio too short.", "code": "DURATION" }),
        );
    }
    if raw > CHAT_AUDIO_MAX_DURATION_MS + AUDIO_DURATION_GRACE_MS {
        return json_status(
            400,
            json!({ "error": "Maximum audio length: 30 seconds.", "code": "DURATION" }),
        );
    }
    let duration_ms = raw.clamp(AUDIO_DURATION_FLOOR_MS, CHAT_AUDIO_MAX_DURATION_MS);
    if let Err(e) = chat_gate_rate(&state, uid).await {
        return e;
    }
    let username = match chat_load_username(&state, uid).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let part = match reqwest::multipart::Part::bytes(audio.to_vec())
        .file_name(original_name.clone())
        .mime_str(if mime.is_empty() {
            "application/octet-stream"
        } else {
            mime.as_str()
        }) {
        Ok(p) => p,
        Err(_) => reqwest::multipart::Part::bytes(audio.to_vec()).file_name(original_name.clone()),
    };
    let form = reqwest::multipart::Form::new()
        .part("audio", part)
        .text("originalName", original_name)
        .text("mime", mime);
    let uploaded = match post_mining_multipart(
        &state.cfg,
        &state.http,
        UPLOAD_CHAT_AUDIO_PATH,
        form,
        MINING_WORKER_PROGRESS_TIMEOUT_MS,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return worker_err_response(e),
    };
    if uploaded.body["ok"] != true {
        return worker_to_response(uploaded);
    }
    let public_url = uploaded.body["publicUrl"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if public_url.is_empty() {
        return json_status(400, json!({ "error": "Upload failed.", "code": "UPLOAD" }));
    }
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        CHAT_INSERT_PATH,
        &json!({
            "userId": uid,
            "username": username,
            "body": "",
            "channel": channel,
            "kind": CHAT_KIND_AUDIO,
            "audioUrl": public_url,
            "durationMs": duration_ms
        }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let message = chat_message_from_insert(&r.body);
            state.emit_chat_message(channel.clone(), message.clone());
            json_status(HTTP_OK, json!({ "ok": true, "message": message }))
        }
        Ok(r) => worker_to_response(r),
        Err(e) => worker_err_response(e),
    }
}

async fn support_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    // Worker `SupportStateRequest.limit` is i64 — parse the query string.
    if let Some(l) = q.limit.as_deref().and_then(|s| s.trim().parse::<i64>().ok()) {
        body["limit"] = json!(l);
    }
    if let Some(c) = q.cursor {
        body["cursor"] = json!(c);
    }
    forward_mining(&state, SUPPORT_STATE_PATH, body).await
}

async fn support_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(l) = q.limit {
        body["limit"] = json!(l);
    }
    if let Some(c) = q.cursor {
        body["cursor"] = json!(c);
    }
    forward_mining(&state, SUPPORT_LIST_MINE_PATH, body).await
}

async fn support_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        SUPPORT_GET_PATH,
        json!({ "userId": uid, "ticketId": ticket_id }),
    )
    .await
}

struct SupportFilePart {
    original_name: String,
    mime: String,
    bytes: Vec<u8>,
}

fn support_part(bytes: Vec<u8>, original: &str, mime: &str) -> reqwest::multipart::Part {
    let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(original.to_string());
    if mime.is_empty() {
        return part;
    }
    part.mime_str(mime)
        .unwrap_or_else(|_| reqwest::multipart::Part::bytes(bytes).file_name(original.to_string()))
}

async fn upload_support_file(
    state: &AppState,
    uid: i64,
    name_prefix: &str,
    file: SupportFilePart,
) -> Result<Value, axum::response::Response> {
    let original: String = file
        .original_name
        .chars()
        .take(ORIGINAL_NAME_MAX_LEN)
        .collect();
    let mime: String = file.mime.chars().take(MIME_MAX_LEN).collect();
    let form = reqwest::multipart::Form::new()
        .part("file", support_part(file.bytes, &original, &mime))
        .text("originalName", original.clone())
        .text("mime", mime.clone())
        .text("userId", uid.to_string())
        .text("namePrefix", name_prefix.to_string());
    let uploaded = match post_mining_multipart(
        &state.cfg,
        &state.http,
        UPLOAD_SUPPORT_ATTACHMENT_PATH,
        form,
        MINING_WORKER_SUPPORT_TIMEOUT_MS,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return Err(worker_err_response(e)),
    };
    if uploaded.body["ok"] != true {
        return Err(worker_to_response(uploaded));
    }
    let public_url = uploaded.body["publicUrl"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let stored = uploaded.body["storedName"].as_str().unwrap_or("");
    if public_url.is_empty() {
        return Err(json_status(
            400,
            json!({ "error": "Upload failed.", "code": "UPLOAD" }),
        ));
    }
    Ok(json!({
        "url": public_url,
        "originalName": if original.is_empty() { stored } else { original.as_str() },
        "mime": mime
    }))
}

pub(crate) async fn parse_support_multipart(
    state: &AppState,
    uid: i64,
    name_prefix: &str,
    mut multipart: Multipart,
) -> Result<(String, String, Option<String>, Option<String>, Vec<Value>), axum::response::Response> {
    let mut subject = String::new();
    let mut message = String::new();
    let mut idempotency_key: Option<String> = None;
    let mut ticket_id: Option<String> = None;
    let mut files: Vec<SupportFilePart> = Vec::new();
    while let Some(field) = match multipart.next_field().await {
        Ok(f) => f,
        Err(e) => {
            return Err(json_status(
                400,
                json!({ "error": e.to_string(), "code": "UPLOAD" }),
            ));
        }
    } {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "files" | "file" => {
                if files.len() >= SUPPORT_UPLOAD_MAX_FILES {
                    continue;
                }
                let original_name = field.file_name().unwrap_or("file.bin").to_string();
                let mime = field.content_type().unwrap_or("").to_string();
                let bytes = match field.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        return Err(json_status(
                            400,
                            json!({ "error": e.to_string(), "code": "UPLOAD" }),
                        ));
                    }
                };
                if !bytes.is_empty() {
                    files.push(SupportFilePart {
                        original_name,
                        mime,
                        bytes,
                    });
                }
            }
            "subject" => {
                if let Ok(t) = field.text().await {
                    subject = t;
                }
            }
            "message" => {
                if let Ok(t) = field.text().await {
                    message = t;
                }
            }
            "idempotencyKey" => {
                if let Ok(t) = field.text().await {
                    let t = t.trim().to_string();
                    if !t.is_empty() {
                        idempotency_key = Some(t);
                    }
                }
            }
            "ticketId" => {
                if let Ok(t) = field.text().await {
                    let t = t.trim().to_string();
                    if !t.is_empty() {
                        ticket_id = Some(t);
                    }
                }
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }
    let mut attachments = Vec::new();
    for file in files {
        attachments.push(upload_support_file(state, uid, name_prefix, file).await?);
    }
    Ok((subject, message, idempotency_key, ticket_id, attachments))
}

async fn support_submit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    if is_multipart(&headers) {
        let multipart = match Multipart::from_request(request, &state).await {
            Ok(m) => m,
            Err(e) => {
                return json_status(400, json!({ "error": e.to_string(), "code": "UPLOAD" }));
            }
        };
        let (subject, message, idem, _ticket_id, attachments) =
            match parse_support_multipart(&state, uid, "support", multipart).await {
                Ok(v) => v,
                Err(e) => return e,
            };
        let mut payload = json!({
            "userId": uid,
            "subject": subject,
            "message": message,
            "attachments": attachments
        });
        if let Some(k) = idem {
            payload["idempotencyKey"] = json!(k);
        }
        return forward_mining(&state, SUPPORT_SUBMIT_PATH, payload).await;
    }
    let bytes = match to_bytes(request.into_body(), SUPPORT_MULTIPART_BODY_LIMIT_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return json_status(
                400,
                json!({ "error": "Invalid JSON.", "code": "VALIDATION" }),
            );
        }
    };
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    forward_mining(&state, SUPPORT_SUBMIT_PATH, merge_user_id(body, uid)).await
}

async fn support_reply(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
    request: Request<Body>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let ticket_id: String = ticket_id
        .trim()
        .chars()
        .take(TICKET_ID_MAX_LENGTH)
        .collect();
    if is_multipart(&headers) {
        let multipart = match Multipart::from_request(request, &state).await {
            Ok(m) => m,
            Err(e) => {
                return json_status(400, json!({ "error": e.to_string(), "code": "UPLOAD" }));
            }
        };
        let (_subject, message, idem, _ticket_id, attachments) =
            match parse_support_multipart(&state, uid, "support-reply", multipart).await {
                Ok(v) => v,
                Err(e) => return e,
            };
        let mut payload = json!({
            "userId": uid,
            "ticketId": ticket_id,
            "message": message,
            "attachments": attachments
        });
        if let Some(k) = idem {
            payload["idempotencyKey"] = json!(k);
        }
        return forward_mining(&state, SUPPORT_REPLY_PATH, payload).await;
    }
    let bytes = match to_bytes(request.into_body(), SUPPORT_MULTIPART_BODY_LIMIT_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return json_status(
                400,
                json!({ "error": "Invalid JSON.", "code": "VALIDATION" }),
            );
        }
    };
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    let mut payload = merge_user_id(body, uid);
    payload["ticketId"] = json!(ticket_id);
    forward_mining(&state, SUPPORT_REPLY_PATH, payload).await
}

async fn support_archive(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        SUPPORT_ARCHIVE_PATH,
        json!({ "userId": uid, "ticketId": ticket_id }),
    )
    .await
}

async fn support_reopen(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        SUPPORT_REOPEN_PATH,
        json!({ "userId": uid, "ticketId": ticket_id }),
    )
    .await
}

async fn announcements_pending(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        ANNOUNCEMENTS_PENDING_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) => {
            let mut body = r.body.clone();
            if body.get("announcements").is_none() {
                if let Some(rows) = body.get("rows").cloned() {
                    body["announcements"] = rows;
                }
            }
            worker_to_response(crate::workers::WorkerJson {
                status: r.status,
                body,
            })
        }
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

async fn mini_blog(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    match crate::workers::post_mining(
        &state.cfg,
        &state.http,
        ANNOUNCEMENTS_MINI_BLOG_PATH,
        &json!({ "userId": uid }),
    )
    .await
    {
        Ok(r) => {
            let mut body = r.body.clone();
            if body.get("entries").is_none() {
                if let Some(rows) = body.get("rows").cloned() {
                    body["entries"] = rows;
                }
            }
            worker_to_response(crate::workers::WorkerJson {
                status: r.status,
                body,
            })
        }
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

async fn announcements_dismiss(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_mining(
        &state,
        ANNOUNCEMENTS_MARK_READ_PATH,
        json!({ "userId": uid, "announcementId": id }),
    )
    .await
}

async fn ranking_public(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FreshQ>,
) -> axum::response::Response {
    if let Err(e) = require_player(&state, &headers).await {
        return e;
    }
    let fresh = truthy_flag(q.fresh.as_deref());
    let pq = format!("{RANKING_PUBLIC_PATH}?fresh={fresh}");
    match get_mining(&state.cfg, &state.http, &pq).await {
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

async fn ranking_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<FreshQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let fresh = truthy_flag(q.fresh.as_deref());
    let pq = format!("{RANKING_ME_PATH}?userId={uid}&fresh={fresh}");
    match get_mining(&state.cfg, &state.http, &pq).await {
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

async fn calculator_me(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ScopeQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(scope) = q.scope.filter(|s| !s.is_empty()) {
        body["scope"] = json!(scope);
    }
    forward_mining(&state, CALCULATOR_SNAPSHOT_PATH, body).await
}

#[derive(Debug, Default, Deserialize)]
struct AiAnalyzeBody {
    #[serde(default)]
    scope: Option<String>,
}

async fn calculator_ai_analyze(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<AiAnalyzeBody>>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let ip = get_client_ip(&state.cfg, &headers, None);
    let key = scoped_actor_key(CALCULATOR_AI_RATE_SCOPE, Some(uid), &ip);
    if let Some(resp) = enforce(
        &state,
        &key,
        CALCULATOR_AI_RATE_MAX,
        PARTNER_GAMES_WINDOW_MS,
        CALCULATOR_AI_RATE_MSG,
    )
    .await
    {
        return resp;
    }
    let mut fwd = json!({ "userId": uid });
    if let Some(Json(b)) = body {
        if let Some(scope) = b.scope.filter(|s| !s.trim().is_empty()) {
            fwd["scope"] = json!(scope);
        }
    }
    match crate::workers::post_mining_slow(
        &state.cfg,
        &state.http,
        CALCULATOR_AI_ANALYZE_PATH,
        &fwd,
        crate::config::CALCULATOR_AI_TIMEOUT_MS,
    )
    .await
    {
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        ),
    }
}

async fn bm_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware_bm_state(&state, MARKET_STATE_PATH, json!({ "userId": uid })).await
}

async fn bm_listings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ListingsQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let search = q.search.clone().or(q.q).unwrap_or_default();
    let limit = genesis_core::market_clamp_limit(q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()));
    let offset =
        genesis_core::market_clamp_offset(q.offset.as_deref().and_then(|s| s.parse::<i64>().ok()));
    let body = json!({
        "excludeSellerId": uid,
        "search": search,
        "category": q.category.unwrap_or_default(),
        "type": q.type_filter.unwrap_or_default(),
        "sortPrice": if q.sort.as_deref() == Some("desc") { "desc" } else { "asc" },
        "limit": limit,
        "offset": offset,
    });
    forward_hardware_bm_listings(&state, MARKET_LISTINGS_PATH, body, limit, offset).await
}

async fn bm_my_listings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, MARKET_MY_LISTINGS_PATH, json!({ "userId": uid })).await
}

async fn bm_escrow(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, MARKET_CUSTODY_PATH, json!({ "userId": uid })).await
}

async fn bm_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<LimitCursorQ>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut body = json!({ "userId": uid });
    if let Some(l) = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()) {
        body["limit"] = json!(l);
    }
    forward_hardware(&state, MARKET_HISTORY_PATH, body).await
}

fn listing_id_from(req: &Value, res: &Value) -> Option<String> {
    res.get("listingId")
        .and_then(|v| v.as_str())
        .or_else(|| req.get("listingId").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn market_ok(r: &WorkerJson) -> bool {
    r.status == HTTP_OK && r.body["ok"] == true
}

fn emit_market_event(state: &AppState, event: &str, extra: Value) {
    let mut payload = json!({ "type": "market", "event": event });
    if let (Some(dst), Some(src)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    state.emit_market(payload);
}

async fn forward_hardware_json(
    state: &AppState,
    path: &str,
    body: Value,
) -> Result<WorkerJson, axum::response::Response> {
    match post_hardware(&state.cfg, &state.http, path, &body).await {
        Ok(r) => Ok(r),
        Err(e) => Err(worker_err_response(e)),
    }
}

async fn bm_sell(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let payload = merge_user_id(body.clone(), uid);
    let r = match forward_hardware_json(&state, MARKET_SELL_PATH, payload).await {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) {
        if let Some(listing_id) = listing_id_from(&body, &r.body) {
            emit_market_event(
                &state,
                "listing_created",
                json!({ "listingId": listing_id }),
            );
        }
    }
    worker_to_response(r)
}

async fn bm_cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let listing_id = listing_id_from(&body, &json!({})).unwrap_or_default();
    let r = match forward_hardware_json(&state, MARKET_CANCEL_PATH, merge_user_id(body, uid)).await
    {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) && !listing_id.is_empty() {
        emit_market_event(
            &state,
            "listing_cancelled",
            json!({ "listingId": listing_id }),
        );
    }
    worker_to_response(r)
}

async fn bm_reserve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let listing_id = listing_id_from(&body, &json!({})).unwrap_or_default();
    let r = match forward_hardware_json(&state, MARKET_RESERVE_PATH, merge_user_id(body, uid)).await
    {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) && !listing_id.is_empty() {
        emit_market_event(
            &state,
            "listing_reserved",
            json!({ "listingId": listing_id }),
        );
    }
    worker_to_response(r)
}

async fn bm_cancel_reserve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let listing_id = listing_id_from(&body, &json!({})).unwrap_or_default();
    let r =
        match forward_hardware_json(&state, MARKET_CANCEL_RESERVE_PATH, merge_user_id(body, uid))
            .await
        {
            Ok(r) => r,
            Err(e) => return e,
        };
    // Node emits when cancelReserve returned true; twin returns ok:true on success.
    if market_ok(&r) && !listing_id.is_empty() {
        emit_market_event(
            &state,
            "listing_unreserved",
            json!({ "listingId": listing_id }),
        );
    }
    worker_to_response(r)
}

async fn bm_buy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let listing_id = listing_id_from(&body, &json!({})).unwrap_or_default();
    let mut payload = body;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("buyerId".into(), json!(uid));
        obj.insert("userId".into(), json!(uid));
        if obj.get("qty").is_none() {
            if let Some(quantity) = obj.get("quantity").cloned() {
                obj.insert("qty".into(), quantity);
            }
        }
    }
    let r = match forward_hardware_json(&state, MARKET_BUY_PATH, payload).await {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) && !listing_id.is_empty() {
        emit_market_event(&state, "listing_sold", json!({ "listingId": listing_id }));
    }
    worker_to_response(r)
}

async fn bm_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let r =
        match forward_hardware_json(&state, MARKET_CLAIM_PROCEEDS_PATH, json!({ "userId": uid }))
            .await
        {
            Ok(r) => r,
            Err(e) => return e,
        };
    if market_ok(&r) {
        emit_market_event(&state, "black_market_proceeds_claimed", json!({}));
    }
    worker_to_response(r)
}

async fn bm_claim_all(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let r = match forward_hardware_json(&state, MARKET_CLAIM_ALL_PATH, json!({ "userId": uid }))
        .await
    {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) {
        let claimed = r.body["claimed"]
            .as_i64()
            .or_else(|| r.body["claimed"].as_u64().map(|u| u as i64))
            .unwrap_or(0);
        emit_market_event(&state, "custody_claimed_all", json!({ "claimed": claimed }));
    }
    worker_to_response(r)
}

async fn bm_claim_item(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let listing_id = listing_id_from(&body, &json!({})).unwrap_or_default();
    let r = match forward_hardware_json(&state, MARKET_CLAIM_ITEM_PATH, merge_user_id(body, uid))
        .await
    {
        Ok(r) => r,
        Err(e) => return e,
    };
    if market_ok(&r) && !listing_id.is_empty() {
        emit_market_event(
            &state,
            "custody_claimed",
            json!({ "listingId": listing_id }),
        );
    }
    worker_to_response(r)
}

fn intent_payload(
    uid: i64,
    kind: &str,
    rack_id: Option<&str>,
    mut body: Value,
    scope: String,
) -> Value {
    let obj = body.as_object_mut().cloned();
    let mut payload = obj.unwrap_or_default();
    payload.insert("userId".into(), json!(uid));
    payload.insert("kind".into(), json!(kind));
    payload.insert("scope".into(), json!(scope));
    if let Some(rid) = rack_id {
        payload.insert("rackId".into(), json!(rid));
    }
    if let Some(cat) = payload.get("typeId").cloned() {
        payload.entry("catalogItemId".to_string()).or_insert(cat);
    }
    if let Some(item) = payload.get("itemId").cloned() {
        payload.entry("catalogItemId".to_string()).or_insert(item);
    }
    Value::Object(payload)
}

async fn intent_place(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let payload = intent_payload(uid, "place", None, body, "srv_place_rack".into());
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rack_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let scope = format!("srv_remove_rack:{rack_id}");
    let payload = intent_payload(uid, "remove", Some(&rack_id), body, scope);
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_miner_equip(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rack_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let slot = body.get("slotIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    let scope = format!("rack_miner_equip:{rack_id}:{slot}");
    let payload = intent_payload(uid, "miner_equip", Some(&rack_id), body, scope);
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_miner_unequip(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rack_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let slot = body.get("slotIndex").and_then(|v| v.as_i64()).unwrap_or(0);
    let scope = format!("rack_miner_unequip:{rack_id}:{slot}");
    let payload = intent_payload(uid, "miner_unequip", Some(&rack_id), body, scope);
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_aux_equip(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rack_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    // `kind` in the body is the aux slot type (battery|wiring|multiplier); the
    // worker `apply_intent` matches on `kind = "aux_equip"` with `auxKind` set.
    let aux_kind = body
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("battery")
        .to_string();
    let scope = format!("rack_aux_equip:{rack_id}:{aux_kind}");
    let mut payload = intent_payload(uid, "aux_equip", Some(&rack_id), body, scope);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("auxKind".into(), json!(aux_kind));
    }
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_aux_unequip(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(rack_id): Path<String>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let aux_kind = body
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("battery")
        .to_string();
    let scope = format!("rack_aux_unequip:{rack_id}:{aux_kind}");
    let mut payload = intent_payload(uid, "aux_unequip", Some(&rack_id), body, scope);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("auxKind".into(), json!(aux_kind));
    }
    forward_hardware(&state, HARDWARE_INTENT_PATH, payload).await
}

async fn intent_equip_battery(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((rig_id, slot_id)): Path<(String, String)>,
    Json(mut body): Json<Value>,
) -> axum::response::Response {
    if slot_id.to_ascii_lowercase() != "battery" {
        return json_status(
            400,
            json!({ "error": "Use slotId \"battery\" on this route." }),
        );
    }
    if let Some(obj) = body.as_object_mut() {
        obj.insert("kind".into(), json!("battery"));
    }
    intent_aux_equip(State(state), headers, Path(rig_id), Json(body)).await
}

async fn intent_remove_battery(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((rig_id, slot_id)): Path<(String, String)>,
    Json(mut body): Json<Value>,
) -> axum::response::Response {
    if slot_id.to_ascii_lowercase() != "battery" {
        return json_status(
            400,
            json!({ "error": "Use slotId \"battery\" on this route." }),
        );
    }
    if let Some(obj) = body.as_object_mut() {
        obj.insert("kind".into(), json!("battery"));
    }
    intent_aux_unequip(State(state), headers, Path(rig_id), Json(body)).await
}

async fn save_servers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let racks = body
        .pointer("/changes/placedRacks")
        .or_else(|| body.get("placedRacks"))
        .cloned();
    let Some(racks) = racks else {
        return json_status(
            400,
            json!({ "error": "Send placedRacks (flat body or changes).", "code": "VALIDATION" }),
        );
    };
    forward_hardware(
        &state,
        HARDWARE_RACKS_POWER_PATH,
        json!({ "userId": uid, "racks": racks }),
    )
    .await
}

async fn room_coins(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, HARDWARE_RACKS_POWER_PATH, merge_user_id(body, uid)).await
}

async fn bulk_batteries(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        HARDWARE_BULK_BATTERIES_PATH,
        merge_user_id(body, uid),
    )
    .await
}

async fn shop_checkout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, SHOP_CHECKOUT_PATH, merge_user_id(body, uid)).await
}

async fn merge_execute(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, MERGE_EXECUTE_PATH, merge_user_id(body, uid)).await
}

async fn upgrades_purchase(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, UPGRADES_PURCHASE_PATH, merge_user_id(body, uid)).await
}

async fn rooms_purchase_slot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, ROOMS_PURCHASE_SLOT_PATH, merge_user_id(body, uid)).await
}

async fn lucky_buy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, LUCKY_BOX_BUY_PATH, merge_user_id(body, uid)).await
}

async fn lucky_open(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, LUCKY_BOX_OPEN_PATH, merge_user_id(body, uid)).await
}

async fn wheel_paid_spin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, WHEEL_PAID_SPIN_PATH, merge_user_id(body, uid)).await
}

async fn wheel_redeem_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, WHEEL_REDEEM_CODE_PATH, merge_user_id(body, uid)).await
}

async fn wheel_roll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, WHEEL_ROLL_PATH, merge_user_id(body, uid)).await
}

async fn roleta_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(&state, ROLETA_CLAIM_PATH, merge_user_id(body, uid)).await
}

async fn lucky_promo_redeem(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_hardware(
        &state,
        LUCKY_BOX_PROMO_REDEEM_PATH,
        merge_user_id(body, uid),
    )
    .await
}

async fn wallet_liquidate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    if mode != "PERCENTAGE" {
        return json_status(
            400,
            json!({ "error": "Invalid mode: use mode PERCENTAGE." }),
        );
    }
    let pct_raw = body
        .get("percentage")
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::NAN);
    let Some(pct) = genesis_core::parse_desk_liquidation_percentage_points(pct_raw) else {
        return json_status(
            400,
            json!({ "error": "percentage deve ser 10, 50 ou 100." }),
        );
    };
    let Some(fraction) = genesis_core::desk_percent_to_fraction(pct) else {
        return json_status(
            400,
            json!({ "error": "percentage deve ser 10, 50 ou 100." }),
        );
    };
    let coin_id = body
        .get("coinId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if coin_id.is_empty() {
        return json_status(400, json!({ "error": "Invalid coin." }));
    }
    let mut min_usdc = body.get("minUsdc").and_then(|v| v.as_f64());
    let mut fee_percent = body.get("feePercent").and_then(|v| v.as_f64());
    if min_usdc.is_none() || fee_percent.is_none() {
        match crate::workers::post_mining(
            &state.cfg,
            &state.http,
            EXCHANGE_SETTINGS_PATH,
            &json!({}),
        )
        .await
        {
            Ok(r) if r.status == HTTP_OK => {
                if min_usdc.is_none() {
                    min_usdc = r
                        .body
                        .get("minExchangeAmount")
                        .and_then(|v| v.as_f64())
                        .or(Some(EXCHANGE_MIN_DEFAULT));
                }
                if fee_percent.is_none() {
                    fee_percent = r
                        .body
                        .get("exchangeFeePercent")
                        .and_then(|v| v.as_f64())
                        .or(Some(EXCHANGE_FEE_DEFAULT));
                }
            }
            Ok(r) => return worker_to_response(r),
            Err(e) => return worker_err_response(e),
        }
    }
    let min_usdc = min_usdc.unwrap_or(EXCHANGE_MIN_DEFAULT);
    let fee_percent = fee_percent.unwrap_or(EXCHANGE_FEE_DEFAULT);
    let idem = body.get("idempotencyKey").cloned().unwrap_or(Value::Null);
    forward_wallet(
        &state,
        WALLET_LIQUIDATE_PATH,
        json!({
            "userId": uid,
            "coinId": coin_id,
            "fraction": fraction,
            "fractionMode": genesis_core::FRACTION_MODE_DESK_SHORTCUTS,
            "minUsdc": min_usdc,
            "feePercent": fee_percent,
            "idempotencyKey": idem,
            "idempotencyScope": EXCHANGE_LIQUIDATE_SCOPE,
        }),
    )
    .await
}

async fn wallet_withdraw(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_wallet(&state, WALLET_WITHDRAW_PATH, merge_user_id(body, uid)).await
}

async fn deposit_verify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    let mut payload = merge_user_id(body, uid);
    if let Value::Object(ref mut m) = payload {
        if let Some(tx) = m.get("txHash").cloned().or_else(|| m.get("hash").cloned()) {
            m.insert("txHash".into(), tx);
        }
    }
    forward_wallet(&state, WALLET_DEPOSIT_VERIFY_PATH, payload).await
}

fn pick_zerads_field(q: &ZeradsCallbackQ, body: &Value, key: &str) -> Option<String> {
    let from_q = match key {
        "user" => q.user.clone(),
        "amount" => q.amount.clone(),
        "clicks" => q.clicks.clone(),
        "pwd" => q.pwd.clone(),
        _ => None,
    };
    if let Some(s) = from_q.filter(|s| !s.is_empty()) {
        return Some(s);
    }
    body.get(key).and_then(|v| {
        v.as_str()
            .map(|s| s.to_string())
            .or_else(|| v.as_f64().map(|n| n.to_string()))
            .or_else(|| v.as_i64().map(|n| n.to_string()))
    })
}

fn parse_zerads_body(headers: &HeaderMap, bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return json!({});
    }
    let ct = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ct.to_ascii_lowercase().starts_with("application/json") {
        return serde_json::from_slice(bytes).unwrap_or_else(|_| json!({}));
    }
    let raw = String::from_utf8_lossy(bytes);
    let mut obj = serde_json::Map::new();
    for pair in raw.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        obj.insert(url_form_decode(k), json!(url_form_decode(v)));
    }
    Value::Object(obj)
}

fn url_form_decode(raw: &str) -> String {
    let plus = raw.replace('+', " ");
    let mut out = String::with_capacity(plus.len());
    let bytes = plus.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &plus[i + 1..i + 3];
            if let Ok(n) = u8::from_str_radix(hex, 16) {
                out.push(n as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

async fn offerwall_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ZeradsCallbackQ>,
    request: Request<Body>,
) -> axum::response::Response {
    let bytes = match to_bytes(request.into_body(), UPLOAD_HTTP_BODY_LIMIT_BYTES).await {
        Ok(b) => b,
        Err(_) => bytes::Bytes::new(),
    };
    let body = parse_zerads_body(&headers, &bytes);
    let cf_ip = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let req_ip = get_client_ip(&state.cfg, &headers, None);
    let req_ip = if req_ip == "unknown" {
        None
    } else {
        Some(req_ip)
    };
    forward_wallet(
        &state,
        ZERADS_CALLBACK_PATH,
        json!({
            "user": pick_zerads_field(&q, &body, "user"),
            "amount": pick_zerads_field(&q, &body, "amount"),
            "clicks": pick_zerads_field(&q, &body, "clicks"),
            "pwd": pick_zerads_field(&q, &body, "pwd"),
            "cfIp": cf_ip,
            "reqIp": req_ip,
        }),
    )
    .await
}

async fn zerads_me_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_wallet(&state, ZERADS_TOKEN_PATH, json!({ "userId": uid })).await
}

async fn zerads_me_stats(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let uid = match require_player(&state, &headers).await {
        Ok(u) => u,
        Err(e) => return e,
    };
    forward_wallet(&state, ZERADS_STATS_PATH, json!({ "userId": uid })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_edit_payload_includes_actor_user_id() {
        let uid = 7_i64;
        let payload = merge_user_id(json!({ "messageId": "1", "body": "x" }), uid);
        assert_eq!(payload["userId"], uid);
        assert_eq!(payload["messageId"], "1");
    }

    #[test]
    fn chat_delete_payload_includes_actor_user_id() {
        let uid = 7_i64;
        let payload = merge_user_id(json!({ "messageId": "1" }), uid);
        assert_eq!(payload["userId"], uid);
        assert!(json!({ "messageId": "1" }).get("userId").is_none());
    }
}
