//! `GET /api/users` — Node `services/list.ts` + `list-query.ts`.
//!
//! The panel sends everything as Express query strings, so the parsing keeps the
//! JS coercions (`parseInt` on a prefix, `String(x || 'all')`) instead of strict
//! Rust parsing: the same URL must produce the same page.

use std::collections::HashMap;

use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_MINUTE;
use serde_json::{json, Map, Value};
use tokio_postgres::types::ToSql;

use crate::player_reads::{f64_cell, i32_cell, now_ms, opt_string, string_cell, PlayerReadError};

use super::truthy_flag;

/// Node `DEFAULT_PAGE` / `DEFAULT_LIMIT` / `MAX_LIMIT`.
const DEFAULT_PAGE: i64 = 1;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
/// Node `SEARCH_MAX_LENGTH` / `FILTER_ID_MAX_LENGTH`.
const SEARCH_MAX_LENGTH: usize = 120;
const FILTER_ID_MAX_LENGTH: usize = 80;
/// Node `ONLINE_WINDOW_MINUTES`.
const ONLINE_WINDOW_MINUTES: i64 = 5;
const ONLINE_WINDOW_MS: i64 = ONLINE_WINDOW_MINUTES * MS_PER_MINUTE as i64;

const FILTER_ALL: &str = "all";
const FILTER_ONLINE: &str = "online";
const FILTER_OFFLINE: &str = "offline";
const SORT_ALPHA: &str = "alpha";
const SORT_DESC: &str = "DESC";
const SORT_ASC: &str = "ASC";

const _: () = assert!(DEFAULT_LIMIT == 50);
const _: () = assert!(MAX_LIMIT == 200);
const _: () = assert!(SEARCH_MAX_LENGTH == 120);
const _: () = assert!(FILTER_ID_MAX_LENGTH == 80);
const _: () = assert!(ONLINE_WINDOW_MS == 5 * 60 * 1000);

/// Node `AdminUsersListQuery`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminUsersListQuery {
    pub page: i64,
    pub limit: i64,
    pub offset: i64,
    pub search: String,
    pub user_id: Option<i32>,
    pub sort_alpha: bool,
    pub sort_desc: bool,
    pub filter_status: String,
    pub filter_level: String,
    pub filter_room: String,
    pub filter_admins_only: bool,
}

/// JS `String(value ?? '')` for the subset Express can produce (query values are
/// strings or arrays of strings; anything else comes from a JSON body).
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

/// JS `parseInt(str, 10)` — leading whitespace, optional sign, digit prefix.
fn js_parse_int(raw: &str) -> Option<i64> {
    let s = raw.trim_start();
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    digits[..end]
        .parse::<i64>()
        .ok()
        .map(|n| if neg { -n } else { n })
}

fn int_or(v: Option<&Value>, fallback: i64) -> i64 {
    js_parse_int(&js_string(v)).unwrap_or(fallback)
}

/// Node `clip` (JS `slice`) — bounded by characters so multi-byte input never
/// splits a code point.
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Node `parsePositiveUserId` — `null`/empty means "no filter".
fn parse_positive_user_id(v: Option<&Value>) -> Option<i32> {
    let raw = js_string(v);
    if raw.trim().is_empty() {
        return None;
    }
    let n = js_parse_int(raw.trim())?;
    if n <= 0 {
        return None;
    }
    i32::try_from(n).ok()
}

