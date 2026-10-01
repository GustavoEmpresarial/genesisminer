//! Admin "Usuários" tab leftovers — the four `/api/user(s)` routes plus the
//! admin half of `GET /api/game-state/:email`, plus
//! `POST /api/admin/users/:userId/save-game-override`, owned rooms, wallet
//! history, impersonate / stop-impersonate, `GET /api/admin/user-activity`,
//! referral models, access-level referral assignments, and dormant mining.
//!
//! Twin of `server/modules/admin/users/controllers/users.controller.ts` (+
//! user-activity from user-audit). The controller-level parsing stays here;
//! SQL / session flags live in mining-worker `admin_users`. Save-game override
//! and owned-rooms revoke are multi-hop (hardware persist between mining hops).

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use genesis_core::calculator::constants::ROOM_INITIAL_ID;
use genesis_core::hardware::is_valid_save_game_item_id;
use serde_json::{json, Map, Value};

use crate::admin_auth::{require_admin, AdminCtx};
use crate::client_ip::get_client_ip;
use crate::config::{AppState, COOKIE_SID};
use crate::facade::{forward_mining, worker_to_response};
use crate::session::{cookies_from_req, json_status, require_player};
use crate::workers::{
    post_auth, post_hardware, post_mining, post_wallet, worker_infra_status, worker_unavailable_body,
};

/// Public paths owned here.
const USERS_PATH: &str = "/api/users";
const USERS_BLOCK_PATH: &str = "/api/users/block";
const USER_PATH: &str = "/api/user";
const USER_BY_EMAIL_PATH: &str = "/api/user/{email}";
const GAME_STATE_BY_EMAIL_PATH: &str = "/api/game-state/{email}";
const SAVE_GAME_OVERRIDE_PATH: &str = "/api/admin/users/{userId}/save-game-override";
const OWNED_ROOMS_PATH: &str = "/api/admin/users/{userId}/rooms";
const WALLET_HISTORY_PATH: &str = "/api/admin/users/{userId}/wallet-history";
const REINVESTMENT_HISTORY_PATH: &str = "/api/admin/users/{userId}/reinvestment-history";
const GRANT_PREMIUM_CHECKIN_PATH: &str = "/api/admin/users/{userId}/grant-premium-checkin";
const IMPERSONATE_PATH: &str = "/api/admin/impersonate";
const STOP_IMPERSONATE_PATH: &str = "/api/admin/stop-impersonate";
const USER_ACTIVITY_PATH: &str = "/api/admin/user-activity";
const REFERRAL_MODELS_PATH: &str = "/api/admin/referral-models";
const REFERRAL_MODELS_ITEM_PATH: &str = "/api/admin/referral-models/{id}";
const ACCESS_LEVEL_REFERRAL_PATH: &str = "/api/admin/access-level-referral-assignments";
const ACCOUNTS_DORMANT_MINING_PATH: &str = "/api/admin/accounts-dormant-mining";

/// Worker twins.
const ADMIN_USERS_LIST_PATH: &str = "/v1/users/admin-list";
const ADMIN_USERS_BLOCK_PATH: &str = "/v1/users/admin-block";
const ADMIN_USERS_UPDATE_PATH: &str = "/v1/users/admin-update";
const ADMIN_USERS_DELETE_RESOLVE_PATH: &str = "/v1/users/admin-delete/resolve";
const ADMIN_USERS_DELETE_PATH: &str = "/v1/users/admin-delete";
const HARDWARE_WIPE_USER_PATH: &str = "/v1/hardware/wipe-user";
const ADMIN_GAME_STATE_BY_EMAIL_PATH: &str = "/v1/game-state/by-email";
const MINING_PROGRESS_PATH: &str = "/v1/mining/progress";
const HARDWARE_PERSIST_PATH: &str = "/v1/hardware/persist";
const ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH: &str =
    "/v1/admin/users/save-game-override-finalize";
const WALLET_ADMIN_SAVE_GAME_BALANCES_PATH: &str = "/v1/wallet/admin/save-game-balances";
const ADMIN_OWNED_ROOMS_PREPARE_PATH: &str = "/v1/admin/users/owned-rooms-prepare";
const ADMIN_OWNED_ROOMS_FINALIZE_PATH: &str = "/v1/admin/users/owned-rooms-finalize";
const ADMIN_WALLET_HISTORY_PATH: &str = "/v1/admin/users/wallet-history";
const ADMIN_GRANT_PREMIUM_CHECKIN_PATH: &str = "/v1/admin/users/grant-premium-checkin";
const WALLET_PLAYER_HISTORY_PATH: &str = "/v1/wallet/history";
/// Node `PLAYER_HISTORY_DEFAULT_LIMIT` (genesis-wallet `player_reads`).
const ADMIN_REINVESTMENT_HISTORY_LIMIT: i64 = 300;
const ADMIN_IMPERSONATE_START_PATH: &str = "/v1/admin/impersonate/start";
const ADMIN_IMPERSONATE_STOP_PATH: &str = "/v1/admin/impersonate/stop";
const ADMIN_USER_ACTIVITY_PATH: &str = "/v1/admin/user-activity";
const ADMIN_REFERRAL_MODELS_LIST_PATH: &str = "/v1/admin/users/referral-models/list";
const ADMIN_REFERRAL_MODELS_UPSERT_PATH: &str = "/v1/admin/users/referral-models/upsert";
const ADMIN_REFERRAL_MODELS_DELETE_PATH: &str = "/v1/admin/users/referral-models/delete";
const ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH: &str =
    "/v1/admin/users/access-level-referral-assignments/list";
const ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH: &str =
    "/v1/admin/users/access-level-referral-assignments/save";
const ADMIN_DORMANT_MINING_PATH: &str = "/v1/admin/users/accounts-dormant-mining";

const JWT_SIGN_PATH: &str = "/v1/auth/jwt/sign";
const REFRESH_ISSUE_PATH: &str = "/v1/auth/refresh/issue";
const REFRESH_REVOKE_PATH: &str = "/v1/auth/refresh/revoke";

