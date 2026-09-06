//! Lucky-box reads + discard — Node `lucky-boxes/services/{state,loot-box}.ts`.

use deadpool_postgres::{GenericClient, Pool};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::HARDWARE_TX_TIMEOUT_MS;
use crate::pg_types::pg_user_id;

use super::{f64_cell, i32_cell, opt_i32_cell, opt_string_cell, string_cell, PlayerReadError};

const OPENING_ID_MAX_LENGTH: usize = 80;
const HISTORY_PAGE_SIZE: i64 = 30;
const HISTORY_FETCH_SIZE: i64 = HISTORY_PAGE_SIZE + 1;
const PERCENT_MAX: f64 = 100.0;
const DROP_CHANCE_ROUND_PRECISION: f64 = 100.0;
const DEFAULT_MAX_PER_ORDER: i32 = 20;
const MAX_ORDER_CEILING: i32 = 500;
const STATE_VERSION: i32 = 1;

const _: () = assert!(HISTORY_PAGE_SIZE == 30);
const _: () = assert!(OPENING_ID_MAX_LENGTH == 80);
const _: () = assert!(DEFAULT_MAX_PER_ORDER == 20);
const _: () = assert!(MAX_ORDER_CEILING == 500);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuckyUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub opening_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LuckyDiscardRequest {
    pub user_id: i64,
    pub box_id: String,
    #[serde(default)]
    pub qty: Option<Value>,
}

struct CatalogNames {
    upgrades: std::collections::HashMap<String, (String, String)>,
    coins: std::collections::HashMap<String, String>,
    packages: std::collections::HashMap<String, String>,
    loot_boxes: std::collections::HashMap<String, (String, String)>,
}

pub async fn run_lucky_state(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    build_lucky_state(&conn, user_id).await
}

