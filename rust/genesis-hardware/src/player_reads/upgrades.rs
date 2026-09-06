//! Admin-pack reads — Node `GET /api/upgrades/state` + `/api/upgrades/purchases`.

use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::pg_types::pg_user_id;

use super::{
    f64_cell, i32_cell, i64_cell, opt_f64_cell, opt_i32_cell, opt_i64_cell, opt_string_cell,
    string_cell, PlayerReadError,
};

/// Node `RECENT_PURCHASES_LIMIT` / `PURCHASES_LIMIT_DEFAULT`.
const PURCHASES_LIMIT_DEFAULT: i64 = 30;
/// Node `PURCHASES_LIMIT_MAX`.
const PURCHASES_LIMIT_MAX: i64 = 50;
/// Node `USDC_DECIMALS`.
const USDC_DECIMALS: i32 = 6;
/// Node `DISCOUNT_PERCENT_PRECISION`.
const DISCOUNT_PERCENT_PRECISION: i32 = 4;
const PERCENT_BASE: f64 = 100.0;
const DEFAULT_CATEGORY: &str = "PROMO_PACK";
const DEFAULT_MAX_PER_USER: i32 = 1;
const DEFAULT_VERSION: i32 = 1;
const TITLE: &str = "Pacotes e upgrades";
const NOTICE: &str = "Preços, descontos, stock e conteúdo são definidos no servidor. Envie apenas o id do pacote e idempotência na compra.";
const CURRENCY_USDC: &str = "USDC";
const QTY_MIN: i32 = 1;