/// Node `HTTP_BAD_REQUEST` in users.controller.ts.
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_OK: u16 = 200;
const HTTP_SERVICE_UNAVAILABLE: u16 = 503;
/// Same status the facade helpers use when a worker answers something the
/// contract does not allow.
const HTTP_BAD_GATEWAY: u16 = 502;
const CODE_WORKER_UNAVAILABLE: &str = "WORKER_UNAVAILABLE";
/// Node `EMAIL_MAX`.
const EMAIL_MAX: usize = 254;
/// Node `COIN_ID_MAX` in admin-game-state.ts (wallet payload bounds).
const COIN_ID_MAX: usize = 128;
/// Hardware persist merge mode — qty 0 → DELETE that SKU.
const STOCK_MODE_MERGE: &str = "merge";

/// Node `X-Admin-Edit` header (`'1'` enables the editable snapshot).
const ADMIN_EDIT_HEADER: &str = "x-admin-edit";
const ADMIN_EDIT_ON: &str = "1";

/// Node controller messages.
const ERR_INVALID_EMAIL: &str = "Email inválido";
const ERR_USER_ID_REQUIRED: &str = "User id is required.";
const ERR_INVALID_USER_ID: &str = "Invalid user id.";
const ERR_PROGRESS_FAILED: &str =
    "Não foi possível liquidar a mineração antes de guardar.";
const ERR_ROOM_IDS: &str = "roomIds must be an array of strings.";
const ERR_COULD_NOT_RENEW: &str = "Could not renew session.";
const CODE_VALIDATION: &str = "VALIDATION";
const CODE_PROGRESS_UNAVAILABLE: &str = "PROGRESS_UNAVAILABLE";

const _: () = assert!(EMAIL_MAX == 254);
const _: () = assert!(COIN_ID_MAX == 128);
const _: () = assert!(HTTP_SERVICE_UNAVAILABLE == 503);
const _: () = assert!(ADMIN_REINVESTMENT_HISTORY_LIMIT == 300);

fn bad_request(body: Value) -> Response {
    json_status(HTTP_BAD_REQUEST, body)
}

/// Express `req.query`. `qs` turns repeated keys into arrays, but the admin
/// panel never sends them, so the flat string map the extractor produces is
/// enough for the worker's parser.
fn query_object(params: &HashMap<String, String>) -> Value {
    let mut obj = Map::new();
    for (k, v) in params {
        obj.insert(k.clone(), Value::String(v.clone()));
    }
    Value::Object(obj)
}

/// Node `parseTargetUserId` — a positive integer, floored.
fn parse_target_user_id(raw: &Value) -> Option<i64> {
    let n = match raw {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    Some(n.floor() as i64)
}

fn body_string(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(str::to_string)
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Run one worker hop and stop the chain on anything but a 200 `ok` body, so a
/// controlled 403/404/409 reaches the panel untouched.
async fn mining_step(state: &AppState, path: &str, body: Value) -> Result<Value, Response> {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => Ok(r.body),
        Ok(r) => Err(worker_to_response(r)),
        Err(e) => Err(json_status(
            worker_infra_status(&e),
            worker_unavailable_body(&e),
        )),
    }
}

async fn get_users(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, USERS_PATH).await {
        return e;
    }
    forward_mining(
        &state,
        ADMIN_USERS_LIST_PATH,
        json!({ "query": query_object(&params) }),
    )
    .await
}

async fn put_users_block(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::PUT, USERS_BLOCK_PATH).await {
        return e;
    }
    let email = body_string(&body, "email")
        .unwrap_or_default()
        .trim()
        .to_string();
    if email.is_empty() || email.len() > EMAIL_MAX {
        return bad_request(json!({ "ok": false, "error": ERR_INVALID_EMAIL }));
    }
    // Node `!!req.body?.blocked` — any truthy JSON value blocks the account.
    let blocked = js_truthy(body.get("blocked"));
    forward_mining(
        &state,
        ADMIN_USERS_BLOCK_PATH,
        json!({ "email": email, "blocked": blocked }),
    )
    .await
}

/// JS `!!value`: `0`, `''`, `false`, `null` and absent are the only falsy cases.
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

async fn put_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::PUT, USER_PATH).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(target_id) = parse_target_user_id(body.get("id").unwrap_or(&Value::Null)) else {
        return bad_request(json!({
            "ok": false,
            "error": ERR_USER_ID_REQUIRED,
            "code": CODE_VALIDATION
        }));
    };
    forward_mining(
        &state,
        ADMIN_USERS_UPDATE_PATH,
        json!({
            "actorUserId": ctx.user_id,
            "actorIsSuperAdmin": ctx.is_super_admin,
            "targetId": target_id,
            "username": body.get("username").cloned().unwrap_or(Value::Null),
            "email": body.get("email").cloned().unwrap_or(Value::Null),
            "polygonWallet": body.get("polygonWallet").cloned().unwrap_or(Value::Null),
            "password": body.get("password").cloned().unwrap_or(Value::Null),
            "accessLevelId": body.get("accessLevelId").cloned().unwrap_or(Value::Null),
            "accessLevelIds": body.get("accessLevelIds").cloned().unwrap_or(Value::Null),
            "ipAddress": get_client_ip(&state.cfg, &headers, None),
            "userAgent": user_agent(&headers),
        }),
    )
    .await
}

async fn delete_user(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(email): Path<String>,
) -> Response {
    let path = format!("/api/user/{email}");
    let ctx = match require_admin(&state, &headers, &Method::DELETE, &path).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    delete_user_chain(&state, &ctx, &email).await
}

/// Node runs the hardware wipe inside `deleteUserByEmail`, after the same
/// resolve + policy checks. Splitting it into three hops keeps that order:
/// nothing destructive runs until the resolve step has answered 200.
async fn delete_user_chain(state: &AppState, ctx: &AdminCtx, email: &str) -> Response {
    let actor = json!({
        "email": email,
        "actorUserId": ctx.user_id,
        "actorIsSuperAdmin": ctx.is_super_admin,
    });
    let resolved = match mining_step(state, ADMIN_USERS_DELETE_RESOLVE_PATH, actor.clone()).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let Some(user_id) = resolved["userId"].as_i64() else {
        return json_status(
            HTTP_BAD_GATEWAY,
            json!({
                "error": "Delete resolve returned no user id.",
                "code": CODE_WORKER_UNAVAILABLE
            }),
        );
    };
    match post_hardware(
        &state.cfg,
        &state.http,
        HARDWARE_WIPE_USER_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK => {}
        Ok(r) => return worker_to_response(r),
        Err(e) => {
            return json_status(worker_infra_status(&e), worker_unavailable_body(&e));
        }
    }
    forward_mining(state, ADMIN_USERS_DELETE_PATH, actor).await
}

