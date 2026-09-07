//! `POST /api/loot-boxes` twin — Node `upsertLootBoxCatalog`.
//!
//! Two behaviours the Node service is careful about, kept verbatim:
//! - an active box with no prizes (payload *and* DB) is saved as a draft with a
//!   warning instead of failing the whole catalog save;
//! - `loot_box_items` is never wiped blindly — only when the payload carries at
//!   least one valid prize, or when `clearItems: true` asks for it.

use std::collections::HashMap;

use deadpool_postgres::Pool;
use serde_json::{json, Value};
use tracing::warn;

use crate::player_reads::PlayerReadError;

use super::{js, set_tx_timeout};

/// Node `DEFAULT_MIN_MAX_QTY`.
const DEFAULT_MIN_MAX_QTY: f64 = 1.0;
/// Node `DEFAULT_ICON`.
const DEFAULT_ICON: &str = "🎁";
/// Node `String(b.trigger || 'shop')`.
const DEFAULT_TRIGGER: &str = "shop";
/// Node `String(it.type || 'item')`.
const DEFAULT_ITEM_TYPE: &str = "item";
/// Node `TRIGGERS_WITHOUT_ITEM_LIST` — these boxes legitimately have no prizes.
const TRIGGERS_WITHOUT_ITEM_LIST: &[&str] = &["roleta_code"];
/// Node `SHOP_TRIGGERS` — these require a positive USDC price to stay active.
const SHOP_TRIGGERS: &[&str] = &["shop", "shop_once", "special"];

const ITEM_COUNTS_SQL: &str = "SELECT box_id, COUNT(*)::bigint AS n
       FROM loot_box_items
      WHERE box_id = ANY($1::text[])
      GROUP BY box_id";

const BOX_UPSERT_SQL: &str = "INSERT INTO loot_boxes
       (id, name, description, price, trigger, icon, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       price = EXCLUDED.price,
       trigger = EXCLUDED.trigger,
       icon = EXCLUDED.icon,
       is_active = EXCLUDED.is_active";

const ITEMS_DELETE_SQL: &str = "DELETE FROM loot_box_items WHERE box_id = $1";
const ITEM_INSERT_SQL: &str = "INSERT INTO loot_box_items
       (box_id, item_type, item_id, min_qty, max_qty, probability)
     VALUES ($1, $2, $3, $4, $5, $6)";

const DEACTIVATE_ALL_SQL: &str = "UPDATE loot_boxes SET is_active = 0";
const DEACTIVATE_MISSING_SQL: &str =
    "UPDATE loot_boxes SET is_active = 0 WHERE id NOT IN (SELECT unnest($1::text[]))";

#[derive(Debug, Clone, PartialEq)]
pub struct LootBoxItemRow {
    pub item_type: String,
    pub item_id: String,
    pub min_qty: i32,
    pub max_qty: i32,
    pub probability: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LootBoxRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub price: f64,
    pub trigger: String,
    pub icon: String,
    pub requested_active: bool,
    pub clear_items: bool,
    pub items: Vec<LootBoxItemRow>,
    /// Number of payload prizes with a non-empty id, before they are mapped.
    pub payload_item_count: usize,
}

/// Node `boxes.filter((b) => b && b.id && typeof b.name === 'string' && String(b.name).trim())`.
pub fn parse_valid_boxes(boxes: &[Value]) -> Vec<LootBoxRow> {
    boxes.iter().filter_map(parse_box).collect()
}

fn parse_box(raw: &Value) -> Option<LootBoxRow> {
    let obj = raw.as_object()?;
    let field = |key: &str| obj.get(key);
    if !js::truthy(field("id")) {
        return None;
    }
    let name = match field("name") {
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    if name.trim().is_empty() {
        return None;
    }
    let items = parse_items(field("items"));
    Some(LootBoxRow {
        id: js::string(field("id")),
        name,
        description: js::string_or_nullish(field("description"), ""),
        price: js::number_or_zero(field("price")),
        trigger: js::string_or(field("trigger"), DEFAULT_TRIGGER),
        icon: js::string_or(field("icon"), DEFAULT_ICON),
        // Node `b.isActive !== false` — only a strict `false` opts out.
        requested_active: field("isActive") != Some(&Value::Bool(false)),
        clear_items: field("clearItems") == Some(&Value::Bool(true)),
        payload_item_count: items.len(),
        items,
    })
}

fn parse_items(raw: Option<&Value>) -> Vec<LootBoxItemRow> {
    let Some(Value::Array(entries)) = raw else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|it| {
            let obj = it.as_object()?;
            let field = |key: &str| obj.get(key);
            let item_id = js::string_or_nullish(field("id"), "");
            if item_id.trim().is_empty() {
                return None;
            }
            Some(LootBoxItemRow {
                item_type: js::string_or(field("type"), DEFAULT_ITEM_TYPE),
                item_id,
                min_qty: floor_qty(js::number_or_zero(field("minQty"))),
                max_qty: floor_qty(js::number_or_zero(field("maxQty"))),
                probability: js::number_or_zero(field("probability")),
            })
        })
        .collect()
}

/// Node `Math.floor(Number(it.minQty) || DEFAULT_MIN_MAX_QTY)`.
fn floor_qty(n: f64) -> i32 {
    let base = if n == 0.0 { DEFAULT_MIN_MAX_QTY } else { n };
    if !base.is_finite() {
        return 0;
    }
    let floored = base.floor();
    if floored > f64::from(i32::MAX) {
        i32::MAX
    } else if floored < f64::from(i32::MIN) {
        i32::MIN
    } else {
        floored as i32
    }
}

/// Node warning text for an active box with no prizes.
pub fn draft_warning(name: &str, id: &str) -> String {
    format!(
        "Caixa \"{}\" ({}): activa mas sem prémios — gravada como inactiva (rascunho). Adicione prémios e reactive.",
        name.trim(),
        id
    )
}

/// Node 400 for an active shop box without a positive price.
pub fn invalid_price_error(name: &str, id: &str) -> String {
    format!(
        "Caixa \"{}\" ({}): preço USDC inválido para venda na loja (use número > 0).",
        name.trim(),
        id
    )
}

/// A box after the draft coercion and the shop-price check.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedLootBox {
    pub index: usize,
    pub effective_active: bool,
}