const _: () = assert!(PURCHASES_LIMIT_DEFAULT == 30);
const _: () = assert!(PURCHASES_LIMIT_MAX == 50);
const _: () = assert!(USDC_DECIMALS == 6);
const _: () = assert!(DISCOUNT_PERCENT_PRECISION == 4);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradesUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn run_upgrades_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let now = current_unix_ms();
    let level_ids = resolve_access_level_ids(&conn, uid).await?;
    let is_admin = user_is_admin(&conn, uid).await?;
    let packs = load_admin_packs(&conn, is_admin).await?;
    let gs = conn
        .query_opt(
            "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let usdc_bal = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);
    let upgrade_names = load_name_map(&conn, "SELECT id, name FROM upgrades").await?;
    let box_names = load_name_map(&conn, "SELECT id, name FROM loot_boxes").await?;
    let recent = conn
        .query(
            "SELECT upgrade_id, purchased_at FROM admin_upgrade_purchases
              WHERE user_id = $1 ORDER BY purchased_at DESC LIMIT $2",
            &[&uid, &PURCHASES_LIMIT_DEFAULT],
        )
        .await?;
    let purch_ids: Vec<String> = recent
        .iter()
        .map(|r| string_cell(r, "upgrade_id"))
        .collect();
    let purch_meta = load_purchase_meta(&conn, &purch_ids).await?;
    let mut packages: Vec<Value> = packs
        .into_iter()
        .filter(|p| visible_to_user(p, &level_ids))
        .map(|p| map_pack(p, usdc_bal, now, &upgrade_names, &box_names))
        .collect();
    packages.sort_by(|a, b| {
        let pa = parse_price(a.get("finalPrice"));
        let pb = parse_price(b.get("finalPrice"));
        pa.partial_cmp(&pb)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let oa = a.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(0);
                let ob = b.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(0);
                oa.cmp(&ob)
            })
            .then_with(|| {
                let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                na.to_lowercase().cmp(&nb.to_lowercase())
            })
    });
    let mut categories: Vec<String> = packages
        .iter()
        .filter_map(|p| {
            p.get("category")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    categories.sort();
    categories.dedup();
    let purchase_history: Vec<Value> = recent
        .iter()
        .map(|r| {
            let id = string_cell(r, "upgrade_id");
            let meta = purch_meta.get(&id);
            json!({
                "upgradeId": id,
                "name": meta.map(|m| m.name.clone()).unwrap_or_else(|| id.clone()),
                "paidUsdc": meta.map(|m| m.price.clone()).unwrap_or_default(),
                "purchasedAt": i64_cell(r, "purchased_at"),
            })
        })
        .collect();
    Ok(json!({
        "title": TITLE,
        "usdcBalance": usdc_bal,
        "categories": categories,
        "packages": packages,
        "purchaseHistory": purchase_history,
        "notice": NOTICE,
    }))
}

pub async fn run_upgrades_purchases(
    pool: &Pool,
    user_id: i64,
    limit: Option<i64>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let lim = clamp_purchases_limit(limit);
    let rows = conn
        .query(
            "SELECT upgrade_id, purchased_at FROM admin_upgrade_purchases
              WHERE user_id = $1 ORDER BY purchased_at DESC LIMIT $2",
            &[&uid, &lim],
        )
        .await?;
    let ids: Vec<String> = rows.iter().map(|r| string_cell(r, "upgrade_id")).collect();
    let meta = load_purchase_meta_full(&conn, &ids).await?;
    let purchases: Vec<Value> = rows
        .iter()
        .map(|r| {
            let id = string_cell(r, "upgrade_id");
            let m = meta.get(&id);
            json!({
                "upgradeId": id,
                "purchasedAt": i64_cell(r, "purchased_at"),
                "name": m.map(|x| x.name.clone()).unwrap_or_else(|| id.clone()),
                "chargedUsdc": m.as_ref().map(|x| json!(x.price.clone())).unwrap_or(Value::Null),
                "category": m.as_ref().and_then(|x| x.category.clone()),
                "packageVersion": m.as_ref().and_then(|x| x.version),
            })
        })
        .collect();
    Ok(json!({ "purchases": purchases }))
}

struct PackRow {
    id: String,
    name: String,
    description: Option<String>,
    price_usdc: f64,
    grant_usdc: f64,
    grant_access_level_id: Option<String>,
    is_active: bool,
    items: Vec<(String, i32)>,
    boxes: Vec<(String, i32)>,
    passes: Vec<String>,
    coins: Vec<(String, f64)>,
    visible: Vec<String>,
    version: i32,
    slug: Option<String>,
    category: String,
    original_price_usdc: Option<f64>,
    stock_remaining: Option<i32>,
    max_per_user: i32,
    starts_at: Option<i64>,
    ends_at: Option<i64>,
    sort_order: i32,
    image_url: Option<String>,
}

struct PurchMeta {
    name: String,
    price: String,
    category: Option<String>,
    version: Option<i32>,
}

async fn user_is_admin<C: GenericClient>(client: &C, uid: i32) -> Result<bool, PlayerReadError> {
    let row = client
        .query_opt("SELECT is_admin FROM users WHERE id = $1", &[&uid])
        .await?;
    Ok(row.map(|r| i32_cell(&r, "is_admin") != 0).unwrap_or(false))
}

async fn resolve_access_level_ids<C: GenericClient>(
    client: &C,
    uid: i32,
) -> Result<std::collections::HashSet<String>, PlayerReadError> {
    let mut ids = std::collections::HashSet::new();
    let user = client
        .query_opt("SELECT access_level_id FROM users WHERE id = $1", &[&uid])
        .await?;
    if let Some(u) = user {
        if let Some(id) = opt_string_cell(&u, "access_level_id") {
            ids.insert(id);
        }
    }
    let grants = client
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    for g in &grants {
        let id = string_cell(g, "access_level_id");
        if !id.is_empty() {
            ids.insert(id);
        }
    }
    Ok(ids)
}

async fn load_admin_packs<C: GenericClient>(
    client: &C,
    is_admin: bool,
) -> Result<Vec<PackRow>, PlayerReadError> {
    let sql = if is_admin {
        "SELECT id, name, description, price_usdc::double precision AS price_usdc,
                grant_usdc::double precision AS grant_usdc, grant_access_level_id, is_active,
                version, slug, category, original_price_usdc::double precision AS original_price_usdc,
                stock_remaining, max_per_user, starts_at, ends_at, sort_order, image_url
           FROM admin_upgrades
          ORDER BY COALESCE(sort_order, 0) ASC, created_at DESC"
    } else {
        "SELECT id, name, description, price_usdc::double precision AS price_usdc,
                grant_usdc::double precision AS grant_usdc, grant_access_level_id, is_active,
                version, slug, category, original_price_usdc::double precision AS original_price_usdc,
                stock_remaining, max_per_user, starts_at, ends_at, sort_order, image_url
           FROM admin_upgrades
          WHERE is_active = 1
          ORDER BY COALESCE(sort_order, 0) ASC, created_at DESC"
    };
    let rows = client.query(sql, &[]).await?;
    let items = client
        .query(
            "SELECT upgrade_id, item_id, qty FROM admin_upgrade_items",
            &[],
        )
        .await?;
    let boxes = client
        .query(
            "SELECT upgrade_id, box_id, qty FROM admin_upgrade_boxes",
            &[],
        )
        .await?;
    let passes = client
        .query("SELECT upgrade_id, pass_id FROM admin_upgrade_passes", &[])
        .await?;
    let coins = client
        .query(
            "SELECT upgrade_id, coin_id, amount::double precision AS amount FROM admin_upgrade_coins",
            &[],
        )
        .await?;
    let vis = client
        .query(
            "SELECT upgrade_id, access_level_id FROM admin_upgrade_visibility",
            &[],
        )
        .await?;
    let mut items_map: std::collections::HashMap<String, Vec<(String, i32)>> =
        std::collections::HashMap::new();
    for r in &items {
        items_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push((string_cell(r, "item_id"), i32_cell(r, "qty")));
    }
    let mut boxes_map: std::collections::HashMap<String, Vec<(String, i32)>> =
        std::collections::HashMap::new();
    for r in &boxes {
        boxes_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push((string_cell(r, "box_id"), i32_cell(r, "qty")));
    }
    let mut passes_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &passes {
        passes_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push(string_cell(r, "pass_id"));
    }
    let mut coins_map: std::collections::HashMap<String, Vec<(String, f64)>> =
        std::collections::HashMap::new();
    for r in &coins {
        coins_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push((string_cell(r, "coin_id"), f64_cell(r, "amount")));
    }
    let mut vis_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &vis {
        vis_map
            .entry(string_cell(r, "upgrade_id"))
            .or_default()
            .push(string_cell(r, "access_level_id"));
    }
    Ok(rows
        .iter()
        .map(|r| {
            let id = string_cell(r, "id");
            PackRow {
                id: id.clone(),
                name: string_cell(r, "name"),
                description: opt_string_cell(r, "description"),
                price_usdc: f64_cell(r, "price_usdc"),
                grant_usdc: f64_cell(r, "grant_usdc"),
                grant_access_level_id: opt_string_cell(r, "grant_access_level_id"),
                is_active: i32_cell(r, "is_active") != 0,
                items: items_map.remove(&id).unwrap_or_default(),
                boxes: boxes_map.remove(&id).unwrap_or_default(),
                passes: passes_map.remove(&id).unwrap_or_default(),
                coins: coins_map.remove(&id).unwrap_or_default(),
                visible: vis_map.remove(&id).unwrap_or_default(),
                version: opt_i32_cell(r, "version").unwrap_or(DEFAULT_VERSION),
                slug: opt_string_cell(r, "slug"),
                category: opt_string_cell(r, "category")
                    .unwrap_or_else(|| DEFAULT_CATEGORY.to_string()),
                original_price_usdc: opt_f64_cell(r, "original_price_usdc"),
                stock_remaining: opt_i32_cell(r, "stock_remaining"),
                max_per_user: opt_i32_cell(r, "max_per_user").unwrap_or(DEFAULT_MAX_PER_USER),
                starts_at: opt_i64_cell(r, "starts_at"),
                ends_at: opt_i64_cell(r, "ends_at"),
                sort_order: opt_i32_cell(r, "sort_order").unwrap_or(0),
                image_url: opt_string_cell(r, "image_url"),
            }
        })
        .collect())
}

async fn load_name_map<C: GenericClient>(
    client: &C,
    sql: &str,
) -> Result<std::collections::HashMap<String, String>, PlayerReadError> {
    let rows = client.query(sql, &[]).await?;
    Ok(rows
        .iter()
        .map(|r| (string_cell(r, "id"), string_cell(r, "name")))
        .collect())
}

async fn load_purchase_meta<C: GenericClient>(
    client: &C,
    ids: &[String],
) -> Result<std::collections::HashMap<String, PurchMeta>, PlayerReadError> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = client
        .query(
            "SELECT id, name, price_usdc::double precision AS price_usdc
               FROM admin_upgrades WHERE id = ANY($1::text[])",
            &[&ids],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                string_cell(r, "id"),
                PurchMeta {
                    name: string_cell(r, "name"),
                    price: format_usdc(f64_cell(r, "price_usdc")),
                    category: None,
                    version: None,
                },
            )
        })
        .collect())
}

