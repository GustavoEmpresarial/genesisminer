//! Dormant mining report — old accounts with no active mining, or mining without wallet.
//!
//! Public twin: `GET /api/admin/accounts-dormant-mining`.

use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_DAY;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::player_reads::{i32_cell, now_ms, opt_string, string_cell, PlayerReadError};

use super::truthy_flag;

pub const ADMIN_DORMANT_MINING_PATH: &str = "/v1/admin/users/accounts-dormant-mining";

/// Client clamps (`admin-users.ts` / AdminUsersPage).
pub const DAYS_MIN_DEFAULT: i64 = 30;
pub const DAYS_MIN_FLOOR: i64 = 30;
pub const DAYS_MIN_CEILING: i64 = 365;
pub const LIMIT_DEFAULT: i64 = 500;
pub const LIMIT_FLOOR: i64 = 50;
pub const LIMIT_CEILING: i64 = 500;
pub const PAGE_DEFAULT: i64 = 1;
const RACK_ON_FLAG: i32 = 1;
const MS_PER_DAY_I64: i64 = MS_PER_DAY as i64;

const NOTE_PT: &str = "Idade por game_states.start_time. Sem mineração: nenhuma rig is_on=1. \
Mineram sem carteira: ≥1 rig is_on=1 e polygon_wallet vazio. Exclui admins e bloqueados.";

const _: () = assert!(DAYS_MIN_DEFAULT == 30);
const _: () = assert!(DAYS_MIN_FLOOR == 30);
const _: () = assert!(DAYS_MIN_CEILING == 365);
const _: () = assert!(LIMIT_DEFAULT == 500);
const _: () = assert!(LIMIT_FLOOR == 50);
const _: () = assert!(LIMIT_CEILING == 500);
const _: () = assert!(PAGE_DEFAULT == 1);
const _: () = assert!(RACK_ON_FLAG == 1);
const _: () = assert!(MS_PER_DAY_I64 == 86_400_000);

const BASE_FILTER_SQL: &str = "
    FROM users u
    INNER JOIN game_states gs ON gs.user_id = u.id
   WHERE gs.start_time IS NOT NULL
     AND gs.start_time <= $1
     AND COALESCE(u.is_admin, 0) = 0
     AND COALESCE(u.is_blocked, 0) = 0";

const NO_MINING_EXTRA: &str = "
     AND NOT EXISTS (
           SELECT 1 FROM placed_racks pr
            WHERE pr.user_id = u.id AND pr.is_on = $2
         )";

const MINING_NO_WALLET_EXTRA: &str = "
     AND EXISTS (
           SELECT 1 FROM placed_racks pr
            WHERE pr.user_id = u.id AND pr.is_on = $2
         )
     AND (u.polygon_wallet IS NULL OR BTRIM(u.polygon_wallet) = '')";

const SELECT_COLS: &str = "SELECT u.id, u.username, u.email, u.polygon_wallet,
       gs.start_time AS start_time_ms,
       u.last_active_at,
       u.ranking_excluded";

const ORDER_LIMIT: &str = " ORDER BY gs.start_time ASC LIMIT $3 OFFSET $4";

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DormantMiningRequest {
    #[serde(default)]
    pub days_min: Option<Value>,
    #[serde(default)]
    pub limit: Option<Value>,
    #[serde(default)]
    pub no_mining_page: Option<Value>,
    #[serde(default)]
    pub mining_no_wallet_page: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DormantMiningQuery {
    pub days_min: i64,
    pub limit: i64,
    pub no_mining_page: i64,
    pub mining_no_wallet_page: i64,
    pub cutoff_ms: i64,
}

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

fn value_as_i64(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_f64().and_then(|f| {
            if f.is_finite() {
                Some(f.floor() as i64)
            } else {
                None
            }
        }),
        Value::String(s) => js_parse_int(s),
        _ => None,
    }
}

pub fn clamp_days_min(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n >= DAYS_MIN_FLOOR => n.min(DAYS_MIN_CEILING),
        _ => DAYS_MIN_DEFAULT,
    }
}

pub fn clamp_limit(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n > 0 => n.clamp(LIMIT_FLOOR, LIMIT_CEILING),
        _ => LIMIT_DEFAULT,
    }
}

pub fn clamp_page(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n >= PAGE_DEFAULT => n,
        _ => PAGE_DEFAULT,
    }
}

pub fn parse_dormant_mining_query(req: &DormantMiningRequest, now: i64) -> DormantMiningQuery {
    let days_min = clamp_days_min(value_as_i64(req.days_min.as_ref()));
    let limit = clamp_limit(value_as_i64(req.limit.as_ref()));
    let no_mining_page = clamp_page(value_as_i64(req.no_mining_page.as_ref()));
    let mining_no_wallet_page = clamp_page(value_as_i64(req.mining_no_wallet_page.as_ref()));
    let cutoff_ms = now - days_min * MS_PER_DAY_I64;
    DormantMiningQuery {
        days_min,
        limit,
        no_mining_page,
        mining_no_wallet_page,
        cutoff_ms,
    }
}