/// Node's `normalized` loop: coerce active-without-prizes to a draft, then
/// reject active shop boxes priced at zero or below.
pub fn normalize_boxes(
    rows: &[LootBoxRow],
    db_item_counts: &HashMap<String, i64>,
) -> Result<(Vec<NormalizedLootBox>, Vec<String>), PlayerReadError> {
    let mut normalized = Vec::with_capacity(rows.len());
    let mut warnings = Vec::new();
    for (index, b) in rows.iter().enumerate() {
        let mut effective_active = b.requested_active;
        let items_in_db = db_item_counts.get(&b.id).copied().unwrap_or(0);
        let items_effective = if b.payload_item_count > 0 {
            b.payload_item_count as i64
        } else {
            items_in_db
        };

        if effective_active
            && !TRIGGERS_WITHOUT_ITEM_LIST.contains(&b.trigger.as_str())
            && items_effective == 0
        {
            effective_active = false;
            let msg = draft_warning(&b.name, &b.id);
            warn!(box_id = %b.id, "loot-box saved as draft: active without prizes");
            warnings.push(msg);
        }

        if effective_active
            && SHOP_TRIGGERS.contains(&b.trigger.as_str())
            && !(b.price.is_finite() && b.price > 0.0)
        {
            return Err(PlayerReadError::bad(invalid_price_error(&b.name, &b.id)));
        }

        normalized.push(NormalizedLootBox {
            index,
            effective_active,
        });
    }
    Ok((normalized, warnings))
}

pub async fn run_upsert_loot_boxes(
    pool: &Pool,
    boxes: &[Value],
    replace_catalog: bool,
) -> Result<Value, PlayerReadError> {
    let rows = parse_valid_boxes(boxes);
    let valid_ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_tx_timeout(&tx).await?;

    let mut db_item_counts: HashMap<String, i64> = HashMap::new();
    if !valid_ids.is_empty() {
        for r in tx.query(ITEM_COUNTS_SQL, &[&valid_ids]).await? {
            db_item_counts.insert(r.get::<_, String>("box_id"), r.get::<_, i64>("n"));
        }
    }

    let (normalized, warnings) = normalize_boxes(&rows, &db_item_counts)?;

    for entry in &normalized {
        let b = &rows[entry.index];
        let is_active = i32::from(entry.effective_active);
        tx.execute(
            BOX_UPSERT_SQL,
            &[
                &b.id,
                &b.name.trim(),
                &b.description,
                &b.price,
                &b.trigger,
                &b.icon,
                &is_active,
            ],
        )
        .await?;

        if !b.items.is_empty() {
            tx.execute(ITEMS_DELETE_SQL, &[&b.id]).await?;
            for it in &b.items {
                tx.execute(
                    ITEM_INSERT_SQL,
                    &[
                        &b.id,
                        &it.item_type,
                        &it.item_id,
                        &it.min_qty,
                        &it.max_qty,
                        &it.probability,
                    ],
                )
                .await?;
            }
        } else if b.clear_items {
            tx.execute(ITEMS_DELETE_SQL, &[&b.id]).await?;
        }
    }

    if replace_catalog {
        if boxes.is_empty() {
            tx.execute(DEACTIVATE_ALL_SQL, &[]).await?;
        } else if !valid_ids.is_empty() {
            tx.execute(DEACTIVATE_MISSING_SQL, &[&valid_ids]).await?;
        }
    }

    tx.commit().await?;
    // Node answers `{ ok: true }` and only adds `warnings` when there are any.
    if warnings.is_empty() {
        return Ok(json!({}));
    }
    Ok(json!({ "warnings": warnings }))
}