async fn load_purchase_meta_full<C: GenericClient>(
    client: &C,
    ids: &[String],
) -> Result<std::collections::HashMap<String, PurchMeta>, PlayerReadError> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let rows = client
        .query(
            "SELECT id, name, price_usdc::double precision AS price_usdc, category, version
               FROM admin_upgrades WHERE id = ANY($1::text[])",
            &[&ids],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            (
                string_cell(r, "id"),
                PurchMeta {
                    name: string_cell(r, "name"),
                    price: format_usdc(f64_cell(r, "price_usdc")),
                    category: opt_string_cell(r, "category"),
                    version: opt_i32_cell(r, "version"),
                },
            )
        })
        .collect())
}

fn visible_to_user(p: &PackRow, level_ids: &std::collections::HashSet<String>) -> bool {
    if p.visible.is_empty() {
        return true;
    }
    p.visible.iter().any(|id| level_ids.contains(id))
}

fn map_pack(
    p: PackRow,
    usdc_bal: f64,
    now: i64,
    names: &std::collections::HashMap<String, String>,
    box_names: &std::collections::HashMap<String, String>,
) -> Value {
    let final_price = p.price_usdc;
    let discount = p
        .original_price_usdc
        .and_then(|orig| compute_discount_percent(orig, final_price));
    let mut reason: Option<&str> = None;
    if !p.is_active {
        reason = Some("Pacote inativo.");
    } else if p.starts_at.is_some_and(|s| now < s) {
        reason = Some("Venda ainda não iniciou.");
    } else if p.ends_at.is_some_and(|e| now > e) {
        reason = Some("Oferta expirada.");
    } else if p.stock_remaining.is_some_and(|s| s <= 0) {
        reason = Some("Esgotado.");
    } else if usdc_bal < final_price {
        reason = Some("Insufficient USDC balance.");
    }
    let preview = item_preview(&p, names, box_names);
    json!({
        "id": p.id,
        "slug": p.slug,
        "name": p.name,
        "description": p.description,
        "imageUrl": p.image_url,
        "category": if p.category.is_empty() { DEFAULT_CATEGORY } else { p.category.as_str() },
        "currency": CURRENCY_USDC,
        "finalPrice": format_usdc(final_price),
        "originalPrice": p.original_price_usdc.map(format_usdc),
        "discountPercent": discount,
        "version": p.version,
        "isPurchasable": reason.is_none(),
        "unpurchasableReason": reason,
        "stockRemaining": p.stock_remaining,
        "maxPerUser": p.max_per_user,
        "startsAt": p.starts_at,
        "endsAt": p.ends_at,
        "sortOrder": p.sort_order,
        "alreadyOwned": false,
        "itemsPreview": preview,
    })
}

