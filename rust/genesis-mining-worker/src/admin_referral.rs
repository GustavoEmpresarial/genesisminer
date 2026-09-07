//! Admin referral program reports — ports `server/modules/admin/referral/`
//! (Express): summary KPIs, paginated commissions ledger + CSV, indicador↔indicado
//! links, multi-token lookup (uplines + network), network block, and the
//! destructive cascade network-delete (`deleteUserByEmail`, DECISIONS.md #43).

use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::player_reads::PlayerReadError;

pub const REF_SUMMARY_PATH: &str = "/v1/admin/referrals/summary";
pub const REF_COMMISSIONS_PATH: &str = "/v1/admin/referrals/commissions";
pub const REF_LINKS_PATH: &str = "/v1/admin/referrals/links";
pub const REF_EXPORT_CSV_PATH: &str = "/v1/admin/referrals/export-csv";
pub const REF_LOOKUP_PATH: &str = "/v1/admin/referrals/lookup";
pub const REF_NETWORK_BLOCK_PATH: &str = "/v1/admin/referrals/network-block";
pub const REF_NETWORK_DELETE_PATH: &str = "/v1/admin/referrals/network-delete";

const COMMISSION_PERCENT: f64 = 5.0;
const TOP_REFERRERS_LIMIT: i64 = 10;
const EXPORT_ROWS_LIMIT: i64 = 50_000;
const PAGE_MAX: i64 = 99_999;
const LIMIT_MAX: i64 = 500;
const LOOKUP_QUERIES_MAX: usize = 50;
const CHAIN_MAX_DEPTH: usize = 10;
const NETWORK_ROWS_PREVIEW_MAX: usize = 100;

fn f64_col(r: &tokio_postgres::Row, c: &str) -> f64 {
    r.try_get::<_, Option<f64>>(c).ok().flatten().unwrap_or(0.0)
}
fn i64_col(r: &tokio_postgres::Row, c: &str) -> i64 {
    if let Ok(v) = r.try_get::<_, i64>(c) {
        return v;
    }
    if let Ok(v) = r.try_get::<_, i32>(c) {
        return i64::from(v);
    }
    r.try_get::<_, Option<i64>>(c).ok().flatten().unwrap_or(0)
}
fn s_col(r: &tokio_postgres::Row, c: &str) -> String {
    r.try_get::<_, Option<String>>(c).ok().flatten().unwrap_or_default()
}
fn opt_s(r: &tokio_postgres::Row, c: &str) -> Value {
    match r.try_get::<_, Option<String>>(c).ok().flatten() {
        Some(s) => json!(s),
        None => Value::Null,
    }
}
fn brief_from(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": i64_col(r, "id"),
        "username": opt_s(r, "username"),
        "email": opt_s(r, "email"),
        "referralCode": opt_s(r, "referral_code"),
    })
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