fn page_offset(page: i64, limit: i64) -> i64 {
    (page - PAGE_DEFAULT) * limit
}

fn bigint_as_string(row: &tokio_postgres::Row, col: &str) -> Option<String> {
    if let Ok(v) = row.try_get::<_, Option<i64>>(col) {
        return v.map(|n| n.to_string());
    }
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return Some(v.to_string());
    }
    if let Ok(v) = row.try_get::<_, Option<i32>>(col) {
        return v.map(|n| n.to_string());
    }
    None
}

fn map_dormant_row(r: &tokio_postgres::Row) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), json!(i32_cell(r, "id")));
    obj.insert("username".into(), json!(string_cell(r, "username")));
    obj.insert("email".into(), json!(string_cell(r, "email")));
    obj.insert(
        "polygonWallet".into(),
        match opt_string(r, "polygon_wallet") {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    obj.insert(
        "startTimeMs".into(),
        match bigint_as_string(r, "start_time_ms") {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    obj.insert(
        "lastActiveAt".into(),
        match bigint_as_string(r, "last_active_at") {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    let ranking = i32_cell(r, "ranking_excluded");
    obj.insert(
        "rankingExcluded".into(),
        json!(truthy_flag(Some(ranking))),
    );
    Value::Object(obj)
}

async fn count_and_page(
    conn: &deadpool_postgres::Object,
    extra_sql: &str,
    cutoff_ms: i64,
    limit: i64,
    page: i64,
) -> Result<(i64, Vec<Value>), PlayerReadError> {
    let on = RACK_ON_FLAG;
    let count_sql = format!("SELECT COUNT(*)::bigint AS n {BASE_FILTER_SQL}{extra_sql}");
    let total: i64 = conn
        .query_one(&count_sql, &[&cutoff_ms, &on])
        .await?
        .get("n");
    let offset = page_offset(page, limit);
    let page_sql = format!("{SELECT_COLS}{BASE_FILTER_SQL}{extra_sql}{ORDER_LIMIT}");
    let rows = conn
        .query(&page_sql, &[&cutoff_ms, &on, &limit, &offset])
        .await?;
    let items: Vec<Value> = rows.iter().map(map_dormant_row).collect();
    Ok((total, items))
}

pub async fn run_dormant_mining(
    pool: &Pool,
    req: &DormantMiningRequest,
) -> Result<Value, PlayerReadError> {
    let q = parse_dormant_mining_query(req, now_ms());
    let conn = pool.get().await?;
    let (no_mining_total, no_mining) = count_and_page(
        &conn,
        NO_MINING_EXTRA,
        q.cutoff_ms,
        q.limit,
        q.no_mining_page,
    )
    .await?;
    let (mining_no_wallet_total, mining_no_wallet) = count_and_page(
        &conn,
        MINING_NO_WALLET_EXTRA,
        q.cutoff_ms,
        q.limit,
        q.mining_no_wallet_page,
    )
    .await?;
    Ok(json!({
        "daysMin": q.days_min,
        "cutoffMs": q.cutoff_ms.to_string(),
        "limit": q.limit,
        "limitEach": q.limit,
        "noMiningPage": q.no_mining_page,
        "miningNoWalletPage": q.mining_no_wallet_page,
        "noMiningTotal": no_mining_total,
        "miningNoWalletTotal": mining_no_wallet_total,
        "note": NOTE_PT,
        "noMining": no_mining,
        "miningNoWallet": mining_no_wallet,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_is_stable() {
        assert_eq!(
            ADMIN_DORMANT_MINING_PATH,
            "/v1/admin/users/accounts-dormant-mining"
        );
    }

    #[test]
    fn clamps_match_client() {
        assert_eq!(clamp_days_min(None), 30);
        assert_eq!(clamp_days_min(Some(10)), 30);
        assert_eq!(clamp_days_min(Some(30)), 30);
        assert_eq!(clamp_days_min(Some(90)), 90);
        assert_eq!(clamp_days_min(Some(400)), 365);
        assert_eq!(clamp_limit(None), 500);
        assert_eq!(clamp_limit(Some(10)), 50);
        assert_eq!(clamp_limit(Some(100)), 100);
        assert_eq!(clamp_limit(Some(999)), 500);
        assert_eq!(clamp_page(None), 1);
        assert_eq!(clamp_page(Some(0)), 1);
        assert_eq!(clamp_page(Some(3)), 3);
    }

    #[test]
    fn cutoff_uses_ms_per_day() {
        let req = DormantMiningRequest {
            days_min: Some(json!(30)),
            limit: Some(json!(50)),
            no_mining_page: Some(json!(2)),
            mining_no_wallet_page: Some(json!(1)),
        };
        let now = 1_700_000_000_000_i64;
        let q = parse_dormant_mining_query(&req, now);
        assert_eq!(q.days_min, 30);
        assert_eq!(q.limit, 50);
        assert_eq!(q.no_mining_page, 2);
        assert_eq!(q.cutoff_ms, now - 30 * MS_PER_DAY_I64);
        assert_eq!(page_offset(2, 50), 50);
    }
}