/// Node `parseAdminUsersListQuery`.
pub fn parse_admin_users_list_query(raw: &Value) -> AdminUsersListQuery {
    let empty = Map::new();
    let src = raw.as_object().unwrap_or(&empty);
    let get = |k: &str| src.get(k);

    let page_raw = int_or(get("page"), DEFAULT_PAGE);
    let page = page_raw.max(DEFAULT_PAGE);
    let limit_raw = int_or(get("limit"), DEFAULT_LIMIT);
    // Node: `Math.min(MAX_LIMIT, Math.max(1, limitRaw || DEFAULT_LIMIT))` — the
    // `||` turns a parsed `0` back into the default.
    let limit_or_default = if limit_raw == 0 {
        DEFAULT_LIMIT
    } else {
        limit_raw
    };
    let limit = limit_or_default.max(1).min(MAX_LIMIT);
    let search = clip(&js_string(get("search")).to_lowercase(), SEARCH_MAX_LENGTH);
    let sort_alpha = get("sortBy").and_then(Value::as_str) == Some(SORT_ALPHA);
    let sort_desc = js_string(get("sortDir")).to_lowercase() == "desc";
    let status_raw = or_default_string(get("filterStatus"), FILTER_ALL);
    let filter_status = if status_raw == FILTER_ONLINE || status_raw == FILTER_OFFLINE {
        status_raw
    } else {
        FILTER_ALL.to_string()
    };
    let filter_level = clip(
        or_default_string(get("filterLevel"), FILTER_ALL).trim(),
        FILTER_ID_MAX_LENGTH,
    );
    let filter_room = clip(
        or_default_string(get("filterRoom"), FILTER_ALL).trim(),
        FILTER_ID_MAX_LENGTH,
    );
    let filter_admins_raw = js_string(get("filterAdmins"));
    let filter_admins_only = filter_admins_raw == "1" || filter_admins_raw.to_lowercase() == "true";

    AdminUsersListQuery {
        page,
        limit,
        offset: (page - 1) * limit,
        search,
        user_id: parse_positive_user_id(get("userId")),
        sort_alpha,
        sort_desc,
        filter_status,
        filter_level: non_empty_or(filter_level, FILTER_ALL),
        filter_room: non_empty_or(filter_room, FILTER_ALL),
        filter_admins_only,
    }
}

/// JS `String(value || fallback)` — empty strings fall back too.
fn or_default_string(v: Option<&Value>, fallback: &str) -> String {
    let s = js_string(v);
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

fn non_empty_or(s: String, fallback: &str) -> String {
    if s.is_empty() {
        fallback.to_string()
    } else {
        s
    }
}

/// Node `orderByClause`. Both branches interpolate a fixed literal, never input.
fn order_by_clause(q: &AdminUsersListQuery) -> String {
    let dir = if q.sort_desc { SORT_DESC } else { SORT_ASC };
    if q.sort_alpha {
        format!("ORDER BY u.username {dir}")
    } else {
        format!("ORDER BY u.id {dir}")
    }
}

/// Node `roomFilterSql` — the same `$n` is reused three times.
fn room_filter_sql(param_idx: usize) -> String {
    format!(
        "(
        EXISTS (
          SELECT 1
          FROM user_rig_rooms urr
          WHERE urr.user_id = u.id
            AND urr.room_id = ${param_idx}
        )
        OR EXISTS (
          SELECT 1
          FROM placed_racks pr
          WHERE pr.user_id = u.id
            AND COALESCE(NULLIF(BTRIM(pr.room_id::text), ''), 'room_initial') = ${param_idx}
        )
        OR EXISTS (
          SELECT 1
          FROM rig_rooms rr
          WHERE rr.id = ${param_idx}
            AND COALESCE(rr.is_active, 1) = 1
            AND (
              COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]') = '[]'
              OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(NULLIF(BTRIM(rr.allowed_levels), ''), '[]')::jsonb) AS room_lvl(level_id)
                WHERE LOWER(BTRIM(room_lvl.level_id)) IN (
                  SELECT lvl.level_id
                  FROM (
                    SELECT LOWER(BTRIM(u.access_level_id::text)) AS level_id
                    WHERE u.access_level_id IS NOT NULL AND BTRIM(u.access_level_id::text) <> ''
                    UNION
                    SELECT LOWER(BTRIM(ual.access_level_id::text)) AS level_id
                    FROM user_access_levels ual
                    WHERE ual.user_id = u.id
                      AND ual.access_level_id IS NOT NULL
                      AND BTRIM(ual.access_level_id::text) <> ''
                  ) lvl
                )
              )
            )
        )
      )"
    )
}