fn item_preview(
    p: &PackRow,
    names: &std::collections::HashMap<String, String>,
    box_names: &std::collections::HashMap<String, String>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (id, qty) in &p.items {
        let q = (*qty).max(QTY_MIN);
        out.push(json!({
            "rewardType": "STOCK_ITEM",
            "catalogId": id,
            "quantity": q,
            "label": names.get(id).cloned().unwrap_or_else(|| id.clone()),
        }));
    }
    for (id, qty) in &p.boxes {
        let q = (*qty).max(QTY_MIN);
        out.push(json!({
            "rewardType": "LOOT_BOX",
            "catalogId": id,
            "quantity": q,
            "label": box_names.get(id).cloned().unwrap_or_else(|| id.clone()),
        }));
    }
    for pid in &p.passes {
        out.push(json!({
            "rewardType": "SEASON_PASS",
            "catalogId": pid,
            "quantity": 1,
            "label": "Season pass",
        }));
    }
    for (id, amt) in &p.coins {
        if amt.is_finite() && *amt != 0.0 {
            out.push(json!({
                "rewardType": "MINED_COIN",
                "catalogId": id,
                "quantity": amt,
                "label": id,
            }));
        }
    }
    if p.grant_usdc.is_finite() && p.grant_usdc > 0.0 {
        out.push(json!({
            "rewardType": "USDC_GRANT",
            "catalogId": "usdc",
            "quantity": p.grant_usdc,
            "label": "USDC (bónus do pacote)",
        }));
    }
    if let Some(lvl) = &p.grant_access_level_id {
        out.push(json!({
            "rewardType": "ACCESS_LEVEL",
            "catalogId": lvl,
            "quantity": 1,
            "label": "Nível de acesso",
        }));
    }
    out
}

fn compute_discount_percent(original: f64, final_price: f64) -> Option<f64> {
    if !(original > 0.0) || final_price < 0.0 || original <= final_price {
        return None;
    }
    let raw = (original - final_price) / original * PERCENT_BASE;
    let factor = 10f64.powi(DISCOUNT_PERCENT_PRECISION);
    let n = (raw * factor).round() / factor;
    if n.is_finite() && n > 0.0 {
        Some(n)
    } else {
        None
    }
}

fn format_usdc(v: f64) -> String {
    if !v.is_finite() {
        return format!("{:.prec$}", 0.0, prec = USDC_DECIMALS as usize);
    }
    format!("{v:.prec$}", prec = USDC_DECIMALS as usize)
}

fn parse_price(v: Option<&Value>) -> f64 {
    v.and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0)
}

fn clamp_purchases_limit(raw: Option<i64>) -> i64 {
    match raw {
        Some(n) if n >= 1 => n.min(PURCHASES_LIMIT_MAX),
        _ => PURCHASES_LIMIT_DEFAULT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discount_only_when_original_higher() {
        assert_eq!(compute_discount_percent(10.0, 8.0), Some(20.0));
        assert_eq!(compute_discount_percent(10.0, 10.0), None);
        assert_eq!(compute_discount_percent(0.0, 1.0), None);
    }

    #[test]
    fn purchases_limit_clamps() {
        assert_eq!(clamp_purchases_limit(None), PURCHASES_LIMIT_DEFAULT);
        assert_eq!(
            clamp_purchases_limit(Some(PURCHASES_LIMIT_MAX + 1)),
            PURCHASES_LIMIT_MAX
        );
    }
}