const EMAIL_MAX: usize = 254;

/// Node `deleteLootBoxAdmin` — delete a box + all known references (cascade).
/// `broken_only` → refuse (409) unless the box has no item with probability > 0.
pub async fn run_delete_loot_box(
    pool: &Pool,
    box_id: &str,
    broken_only: bool,
) -> Result<Value, PlayerReadError> {
    let box_id = box_id.trim().to_string();
    if box_id.is_empty() {
        return Err(PlayerReadError::bad("ID da caixa inválido."));
    }

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_tx_timeout(&tx).await?;

    let exists = tx
        .query("SELECT name FROM loot_boxes WHERE id = $1", &[&box_id])
        .await?;
    if exists.is_empty() {
        return Err(PlayerReadError::not_found("Caixa não encontrada."));
    }

    if broken_only {
        let br = tx
            .query_one(
                "SELECT COUNT(*)::int8 AS n,
                        COALESCE(SUM(GREATEST(0, probability::double precision)), 0)::float8 AS w
                   FROM loot_box_items WHERE box_id = $1",
                &[&box_id],
            )
            .await?;
        let n: i64 = br.get("n");
        let w: f64 = br.get("w");
        if !(n == 0 || w <= 0.0) {
            return Err(PlayerReadError::conflict(
                "A caixa ainda tem itens com probabilidade > 0. Remova brokenOnly=1 para apagar à força, ou zere as probabilidades no editor.",
            ));
        }
    }

    let loot_box_items_removed = tx
        .execute("DELETE FROM loot_box_items WHERE box_id = $1", &[&box_id])
        .await?;
    let unopened_boxes_rows = tx
        .execute("DELETE FROM unopened_boxes WHERE box_id = $1", &[&box_id])
        .await?;
    let player_claimed_rows = tx
        .execute(
            "DELETE FROM player_claimed_boxes WHERE box_id = $1",
            &[&box_id],
        )
        .await?;
    let admin_upgrade_boxes_rows = tx
        .execute(
            "DELETE FROM admin_upgrade_boxes WHERE box_id = $1",
            &[&box_id],
        )
        .await?;
    let promo_codes_cleared = tx
        .execute(
            "UPDATE promo_codes SET loot_box_id = NULL WHERE loot_box_id = $1",
            &[&box_id],
        )
        .await?;
    let referral_models_sender_cleared = tx
        .execute(
            "UPDATE referral_models SET sender_loot_box_id = NULL WHERE sender_loot_box_id = $1",
            &[&box_id],
        )
        .await?;
    let referral_models_receiver_cleared = tx
        .execute(
            "UPDATE referral_models SET receiver_loot_box_id = NULL WHERE receiver_loot_box_id = $1",
            &[&box_id],
        )
        .await?;
    let loot_boxes_removed = tx
        .execute("DELETE FROM loot_boxes WHERE id = $1", &[&box_id])
        .await?;

    tx.commit().await?;

    Ok(json!({
        "ok": true,
        "summary": {
            "lootBoxItemsRemoved": loot_box_items_removed,
            "unopenedBoxesRows": unopened_boxes_rows,
            "playerClaimedRows": player_claimed_rows,
            "adminUpgradeBoxesRows": admin_upgrade_boxes_rows,
            "promoCodesCleared": promo_codes_cleared,
            "referralModelsSenderCleared": referral_models_sender_cleared,
            "referralModelsReceiverCleared": referral_models_receiver_cleared,
            "lootBoxesRemoved": loot_boxes_removed,
        }
    }))
}