async fn get_game_state_by_email(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(email): Path<String>,
) -> Response {
    let path = format!("/api/game-state/{email}");
    if let Err(e) = require_admin(&state, &headers, &Method::GET, &path).await {
        return e;
    }
    let admin_edit = headers
        .get(ADMIN_EDIT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v == ADMIN_EDIT_ON)
        .unwrap_or(false);
    match post_hardware(
        &state.cfg,
        &state.http,
        ADMIN_GAME_STATE_BY_EMAIL_PATH,
        &json!({ "email": email.trim(), "adminEdit": admin_edit }),
    )
    .await
    {
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn post_save_game_override(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id_raw): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let path = format!("/api/admin/users/{user_id_raw}/save-game-override");
    let ctx = match require_admin(&state, &headers, &Method::POST, &path).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(target_user_id) = parse_target_user_id(&Value::String(user_id_raw)) else {
        return bad_request(json!({
            "ok": false,
            "error": ERR_INVALID_USER_ID,
            "code": CODE_VALIDATION
        }));
    };
    let changes = match body.get("changes") {
        Some(Value::Object(m)) => Value::Object(m.clone()),
        _ => json!({}),
    };
    // Node accepts `reason` for audit UI; service voids it.
    let _reason = body.get("reason").and_then(Value::as_str);
    let _actor = ctx.user_id;
    save_game_override_chain(&state, target_user_id, &changes).await
}

/// Node `normalizeAdminStockSnapshot` — qty finitas ≥ 0 (inclui 0) so merge
/// persist can DELETE those SKUs; omitted keys stay intact.
fn normalize_admin_stock_snapshot(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = raw.as_object() else {
        return out;
    };
    for (raw_id, raw_qty) in obj {
        let id = raw_id.trim();
        if id.is_empty() || !is_valid_save_game_item_id(id) {
            continue;
        }
        let n = match raw_qty {
            Value::Number(num) => num.as_f64(),
            Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        };
        let Some(n) = n else { continue };
        if !n.is_finite() || n < 0.0 {
            continue;
        }
        let qty = n.floor() as i64;
        let entry = out.entry(id.to_string()).or_insert(json!(0));
        let prev = entry.as_i64().unwrap_or(0);
        *entry = json!(prev + qty);
    }
    out
}

/// Node `normalizePlacedRacksForPersist`.
fn normalize_placed_racks_for_persist(raw: &Value) -> Option<Vec<Value>> {
    let Some(arr) = raw.as_array() else {
        return None;
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(o) = item.as_object() else {
            continue;
        };
        let id = o
            .get("id")
            .map(|v| match v {
                Value::String(s) => s.trim().to_string(),
                other => other.to_string().trim().to_string(),
            })
            .unwrap_or_default();
        let item_id = o
            .get("itemId")
            .map(|v| match v {
                Value::String(s) => s.trim().to_string(),
                other => other.to_string().trim().to_string(),
            })
            .unwrap_or_default();
        if id.is_empty() || !is_valid_save_game_item_id(&id) {
            continue;
        }
        if item_id.is_empty() || !is_valid_save_game_item_id(&item_id) {
            continue;
        }
        let slots = match o.get("slots") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|s| {
                    if s.is_null() {
                        Value::String(String::new())
                    } else {
                        Value::String(match s {
                            Value::String(t) => t.clone(),
                            other => other.to_string(),
                        })
                    }
                })
                .collect::<Vec<_>>(),
            _ => vec![],
        };
        let multiplier_slots = match o.get("multiplierSlots") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|s| {
                    if s.is_null() {
                        Value::String(String::new())
                    } else {
                        Value::String(match s {
                            Value::String(t) => t.clone(),
                            other => other.to_string(),
                        })
                    }
                })
                .collect::<Vec<_>>(),
            _ => vec![],
        };
        let slot_lease_ids = match o.get("slotLeaseIds") {
            Some(Value::Array(a)) => Some(
                a.iter()
                    .map(|s| {
                        if s.is_null() {
                            Value::String(String::new())
                        } else {
                            Value::String(match s {
                                Value::String(t) => t.clone(),
                                other => other.to_string(),
                            })
                        }
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        };
        let wiring_id = optional_trimmed_str(o.get("wiringId"));
        let battery_id = optional_trimmed_str(o.get("batteryId"));
        let selected_coin_id = optional_trimmed_str(o.get("selectedCoinId"));
        let room_id = o
            .get("roomId")
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other if !other.is_null() => other.to_string(),
                _ => ROOM_INITIAL_ID.to_string(),
            })
            .unwrap_or_else(|| ROOM_INITIAL_ID.to_string());
        let slot_index = o
            .get("slotIndex")
            .and_then(|v| v.as_f64())
            .filter(|n| n.is_finite())
            .map(|n| n.floor().max(0.0) as i64)
            .unwrap_or(0);
        let mut rack = json!({
            "id": id,
            "itemId": item_id,
            "slots": slots,
            "multiplierSlots": multiplier_slots,
            "wiringId": wiring_id,
            "batteryId": battery_id,
            "isOn": js_truthy(o.get("isOn")),
            "selectedCoinId": selected_coin_id,
            "roomId": room_id,
            "slotIndex": slot_index,
            "batteryCatalogItemId": optional_string_or_null(o.get("batteryCatalogItemId")),
            "batteryDisplayName": optional_string_or_null(o.get("batteryDisplayName")),
            "batteryImageUrl": optional_string_or_null(o.get("batteryImageUrl")),
        });
        if let Some(leases) = slot_lease_ids {
            rack["slotLeaseIds"] = Value::Array(leases);
        }
        out.push(rack);
    }
    Some(out)
}

