//! Admin "Usuários" tab leftovers — the four `/api/user(s)` routes plus the
//! admin half of `GET /api/game-state/:email`.
//!
//! Twin of `server/modules/admin/users/controllers/users.controller.ts`. The
//! controller-level parsing (query string, `id`, e-mail bounds) stays here like
//! it does in Express; the SQL lives in mining-worker `admin_users` and the
//! game-state read in genesis-hardware.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::admin_auth::{require_admin, AdminCtx};
use crate::client_ip::get_client_ip;
use crate::config::AppState;
use crate::facade::{forward_mining, worker_to_response};
use crate::session::json_status;
use crate::workers::{post_hardware, post_mining, worker_infra_status, worker_unavailable_body};

/// Public paths owned here.
const USERS_PATH: &str = "/api/users";
const USERS_BLOCK_PATH: &str = "/api/users/block";
const USER_PATH: &str = "/api/user";
const USER_BY_EMAIL_PATH: &str = "/api/user/{email}";
const GAME_STATE_BY_EMAIL_PATH: &str = "/api/game-state/{email}";

/// Worker twins.
const ADMIN_USERS_LIST_PATH: &str = "/v1/users/admin-list";
const ADMIN_USERS_BLOCK_PATH: &str = "/v1/users/admin-block";
const ADMIN_USERS_UPDATE_PATH: &str = "/v1/users/admin-update";
const ADMIN_USERS_DELETE_RESOLVE_PATH: &str = "/v1/users/admin-delete/resolve";
const ADMIN_USERS_DELETE_PATH: &str = "/v1/users/admin-delete";
const HARDWARE_WIPE_USER_PATH: &str = "/v1/hardware/wipe-user";
const ADMIN_GAME_STATE_BY_EMAIL_PATH: &str = "/v1/game-state/by-email";

/// Node `HTTP_BAD_REQUEST` in users.controller.ts.
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_OK: u16 = 200;
/// Same status the facade helpers use when a worker answers something the
/// contract does not allow.
const HTTP_BAD_GATEWAY: u16 = 502;
const CODE_WORKER_UNAVAILABLE: &str = "WORKER_UNAVAILABLE";
/// Node `EMAIL_MAX`.
const EMAIL_MAX: usize = 254;

/// Node `X-Admin-Edit` header (`'1'` enables the editable snapshot).
const ADMIN_EDIT_HEADER: &str = "x-admin-edit";
const ADMIN_EDIT_ON: &str = "1";

/// Node controller messages.
const ERR_INVALID_EMAIL: &str = "Email inválido";
const ERR_USER_ID_REQUIRED: &str = "User id is required.";
const CODE_VALIDATION: &str = "VALIDATION";

const _: () = assert!(EMAIL_MAX == 254);

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

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(USERS_PATH, get(get_users))
        .route(USERS_BLOCK_PATH, put(put_users_block))
        .route(USER_PATH, put(put_user))
        .route(USER_BY_EMAIL_PATH, delete(delete_user))
        .route(GAME_STATE_BY_EMAIL_PATH, get(get_game_state_by_email))
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
}