pub async fn run_summary(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let overall = c
        .query_one(
            "SELECT COUNT(*)::bigint AS commission_count,
                    COALESCE(SUM(base_amount_usdc),0)::float8 AS base_total,
                    COALESCE(SUM(commission_usdc),0)::float8 AS commission_total
               FROM referral_commission_ledger",
            &[],
        )
        .await?;
    let distinct = c
        .query_one(
            "SELECT COUNT(DISTINCT user_id)::bigint AS unique_referrers,
                    COUNT(*)::bigint AS total_links,
                    COUNT(DISTINCT referred_username)::bigint AS referred_distinct
               FROM referrals",
            &[],
        )
        .await?;
    let top = c
        .query(
            "SELECT u.id AS referrer_user_id, u.username, u.email,
                    COALESCE(inv.invited_count, 0) AS invited_count,
                    COALESCE(cm.commission_total, 0)::float8 AS commission_total
               FROM users u
               JOIN (SELECT user_id, COUNT(DISTINCT referred_username) AS invited_count
                       FROM referrals GROUP BY user_id) inv ON inv.user_id = u.id
               LEFT JOIN (SELECT referrer_user_id, SUM(commission_usdc) AS commission_total
                            FROM referral_commission_ledger GROUP BY referrer_user_id) cm
                      ON cm.referrer_user_id = u.id
              WHERE COALESCE(inv.invited_count, 0) > 0
              ORDER BY commission_total DESC NULLS LAST, invited_count DESC NULLS LAST
              LIMIT $1",
            &[&TOP_REFERRERS_LIMIT],
        )
        .await?;

    Ok(json!({
        "ok": true,
        "commissionPercent": COMMISSION_PERCENT,
        "commissionRate": COMMISSION_PERCENT / 100.0,
        "stats": {
            "uniqueReferrers": i64_col(&distinct, "unique_referrers"),
            "totalLinks": i64_col(&distinct, "total_links"),
            "referredDistinct": i64_col(&distinct, "referred_distinct"),
            "commissionsCount": i64_col(&overall, "commission_count"),
            "totalReferredDepositsUsdc": f64_col(&overall, "base_total"),
            "totalCommissionPaidUsdc": f64_col(&overall, "commission_total"),
            "pendingCommissionUsdc": 0,
        },
        "topReferrers": top.iter().map(|r| json!({
            "id": i64_col(r, "referrer_user_id"),
            "username": opt_s(r, "username"),
            "email": opt_s(r, "email"),
            "invitedCount": i64_col(r, "invited_count"),
            "commissionTotalUsdc": f64_col(r, "commission_total"),
        })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// commissions ledger + CSV
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommissionsRequest {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub start_ms: Option<i64>,
    #[serde(default)]
    pub end_ms: Option<i64>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub referred: Option<String>,
    #[serde(default)]
    pub min_commission: Option<f64>,
    #[serde(default)]
    pub max_commission: Option<f64>,
    #[serde(default)]
    pub q: Option<String>,
}

struct Where {
    sql: String,
    binds: Vec<Bind>,
}
enum Bind {
    I64(i64),
    F64(f64),
    S(String),
}
impl Bind {
    fn as_sql(&self) -> &(dyn tokio_postgres::types::ToSql + Sync) {
        match self {
            Bind::I64(v) => v,
            Bind::F64(v) => v,
            Bind::S(v) => v,
        }
    }
}

fn like_of(q: &str) -> String {
    format!("%{}%", q.to_lowercase())
}

fn rebuild_commissions_where(f: &CommissionsRequest, for_csv: bool) -> Where {
    let mut sql = String::new();
    let mut binds: Vec<Bind> = Vec::new();
    let mut add = |cond: String, sql: &mut String| {
        if sql.is_empty() {
            sql.push_str(" WHERE ");
        } else {
            sql.push_str(" AND ");
        }
        sql.push_str(&cond);
    };
    macro_rules! ph {
        () => {{
            binds.len() + 1
        }};
    }
    if let Some(v) = f.start_ms {
        let p = ph!();
        binds.push(Bind::I64(v));
        add(format!("l.created_at >= ${p}"), &mut sql);
    }
    if let Some(v) = f.end_ms {
        let p = ph!();
        binds.push(Bind::I64(v));
        add(format!("l.created_at <= ${p}"), &mut sql);
    }
    if let Some(r) = f.referrer.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = ph!();
        binds.push(Bind::S(r.to_lowercase()));
        add(
            format!("(LOWER(ur.username) = ${p} OR LOWER(ur.email) = ${p} OR ur.id::text = ${p})"),
            &mut sql,
        );
    }
    if let Some(r) = f.referred.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = ph!();
        binds.push(Bind::S(r.to_lowercase()));
        add(
            format!("(LOWER(ud.username) = ${p} OR LOWER(ud.email) = ${p} OR ud.id::text = ${p})"),
            &mut sql,
        );
    }
    if !for_csv {
        if let Some(v) = f.min_commission.filter(|v| v.is_finite()) {
            let p = ph!();
            binds.push(Bind::F64(v));
            add(format!("l.commission_usdc >= ${p}"), &mut sql);
        }
        if let Some(v) = f.max_commission.filter(|v| v.is_finite()) {
            let p = ph!();
            binds.push(Bind::F64(v));
            add(format!("l.commission_usdc <= ${p}"), &mut sql);
        }
    }
    if let Some(q) = f.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = ph!();
        binds.push(Bind::S(like_of(q)));
        let cond = if for_csv {
            format!("(LOWER(COALESCE(ur.username,'')) LIKE ${p} OR LOWER(COALESCE(ud.username,'')) LIKE ${p} OR LOWER(COALESCE(l.idempotency_key,'')) LIKE ${p})")
        } else {
            format!("(LOWER(COALESCE(ur.username,'')) LIKE ${p} OR LOWER(COALESCE(ur.email,'')) LIKE ${p} OR LOWER(COALESCE(ud.username,'')) LIKE ${p} OR LOWER(COALESCE(ud.email,'')) LIKE ${p} OR LOWER(COALESCE(l.idempotency_key,'')) LIKE ${p})")
        };
        add(cond, &mut sql);
    }
    Where { sql, binds }
}

fn bind_refs(binds: &[Bind]) -> Vec<&(dyn tokio_postgres::types::ToSql + Sync)> {
    binds.iter().map(Bind::as_sql).collect()
}

pub async fn run_commissions(pool: &Pool, req: CommissionsRequest) -> Result<Value, PlayerReadError> {
    let page = req.page.unwrap_or(1).clamp(1, PAGE_MAX);
    let limit = req.limit.unwrap_or(50).clamp(1, LIMIT_MAX);
    let offset = (page - 1) * limit;
    let w = rebuild_commissions_where(&req, false);
    let c = pool.get().await?;
    let params = bind_refs(&w.binds);

    let total = c
        .query_one(
            &format!(
                "SELECT COUNT(*)::bigint AS total FROM referral_commission_ledger l
                   LEFT JOIN users ur ON ur.id = l.referrer_user_id
                   LEFT JOIN users ud ON ud.id = l.referred_user_id{}",
                w.sql
            ),
            &params,
        )
        .await
        .map(|r| i64_col(&r, "total"))?;

    let rows = c
        .query(
            &format!(
                "SELECT l.id::text AS id, l.created_at, l.idempotency_key, l.source_type,
                        l.base_amount_usdc, l.commission_percent, l.commission_usdc,
                        l.referrer_user_id, ur.username AS referrer_username, ur.email AS referrer_email,
                        l.referred_user_id, ud.username AS referred_username, ud.email AS referred_email
                   FROM referral_commission_ledger l
                   LEFT JOIN users ur ON ur.id = l.referrer_user_id
                   LEFT JOIN users ud ON ud.id = l.referred_user_id{}
                  ORDER BY l.created_at DESC
                  LIMIT {limit} OFFSET {offset}",
                w.sql
            ),
            &params,
        )
        .await?;

    Ok(json!({
        "ok": true, "page": page, "limit": limit, "total": total,
        "rows": rows.iter().map(|r| {
            let pct = f64_col(r, "commission_percent");
            let src = { let s = s_col(r, "source_type"); if s.is_empty() { "deposit".to_string() } else { s } };
            json!({
                "id": s_col(r, "id"),
                "createdAt": i64_col(r, "created_at"),
                "sourceType": src,
                "sourceTransactionId": s_col(r, "idempotency_key"),
                "depositAmountUsdc": f64_col(r, "base_amount_usdc"),
                "commissionPercent": pct,
                "commissionRate": pct / 100.0,
                "commissionAmountUsdc": f64_col(r, "commission_usdc"),
                "referrer": { "id": i64_col(r, "referrer_user_id"), "username": opt_s(r, "referrer_username"), "email": opt_s(r, "referrer_email") },
                "referred": { "id": i64_col(r, "referred_user_id"), "username": opt_s(r, "referred_username"), "email": opt_s(r, "referred_email") },
                "status": "paid",
            })
        }).collect::<Vec<_>>(),
    }))
}

fn csv_cell(s: &str) -> String {
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
fn iso_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

pub async fn run_export_csv(pool: &Pool, req: CommissionsRequest) -> Result<Value, PlayerReadError> {
    let w = rebuild_commissions_where(&req, true);
    let c = pool.get().await?;
    let params = bind_refs(&w.binds);
    let rows = c
        .query(
            &format!(
                "SELECT l.id::text AS id, l.created_at, l.idempotency_key, l.source_type,
                        l.base_amount_usdc, l.commission_percent, l.commission_usdc,
                        ur.username AS referrer_username, ur.email AS referrer_email,
                        ud.username AS referred_username, ud.email AS referred_email
                   FROM referral_commission_ledger l
                   LEFT JOIN users ur ON ur.id = l.referrer_user_id
                   LEFT JOIN users ud ON ud.id = l.referred_user_id{}
                  ORDER BY l.created_at DESC
                  LIMIT {EXPORT_ROWS_LIMIT}",
                w.sql
            ),
            &params,
        )
        .await?;
    let mut out = String::from(
        "id,created_at_iso,created_at_ms,source_type,source_transaction_id,referrer_username,referrer_email,referred_username,referred_email,deposit_usdc,commission_percent,commission_usdc,status\n",
    );
    for r in &rows {
        let ms = i64_col(r, "created_at");
        let st = { let s = s_col(r, "source_type"); if s.is_empty() { "deposit".to_string() } else { s } };
        let cells = [
            s_col(r, "id"),
            iso_ms(ms),
            ms.to_string(),
            st,
            s_col(r, "idempotency_key"),
            s_col(r, "referrer_username"),
            s_col(r, "referrer_email"),
            s_col(r, "referred_username"),
            s_col(r, "referred_email"),
            format!("{:.8}", f64_col(r, "base_amount_usdc")),
            format!("{:.4}", f64_col(r, "commission_percent")),
            format!("{:.8}", f64_col(r, "commission_usdc")),
            "paid".to_string(),
        ];
        out.push_str(&cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    Ok(json!({ "csv": out }))
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksRequest {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub q: Option<String>,
}

pub async fn run_links(pool: &Pool, req: LinksRequest) -> Result<Value, PlayerReadError> {
    let page = req.page.unwrap_or(1).clamp(1, PAGE_MAX);
    let limit = req.limit.unwrap_or(50).clamp(1, LIMIT_MAX);
    let offset = (page - 1) * limit;
    let like = req.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(like_of);
    let where_sql = if like.is_some() {
        " WHERE (LOWER(COALESCE(ur.username,'')) LIKE $1 OR LOWER(COALESCE(ur.email,'')) LIKE $1 OR LOWER(COALESCE(ud.username,'')) LIKE $1 OR LOWER(COALESCE(ud.email,'')) LIKE $1)"
    } else {
        ""
    };
    let c = pool.get().await?;
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
        if let Some(ref l) = like { vec![l] } else { vec![] };

    let total = c
        .query_one(
            &format!(
                "SELECT COUNT(*)::bigint AS total FROM referrals r
                   JOIN users ur ON ur.id = r.user_id
                   LEFT JOIN users ud ON ud.username = r.referred_username{where_sql}"
            ),
            &params,
        )
        .await
        .map(|r| i64_col(&r, "total"))?;

    let rows = c
        .query(
            &format!(
                "SELECT r.id AS link_id, r.user_id AS referrer_user_id,
                        ur.username AS referrer_username, ur.email AS referrer_email,
                        r.referred_username AS referred_username_raw, ud.id AS referred_user_id,
                        ud.email AS referred_email,
                        MIN(l.created_at) AS first_commission_at,
                        COALESCE(SUM(l.base_amount_usdc),0)::float8 AS total_deposit_usdc,
                        COALESCE(SUM(l.commission_usdc),0)::float8 AS total_commission_usdc
                   FROM referrals r
                   JOIN users ur ON ur.id = r.user_id
                   LEFT JOIN users ud ON ud.username = r.referred_username
                   LEFT JOIN referral_commission_ledger l
                     ON l.referrer_user_id = r.user_id AND l.referred_user_id = ud.id{where_sql}
                  GROUP BY r.id, r.user_id, ur.username, ur.email, r.referred_username, ud.id, ud.email
                  ORDER BY r.id DESC
                  LIMIT {limit} OFFSET {offset}"
            ),
            &params,
        )
        .await?;

    Ok(json!({
        "ok": true, "page": page, "limit": limit, "total": total,
        "rows": rows.iter().map(|r| {
            let ruid: Option<i32> = r.try_get("referred_user_id").ok().flatten();
            json!({
                "linkId": i64_col(r, "link_id"),
                "referrer": { "id": i64_col(r, "referrer_user_id"), "username": opt_s(r, "referrer_username"), "email": opt_s(r, "referrer_email") },
                "referred": { "id": ruid.map(i64::from), "username": opt_s(r, "referred_username_raw"), "email": opt_s(r, "referred_email") },
                "firstCommissionAt": i64_col(r, "first_commission_at"),
                "totalDepositedUsdc": f64_col(r, "total_deposit_usdc"),
                "totalCommissionUsdc": f64_col(r, "total_commission_usdc"),
            })
        }).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// lookup + network helpers
// ---------------------------------------------------------------------------

async fn find_user_by_token<C: GenericClient>(
    c: &C,
    token: &str,
) -> Result<Option<tokio_postgres::Row>, PlayerReadError> {
    let t = token.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let by_id: Option<i32> = t.parse().ok();
    Ok(c.query_opt(
        "SELECT id, username, email, referral_code, referred_by
           FROM users
          WHERE ($1::int IS NOT NULL AND id = $1)
             OR LOWER(username) = LOWER($2)
             OR LOWER(email) = LOWER($2)
          ORDER BY id ASC LIMIT 1",
        &[&by_id, &t],
    )
    .await?)
}

async fn resolve_referrer<C: GenericClient>(
    c: &C,
    referred_by: Option<&str>,
) -> Result<Option<tokio_postgres::Row>, PlayerReadError> {
    let Some(key) = referred_by.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    Ok(c.query_opt(
        "SELECT id, username, email, referral_code, referred_by
           FROM users WHERE username = $1 OR referral_code = $1 ORDER BY id ASC LIMIT 1",
        &[&key],
    )
    .await?)
}

async fn referrer_chain<C: GenericClient>(
    c: &C,
    start: &tokio_postgres::Row,
) -> Result<Vec<Value>, PlayerReadError> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(i64_col(start, "id"));
    let mut cur_referred_by: Option<String> = start.try_get("referred_by").ok().flatten();
    for _ in 0..CHAIN_MAX_DEPTH {
        let Some(next) = resolve_referrer(c, cur_referred_by.as_deref()).await? else {
            break;
        };
        let id = i64_col(&next, "id");
        if !seen.insert(id) {
            break;
        }
        chain.push(brief_from(&next));
        cur_referred_by = next.try_get("referred_by").ok().flatten();
    }
    Ok(chain)
}

const NETWORK_ROWS_SQL: &str = "
    WITH from_links AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM referrals r JOIN users u ON LOWER(TRIM(u.username)) = LOWER(TRIM(r.referred_username))
      WHERE r.user_id = $1
    ), from_email AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM referrals r JOIN users u ON u.email IS NOT NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(r.referred_username))
      WHERE r.user_id = $1
    ), from_referred_by AS (
      SELECT DISTINCT u.id, u.username, u.email, u.referral_code, u.referred_by
      FROM users u JOIN users ref ON ref.id = $1
      WHERE u.referred_by = ref.referral_code OR u.referred_by = ref.username
    ), merged AS (
      SELECT * FROM from_links UNION SELECT * FROM from_email UNION SELECT * FROM from_referred_by
    )
    SELECT id, username, email, referral_code, referred_by FROM merged ORDER BY id ASC";

async fn network_rows<C: GenericClient>(
    c: &C,
    referrer_id: i32,
) -> Result<Vec<tokio_postgres::Row>, PlayerReadError> {
    Ok(c.query(NETWORK_ROWS_SQL, &[&referrer_id]).await?)
}

async fn network_counts<C: GenericClient>(
    c: &C,
    referrer_id: i32,
) -> Result<(i64, i64), PlayerReadError> {
    let r = c
        .query_one(
            "SELECT
               (SELECT COUNT(*)::int FROM referrals WHERE user_id = $1) AS link_count,
               (SELECT COUNT(*)::int FROM referrals r
                 WHERE r.user_id = $1 AND NOT EXISTS (
                   SELECT 1 FROM users u
                    WHERE LOWER(TRIM(u.username)) = LOWER(TRIM(r.referred_username))
                       OR (u.email IS NOT NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(r.referred_username)))
                 )) AS orphan_links",
            &[&referrer_id],
        )
        .await?;
    Ok((i64_col(&r, "link_count"), i64_col(&r, "orphan_links")))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupRequest {
    #[serde(default)]
    pub q: Option<String>,
}

fn parse_lookup_queries(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.split([',', ';', '\n', '\r'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string()))
        .take(LOOKUP_QUERIES_MAX)
        .map(str::to_string)
        .collect()
}

pub async fn run_lookup(pool: &Pool, req: LookupRequest) -> Result<(u16, Value), PlayerReadError> {
    let queries = parse_lookup_queries(req.q.as_deref().unwrap_or(""));
    if queries.is_empty() {
        return Ok((
            400,
            json!({ "ok": false, "error": "Informe ao menos um username, email ou id em ?q=" }),
        ));
    }
    let c = pool.get().await?;
    let mut results = Vec::new();
    let mut not_found = Vec::new();
    for q in &queries {
        let Some(user) = find_user_by_token(&c, q).await? else {
            not_found.push(q.clone());
            continue;
        };
        let uid = i64_col(&user, "id") as i32;
        let referred_by: Option<String> = user.try_get("referred_by").ok().flatten();
        let referrer = resolve_referrer(&c, referred_by.as_deref()).await?;
        let chain = referrer_chain(&c, &user).await?;
        let rows = network_rows(&c, uid).await?;
        let (link_count, orphan) = network_counts(&c, uid).await?;
        results.push(json!({
            "query": q,
            "user": brief_from(&user),
            "referredByRaw": referred_by,
            "referrer": referrer.as_ref().map(brief_from),
            "referrerChain": chain,
            "referredLinkCount": link_count,
            "referredCount": rows.len(),
            "orphanLinkCount": orphan,
            "referredUsers": rows.iter().take(NETWORK_ROWS_PREVIEW_MAX).map(|r| json!({
                "id": i64_col(r, "id"),
                "username": opt_s(r, "username"),
                "email": opt_s(r, "email"),
                "referralCode": opt_s(r, "referral_code"),
            })).collect::<Vec<_>>(),
        }));
    }
    Ok((200, json!({ "ok": true, "results": results, "notFound": not_found })))
}

// ---------------------------------------------------------------------------
// network block
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkTargetRequest {
    #[serde(default)]
    pub user_id: Option<Value>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    // network-delete only:
    #[serde(default)]
    pub super_admin: bool,
    #[serde(default)]
    pub actor_id: Option<i64>,
}

async fn resolve_target<C: GenericClient>(
    c: &C,
    req: &NetworkTargetRequest,
) -> Result<Option<tokio_postgres::Row>, PlayerReadError> {
    for tok in [
        req.user_id.as_ref().and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }),
        req.email.clone(),
        req.username.clone(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(u) = find_user_by_token(c, &tok).await? {
            return Ok(Some(u));
        }
    }
    Ok(None)
}

pub async fn run_network_block(
    pool: &Pool,
    req: NetworkTargetRequest,
) -> Result<(u16, Value), PlayerReadError> {
    let c = pool.get().await?;
    let Some(target) = resolve_target(&c, &req).await? else {
        return Ok((404, json!({ "ok": false, "error": "Utilizador não encontrado." })));
    };
    let tid = i64_col(&target, "id") as i32;
    let referred = network_rows(&c, tid).await?;
    let (link_count, orphan) = network_counts(&c, tid).await?;
    let mut ids: Vec<i32> = vec![tid];
    ids.extend(referred.iter().map(|r| i64_col(r, "id") as i32));
    c.execute(
        "UPDATE users SET is_blocked = 1 WHERE id = ANY($1::int[])",
        &[&ids],
    )
    .await?;
    Ok((
        200,
        json!({
            "ok": true,
            "blockedCount": ids.len(),
            "referredLinkCount": link_count,
            "resolvableCount": referred.len(),
            "orphanLinkCount": orphan,
            "referrer": brief_from(&target),
            "referred": referred.iter().map(brief_from).collect::<Vec<_>>(),
        }),
    ))
}

// ---------------------------------------------------------------------------
// network delete (destructive cascade)
// ---------------------------------------------------------------------------

async fn delete_user_by_email(
    tx: &deadpool_postgres::Transaction<'_>,
    email: &str,
) -> Result<bool, PlayerReadError> {
    let lower = email.trim().to_lowercase();
    if lower.is_empty() {
        return Ok(false);
    }
    let mut rows = tx
        .query(
            "SELECT id, username, polygon_wallet, email FROM users WHERE lower(trim(email::text)) = $1",
            &[&lower],
        )
        .await?;
    if rows.len() > 1 {
        let exact = tx
            .query(
                "SELECT id, username, polygon_wallet, email FROM users
                  WHERE lower(trim(email::text)) = $1 AND email = $2",
                &[&lower, &email.trim()],
            )
            .await?;
        if exact.len() == 1 {
            rows = exact;
        } else {
            return Err(PlayerReadError::bad(
                "Várias contas com o mesmo e-mail (só difere maiúsculas). Remove por ID.",
            ));
        }
    }
    let Some(u) = rows.into_iter().next() else {
        return Ok(false);
    };
    let uid: i32 = u.get("id");
    let username: Option<String> = u.try_get("username").ok().flatten();
    let wallet: Option<String> = u.try_get("polygon_wallet").ok().flatten();

    // hardware-owned rows (mirrors genesis-hardware wipe_user.rs)
    for sql in [
        "DELETE FROM rack_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)",
        "DELETE FROM rack_multiplier_slots WHERE rack_id IN (SELECT id FROM placed_racks WHERE user_id = $1)",
        "DELETE FROM placed_racks WHERE user_id = $1",
        "DELETE FROM stored_batteries WHERE user_id = $1",
        "DELETE FROM stock WHERE user_id = $1",
        "DELETE FROM player_listing_instances WHERE instance_id IN (SELECT id FROM item_instances WHERE user_id = $1)",
        "DELETE FROM item_instances WHERE user_id = $1",
        "DELETE FROM player_asic_leases WHERE user_id = $1",
        "DELETE FROM game_servers_intent_idempotency WHERE user_id = $1",
    ] {
        exec_ignore_missing(tx, sql, uid).await?;
    }

    exec_ignore_missing(tx, "DELETE FROM support_ticket_replies WHERE admin_user_id = $1", uid).await?;
    exec_ignore_missing(tx, "DELETE FROM support_tickets WHERE user_id = $1", uid).await?;
    exec_ignore_missing(
        tx,
        "DELETE FROM p2p_market_trade_history WHERE buyer_id = $1 OR seller_id = $1",
        uid,
    )
    .await?;
    exec_ignore_missing(tx, "DELETE FROM sessions WHERE user_id = $1", uid).await?;

    for sql in [
        "UPDATE partner_youtube_submissions SET reviewed_by = NULL WHERE reviewed_by = $1",
        "UPDATE partner_youtube_creator_profiles SET updated_by = NULL WHERE updated_by = $1",
        "UPDATE partner_youtube_manual_allowlist SET added_by = NULL WHERE added_by = $1",
        "DELETE FROM partner_youtube_manual_allowlist WHERE user_id = $1",
    ] {
        exec_ignore_missing(tx, sql, uid).await?;
    }

    for sql in [
        "DELETE FROM referrals WHERE user_id = $1",
        "DELETE FROM player_news_submissions WHERE user_id = $1",
        "DELETE FROM admin_upgrade_purchases WHERE user_id = $1",
        "DELETE FROM season_purchases WHERE user_id = $1",
        "DELETE FROM user_rig_rooms WHERE user_id = $1",
        "DELETE FROM unopened_boxes WHERE user_id = $1",
        "DELETE FROM coin_balances WHERE user_id = $1",
        "DELETE FROM coin_withdrawals WHERE user_id = $1",
        "DELETE FROM withdrawal_requests WHERE user_id = $1",
        "DELETE FROM user_history_ips WHERE user_id = $1",
        "DELETE FROM player_listings WHERE user_id = $1",
        "DELETE FROM daily_actions WHERE user_id = $1",
        "DELETE FROM promo_code_redemptions WHERE user_id = $1",
        "DELETE FROM player_claimed_boxes WHERE user_id = $1",
        "DELETE FROM game_states WHERE user_id = $1",
    ] {
        exec_ignore_missing(tx, sql, uid).await?;
    }
    if let Some(un) = username.as_deref().filter(|s| !s.is_empty()) {
        exec_ignore_missing_s(tx, "DELETE FROM wheel_players WHERE username = $1", un).await?;
    }
    if let Some(w) = wallet.as_deref().filter(|s| !s.is_empty()) {
        exec_ignore_missing_s(tx, "DELETE FROM nft_items WHERE owner_address = $1", w).await?;
    }
    tx.execute("DELETE FROM users WHERE id = $1", &[&uid]).await?;
    Ok(true)
}

async fn exec_ignore_missing(
    tx: &deadpool_postgres::Transaction<'_>,
    sql: &str,
    uid: i32,
) -> Result<(), PlayerReadError> {
    match tx.execute(sql, &[&uid]).await {
        Ok(_) => Ok(()),
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
async fn exec_ignore_missing_s(
    tx: &deadpool_postgres::Transaction<'_>,
    sql: &str,
    v: &str,
) -> Result<(), PlayerReadError> {
    match tx.execute(sql, &[&v]).await {
        Ok(_) => Ok(()),
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNDEFINED_TABLE) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub async fn run_network_delete(
    pool: &Pool,
    req: NetworkTargetRequest,
) -> Result<(u16, Value), PlayerReadError> {
    let mut conn = pool.get().await?;
    let Some(target) = resolve_target(&conn, &req).await? else {
        return Ok((
            404,
            json!({ "ok": false, "error": "Utilizador não encontrado ou sem e-mail." }),
        ));
    };
    let target_email: Option<String> = target.try_get("email").ok().flatten();
    let Some(target_email) = target_email.filter(|s| !s.trim().is_empty()) else {
        return Ok((
            404,
            json!({ "ok": false, "error": "Utilizador não encontrado ou sem e-mail." }),
        ));
    };
    let tid = i64_col(&target, "id") as i32;
    let referred = network_rows(&conn, tid).await?;
    let (link_count, orphan) = network_counts(&conn, tid).await?;

    let mut all_ids: Vec<i32> = vec![tid];
    all_ids.extend(referred.iter().map(|r| i64_col(r, "id") as i32));

    if !req.super_admin {
        let actor = req.actor_id.map(|v| v as i32).unwrap_or(-1);
        let admins = conn
            .query(
                "SELECT id FROM users WHERE id = ANY($1::int[]) AND COALESCE(is_admin, 0) <> 0",
                &[&all_ids],
            )
            .await?;
        if admins.iter().any(|r| r.get::<_, i32>("id") != actor) {
            return Ok((
                403,
                json!({ "ok": false, "error": "Apenas super administradores podem excluir outras contas administrador." }),
            ));
        }
    }

    let referred_emails: Vec<Option<String>> = referred
        .iter()
        .map(|r| r.try_get::<_, Option<String>>("email").ok().flatten())
        .collect();

    let tx = conn.transaction().await?;
    let mut deleted = 0i64;
    let mut failed: Vec<String> = Vec::new();
    for (r, em) in referred.iter().zip(referred_emails.iter()) {
        match em.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(e) => match delete_user_by_email(&tx, e).await {
                Ok(true) => deleted += 1,
                Ok(false) => failed.push(e.to_string()),
                Err(err) => {
                    tx.rollback().await.ok();
                    return Err(err);
                }
            },
            None => failed.push(
                r.try_get::<_, Option<String>>("username")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| format!("#{}", i64_col(r, "id"))),
            ),
        }
    }
    match delete_user_by_email(&tx, target_email.trim()).await {
        Ok(true) => deleted += 1,
        Ok(false) | Err(_) => {
            tx.rollback().await.ok();
            return Ok((
                400,
                json!({ "ok": false, "error": "Falha ao excluir o indicador." }),
            ));
        }
    }
    tx.commit().await?;

    Ok((
        200,
        json!({
            "ok": true,
            "deletedCount": deleted,
            "referredDeleted": referred.len(),
            "referredLinkCount": link_count,
            "resolvableCount": referred.len(),
            "orphanLinkCount": orphan,
            "failed": failed,
            "referrer": brief_from(&target),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_query_split() {
        assert_eq!(
            parse_lookup_queries("a, b\nc;;a"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert!(parse_lookup_queries("  ").is_empty());
    }

    #[test]
    fn commissions_where_placeholders() {
        let w = rebuild_commissions_where(
            &CommissionsRequest {
                start_ms: Some(1),
                referrer: Some("x".into()),
                q: Some("y".into()),
                ..Default::default()
            },
            false,
        );
        assert!(w.sql.starts_with(" WHERE l.created_at >= $1"));
        assert!(w.sql.contains("$2"));
        assert!(w.sql.contains("$3"));
        assert_eq!(w.binds.len(), 3);
    }
}