/// Owned SQL parameter values — `buildUsersListWhere` mixes ids, patterns and
/// timestamps, so they are boxed into one heterogeneous list.
enum WhereParam {
    Int(i32),
    Text(String),
    BigInt(i64),
}

impl WhereParam {
    fn as_sql(&self) -> &(dyn ToSql + Sync) {
        match self {
            Self::Int(v) => v,
            Self::Text(v) => v,
            Self::BigInt(v) => v,
        }
    }
}

struct UsersListWhere {
    sql: String,
    params: Vec<WhereParam>,
    next_idx: usize,
}

/// Node `buildUsersListWhere`.
fn build_users_list_where(q: &AdminUsersListQuery, now_ms: i64) -> UsersListWhere {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<WhereParam> = Vec::new();
    let mut idx = 1usize;

    if q.filter_admins_only {
        conditions.push("u.is_admin = 1".to_string());
    }

    if let Some(uid) = q.user_id {
        conditions.push(format!("u.id = ${idx}"));
        params.push(WhereParam::Int(uid));
        idx += 1;
    }

    if !q.search.is_empty() {
        conditions.push(format!(
            "(LOWER(u.username) LIKE ${idx} OR LOWER(u.email) LIKE ${idx} OR LOWER(u.polygon_wallet) LIKE ${idx})"
        ));
        params.push(WhereParam::Text(format!("%{}%", q.search)));
        idx += 1;
    }

    if q.filter_level != FILTER_ALL && q.filter_room == FILTER_ALL {
        conditions.push(format!("u.access_level_id = ${idx}"));
        params.push(WhereParam::Text(q.filter_level.clone()));
        idx += 1;
    }

    if q.filter_room != FILTER_ALL {
        conditions.push(room_filter_sql(idx));
        params.push(WhereParam::Text(q.filter_room.clone()));
        idx += 1;
    }

    let window_start = now_ms - ONLINE_WINDOW_MS;
    if q.filter_status == FILTER_ONLINE {
        conditions.push(format!("gs.last_updated_at >= ${idx}"));
        params.push(WhereParam::BigInt(window_start));
        idx += 1;
    } else if q.filter_status == FILTER_OFFLINE {
        conditions.push(format!(
            "(gs.last_updated_at < ${idx} OR gs.last_updated_at IS NULL)"
        ));
        params.push(WhereParam::BigInt(window_start));
        idx += 1;
    }

    let sql = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    UsersListWhere {
        sql,
        params,
        next_idx: idx,
    }
}