async fn build_lucky_state<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<Value, PlayerReadError> {
    let uid = pg_user_id(user_id)?;
    let gs = client
        .query_opt("SELECT usdc FROM game_states WHERE user_id = $1", &[&uid])
        .await?;
    let usdc = gs.as_ref().map(|r| f64_cell(r, "usdc")).unwrap_or(0.0);

    let boxes = client
        .query(
            "SELECT id, name, description, icon, price, trigger, is_active, max_per_order, stock
               FROM loot_boxes
              ORDER BY is_active DESC, trigger ASC, name ASC, id ASC",
            &[],
        )
        .await?;
    let box_ids: Vec<String> = boxes.iter().map(|r| string_cell(r, "id")).collect();
    let item_rows = if box_ids.is_empty() {
        Vec::new()
    } else {
        client
            .query(
                "SELECT box_id, item_type, item_id, min_qty, max_qty, probability
                   FROM loot_box_items WHERE box_id = ANY($1::text[])",
                &[&box_ids],
            )
            .await?
    };

    let mut item_map: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    let mut catalog_ids = std::collections::HashSet::new();
    let mut coin_ids = std::collections::HashSet::new();
    let mut package_ids = std::collections::HashSet::new();
    for it in &item_rows {
        let box_id = string_cell(it, "box_id");
        let t = string_cell(it, "item_type").to_ascii_lowercase();
        let id = string_cell(it, "item_id").trim().to_string();
        item_map.entry(box_id).or_default().push(json!({
            "item_type": t,
            "item_id": id,
            "min_qty": i32_cell(it, "min_qty"),
            "max_qty": i32_cell(it, "max_qty"),
            "probability": f64_cell(it, "probability"),
        }));
        if id.is_empty() {
            continue;
        }
        if t == "coin" {
            coin_ids.insert(id);
        } else if t == "bundle" {
            package_ids.insert(id);
        } else if t != "currency" {
            catalog_ids.insert(id);
        }
    }
    let names = load_catalog_names(client, &catalog_ids, &coin_ids, &package_ids).await?;

    let claimed = client
        .query(
            "SELECT box_id FROM player_claimed_boxes WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let claimed_set: std::collections::HashSet<String> =
        claimed.iter().map(|r| string_cell(r, "box_id")).collect();

    let unopened = client
        .query(
            "SELECT box_id, qty FROM unopened_boxes WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let mut unopened_map = std::collections::HashMap::new();
    for r in &unopened {
        unopened_map.insert(string_cell(r, "box_id"), i32_cell(r, "qty"));
    }

    let mut shop = Vec::new();
    for b in &boxes {
        if !is_loot_box_active(opt_i32_cell(b, "is_active")) {
            continue;
        }
        let trig = string_cell(b, "trigger").trim().to_string();
        if trig != "shop" && trig != "shop_once" && trig != "special" {
            continue;
        }
        let id = string_cell(b, "id");
        if trig == "shop_once" && claimed_set.contains(&id) {
            continue;
        }
        let rs = reward_summary(item_map.get(&id).cloned().unwrap_or_default(), &names);
        if rs.0 < 1 {
            continue;
        }
        let price = f64_cell(b, "price");
        if !price.is_finite() || price <= 0.0 {
            continue;
        }
        let max_per_order = i32_cell(b, "max_per_order");
        let max_per_order = if max_per_order <= 0 {
            DEFAULT_MAX_PER_ORDER
        } else {
            max_per_order.min(MAX_ORDER_CEILING).max(1)
        };
        let stock_remaining = opt_i32_cell(b, "stock").map(|s| s.max(0));
        shop.push(json!({
            "id": id,
            "name": string_cell(b, "name"),
            "description": string_cell(b, "description"),
            "icon": prefer_catalog_image(opt_string_cell(b, "icon").as_deref(), None),
            "priceUsdc": price,
            "currency": "USDC",
            "trigger": trig,
            "maxPerOrder": max_per_order,
            "stockRemaining": stock_remaining,
            "rewardSummary": { "slotCount": rs.0, "slots": rs.1 },
        }));
    }

    let box_by_id: std::collections::HashMap<String, &tokio_postgres::Row> =
        boxes.iter().map(|r| (string_cell(r, "id"), r)).collect();
    let mut inventory = Vec::new();
    for (box_id, qty) in &unopened_map {
        if *qty < 1 {
            continue;
        }
        let def = box_by_id.get(box_id);
        let trig = def
            .map(|d| string_cell(d, "trigger").trim().to_string())
            .unwrap_or_default();
        if trig == "roleta_code" {
            continue;
        }
        let rs = reward_summary(item_map.get(box_id).cloned().unwrap_or_default(), &names);
        inventory.push(json!({
            "boxId": box_id,
            "qty": qty,
            "name": def.map(|d| string_cell(d, "name")).unwrap_or_else(|| box_id.clone()),
            "description": def.map(|d| string_cell(d, "description")).unwrap_or_default(),
            "icon": prefer_catalog_image(def.and_then(|d| opt_string_cell(d, "icon")).as_deref(), None),
            "trigger": trig,
            "openableHere": trig != "roleta_code",
            "rewardSummary": { "slotCount": rs.0, "slots": rs.1 },
        }));
    }
    inventory.sort_by(|a, b| {
        let an = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
        an.cmp(bn)
    });

    let (history_items, next_cursor) = load_history(client, uid, None)
        .await
        .unwrap_or((Vec::new(), None));
    let shop_empty = shop.is_empty();
    Ok(json!({
        "version": STATE_VERSION,
        "usdc": usdc,
        "banner": if shop_empty { json!({ "text": "Loja de caixas vazia neste momento.", "variant": "warning" }) } else { Value::Null },
        "promoHelp": "Códigos promocionais válidos são verificados no servidor (validade, limite de uso e recompensa).",
        "roulettePromoNote": "Códigos da Roleta são tratados no menu Roleta — não precisas de os colar aqui; ao resgatar, segue para a Roleta quando aplicável.",
        "shop": shop,
        "shopEmptyMessage": if shop_empty { "Nenhuma caixa disponível para compra no momento." } else { "Escolhe uma caixa abaixo. Preço e stock são confirmados no servidor ao comprar." },
        "inventory": inventory,
        "history": { "items": history_items, "limit": HISTORY_PAGE_SIZE, "nextCursor": next_cursor },
    }))
}

pub async fn run_lucky_shop(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let state = run_lucky_state(pool, user_id).await?;
    Ok(json!({
        "shop": state.get("shop").cloned().unwrap_or(json!([])),
        "usdc": state.get("usdc").cloned().unwrap_or(json!(0)),
        "shopEmptyMessage": state.get("shopEmptyMessage").cloned().unwrap_or(json!("")),
        "banner": state.get("banner").cloned().unwrap_or(Value::Null),
    }))
}

pub async fn run_lucky_inventory(pool: &Pool, user_id: i64) -> Result<Value, PlayerReadError> {
    let state = run_lucky_state(pool, user_id).await?;
    Ok(json!({
        "inventory": state.get("inventory").cloned().unwrap_or(json!([])),
        "usdc": state.get("usdc").cloned().unwrap_or(json!(0)),
    }))
}

pub async fn run_lucky_history(
    pool: &Pool,
    user_id: i64,
    _cursor: Option<&str>,
) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let (items, next) = load_history(&conn, uid, None).await?;
    Ok(json!({ "items": items, "limit": HISTORY_PAGE_SIZE, "nextCursor": next }))
}

pub async fn run_lucky_opening(
    pool: &Pool,
    user_id: i64,
    opening_id: &str,
) -> Result<Value, PlayerReadError> {
    let id = opening_id.trim();
    if id.is_empty() || id.len() > OPENING_ID_MAX_LENGTH {
        return Err(PlayerReadError::not_found("Opening not found."));
    }
    let conn = pool.get().await?;
    let uid = pg_user_id(user_id)?;
    let row = conn
        .query_opt(
            "SELECT id, created_at, box_id, gained_usdc::text AS gained_usdc, rewards_json
               FROM lucky_box_openings WHERE id = $1 AND user_id = $2",
            &[&id, &uid],
        )
        .await?;
    let Some(o) = row else {
        return Err(PlayerReadError::not_found("Opening not found."));
    };
    let box_id = string_cell(&o, "box_id");
    let name_row = conn
        .query_opt("SELECT name FROM loot_boxes WHERE id = $1", &[&box_id])
        .await?;
    let box_name = name_row
        .as_ref()
        .map(|r| string_cell(r, "name"))
        .filter(|s| !s.is_empty())
        .unwrap_or(box_id.clone());
    Ok(json!({
        "id": string_cell(&o, "id"),
        "at": i64_ms(&o, "created_at"),
        "boxId": box_id,
        "boxName": box_name,
        "gainedUsdc": string_cell(&o, "gained_usdc"),
        "rewards": map_rewards_json(o.try_get::<_, Option<Value>>("rewards_json").ok().flatten()),
    }))
}

pub async fn run_lucky_discard(
    pool: &Pool,
    user_id: i64,
    box_id: &str,
    qty_spec: &Value,
) -> Result<Value, PlayerReadError> {
    let bid = box_id.trim();
    if bid.is_empty() {
        return Err(PlayerReadError::bad("Invalid box."));
    }
    let mut conn = pool.get().await?;
    let tx = conn.transaction().await?;
    tx.execute(
        &format!("SET LOCAL lock_timeout = {HARDWARE_TX_TIMEOUT_MS}"),
        &[],
    )
    .await?;
    let uid = pg_user_id(user_id)?;
    let locked = tx
        .query_opt(
            "SELECT qty FROM unopened_boxes WHERE user_id = $1 AND box_id = $2 FOR UPDATE",
            &[&uid, &bid],
        )
        .await?;
    let owned = locked.as_ref().map(|r| i32_cell(r, "qty")).unwrap_or(0);
    if locked.is_none() || owned < 1 {
        return Err(PlayerReadError::bad(
            "You have no boxes of this type in inventory.",
        ));
    }
    let to_remove = if qty_spec.as_str() == Some("all") {
        owned
    } else {
        let q = qty_spec.as_i64().unwrap_or(0);
        i32::try_from(q).unwrap_or(0).min(owned)
    };
    if to_remove < 1 {
        return Err(PlayerReadError::bad("Invalid quantity."));
    }
    if owned <= to_remove {
        tx.execute(
            "DELETE FROM unopened_boxes WHERE user_id = $1 AND box_id = $2",
            &[&uid, &bid],
        )
        .await?;
    } else {
        tx.execute(
            "UPDATE unopened_boxes SET qty = qty - $3 WHERE user_id = $1 AND box_id = $2",
            &[&uid, &bid, &to_remove],
        )
        .await?;
    }
    let box_row = tx
        .query_opt("SELECT name FROM loot_boxes WHERE id = $1", &[&bid])
        .await?;
    let box_name = box_row
        .as_ref()
        .map(|r| string_cell(r, "name"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| bid.to_string());
    tx.commit().await?;
    Ok(json!({
        "discardedQty": to_remove,
        "remainingQty": owned - to_remove,
        "boxName": box_name,
    }))
}

async fn load_history<C: GenericClient>(
    client: &C,
    uid: i32,
    _cursor: Option<&str>,
) -> Result<(Vec<Value>, Option<String>), PlayerReadError> {
    let opens = client
        .query(
            "SELECT o.id, o.created_at, o.box_id, o.gained_usdc::text AS gained_usdc, o.rewards_json, b.name AS box_name
               FROM lucky_box_openings o
               LEFT JOIN loot_boxes b ON b.id = o.box_id
              WHERE o.user_id = $1
              ORDER BY o.created_at DESC
              LIMIT $2",
            &[&uid, &HISTORY_FETCH_SIZE],
        )
        .await?;
    let page = if opens.len() as i64 > HISTORY_PAGE_SIZE {
        &opens[..HISTORY_PAGE_SIZE as usize]
    } else {
        &opens[..]
    };
    let next = if opens.len() as i64 > HISTORY_PAGE_SIZE {
        page.last().map(|r| string_cell(r, "id"))
    } else {
        None
    };
    let items = page
        .iter()
        .map(|o| {
            json!({
                "id": string_cell(o, "id"),
                "at": i64_ms(o, "created_at"),
                "boxId": string_cell(o, "box_id"),
                "boxName": opt_string_cell(o, "box_name").unwrap_or_else(|| string_cell(o, "box_id")),
                "gainedUsdc": string_cell(o, "gained_usdc"),
                "rewards": map_rewards_json(o.try_get::<_, Option<Value>>("rewards_json").ok().flatten()),
            })
        })
        .collect();
    Ok((items, next))
}

async fn load_catalog_names<C: GenericClient>(
    client: &C,
    catalog_ids: &std::collections::HashSet<String>,
    coin_ids: &std::collections::HashSet<String>,
    package_ids: &std::collections::HashSet<String>,
) -> Result<CatalogNames, PlayerReadError> {
    let mut names = CatalogNames {
        upgrades: std::collections::HashMap::new(),
        coins: std::collections::HashMap::new(),
        packages: std::collections::HashMap::new(),
        loot_boxes: std::collections::HashMap::new(),
    };
    if !catalog_ids.is_empty() {
        let ids: Vec<String> = catalog_ids.iter().cloned().collect();
        let rows = client
            .query(
                "SELECT id, name, icon, image FROM upgrades WHERE id = ANY($1::text[])",
                &[&ids],
            )
            .await?;
        for r in &rows {
            names.upgrades.insert(
                string_cell(r, "id"),
                (
                    string_cell(r, "name"),
                    prefer_catalog_image(
                        opt_string_cell(r, "icon").as_deref(),
                        opt_string_cell(r, "image").as_deref(),
                    ),
                ),
            );
        }
    }
    if !coin_ids.is_empty() {
        let ids: Vec<String> = coin_ids.iter().cloned().collect();
        let rows = client
            .query(
                "SELECT id, name FROM mining_coins WHERE id = ANY($1::text[])",
                &[&ids],
            )
            .await?;
        for r in &rows {
            names
                .coins
                .insert(string_cell(r, "id"), string_cell(r, "name"));
        }
    }
    if !package_ids.is_empty() {
        let ids: Vec<String> = package_ids.iter().cloned().collect();
        let pkgs = client
            .query(
                "SELECT id, name FROM admin_upgrades WHERE id = ANY($1::text[])",
                &[&ids],
            )
            .await?;
        for r in &pkgs {
            names
                .packages
                .insert(string_cell(r, "id"), string_cell(r, "name"));
        }
        let boxes = client
            .query(
                "SELECT id, name, icon FROM loot_boxes WHERE id = ANY($1::text[])",
                &[&ids],
            )
            .await?;
        for r in &boxes {
            names.loot_boxes.insert(
                string_cell(r, "id"),
                (
                    string_cell(r, "name"),
                    prefer_catalog_image(opt_string_cell(r, "icon").as_deref(), None),
                ),
            );
        }
    }
    Ok(names)
}

fn is_loot_box_active(is_active: Option<i32>) -> bool {
    is_active.is_none() || is_active == Some(1)
}

fn looks_like_asset_path(raw: &str) -> bool {
    let s = raw.trim();
    if s.is_empty() {
        return false;
    }
    if s.to_ascii_lowercase().starts_with("http://")
        || s.to_ascii_lowercase().starts_with("https://")
        || s.contains('/')
    {
        return true;
    }
    let lower = s.to_ascii_lowercase();
    lower.contains(".png")
        || lower.contains(".jpg")
        || lower.contains(".jpeg")
        || lower.contains(".gif")
        || lower.contains(".webp")
        || lower.contains(".ico")
        || lower.contains(".svg")
}

fn prefer_catalog_image(icon: Option<&str>, image: Option<&str>) -> String {
    if let Some(img) = image {
        let t = img.trim();
        if !t.is_empty() && looks_like_asset_path(t) {
            return t.to_string();
        }
    }
    if let Some(ic) = icon {
        let t = ic.trim();
        if !t.is_empty() && looks_like_asset_path(t) {
            return t.to_string();
        }
    }
    String::new()
}

fn format_drop_chance(raw: f64) -> String {
    if !raw.is_finite() {
        return "0%".into();
    }
    let clamped = raw.max(0.0).min(PERCENT_MAX);
    let rounded = (clamped * DROP_CHANCE_ROUND_PRECISION).round() / DROP_CHANCE_ROUND_PRECISION;
    if (rounded - rounded.round()).abs() < f64::EPSILON {
        format!("{}%", rounded.round() as i64)
    } else {
        format!("{rounded}%")
    }
}

fn reward_summary(items: Vec<Value>, names: &CatalogNames) -> (usize, Vec<Value>) {
    let slots: Vec<Value> = items
        .into_iter()
        .map(|it| {
            let t = it
                .get("item_type")
                .and_then(|x| x.as_str())
                .unwrap_or("item")
                .to_ascii_lowercase();
            let id = it
                .get("item_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let label = if t == "currency" && (id == "usdc" || id.is_empty()) {
                "USDC".into()
            } else if t == "coin" {
                names
                    .coins
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| format!("Moeda {id}"))
            } else if t == "bundle" {
                package_label(&id, names)
            } else {
                names
                    .upgrades
                    .get(&id)
                    .map(|(n, _)| n.clone())
                    .unwrap_or_else(|| {
                        if id.is_empty() {
                            "—".into()
                        } else {
                            format!("Item {id}")
                        }
                    })
            };
            let min_q = it
                .get("min_qty")
                .and_then(|x| x.as_i64())
                .unwrap_or(0)
                .max(0);
            let max_q = it
                .get("max_qty")
                .and_then(|x| x.as_i64())
                .unwrap_or(min_q)
                .max(min_q);
            let range = if min_q == max_q {
                format!("×{min_q}")
            } else {
                format!("×{min_q}–{max_q}")
            };
            let image = slot_image(&t, &id, names);
            let prob = it
                .get("probability")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0);
            json!({
                "kind": t,
                "itemId": if id.is_empty() { Value::Null } else { json!(id) },
                "label": label,
                "rangeText": range,
                "chanceText": format_drop_chance(prob),
                "icon": image,
            })
        })
        .collect();
    (slots.len(), slots)
}