/// Node `listLootBoxRedemptions` — promo-code redemptions bound to a box, newest first.
pub async fn run_loot_box_redemptions(
    pool: &Pool,
    box_id: &str,
) -> Result<Value, PlayerReadError> {
    let box_id = box_id.trim().to_string();
    if box_id.is_empty() {
        return Err(PlayerReadError::bad("ID da caixa inválido."));
    }
    let client = pool.get().await?;
    let rows = client
        .query(
            "SELECT r.code,
                    pc.type AS ptype,
                    COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.email), ''),
                             'user_' || r.user_id::text) AS username,
                    r.redeemed_at
               FROM promo_code_redemptions r
               JOIN promo_codes pc ON pc.code = r.code
               LEFT JOIN users u ON u.id = r.user_id
              WHERE pc.loot_box_id = $1
              ORDER BY r.redeemed_at DESC",
            &[&box_id],
        )
        .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "code": r.get::<_, String>("code"),
                "type": r.get::<_, Option<String>>("ptype").unwrap_or_default(),
                "username": r.get::<_, String>("username"),
                "redeemedAt": r.get::<_, Option<i64>>("redeemed_at").unwrap_or(0),
            })
        })
        .collect();
    Ok(json!(out))
}

async fn user_id_by_email_ci<C: deadpool_postgres::GenericClient>(
    client: &C,
    email: &str,
) -> Result<i32, PlayerReadError> {
    let rows = client
        .query(
            "SELECT id FROM users WHERE lower(email) = lower($1) ORDER BY id ASC LIMIT 1",
            &[&email],
        )
        .await?;
    match rows.first() {
        Some(r) => Ok(r.get::<_, i32>("id")),
        None => Err(PlayerReadError::not_found("User not found")),
    }
}

/// Node `listUserUnopenedBoxes` — `{ boxes: [{ box_id, qty }] }` for the email's owner.
pub async fn run_admin_user_boxes(pool: &Pool, email: &str) -> Result<Value, PlayerReadError> {
    let email = email.trim();
    if email.is_empty() || email.len() > EMAIL_MAX {
        return Err(PlayerReadError::bad("Email required"));
    }
    let client = pool.get().await?;
    let uid = user_id_by_email_ci(&client, email).await?;
    let rows = client
        .query(
            "SELECT box_id, qty FROM unopened_boxes WHERE user_id = $1 ORDER BY qty DESC",
            &[&uid],
        )
        .await?;
    let boxes: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "box_id": r.get::<_, String>("box_id"),
                "qty": r.get::<_, Option<i32>>("qty").unwrap_or(0),
            })
        })
        .collect();
    Ok(json!({ "boxes": boxes }))
}