/// Node `parseAdminPermissionsJson` — a JSON array of strings, or nothing.
fn parse_admin_permissions_json(raw: Option<&str>) -> Vec<String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(s) {
        Ok(Value::Array(items)) => items
            .iter()
            .map(|x| match x {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Node `numOrUndef` — `null` / empty is "absent", not `0`.
fn num_or_undef(row: &tokio_postgres::Row, col: &str) -> Option<f64> {
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return Some(v as f64);
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i32>>(col) {
        return Some(f64::from(v));
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<f64>>(col) {
        return Some(v);
    }
    if let Ok(Some(s)) = row.try_get::<_, Option<String>>(col) {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        return t.parse::<f64>().ok();
    }
    None
}

/// Node `JSON.stringify` drops `undefined` keys — mirror that instead of
/// emitting `null`, so the panel keeps its `?? fallback` behaviour.
fn insert_optional(obj: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        obj.insert(key.to_string(), v);
    }
}

/// Node `Math.ceil(total / limit)`, guarded on `limit > 0`.
fn page_count(total: i64, limit: i64) -> i64 {
    if limit <= 0 {
        return 0;
    }
    (total + limit - 1) / limit
}

struct GameStateAggregate {
    last_updated_at: Option<f64>,
    total_usdc_deposited: f64,
    total_crypto_withdrawn: f64,
}

pub async fn run_admin_users_list(
    pool: &Pool,
    raw_query: &Value,
) -> Result<Value, PlayerReadError> {
    let q = parse_admin_users_list_query(raw_query);
    let where_clause = build_users_list_where(&q, now_ms());
    let params: Vec<&(dyn ToSql + Sync)> =
        where_clause.params.iter().map(WhereParam::as_sql).collect();
    let order_sql = order_by_clause(&q);
    let where_sql = &where_clause.sql;

    let conn = pool.get().await?;

    let count_row = conn
        .query_one(
            &format!(
                "SELECT COUNT(*) AS count
                   FROM users u
                   LEFT JOIN game_states gs ON u.id = gs.user_id
                   {where_sql}"
            ),
            &params,
        )
        .await?;
    let total = count_row.try_get::<_, i64>("count").unwrap_or(0);
    let pages = page_count(total, q.limit);

    let limit_idx = where_clause.next_idx;
    let offset_idx = limit_idx + 1;
    let mut page_params = params.clone();
    page_params.push(&q.limit);
    page_params.push(&q.offset);
    let rows = conn
        .query(
            &format!(
                "SELECT u.*
                   FROM users u
                   LEFT JOIN game_states gs ON u.id = gs.user_id
                   {where_sql}
                   {order_sql}
                   LIMIT ${limit_idx} OFFSET ${offset_idx}"
            ),
            &page_params,
        )
        .await?;

    let level_rows = conn.query("SELECT id,name FROM access_levels", &[]).await?;
    let room_rows = conn
        .query(
            "SELECT id, name
               FROM rig_rooms
              WHERE COALESCE(is_active, 1) = 1
              ORDER BY sort_order ASC, name ASC",
            &[],
        )
        .await?;
    let levels: Vec<Value> = level_rows
        .iter()
        .map(|r| json!({ "id": string_cell(r, "id"), "name": string_cell(r, "name") }))
        .collect();
    let rooms: Vec<Value> = room_rows
        .iter()
        .map(|r| json!({ "id": string_cell(r, "id"), "name": string_cell(r, "name") }))
        .collect();

    if rows.is_empty() {
        return Ok(json!({
            "users": [],
            "total": total,
            "pages": pages,
            "levels": levels,
            "rooms": rooms,
        }));
    }

    let user_ids: Vec<i32> = rows.iter().map(|r| i32_cell(r, "id")).collect();

    let referral_rows = conn
        .query(
            "SELECT user_id, referred_username FROM referrals WHERE user_id = ANY($1)",
            &[&user_ids],
        )
        .await?;
    let gs_rows = conn
        .query(
            "SELECT user_id, last_updated_at,
                    total_usdc_deposited::double precision AS total_usdc_deposited,
                    total_crypto_withdrawn::double precision AS total_crypto_withdrawn
               FROM game_states WHERE user_id = ANY($1)",
            &[&user_ids],
        )
        .await?;
    let user_level_rows = conn
        .query(
            "SELECT user_id, access_level_id FROM user_access_levels WHERE user_id = ANY($1)",
            &[&user_ids],
        )
        .await?;

    let mut referrals_by_user: HashMap<i32, Vec<String>> = HashMap::new();
    for r in &referral_rows {
        referrals_by_user
            .entry(i32_cell(r, "user_id"))
            .or_default()
            .push(string_cell(r, "referred_username"));
    }
    let mut game_states: HashMap<i32, GameStateAggregate> = HashMap::new();
    for r in &gs_rows {
        game_states.insert(
            i32_cell(r, "user_id"),
            GameStateAggregate {
                last_updated_at: num_or_undef(r, "last_updated_at"),
                total_usdc_deposited: f64_cell(r, "total_usdc_deposited"),
                total_crypto_withdrawn: f64_cell(r, "total_crypto_withdrawn"),
            },
        );
    }
    let mut levels_by_user: HashMap<i32, Vec<String>> = HashMap::new();
    for r in &user_level_rows {
        levels_by_user
            .entry(i32_cell(r, "user_id"))
            .or_default()
            .push(string_cell(r, "access_level_id"));
    }

    let users: Vec<Value> = rows
        .iter()
        .map(|r| map_user_row(r, &referrals_by_user, &game_states, &levels_by_user))
        .collect();

    Ok(json!({
        "users": users,
        "total": total,
        "pages": pages,
        "levels": levels,
        "rooms": rooms,
    }))
}

/// Node `mapUserRow`.
fn map_user_row(
    r: &tokio_postgres::Row,
    referrals_by_user: &HashMap<i32, Vec<String>>,
    game_states: &HashMap<i32, GameStateAggregate>,
    levels_by_user: &HashMap<i32, Vec<String>>,
) -> Value {
    let id = i32_cell(r, "id");
    let gs = game_states.get(&id);
    let access_level_id = opt_string(r, "access_level_id");
    let mut access_level_ids: Vec<String> = Vec::new();
    for lvl in levels_by_user
        .get(&id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .chain(access_level_id.clone())
    {
        if !access_level_ids.contains(&lvl) {
            access_level_ids.push(lvl);
        }
    }
    let last_active_at =
        num_or_undef(r, "last_active_at").or_else(|| gs.and_then(|g| g.last_updated_at));

    let mut obj = Map::new();
    obj.insert("id".into(), json!(id));
    obj.insert("username".into(), json!(string_cell(r, "username")));
    obj.insert("email".into(), json!(string_cell(r, "email")));
    obj.insert(
        "isAdmin".into(),
        json!(truthy_flag(Some(i32_cell(r, "is_admin")))),
    );
    obj.insert(
        "isSuperAdmin".into(),
        json!(truthy_flag(Some(i32_cell(r, "is_super_admin")))),
    );
    insert_optional(
        &mut obj,
        "polygonWallet",
        opt_string(r, "polygon_wallet").map(Value::String),
    );
    obj.insert(
        "isBlocked".into(),
        json!(truthy_flag(Some(i32_cell(r, "is_blocked")))),
    );
    insert_optional(
        &mut obj,
        "accessLevelId",
        access_level_id.map(Value::String),
    );
    insert_optional(
        &mut obj,
        "referralCode",
        opt_string(r, "referral_code").map(Value::String),
    );
    insert_optional(
        &mut obj,
        "referredBy",
        opt_string(r, "referred_by").map(Value::String),
    );
    obj.insert(
        "referrals".into(),
        json!(referrals_by_user.get(&id).cloned().unwrap_or_default()),
    );
    obj.insert("accessLevelIds".into(), json!(access_level_ids));
    insert_optional(&mut obj, "lastActiveAt", last_active_at.map(|v| json!(v)));
    obj.insert(
        "totalUsdcDeposited".into(),
        json!(gs.map(|g| g.total_usdc_deposited).unwrap_or(0.0)),
    );
    obj.insert(
        "totalCryptoWithdrawn".into(),
        json!(gs.map(|g| g.total_crypto_withdrawn).unwrap_or(0.0)),
    );
    obj.insert(
        "adminPermissions".into(),
        json!(parse_admin_permissions_json(
            r.try_get::<_, Option<String>>("admin_permissions")
                .unwrap_or(None)
                .as_deref()
        )),
    );
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(v: Value) -> AdminUsersListQuery {
        parse_admin_users_list_query(&v)
    }

    #[test]
    fn defaults_match_node() {
        let parsed = q(json!({}));
        assert_eq!(parsed.page, DEFAULT_PAGE);
        assert_eq!(parsed.limit, DEFAULT_LIMIT);
        assert_eq!(parsed.offset, 0);
        assert!(parsed.search.is_empty());
        assert_eq!(parsed.user_id, None);
        assert!(!parsed.sort_alpha);
        assert!(!parsed.sort_desc);
        assert_eq!(parsed.filter_status, FILTER_ALL);
        assert_eq!(parsed.filter_level, FILTER_ALL);
        assert_eq!(parsed.filter_room, FILTER_ALL);
        assert!(!parsed.filter_admins_only);
    }

    #[test]
    fn limit_is_clamped_like_node() {
        assert_eq!(q(json!({ "limit": "0" })).limit, DEFAULT_LIMIT);
        assert_eq!(q(json!({ "limit": "-5" })).limit, 1);
        assert_eq!(q(json!({ "limit": "9999" })).limit, MAX_LIMIT);
        assert_eq!(q(json!({ "limit": "abc" })).limit, DEFAULT_LIMIT);
        assert_eq!(q(json!({ "limit": "25" })).limit, 25);
    }

    #[test]
    fn page_floor_and_offset() {
        assert_eq!(q(json!({ "page": "0" })).page, DEFAULT_PAGE);
        assert_eq!(q(json!({ "page": "-3" })).page, DEFAULT_PAGE);
        let parsed = q(json!({ "page": "3", "limit": "10" }));
        assert_eq!(parsed.offset, 20);
    }

    #[test]
    fn parse_int_keeps_js_prefix_semantics() {
        assert_eq!(js_parse_int("12abc"), Some(12));
        assert_eq!(js_parse_int("  7 "), Some(7));
        assert_eq!(js_parse_int("-4x"), Some(-4));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
    }

    #[test]
    fn search_is_lowercased_and_clipped() {
        let long = "A".repeat(SEARCH_MAX_LENGTH + 40);
        let parsed = q(json!({ "search": long }));
        assert_eq!(parsed.search.chars().count(), SEARCH_MAX_LENGTH);
        assert!(parsed.search.chars().all(|c| c == 'a'));
    }

    #[test]
    fn user_id_filter_rejects_non_positive() {
        assert_eq!(q(json!({ "userId": "42" })).user_id, Some(42));
        assert_eq!(q(json!({ "userId": "0" })).user_id, None);
        assert_eq!(q(json!({ "userId": "-1" })).user_id, None);
        assert_eq!(q(json!({ "userId": "" })).user_id, None);
        assert_eq!(q(json!({ "userId": "7.9" })).user_id, Some(7));
    }

    #[test]
    fn sort_and_filter_flags() {
        assert!(q(json!({ "sortBy": "alpha" })).sort_alpha);
        assert!(!q(json!({ "sortBy": "creation" })).sort_alpha);
        assert!(q(json!({ "sortDir": "DESC" })).sort_desc);
        assert!(!q(json!({ "sortDir": "asc" })).sort_desc);
        assert!(q(json!({ "filterAdmins": "1" })).filter_admins_only);
        assert!(q(json!({ "filterAdmins": "TRUE" })).filter_admins_only);
        assert!(!q(json!({ "filterAdmins": "0" })).filter_admins_only);
        assert_eq!(
            q(json!({ "filterStatus": "online" })).filter_status,
            "online"
        );
        assert_eq!(
            q(json!({ "filterStatus": "bogus" })).filter_status,
            FILTER_ALL
        );
        assert_eq!(q(json!({ "filterLevel": "  " })).filter_level, FILTER_ALL);
        assert_eq!(q(json!({ "filterLevel": " gold " })).filter_level, "gold");
    }

    #[test]
    fn order_by_uses_fixed_literals() {
        assert_eq!(
            order_by_clause(&q(json!({ "sortBy": "alpha", "sortDir": "desc" }))),
            "ORDER BY u.username DESC"
        );
        assert_eq!(order_by_clause(&q(json!({}))), "ORDER BY u.id ASC");
    }

    #[test]
    fn where_is_empty_without_filters() {
        let built = build_users_list_where(&q(json!({})), 1_000_000);
        assert_eq!(built.sql, "");
        assert!(built.params.is_empty());
        assert_eq!(built.next_idx, 1);
    }

    #[test]
    fn where_numbers_params_in_node_order() {
        let built = build_users_list_where(
            &q(json!({
                "filterAdmins": "1",
                "userId": "9",
                "search": "bob",
                "filterRoom": "room_x",
                "filterStatus": "online"
            })),
            1_000_000,
        );
        assert!(built.sql.starts_with("WHERE u.is_admin = 1 AND u.id = $1"));
        assert!(built.sql.contains("LOWER(u.username) LIKE $2"));
        assert!(built.sql.contains("urr.room_id = $3"));
        assert!(built.sql.contains("gs.last_updated_at >= $4"));
        assert_eq!(built.next_idx, 5);
        assert_eq!(built.params.len(), 4);
    }

    #[test]
    fn level_filter_is_skipped_when_a_room_filter_is_set() {
        let level_only = build_users_list_where(&q(json!({ "filterLevel": "gold" })), 0);
        assert!(level_only.sql.contains("u.access_level_id = $1"));
        let with_room = build_users_list_where(
            &q(json!({ "filterLevel": "gold", "filterRoom": "room_x" })),
            0,
        );
        assert!(!with_room.sql.contains("u.access_level_id = $"));
        assert_eq!(with_room.params.len(), 1);
    }

    #[test]
    fn offline_filter_includes_null_last_update() {
        let built = build_users_list_where(&q(json!({ "filterStatus": "offline" })), 60_000);
        assert!(built
            .sql
            .contains("(gs.last_updated_at < $1 OR gs.last_updated_at IS NULL)"));
    }

    #[test]
    fn online_window_is_five_minutes_before_now() {
        let now = 10 * ONLINE_WINDOW_MS;
        let built = build_users_list_where(&q(json!({ "filterStatus": "online" })), now);
        match built.params.first() {
            Some(WhereParam::BigInt(v)) => assert_eq!(*v, now - ONLINE_WINDOW_MS),
            _ => panic!("expected the window start as a bigint param"),
        }
    }

    #[test]
    fn room_filter_reuses_the_same_placeholder() {
        let sql = room_filter_sql(3);
        assert_eq!(sql.matches("$3").count(), 3);
    }

    #[test]
    fn admin_permissions_parse_like_node() {
        assert!(parse_admin_permissions_json(None).is_empty());
        assert!(parse_admin_permissions_json(Some("  ")).is_empty());
        assert!(parse_admin_permissions_json(Some("not json")).is_empty());
        assert!(parse_admin_permissions_json(Some(r#"{"users":true}"#)).is_empty());
        assert_eq!(
            parse_admin_permissions_json(Some(r#"["users","reports"]"#)),
            vec!["users".to_string(), "reports".to_string()]
        );
    }

    #[test]
    fn page_count_rounds_up_like_node() {
        assert_eq!(page_count(0, DEFAULT_LIMIT), 0);
        assert_eq!(page_count(1, DEFAULT_LIMIT), 1);
        assert_eq!(page_count(DEFAULT_LIMIT, DEFAULT_LIMIT), 1);
        assert_eq!(page_count(DEFAULT_LIMIT + 1, DEFAULT_LIMIT), 2);
        assert_eq!(page_count(10, 0), 0);
    }

    #[test]
    fn optional_fields_are_omitted_not_nulled() {
        let mut obj = Map::new();
        insert_optional(&mut obj, "polygonWallet", None);
        insert_optional(&mut obj, "accessLevelId", Some(json!("gold")));
        assert!(!obj.contains_key("polygonWallet"));
        assert_eq!(obj["accessLevelId"], "gold");
    }
}