fn package_label(id: &str, names: &CatalogNames) -> String {
    if let Some(pkg) = names
        .packages
        .get(id)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        if pkg.to_ascii_lowercase().starts_with("pacote ") {
            return pkg;
        }
        return format!("Pacote {pkg}");
    }
    if let Some((box_name, _)) = names.loot_boxes.get(id) {
        let t = box_name.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some((up, _)) = names.upgrades.get(id) {
        let t = up.trim();
        if !t.is_empty() {
            if t.to_ascii_lowercase().starts_with("pacote ") {
                return t.to_string();
            }
            return format!("Pacote {t}");
        }
    }
    "Pacote de upgrade".into()
}

fn slot_image(kind: &str, id: &str, names: &CatalogNames) -> String {
    if kind == "currency" || kind == "coin" || kind == "pass" || kind == "access_level" {
        return String::new();
    }
    if kind == "box" {
        return names
            .loot_boxes
            .get(id)
            .map(|(_, i)| i.clone())
            .unwrap_or_default();
    }
    if kind == "bundle" {
        if let Some((_, img)) = names.loot_boxes.get(id) {
            if !img.is_empty() {
                return img.clone();
            }
        }
        return names
            .upgrades
            .get(id)
            .map(|(_, i)| i.clone())
            .unwrap_or_default();
    }
    names
        .upgrades
        .get(id)
        .map(|(_, i)| i.clone())
        .unwrap_or_default()
}

fn map_rewards_json(raw: Option<Value>) -> Vec<Value> {
    let Some(Value::Array(arr)) = raw else {
        return Vec::new();
    };
    arr.into_iter()
        .map(|x| {
            let obj = x.as_object();
            json!({
                "type": obj.and_then(|o| o.get("type")).and_then(|v| v.as_str()).unwrap_or("unknown"),
                "id": obj.and_then(|o| o.get("id")).and_then(|v| v.as_str()).unwrap_or(""),
                "qty": obj.and_then(|o| o.get("qty")).and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0),
            })
        })
        .collect()
}

fn i64_ms(row: &tokio_postgres::Row, col: &str) -> i64 {
    if let Ok(v) = row.try_get::<_, i64>(col) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    0
}