fn optional_trimmed_str(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Value::Null
            } else {
                Value::String(t.to_string())
            }
        }
        Some(Value::Null) | None => Value::Null,
        Some(other) => {
            let t = other.to_string().trim().to_string();
            if t.is_empty() || t == "null" {
                Value::Null
            } else {
                Value::String(t)
            }
        }
    }
}

fn optional_string_or_null(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(Value::Null) | None => Value::Null,
        Some(other) => Value::String(other.to_string()),
    }
}

/// Node `normalizeCoinBalancesForWallet`.
fn normalize_coin_balances_for_wallet(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = raw.as_object() else {
        return out;
    };
    for (raw_coin_id, raw_amount) in obj {
        let coin_id = raw_coin_id.trim();
        if coin_id.is_empty() || coin_id.len() > COIN_ID_MAX {
            continue;
        }
        let amount = match raw_amount {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        };
        let Some(amount) = amount else { continue };
        if !amount.is_finite() {
            continue;
        }
        out.insert(coin_id.to_string(), json!(amount));
    }
    out
}

/// Node `applyAdminSaveGameOverride` orchestration across mining / hardware / wallet.
async fn save_game_override_chain(state: &AppState, target_user_id: i64, changes: &Value) -> Response {
    let has_stock = changes
        .get("stock")
        .map(|v| v.is_object())
        .unwrap_or(false);
    let placed_racks_norm = changes
        .get("placedRacks")
        .and_then(normalize_placed_racks_for_persist);
    let wrote_racks = placed_racks_norm.is_some();
    let has_usdc = changes
        .get("usdc")
        .and_then(Value::as_f64)
        .map(|n| n.is_finite())
        .unwrap_or(false);
    let has_coins = changes
        .get("coinBalances")
        .map(|v| v.is_object())
        .unwrap_or(false);

    // Liquida progresso ANTES do bump last_updated_at — fail-closed.
    match post_mining(
        &state.cfg,
        &state.http,
        MINING_PROGRESS_PATH,
        &json!({ "userId": target_user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {}
        Ok(_) => {
            return json_status(
                HTTP_SERVICE_UNAVAILABLE,
                json!({
                    "error": ERR_PROGRESS_FAILED,
                    "code": CODE_PROGRESS_UNAVAILABLE
                }),
            );
        }
        Err(e) => {
            return json_status(
                HTTP_SERVICE_UNAVAILABLE,
                json!({
                    "error": ERR_PROGRESS_FAILED,
                    "code": CODE_PROGRESS_UNAVAILABLE,
                    "detail": e.message(),
                }),
            );
        }
    }

    if has_stock || placed_racks_norm.is_some() {
        let mut persist = json!({ "userId": target_user_id });
        if has_stock {
            persist["stock"] =
                Value::Object(normalize_admin_stock_snapshot(changes.get("stock").unwrap()));
            persist["stockMode"] = json!(STOCK_MODE_MERGE);
        }
        if let Some(racks) = &placed_racks_norm {
            persist["placedRacks"] = Value::Array(racks.clone());
        }
        match post_hardware(&state.cfg, &state.http, HARDWARE_PERSIST_PATH, &persist).await {
            Ok(r) if r.status == HTTP_OK && r.body["ok"] != false => {}
            Ok(r) => return worker_to_response(r),
            Err(e) => {
                return json_status(worker_infra_status(&e), worker_unavailable_body(&e));
            }
        }
    }

    let finalized = match mining_step(
        state,
        ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH,
        json!({
            "userId": target_user_id,
            "wroteRacks": wrote_racks,
        }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return e,
    };

    let server_updated_at = finalized
        .get("serverUpdatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let stock = finalized.get("stock").cloned().unwrap_or(json!({}));

    if has_usdc || has_coins {
        let coin_balances = if has_coins {
            normalize_coin_balances_for_wallet(changes.get("coinBalances").unwrap())
        } else {
            Map::new()
        };
        let coins_payload = if coin_balances.is_empty() {
            None
        } else {
            Some(coin_balances)
        };
        if has_usdc || coins_payload.is_some() {
            let mut wallet_body = json!({
                "userId": target_user_id,
                "serverNowMs": server_updated_at,
            });
            if has_usdc {
                wallet_body["usdc"] = changes.get("usdc").cloned().unwrap_or(Value::Null);
            }
            if let Some(coins) = coins_payload {
                wallet_body["coinBalances"] = Value::Object(coins);
            }
            // Node remaps wallet worker errors — fail-closed (not best-effort).
            match post_wallet(
                &state.cfg,
                &state.http,
                WALLET_ADMIN_SAVE_GAME_BALANCES_PATH,
                &wallet_body,
            )
            .await
            {
                Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {}
                Ok(r) => return worker_to_response(r),
                Err(e) => {
                    return json_status(worker_infra_status(&e), worker_unavailable_body(&e));
                }
            }
        }
    }

    let mut out = json!({
        "ok": true,
        "stock": stock,
        "serverUpdatedAt": server_updated_at,
    });
    if wrote_racks {
        if let Some(racks) = finalized.get("placedRacks") {
            out["placedRacks"] = racks.clone();
        }
    }
    json_status(HTTP_OK, out)
}

async fn put_owned_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id_raw): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let path = format!("/api/admin/users/{user_id_raw}/rooms");
    if let Err(e) = require_admin(&state, &headers, &Method::PUT, &path).await {
        return e;
    }
    let Some(target_user_id) = parse_target_user_id(&Value::String(user_id_raw)) else {
        return bad_request(json!({
            "ok": false,
            "error": ERR_INVALID_USER_ID,
            "code": CODE_VALIDATION
        }));
    };
    let room_ids = match body.get("roomIds") {
        Some(Value::Array(arr)) if arr.iter().all(|v| v.is_string()) => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>(),
        _ => {
            return bad_request(json!({
                "ok": false,
                "error": ERR_ROOM_IDS,
                "code": CODE_VALIDATION
            }));
        }
    };

    let prepared = match mining_step(
        &state,
        ADMIN_OWNED_ROOMS_PREPARE_PATH,
        json!({ "userId": target_user_id, "roomIds": room_ids }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return e,
    };

    if prepared.get("noop") == Some(&Value::Bool(true)) {
        return json_status(
            HTTP_OK,
            json!({
                "ok": true,
                "ownedRoomIds": prepared.get("ownedRoomIds").cloned().unwrap_or(json!([])),
                "removedRackCount": prepared.get("removedRackCount").cloned().unwrap_or(json!(0)),
            }),
        );
    }

    let to_remove = prepared
        .get("toRemove")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !to_remove.is_empty() {
        let keep = prepared
            .get("keepPlacedRacks")
            .cloned()
            .unwrap_or(json!([]));
        match post_hardware(
            &state.cfg,
            &state.http,
            HARDWARE_PERSIST_PATH,
            &json!({
                "userId": target_user_id,
                "placedRacks": keep,
            }),
        )
        .await
        {
            Ok(r) if r.status == HTTP_OK && r.body["ok"] != false => {}
            Ok(r) => return worker_to_response(r),
            Err(e) => {
                return json_status(worker_infra_status(&e), worker_unavailable_body(&e));
            }
        }
    }

    let finalized = match mining_step(
        &state,
        ADMIN_OWNED_ROOMS_FINALIZE_PATH,
        json!({
            "userId": target_user_id,
            "toAdd": prepared.get("toAdd").cloned().unwrap_or(json!([])),
            "toRemove": to_remove,
            "removedRackCount": prepared.get("removedRackCount").cloned().unwrap_or(json!(0)),
        }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return e,
    };

    json_status(
        HTTP_OK,
        json!({
            "ok": true,
            "ownedRoomIds": finalized.get("ownedRoomIds").cloned().unwrap_or(json!([])),
            "removedRackCount": finalized.get("removedRackCount").cloned().unwrap_or(json!(0)),
        }),
    )
}

async fn get_wallet_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id_raw): Path<String>,
) -> Response {
    let path = format!("/api/admin/users/{user_id_raw}/wallet-history");
    if let Err(e) = require_admin(&state, &headers, &Method::GET, &path).await {
        return e;
    }
    // Node `parseAdminWalletHistoryUserId` — reject leading zeros / non-decimal.
    let trimmed = user_id_raw.trim();
    let valid = !trimmed.is_empty()
        && trimmed.bytes().all(|b| b.is_ascii_digit())
        && !trimmed.starts_with('0')
        && trimmed.parse::<i64>().ok().filter(|n| *n > 0).is_some();
    let Some(target_user_id) = (if valid {
        trimmed.parse::<i64>().ok()
    } else {
        None
    }) else {
        return bad_request(json!({
            "error": ERR_INVALID_USER_ID,
            "code": CODE_VALIDATION
        }));
    };
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_WALLET_HISTORY_PATH,
        &json!({ "userId": target_user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut body = r.body.clone();
            if let Some(obj) = body.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, body)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn post_grant_premium_checkin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id_raw): Path<String>,
) -> Response {
    let path = format!("/api/admin/users/{user_id_raw}/grant-premium-checkin");
    if let Err(e) = require_admin(&state, &headers, &Method::POST, &path).await {
        return e;
    }
    let trimmed = user_id_raw.trim();
    let valid = !trimmed.is_empty()
        && trimmed.bytes().all(|b| b.is_ascii_digit())
        && !trimmed.starts_with('0')
        && trimmed.parse::<i64>().ok().filter(|n| *n > 0).is_some();
    let Some(target_user_id) = (if valid {
        trimmed.parse::<i64>().ok()
    } else {
        None
    }) else {
        return bad_request(json!({
            "error": ERR_INVALID_USER_ID,
            "code": CODE_VALIDATION
        }));
    };
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_GRANT_PREMIUM_CHECKIN_PATH,
        &json!({ "userId": target_user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut body = r.body.clone();
            if let Some(obj) = body.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, body)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_reinvestment_history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user_id_raw): Path<String>,
) -> Response {
    let path = format!("/api/admin/users/{user_id_raw}/reinvestment-history");
    if let Err(e) = require_admin(&state, &headers, &Method::GET, &path).await {
        return e;
    }
    // Node `parseAdminWalletHistoryUserId` — reject leading zeros / non-decimal.
    let trimmed = user_id_raw.trim();
    let valid = !trimmed.is_empty()
        && trimmed.bytes().all(|b| b.is_ascii_digit())
        && !trimmed.starts_with('0')
        && trimmed.parse::<i64>().ok().filter(|n| *n > 0).is_some();
    let Some(target_user_id) = (if valid {
        trimmed.parse::<i64>().ok()
    } else {
        None
    }) else {
        return bad_request(json!({
            "error": ERR_INVALID_USER_ID,
            "code": CODE_VALIDATION
        }));
    };
    match post_wallet(
        &state.cfg,
        &state.http,
        WALLET_PLAYER_HISTORY_PATH,
        &json!({
            "userId": target_user_id,
            "limit": ADMIN_REINVESTMENT_HISTORY_LIMIT
        }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let ledger = r.body.get("ledger").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, json!({ "history": ledger }))
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

fn append_cookie(res: &mut Response, value: String) {
    if let Ok(hv) = header::HeaderValue::from_str(&value) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
}

/// Same contract as login / gerente — refresh revoke → issue → JWT sign.
async fn issue_jwt_auth_cookies(
    state: &AppState,
    headers: &HeaderMap,
    user_id: i64,
) -> Result<(String, u64, String, u64), Response> {
    match post_auth(
        &state.cfg,
        &state.http,
        REFRESH_REVOKE_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            return Err(json_status(
                worker_infra_status(&e),
                worker_unavailable_body(&e),
            ));
        }
    }
    let ip = get_client_ip(&state.cfg, headers, None);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok());
    let issued = match post_auth(
        &state.cfg,
        &state.http,
        REFRESH_ISSUE_PATH,
        &json!({ "userId": user_id, "userAgent": ua, "ip": ip }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => r,
        Ok(r) => {
            return Err(json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({ "error": ERR_COULD_NOT_RENEW }),
            ));
        }
        Err(e) => {
            return Err(json_status(
                worker_infra_status(&e),
                worker_unavailable_body(&e),
            ));
        }
    };
    let refresh = issued.body["refreshToken"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let refresh_ttl = issued.body["expiresInSec"].as_u64().unwrap_or(0);
    let signed = match post_auth(
        &state.cfg,
        &state.http,
        JWT_SIGN_PATH,
        &json!({ "userId": user_id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => r,
        Ok(r) => {
            return Err(json_status(
                if r.status == 0 { 502 } else { r.status },
                json!({ "error": ERR_COULD_NOT_RENEW }),
            ));
        }
        Err(e) => {
            return Err(json_status(
                worker_infra_status(&e),
                worker_unavailable_body(&e),
            ));
        }
    };
    let access = signed.body["token"].as_str().unwrap_or("").to_string();
    let access_ttl = signed.body["expiresInSec"].as_u64().unwrap_or(0);
    if access.is_empty() || refresh.is_empty() || access_ttl == 0 || refresh_ttl == 0 {
        return Err(json_status(500, json!({ "error": ERR_COULD_NOT_RENEW })));
    }
    Ok((access, access_ttl, refresh, refresh_ttl))
}

async fn apply_jwt_cookies(state: &AppState, headers: &HeaderMap, user_id: i64) -> Response {
    match issue_jwt_auth_cookies(state, headers, user_id).await {
        Ok((access, access_ttl, refresh, refresh_ttl)) => {
            let mut res = json_status(HTTP_OK, json!({ "ok": true }));
            append_cookie(
                &mut res,
                state.cfg.cookie.access_cookie(&access, access_ttl),
            );
            append_cookie(
                &mut res,
                state.cfg.cookie.refresh_cookie(&refresh, refresh_ttl),
            );
            res
        }
        Err(e) => e,
    }
}

async fn post_impersonate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, IMPERSONATE_PATH).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let cookies = cookies_from_req(&headers);
    let sid = cookies
        .get(COOKIE_SID)
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_string();
    let target_email = body
        .get("targetEmail")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_IMPERSONATE_START_PATH,
        &json!({
            "adminUserId": ctx.user_id,
            "sessionId": sid,
            "targetEmail": target_email,
        }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let Some(target_uid) = r.body["targetUserId"].as_i64().filter(|i| *i > 0) else {
                return json_status(500, json!({ "error": "Could not impersonate user." }));
            };
            apply_jwt_cookies(&state, &headers, target_uid).await
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn post_stop_impersonate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    // Node uses `authenticateToken` (not isAdmin) — JWT is the target's.
    if let Err(e) = require_player(&state, &headers).await {
        return e;
    }
    let cookies = cookies_from_req(&headers);
    let sid = cookies
        .get(COOKIE_SID)
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_string();
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_IMPERSONATE_STOP_PATH,
        &json!({ "sessionId": sid }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let Some(admin_uid) = r.body["adminUserId"].as_i64().filter(|i| *i > 0) else {
                return json_status(500, json!({ "error": "Could not stop impersonation." }));
            };
            apply_jwt_cookies(&state, &headers, admin_uid).await
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_user_activity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, USER_ACTIVITY_PATH).await {
        return e;
    }
    let mut body = Map::new();
    for (k, v) in &params {
        // Forward query keys as camelCase strings the worker deserializes.
        let key = match k.as_str() {
            "beforeMs" => "beforeMs",
            "filterId" => "filterId",
            "userId" => "userId",
            other => other,
        };
        body.insert(key.to_string(), Value::String(v.clone()));
    }
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_USER_ACTIVITY_PATH,
        &Value::Object(body),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut out = r.body.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, out)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

/// Worker `{ ok, items }` → public JSON array (referral models list).
async fn mining_items_array(state: &AppState, path: &str, body: Value) -> Response {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let items = r.body.get("items").cloned().unwrap_or(json!([]));
            json_status(HTTP_OK, items)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

/// Worker `{ ok, assignments }` → bare `Record<string, number>`.
async fn mining_assignments_map(state: &AppState, path: &str, body: Value) -> Response {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let map = r
                .body
                .get("assignments")
                .cloned()
                .unwrap_or(json!({}));
            json_status(HTTP_OK, map)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

/// Strip worker `ok` and return the flattened object (dormant report / upsert).
async fn mining_strip_ok(state: &AppState, path: &str, body: Value) -> Response {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut out = r.body.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.remove("ok");
            }
            json_status(HTTP_OK, out)
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_referral_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, REFERRAL_MODELS_PATH).await {
        return e;
    }
    mining_items_array(&state, ADMIN_REFERRAL_MODELS_LIST_PATH, json!({})).await
}

async fn post_referral_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::POST, REFERRAL_MODELS_PATH).await {
        return e;
    }
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_REFERRAL_MODELS_UPSERT_PATH,
        &json!({ "model": body }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let mut out = r.body.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.remove("ok");
            }
            // Client expects `{ ok: true, ... }`.
            let mut wrapped = Map::new();
            wrapped.insert("ok".into(), json!(true));
            if let Some(obj) = out.as_object() {
                for (k, v) in obj {
                    wrapped.insert(k.clone(), v.clone());
                }
            }
            json_status(HTTP_OK, Value::Object(wrapped))
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn delete_referral_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id_raw): Path<String>,
) -> Response {
    let path = format!("/api/admin/referral-models/{id_raw}");
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, &path).await {
        return e;
    }
    let trimmed = id_raw.trim();
    let id = trimmed
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .unwrap_or(0);
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_REFERRAL_MODELS_DELETE_PATH,
        &json!({ "id": id }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            let deleted = r.body.get("deleted").and_then(Value::as_bool).unwrap_or(false);
            json_status(HTTP_OK, json!({ "ok": deleted }))
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_access_level_referral_assignments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::GET, ACCESS_LEVEL_REFERRAL_PATH).await
    {
        return e;
    }
    mining_assignments_map(&state, ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH, json!({})).await
}