/// Node `deleteUserUnopenedBox` — drop one `unopened_boxes` row, return removed qty.
pub async fn run_delete_user_box(
    pool: &Pool,
    email: &str,
    box_id: &str,
) -> Result<Value, PlayerReadError> {
    let email = email.trim();
    let box_id = box_id.trim();
    if email.is_empty() || email.len() > EMAIL_MAX || box_id.is_empty() {
        return Err(PlayerReadError::bad("Email and boxId required"));
    }
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let uid = user_id_by_email_ci(&tx, email).await?;
    let existing = tx
        .query(
            "SELECT qty FROM unopened_boxes WHERE user_id = $1 AND box_id = $2",
            &[&uid, &box_id],
        )
        .await?;
    let Some(row) = existing.first() else {
        return Err(PlayerReadError::not_found("Box not found in user inventory"));
    };
    let deleted_qty: i32 = row.get::<_, Option<i32>>("qty").unwrap_or(0);
    tx.execute(
        "DELETE FROM unopened_boxes WHERE user_id = $1 AND box_id = $2",
        &[&uid, &box_id],
    )
    .await?;
    tx.commit().await?;
    Ok(json!({
        "ok": true,
        "message": format!("Deleted {deleted_qty}x box {box_id} from {email}"),
        "deletedQty": deleted_qty,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(&str, i64)]) -> HashMap<String, i64> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), *v)).collect()
    }

    #[test]
    fn invalid_boxes_are_dropped() {
        let rows = parse_valid_boxes(&[
            json!({ "id": "", "name": "x" }),
            json!({ "id": "b", "name": 7 }),
            json!({ "id": "b", "name": "   " }),
            json!("nope"),
            json!({ "id": "ok", "name": "Box" }),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ok");
    }

    #[test]
    fn defaults_match_node() {
        let rows = parse_valid_boxes(&[json!({ "id": "b1", "name": " Box " })]);
        let row = &rows[0];
        assert_eq!(row.description, "");
        assert_eq!(row.price, 0.0);
        assert_eq!(row.trigger, DEFAULT_TRIGGER);
        assert_eq!(row.icon, DEFAULT_ICON);
        assert!(row.requested_active);
        assert!(!row.clear_items);
        assert!(row.items.is_empty());
    }

    #[test]
    fn only_strict_false_deactivates_and_only_strict_true_clears() {
        let rows = parse_valid_boxes(&[json!({
            "id": "b", "name": "B", "isActive": 0, "clearItems": 1
        })]);
        assert!(rows[0].requested_active);
        assert!(!rows[0].clear_items);

        let rows = parse_valid_boxes(&[json!({
            "id": "b", "name": "B", "isActive": false, "clearItems": true
        })]);
        assert!(!rows[0].requested_active);
        assert!(rows[0].clear_items);
    }

    #[test]
    fn items_without_id_are_skipped_and_qty_defaults_to_one() {
        let rows = parse_valid_boxes(&[json!({
            "id": "b", "name": "B",
            "items": [
                { "id": "  " },
                { "type": "coin", "id": "gemt", "probability": "12.5" },
                { "id": "rack", "minQty": 2, "maxQty": "5.9" }
            ]
        })]);
        let items = &rows[0].items;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].item_type, "coin");
        assert_eq!(items[0].min_qty, 1);
        assert_eq!(items[0].max_qty, 1);
        assert_eq!(items[0].probability, 12.5);
        assert_eq!(items[1].item_type, DEFAULT_ITEM_TYPE);
        assert_eq!(items[1].min_qty, 2);
        assert_eq!(items[1].max_qty, 5);
    }

    #[test]
    fn active_box_without_prizes_becomes_a_draft() {
        let rows = parse_valid_boxes(&[json!({ "id": "b", "name": "Box", "price": 5 })]);
        let (normalized, warnings) = normalize_boxes(&rows, &HashMap::new()).unwrap();
        assert!(!normalized[0].effective_active);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Box"));
        assert!(warnings[0].contains("(b)"));
    }

    #[test]
    fn prizes_already_in_db_keep_the_box_active() {
        let rows = parse_valid_boxes(&[json!({ "id": "b", "name": "Box", "price": 5 })]);
        let (normalized, warnings) = normalize_boxes(&rows, &counts(&[("b", 3)])).unwrap();
        assert!(normalized[0].effective_active);
        assert!(warnings.is_empty());
    }

    #[test]
    fn roleta_code_trigger_stays_active_without_prizes() {
        let rows = parse_valid_boxes(&[json!({
            "id": "b", "name": "Box", "trigger": "roleta_code"
        })]);
        let (normalized, warnings) = normalize_boxes(&rows, &HashMap::new()).unwrap();
        assert!(normalized[0].effective_active);
        assert!(warnings.is_empty());
    }

    #[test]
    fn active_shop_box_needs_a_positive_price() {
        for trigger in SHOP_TRIGGERS {
            let rows = parse_valid_boxes(&[json!({
                "id": "b", "name": "Box", "trigger": trigger,
                "items": [{ "id": "rack" }]
            })]);
            let err = normalize_boxes(&rows, &HashMap::new()).unwrap_err();
            assert_eq!(err.http_status, 400);
            assert!(err.error.contains("preço USDC inválido"));
        }
    }

    #[test]
    fn drafted_box_skips_the_price_check() {
        // No prizes → coerced to draft → the shop price is never validated.
        let rows = parse_valid_boxes(&[json!({ "id": "b", "name": "Box", "trigger": "shop" })]);
        let (normalized, warnings) = normalize_boxes(&rows, &HashMap::new()).unwrap();
        assert!(!normalized[0].effective_active);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn non_shop_trigger_ignores_the_price() {
        let rows = parse_valid_boxes(&[json!({
            "id": "b", "name": "Box", "trigger": "referral",
            "items": [{ "id": "rack" }]
        })]);
        let (normalized, warnings) = normalize_boxes(&rows, &HashMap::new()).unwrap();
        assert!(normalized[0].effective_active);
        assert!(warnings.is_empty());
    }
}