async fn post_access_level_referral_assignments(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::POST, ACCESS_LEVEL_REFERRAL_PATH).await
    {
        return e;
    }
    let assignments = body.get("assignments").cloned().unwrap_or(json!({}));
    match post_mining(
        &state.cfg,
        &state.http,
        ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH,
        &json!({ "assignments": assignments }),
    )
    .await
    {
        Ok(r) if r.status == HTTP_OK && r.body["ok"] == true => {
            json_status(HTTP_OK, json!({ "ok": true }))
        }
        Ok(r) => worker_to_response(r),
        Err(e) => json_status(worker_infra_status(&e), worker_unavailable_body(&e)),
    }
}

async fn get_accounts_dormant_mining(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) =
        require_admin(&state, &headers, &Method::GET, ACCOUNTS_DORMANT_MINING_PATH).await
    {
        return e;
    }
    let mut body = Map::new();
    for (k, v) in &params {
        let key = match k.as_str() {
            "daysMin" => "daysMin",
            "limit" => "limit",
            "noMiningPage" => "noMiningPage",
            "miningNoWalletPage" => "miningNoWalletPage",
            other => other,
        };
        body.insert(key.to_string(), Value::String(v.clone()));
    }
    mining_strip_ok(&state, ADMIN_DORMANT_MINING_PATH, Value::Object(body)).await
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(USERS_PATH, get(get_users))
        .route(USERS_BLOCK_PATH, put(put_users_block))
        .route(USER_PATH, put(put_user))
        .route(USER_BY_EMAIL_PATH, delete(delete_user))
        .route(GAME_STATE_BY_EMAIL_PATH, get(get_game_state_by_email))
        .route(SAVE_GAME_OVERRIDE_PATH, post(post_save_game_override))
        .route(OWNED_ROOMS_PATH, put(put_owned_rooms))
        .route(WALLET_HISTORY_PATH, get(get_wallet_history))
        .route(REINVESTMENT_HISTORY_PATH, get(get_reinvestment_history))
        .route(GRANT_PREMIUM_CHECKIN_PATH, post(post_grant_premium_checkin))
        .route(IMPERSONATE_PATH, post(post_impersonate))
        .route(STOP_IMPERSONATE_PATH, post(post_stop_impersonate))
        .route(USER_ACTIVITY_PATH, get(get_user_activity))
        .route(
            REFERRAL_MODELS_PATH,
            get(get_referral_models).post(post_referral_models),
        )
        .route(REFERRAL_MODELS_ITEM_PATH, delete(delete_referral_model))
        .route(
            ACCESS_LEVEL_REFERRAL_PATH,
            get(get_access_level_referral_assignments).post(post_access_level_referral_assignments),
        )
        .route(ACCOUNTS_DORMANT_MINING_PATH, get(get_accounts_dormant_mining))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_paths_match_twins() {
        assert_eq!(ADMIN_USERS_LIST_PATH, "/v1/users/admin-list");
        assert_eq!(ADMIN_USERS_BLOCK_PATH, "/v1/users/admin-block");
        assert_eq!(ADMIN_USERS_UPDATE_PATH, "/v1/users/admin-update");
        assert_eq!(
            ADMIN_USERS_DELETE_RESOLVE_PATH,
            "/v1/users/admin-delete/resolve"
        );
        assert_eq!(ADMIN_USERS_DELETE_PATH, "/v1/users/admin-delete");
        assert_eq!(HARDWARE_WIPE_USER_PATH, "/v1/hardware/wipe-user");
        assert_eq!(ADMIN_GAME_STATE_BY_EMAIL_PATH, "/v1/game-state/by-email");
        assert_eq!(MINING_PROGRESS_PATH, "/v1/mining/progress");
        assert_eq!(HARDWARE_PERSIST_PATH, "/v1/hardware/persist");
        assert_eq!(
            ADMIN_SAVE_GAME_OVERRIDE_FINALIZE_PATH,
            "/v1/admin/users/save-game-override-finalize"
        );
        assert_eq!(
            WALLET_ADMIN_SAVE_GAME_BALANCES_PATH,
            "/v1/wallet/admin/save-game-balances"
        );
        assert_eq!(STOCK_MODE_MERGE, "merge");
        assert_eq!(
            ADMIN_OWNED_ROOMS_PREPARE_PATH,
            "/v1/admin/users/owned-rooms-prepare"
        );
        assert_eq!(
            ADMIN_OWNED_ROOMS_FINALIZE_PATH,
            "/v1/admin/users/owned-rooms-finalize"
        );
        assert_eq!(ADMIN_WALLET_HISTORY_PATH, "/v1/admin/users/wallet-history");
        assert_eq!(
            ADMIN_GRANT_PREMIUM_CHECKIN_PATH,
            "/v1/admin/users/grant-premium-checkin"
        );
        assert_eq!(ADMIN_IMPERSONATE_START_PATH, "/v1/admin/impersonate/start");
        assert_eq!(ADMIN_IMPERSONATE_STOP_PATH, "/v1/admin/impersonate/stop");
        assert_eq!(ADMIN_USER_ACTIVITY_PATH, "/v1/admin/user-activity");
        assert_eq!(OWNED_ROOMS_PATH, "/api/admin/users/{userId}/rooms");
        assert_eq!(
            WALLET_HISTORY_PATH,
            "/api/admin/users/{userId}/wallet-history"
        );
        assert_eq!(
            REINVESTMENT_HISTORY_PATH,
            "/api/admin/users/{userId}/reinvestment-history"
        );
        assert_eq!(WALLET_PLAYER_HISTORY_PATH, "/v1/wallet/history");
        assert_eq!(ADMIN_REINVESTMENT_HISTORY_LIMIT, 300);
        assert_eq!(IMPERSONATE_PATH, "/api/admin/impersonate");
        assert_eq!(STOP_IMPERSONATE_PATH, "/api/admin/stop-impersonate");
        assert_eq!(USER_ACTIVITY_PATH, "/api/admin/user-activity");
        assert_eq!(REFERRAL_MODELS_PATH, "/api/admin/referral-models");
        assert_eq!(
            REFERRAL_MODELS_ITEM_PATH,
            "/api/admin/referral-models/{id}"
        );
        assert_eq!(
            ACCESS_LEVEL_REFERRAL_PATH,
            "/api/admin/access-level-referral-assignments"
        );
        assert_eq!(
            ACCOUNTS_DORMANT_MINING_PATH,
            "/api/admin/accounts-dormant-mining"
        );
        assert_eq!(
            ADMIN_REFERRAL_MODELS_LIST_PATH,
            "/v1/admin/users/referral-models/list"
        );
        assert_eq!(
            ADMIN_REFERRAL_MODELS_UPSERT_PATH,
            "/v1/admin/users/referral-models/upsert"
        );
        assert_eq!(
            ADMIN_REFERRAL_MODELS_DELETE_PATH,
            "/v1/admin/users/referral-models/delete"
        );
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_LIST_PATH,
            "/v1/admin/users/access-level-referral-assignments/list"
        );
        assert_eq!(
            ADMIN_ACCESS_LEVEL_REFERRAL_SAVE_PATH,
            "/v1/admin/users/access-level-referral-assignments/save"
        );
        assert_eq!(
            ADMIN_DORMANT_MINING_PATH,
            "/v1/admin/users/accounts-dormant-mining"
        );
    }

    #[test]
    fn query_object_forwards_params_as_strings() {
        let params = HashMap::from([
            ("page".to_string(), "2".to_string()),
            ("search".to_string(), "bob b".to_string()),
            ("filterAdmins".to_string(), "1".to_string()),
        ]);
        let q = query_object(&params);
        assert_eq!(q["page"], "2");
        assert_eq!(q["search"], "bob b");
        assert_eq!(q["filterAdmins"], "1");
    }

    #[test]
    fn query_object_is_an_empty_object_without_params() {
        assert_eq!(query_object(&HashMap::new()), json!({}));
    }

    #[test]
    fn target_user_id_matches_node_parse() {
        assert_eq!(parse_target_user_id(&json!(7)), Some(7));
        assert_eq!(parse_target_user_id(&json!("7")), Some(7));
        assert_eq!(parse_target_user_id(&json!(" 7 ")), Some(7));
        assert_eq!(parse_target_user_id(&json!(7.9)), Some(7));
        assert_eq!(parse_target_user_id(&json!(0)), None);
        assert_eq!(parse_target_user_id(&json!(-3)), None);
        assert_eq!(parse_target_user_id(&json!("abc")), None);
        assert_eq!(parse_target_user_id(&Value::Null), None);
    }

    #[test]
    fn blocked_flag_follows_js_truthiness() {
        assert!(js_truthy(Some(&json!(true))));
        assert!(js_truthy(Some(&json!(1))));
        assert!(js_truthy(Some(&json!("0"))));
        assert!(!js_truthy(Some(&json!(false))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&Value::Null)));
        assert!(!js_truthy(None));
    }

    #[test]
    fn router_accepts_both_game_state_shapes() {
        // Panics if `/api/game-state/me` (player.rs) and the `{email}` param
        // route here cannot coexist in the same tree.
        let _ = Router::<Arc<AppState>>::new()
            .merge(router())
            .route("/api/game-state/me", get(|| async { "" }));
    }

    #[test]
    fn normalize_admin_stock_keeps_zero_for_merge_delete() {
        let out = normalize_admin_stock_snapshot(&json!({
            "gpu_a": 2,
            "gpu_b": 0,
            "bad/id": 3,
            "neg": -1,
        }));
        assert_eq!(out.get("gpu_a"), Some(&json!(2)));
        assert_eq!(out.get("gpu_b"), Some(&json!(0)));
        assert!(!out.contains_key("bad/id"));
        assert!(!out.contains_key("neg"));
    }

    #[test]
    fn normalize_admin_stock_coerces_strings() {
        let out = normalize_admin_stock_snapshot(&json!({ "a": "4", "b": "0", "c": "x" }));
        assert_eq!(out.get("a"), Some(&json!(4)));
        assert_eq!(out.get("b"), Some(&json!(0)));
        assert!(!out.contains_key("c"));
    }

    #[test]
    fn normalize_admin_stock_sums_duplicate_ids_via_accumulation() {
        // Simulate two entries for the same id the way the Node loop does.
        let mut raw = Map::new();
        raw.insert("gpu_a".into(), json!(2));
        let first = normalize_admin_stock_snapshot(&Value::Object(raw.clone()));
        raw.insert("gpu_a".into(), json!(3));
        // Object can't hold dupes; accumulation is covered by calling normalize twice into one map.
        let mut acc = first;
        let second = normalize_admin_stock_snapshot(&json!({ "gpu_a": 3 }));
        for (k, v) in second {
            let prev = acc.get(&k).and_then(Value::as_i64).unwrap_or(0);
            acc.insert(k, json!(prev + v.as_i64().unwrap_or(0)));
        }
        assert_eq!(acc.get("gpu_a"), Some(&json!(5)));
    }

    #[test]
    fn normalize_admin_stock_rejects_non_objects() {
        assert!(normalize_admin_stock_snapshot(&Value::Null).is_empty());
        assert!(normalize_admin_stock_snapshot(&json!([])).is_empty());
        assert!(normalize_admin_stock_snapshot(&json!("x")).is_empty());
    }

    #[test]
    fn normalize_placed_racks_defaults_room_and_filters_bad_ids() {
        let racks = normalize_placed_racks_for_persist(&json!([
            { "id": "rack_1", "itemId": "rack04", "slots": [null, "gpu_a"], "isOn": 1 },
            { "id": "bad id", "itemId": "rack04" },
            { "id": "r2", "itemId": "" },
        ]))
        .expect("array");
        assert_eq!(racks.len(), 1);
        assert_eq!(racks[0]["id"], "rack_1");
        assert_eq!(racks[0]["roomId"], ROOM_INITIAL_ID);
        assert_eq!(racks[0]["isOn"], true);
        assert_eq!(racks[0]["slots"], json!(["", "gpu_a"]));
    }

    #[test]
    fn normalize_coin_balances_bounds_match_node() {
        let out = normalize_coin_balances_for_wallet(&json!({
            "btc": 1.5,
            "": 2,
            "x": "nope",
            "ok": "3.25",
        }));
        assert_eq!(out.get("btc"), Some(&json!(1.5)));
        assert_eq!(out.get("ok"), Some(&json!(3.25)));
        assert!(!out.contains_key(""));
        assert!(!out.contains_key("x"));
        let mut m = Map::new();
        m.insert("c".repeat(COIN_ID_MAX + 1), json!(1));
        let out2 = normalize_coin_balances_for_wallet(&Value::Object(m));
        assert!(out2.is_empty());
    }
}
