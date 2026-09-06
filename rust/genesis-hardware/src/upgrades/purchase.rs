//! Upgrade package purchase — USDC debit + loot-box materialize + idem in one TX.
//!
//! Mirrors Node `runUpgradePackagePurchase` + `materializeUpgradePackageAsLootBoxInTx`.

use deadpool_postgres::{GenericClient, Pool};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::current_unix_ms;
use crate::market::{
    assert_active_user, BUY_LOCK_TIMEOUT_MS, IDEMPOTENCY_KEY_MAX_LEN, IDEMPOTENCY_KEY_MIN_LENGTH,
    TX_BUY_TIMEOUT_MS,
};
use crate::pg_types::pg_user_id;

use super::errors::{
    UpgradesError, CODE_IDEMPOTENCY_KEY_REQUIRED, CODE_IDEMPOTENCY_PAYLOAD_MISMATCH,
    CODE_PACKAGE_ACCESS_DENIED, CODE_UPGRADE_NOT_FOUND, ERR_GAME_STATE_MISSING,
    ERR_IDEMPOTENCY_KEY_REQUIRED, ERR_IDEMPOTENCY_PAYLOAD_MISMATCH, ERR_INSUFFICIENT_USDC,
    ERR_INVALID_PACKAGE, ERR_MISSING_ACCESS_LEVEL, ERR_PACKAGE_ACCESS_DENIED, ERR_PACKAGE_EXPIRED,
    ERR_PACKAGE_INACTIVE, ERR_PACKAGE_NOT_FOUND, ERR_PACKAGE_NOT_ON_SALE,
    ERR_PACKAGE_VERSION_STALE, ERR_SOLD_OUT, ERR_UPGRADE_NOT_FOUND_MATERIALIZE, ERR_USER_NOT_FOUND,
};

/// Node `TRANSACTION_TIMEOUT_MS` in `purchase.ts`.
pub const PURCHASE_TX_TIMEOUT_MS: u64 = 60_000;
/// Node `LOCK_TIMEOUT_MS`.
pub const LOCK_TIMEOUT_MS: u64 = BUY_LOCK_TIMEOUT_MS;
/// Node `IDEM_SCOPE`.
pub const IDEM_SCOPE: &str = "upgrade_purchase";
/// Advisory lock label.
pub const PURCHASE_LOCK_LABEL: &str = "upgrade_package_purchase";
/// Node fingerprint op.
const FINGERPRINT_OP: &str = "upgrade_package_purchase";
/// Node `FINGERPRINT_LENGTH` in `stable-fingerprint.ts`.
pub const FINGERPRINT_HEX_LEN: usize = 32;
/// Node `UPGRADE_PACKAGE_ID_RE` max length.
pub const PACKAGE_ID_MAX_LEN: usize = 120;
/// Node `MAX_SAMPLES` for missing-ref messages.
pub const MAX_REF_SAMPLES: usize = 5;
/// Node `UPGRADE_PACKAGE_BOX_TRIGGER`.
pub const UPGRADE_PACKAGE_BOX_TRIGGER: &str = "upgrade_package";
/// Node `BOX_ID_MAX_LENGTH`.
pub const BOX_ID_MAX_LENGTH: usize = 200;
/// Node `BOX_NAME_MAX_LENGTH`.
pub const BOX_NAME_MAX_LENGTH: usize = 200;
/// Node `BOX_ICON`.
pub const BOX_ICON: &str = "📦";
/// Node `GRANT_QTY` — one unopened box per purchase.
pub const GRANT_QTY: i32 = 1;
/// Node `BUNDLE_DRAFT_PROBABILITY`.
pub const BUNDLE_DRAFT_PROBABILITY: f64 = 100.0;
/// Node `FIXED_REWARD_PROBABILITY`.
pub const FIXED_REWARD_PROBABILITY: f64 = 0.0;
/// Inactive loot box (not listed in shop).
pub const LOOT_BOX_INACTIVE: i32 = 0;
/// Package active flag.
pub const PACKAGE_ACTIVE: i32 = 1;

const _: () = assert!(PURCHASE_TX_TIMEOUT_MS == 60_000);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(TX_BUY_TIMEOUT_MS >= PURCHASE_TX_TIMEOUT_MS);

pub const UPGRADE_PACKAGE_PURCHASE_PATH: &str = "/v1/upgrades/purchase";

const SELECT_IDEM_SQL: &str = "SELECT response_json, request_fingerprint
     FROM upgrade_purchase_idempotency
     WHERE user_id = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE";
const INSERT_IDEM_SQL: &str = "INSERT INTO upgrade_purchase_idempotency
     (user_id, scope, idempotency_key, response_json, created_at, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6)";
const LOCK_PACKAGE_SQL: &str = "SELECT id FROM admin_upgrades WHERE id = $1 FOR UPDATE";
const SELECT_PACKAGE_SQL: &str = "SELECT id, name, price_usdc::double precision AS price_usdc,
            grant_usdc::double precision AS grant_usdc, grant_access_level_id,
            is_active, version, stock_remaining, starts_at, ends_at
     FROM admin_upgrades WHERE id = $1";
const DECR_STOCK_SQL: &str = "UPDATE admin_upgrades
    SET stock_remaining = stock_remaining - 1
    WHERE id = $1
      AND is_active = 1
      AND stock_remaining IS NOT NULL
      AND stock_remaining > 0
    RETURNING id";
const SELECT_VISIBILITY_SQL: &str =
    "SELECT access_level_id FROM admin_upgrade_visibility WHERE upgrade_id = $1";
const SELECT_USER_ACCESS_SQL: &str = "SELECT access_level_id FROM users WHERE id = $1";
const SELECT_USER_ACCESS_GRANTS_SQL: &str =
    "SELECT access_level_id FROM user_access_levels WHERE user_id = $1";
const SELECT_ADMIN_ITEMS_SQL: &str =
    "SELECT item_id, qty FROM admin_upgrade_items WHERE upgrade_id = $1";
const SELECT_ADMIN_BOXES_SQL: &str =
    "SELECT box_id, qty FROM admin_upgrade_boxes WHERE upgrade_id = $1";
const SELECT_ADMIN_COINS_SQL: &str =
    "SELECT coin_id, amount::double precision AS amount FROM admin_upgrade_coins WHERE upgrade_id = $1";
const SELECT_CATALOG_ITEMS_SQL: &str = "SELECT id FROM upgrades WHERE id = ANY($1::text[])";
const SELECT_LOOT_BOXES_SQL: &str = "SELECT id FROM loot_boxes WHERE id = ANY($1::text[])";
const SELECT_ACCESS_LEVEL_SQL: &str = "SELECT id FROM access_levels WHERE id = $1";
const SELECT_USDC_SQL: &str =
    "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1 FOR UPDATE";
const SET_USDC_SQL: &str = "UPDATE game_states SET usdc = $2 WHERE user_id = $1";
const INSERT_PURCHASE_SQL: &str =
    "INSERT INTO admin_upgrade_purchases (id, user_id, upgrade_id, purchased_at)
     VALUES ($1, $2, $3, $4)";
const SELECT_VERSION_SQL: &str = "SELECT version FROM admin_upgrades WHERE id = $1";
const UPSERT_LOOT_BOX_SQL: &str = "INSERT INTO loot_boxes
     (id, name, description, price, trigger, icon, is_active, stock, max_per_order, max_per_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 1, NULL)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       trigger = EXCLUDED.trigger,
       icon = EXCLUDED.icon,
       is_active = EXCLUDED.is_active";
const DELETE_LOOT_ITEMS_SQL: &str = "DELETE FROM loot_box_items WHERE box_id = $1";
const INSERT_LOOT_ITEM_SQL: &str = "INSERT INTO loot_box_items
     (box_id, item_type, item_id, min_qty, max_qty, probability)
     VALUES ($1, $2, $3, $4, $5, $6)";
const UPSERT_UNOPENED_SQL: &str =
    "INSERT INTO unopened_boxes (user_id, box_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, box_id) DO UPDATE SET qty = unopened_boxes.qty + EXCLUDED.qty";

#[derive(Debug, Clone)]
pub struct PurchasedBox {
    pub id: String,
    pub name: String,
    pub quantity: i32,
}

#[derive(Debug, Clone)]
pub struct PurchaseOutcome {
    pub new_usdc: f64,
    pub idempotent_replay: bool,
    pub package_version: i32,
    pub box_info: Option<PurchasedBox>,
}

fn is_valid_package_id(id: &str) -> bool {
    if id.is_empty() || id.len() > PACKAGE_ID_MAX_LEN {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

fn normalize_idem_key(raw: &str) -> Result<String, UpgradesError> {
    let trimmed = raw.trim();
    let key = if trimmed.len() > IDEMPOTENCY_KEY_MAX_LEN {
        trimmed[..IDEMPOTENCY_KEY_MAX_LEN].to_string()
    } else {
        trimmed.to_string()
    };
    if key.len() < IDEMPOTENCY_KEY_MIN_LENGTH {
        return Err(UpgradesError::bad_code(
            ERR_IDEMPOTENCY_KEY_REQUIRED,
            CODE_IDEMPOTENCY_KEY_REQUIRED,
        ));
    }
    Ok(key)
}

/// Node `upgradePurchaseRequestFingerprint` / `stableIntentFingerprint`.
fn upgrade_purchase_fingerprint(package_id: &str, client_package_version: Option<i32>) -> String {
    let mut map = serde_json::Map::new();
    map.insert(
        "clientPackageVersion".to_string(),
        match client_package_version {
            Some(v) => json!(v),
            None => json!(null),
        },
    );
    map.insert("op".to_string(), json!(FINGERPRINT_OP));
    map.insert("packageId".to_string(), json!(package_id));
    let keys: Vec<String> = {
        let mut k: Vec<_> = map.keys().cloned().collect();
        k.sort();
        k
    };
    let mut ordered = serde_json::Map::new();
    for k in keys {
        if let Some(v) = map.get(&k) {
            ordered.insert(k, v.clone());
        }
    }
    let payload = serde_json::Value::Object(ordered).to_string();
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)
        .chars()
        .take(FINGERPRINT_HEX_LEN)
        .collect()
}

fn upgrade_package_box_id(upgrade_id: &str) -> String {
    let safe: String = upgrade_id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut id = format!("upgrade_pkg_{safe}");
    if id.len() > BOX_ID_MAX_LENGTH {
        id.truncate(BOX_ID_MAX_LENGTH);
    }
    id
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code().map(|c| c.code() == "23505").unwrap_or(false)
}

fn market_to_upgrades(e: crate::market::errors::MarketError) -> UpgradesError {
    match e {
        crate::market::errors::MarketError::Domain {
            status,
            error,
            code,
            ..
        } => UpgradesError::Domain {
            status,
            error,
            code,
        },
        crate::market::errors::MarketError::Transport(err) => UpgradesError::Transport(err),
    }
}

fn parse_cached_ok(body_json: &str) -> Option<PurchaseOutcome> {
    let v: serde_json::Value = serde_json::from_str(body_json).ok()?;
    if v.get("ok") != Some(&json!(true)) {
        return None;
    }
    let new_usdc = v.get("newUsdc")?.as_f64().filter(|n| n.is_finite())?;
    let package_version = v
        .get("packageVersion")
        .and_then(|x| x.as_i64())
        .map(|n| n as i32)
        .unwrap_or(0);
    let box_info = v.get("box").and_then(|b| {
        let id = b.get("id")?.as_str()?.to_string();
        let name = b.get("name")?.as_str()?.to_string();
        let quantity = b
            .get("quantity")
            .and_then(|q| q.as_i64())
            .map(|n| n as i32)
            .unwrap_or(GRANT_QTY);
        Some(PurchasedBox { id, name, quantity })
    });
    Some(PurchaseOutcome {
        new_usdc,
        idempotent_replay: true,
        package_version,
        box_info,
    })
}

pub async fn purchase_package(
    pool: &Pool,
    user_id: i64,
    package_id_raw: &str,
    idempotency_key: Option<&str>,
    client_package_version: Option<i32>,
    server_now_ms: Option<i64>,
) -> Result<PurchaseOutcome, UpgradesError> {
    let package_id = package_id_raw.trim();
    if !is_valid_package_id(package_id) {
        return Err(UpgradesError::bad(ERR_INVALID_PACKAGE));
    }
    let idem_key = match idempotency_key {
        Some(raw) if !raw.trim().is_empty() => Some(normalize_idem_key(raw)?),
        _ => None,
    };
    let client_v = client_package_version;
    let request_fp = upgrade_purchase_fingerprint(package_id, client_v);
    let now = server_now_ms.unwrap_or_else(current_unix_ms);
    let uid = pg_user_id(user_id).map_err(UpgradesError::transport)?;

    let mut client = pool.get().await?;
    let tx = client
        .transaction()
        .await
        .map_err(UpgradesError::transport)?;

    let out = match run_inner(
        &tx,
        uid,
        user_id,
        package_id,
        idem_key.as_deref(),
        &request_fp,
        client_v,
        now,
    )
    .await
    {
        Ok(o) => {
            tx.commit().await.map_err(UpgradesError::transport)?;
            o
        }
        Err(e) => {
            let _ = tx.rollback().await;
            return Err(e);
        }
    };
    Ok(out)
}

async fn run_inner<C: GenericClient>(
    client: &C,
    uid: i32,
    user_id: i64,
    package_id: &str,
    idem_key: Option<&str>,
    request_fp: &str,
    client_v: Option<i32>,
    now_ms: i64,
) -> Result<PurchaseOutcome, UpgradesError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {PURCHASE_TX_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(UpgradesError::transport)?;
    client
        .execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"), &[])
        .await
        .map_err(UpgradesError::transport)?;

    assert_active_user(client, user_id)
        .await
        .map_err(market_to_upgrades)?;

    if let Some(key) = idem_key {
        let lock_b = format!("{user_id}:{key}");
        client
            .execute(
                "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
                &[&PURCHASE_LOCK_LABEL, &lock_b],
            )
            .await
            .map_err(UpgradesError::transport)?;

        let existing = client
            .query(SELECT_IDEM_SQL, &[&uid, &IDEM_SCOPE, &key])
            .await
            .map_err(UpgradesError::transport)?;
        if let Some(row) = existing.first() {
            let response_json: String = row.get("response_json");
            let st_fp: Option<String> = row.get("request_fingerprint");
            let st_fp = st_fp.unwrap_or_default().trim().to_string();
            if !st_fp.is_empty() && st_fp != request_fp {
                return Err(UpgradesError::conflict_code(
                    ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
                    CODE_IDEMPOTENCY_PAYLOAD_MISMATCH,
                ));
            }
            if let Some(cached) = parse_cached_ok(&response_json) {
                return Ok(cached);
            }
        }
    }

    client
        .query(LOCK_PACKAGE_SQL, &[&package_id])
        .await
        .map_err(UpgradesError::transport)?;

    let user_rows = client
        .query("SELECT id FROM users WHERE id = $1", &[&uid])
        .await
        .map_err(UpgradesError::transport)?;
    if user_rows.is_empty() {
        return Err(UpgradesError::not_found(ERR_USER_NOT_FOUND));
    }

    let pkg_rows = client
        .query(SELECT_PACKAGE_SQL, &[&package_id])
        .await
        .map_err(UpgradesError::transport)?;
    let Some(pkg) = pkg_rows.first() else {
        return Err(UpgradesError::not_found(ERR_PACKAGE_NOT_FOUND));
    };

    let is_active: i32 = pkg.get("is_active");
    if is_active != PACKAGE_ACTIVE {
        return Err(UpgradesError::unprocessable(ERR_PACKAGE_INACTIVE));
    }
    let starts_at: Option<i64> = pkg.get("starts_at");
    if let Some(start) = starts_at {
        if now_ms < start {
            return Err(UpgradesError::unprocessable(ERR_PACKAGE_NOT_ON_SALE));
        }
    }
    let ends_at: Option<i64> = pkg.get("ends_at");
    if let Some(end) = ends_at {
        if now_ms > end {
            return Err(UpgradesError::unprocessable(ERR_PACKAGE_EXPIRED));
        }
    }

    assert_package_visible(client, uid, package_id).await?;

    let version: i32 = pkg.get("version");
    if let Some(cv) = client_v {
        if cv != version {
            return Err(UpgradesError::conflict(ERR_PACKAGE_VERSION_STALE));
        }
    }

    let stock_remaining: Option<i32> = pkg.get("stock_remaining");
    if stock_remaining.is_some() {
        let stock_rows = client
            .query(DECR_STOCK_SQL, &[&package_id])
            .await
            .map_err(UpgradesError::transport)?;
        if stock_rows.is_empty() {
            return Err(UpgradesError::unprocessable(ERR_SOLD_OUT));
        }
    }

    let grant_al: Option<String> = pkg.get("grant_access_level_id");
    assert_grant_refs(client, package_id, grant_al.as_deref()).await?;

    let gs = client
        .query(SELECT_USDC_SQL, &[&uid])
        .await
        .map_err(UpgradesError::transport)?;
    let Some(gs_row) = gs.first() else {
        return Err(UpgradesError::unprocessable(ERR_GAME_STATE_MISSING));
    };
    let balance: f64 = gs_row.get("usdc");
    let price: f64 = pkg.get("price_usdc");
    if !balance.is_finite() || !price.is_finite() || balance < price {
        return Err(UpgradesError::unprocessable(ERR_INSUFFICIENT_USDC));
    }
    let new_bal = balance - price;
    client
        .execute(SET_USDC_SQL, &[&uid, &new_bal])
        .await
        .map_err(UpgradesError::transport)?;

    let purchase_id = Uuid::new_v4();
    client
        .execute(
            INSERT_PURCHASE_SQL,
            &[&purchase_id, &uid, &package_id, &now_ms],
        )
        .await
        .map_err(UpgradesError::transport)?;

    let upgrade_name: String = pkg.get("name");
    let grant_usdc: Option<f64> = pkg.get("grant_usdc");
    let created = materialize_as_loot_box(
        client,
        uid,
        package_id,
        &upgrade_name,
        grant_usdc.unwrap_or(0.0),
    )
    .await?;

    let final_gs = client
        .query(
            "SELECT usdc::double precision AS usdc FROM game_states WHERE user_id = $1",
            &[&uid],
        )
        .await
        .map_err(UpgradesError::transport)?;
    let new_usdc = final_gs
        .first()
        .map(|r| r.get::<_, f64>("usdc"))
        .unwrap_or(new_bal);

    let fresh = client
        .query(SELECT_VERSION_SQL, &[&package_id])
        .await
        .map_err(UpgradesError::transport)?;
    let package_version = fresh
        .first()
        .map(|r| r.get::<_, i32>("version"))
        .unwrap_or(version);

    let out = PurchaseOutcome {
        new_usdc,
        idempotent_replay: false,
        package_version,
        box_info: Some(PurchasedBox {
            id: created.0,
            name: created.1,
            quantity: GRANT_QTY,
        }),
    };

    if let Some(key) = idem_key {
        let payload = build_idem_payload(&out);
        match client
            .execute(
                INSERT_IDEM_SQL,
                &[&uid, &IDEM_SCOPE, &key, &payload, &now_ms, &request_fp],
            )
            .await
        {
            Ok(_) => {}
            Err(e) if is_unique_violation(&e) => {
                let again = client
                    .query(SELECT_IDEM_SQL, &[&uid, &IDEM_SCOPE, &key])
                    .await
                    .map_err(UpgradesError::transport)?;
                if let Some(row) = again.first() {
                    let st_fp: Option<String> = row.get("request_fingerprint");
                    let st_fp = st_fp.unwrap_or_default().trim().to_string();
                    if !st_fp.is_empty() && st_fp != request_fp {
                        return Err(UpgradesError::conflict_code(
                            ERR_IDEMPOTENCY_PAYLOAD_MISMATCH,
                            CODE_IDEMPOTENCY_PAYLOAD_MISMATCH,
                        ));
                    }
                    let response_json: String = row.get("response_json");
                    if let Some(cached) = parse_cached_ok(&response_json) {
                        return Ok(cached);
                    }
                }
                return Err(UpgradesError::transport(e));
            }
            Err(e) => return Err(UpgradesError::transport(e)),
        }
    }

    Ok(out)
}

fn build_idem_payload(out: &PurchaseOutcome) -> String {
    let mut map = serde_json::Map::new();
    map.insert("ok".to_string(), json!(true));
    map.insert("newUsdc".to_string(), json!(out.new_usdc));
    map.insert("idempotentReplay".to_string(), json!(false));
    map.insert("packageVersion".to_string(), json!(out.package_version));
    if let Some(ref b) = out.box_info {
        map.insert(
            "box".to_string(),
            json!({
                "id": b.id,
                "name": b.name,
                "quantity": b.quantity,
            }),
        );
    }
    serde_json::Value::Object(map).to_string()
}

async fn assert_package_visible<C: GenericClient>(
    client: &C,
    uid: i32,
    package_id: &str,
) -> Result<(), UpgradesError> {
    let vis = client
        .query(SELECT_VISIBILITY_SQL, &[&package_id])
        .await
        .map_err(UpgradesError::transport)?;
    if vis.is_empty() {
        return Ok(());
    }
    let mut level_ids = std::collections::HashSet::new();
    let user = client
        .query(SELECT_USER_ACCESS_SQL, &[&uid])
        .await
        .map_err(UpgradesError::transport)?;
    if let Some(row) = user.first() {
        let al: Option<String> = row.get("access_level_id");
        if let Some(id) = al.filter(|s| !s.trim().is_empty()) {
            level_ids.insert(id);
        }
    }
    let grants = client
        .query(SELECT_USER_ACCESS_GRANTS_SQL, &[&uid])
        .await
        .map_err(UpgradesError::transport)?;
    for row in grants {
        let id: String = row.get("access_level_id");
        if !id.trim().is_empty() {
            level_ids.insert(id);
        }
    }
    let allowed = vis.iter().any(|r| {
        let aid: String = r.get("access_level_id");
        level_ids.contains(&aid)
    });
    if allowed {
        return Ok(());
    }
    Err(UpgradesError::forbidden_code(
        ERR_PACKAGE_ACCESS_DENIED,
        CODE_PACKAGE_ACCESS_DENIED,
    ))
}

async fn assert_grant_refs<C: GenericClient>(
    client: &C,
    upgrade_id: &str,
    grant_access_level_id: Option<&str>,
) -> Result<(), UpgradesError> {
    let items = client
        .query(SELECT_ADMIN_ITEMS_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;
    let mut item_ids: Vec<String> = items
        .iter()
        .map(|r| r.get::<_, String>("item_id").trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    item_ids.sort();
    item_ids.dedup();
    if !item_ids.is_empty() {
        let found = client
            .query(SELECT_CATALOG_ITEMS_SQL, &[&item_ids])
            .await
            .map_err(UpgradesError::transport)?;
        let ok: std::collections::HashSet<String> =
            found.iter().map(|r| r.get::<_, String>("id")).collect();
        let missing: Vec<&str> = item_ids
            .iter()
            .filter(|id| !ok.contains(*id))
            .map(|s| s.as_str())
            .collect();
        if !missing.is_empty() {
            let sample: Vec<&str> = missing.into_iter().take(MAX_REF_SAMPLES).collect();
            return Err(UpgradesError::unprocessable(format!(
                "Package has invalid configuration: missing part(s) in catalog ({}). Contact support.",
                sample.join(", ")
            )));
        }
    }

    let boxes = client
        .query(SELECT_ADMIN_BOXES_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;
    let mut box_ids: Vec<String> = boxes
        .iter()
        .map(|r| r.get::<_, String>("box_id").trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    box_ids.sort();
    box_ids.dedup();
    if !box_ids.is_empty() {
        let found = client
            .query(SELECT_LOOT_BOXES_SQL, &[&box_ids])
            .await
            .map_err(UpgradesError::transport)?;
        let ok: std::collections::HashSet<String> =
            found.iter().map(|r| r.get::<_, String>("id")).collect();
        let missing: Vec<&str> = box_ids
            .iter()
            .filter(|id| !ok.contains(*id))
            .map(|s| s.as_str())
            .collect();
        if !missing.is_empty() {
            let sample: Vec<&str> = missing.into_iter().take(MAX_REF_SAMPLES).collect();
            return Err(UpgradesError::unprocessable(format!(
                "Package has invalid configuration: missing box(es) ({}). Contact support.",
                sample.join(", ")
            )));
        }
    }

    // coins: amount is numeric — no catalog ref (Node keeps query for symmetry only).
    let _coins = client
        .query(SELECT_ADMIN_COINS_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;

    if let Some(al) = grant_access_level_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let row = client
            .query(SELECT_ACCESS_LEVEL_SQL, &[&al])
            .await
            .map_err(UpgradesError::transport)?;
        if row.is_empty() {
            return Err(UpgradesError::unprocessable(ERR_MISSING_ACCESS_LEVEL));
        }
    }
    Ok(())
}

/// Node `materializeUpgradePackageAsLootBoxInTx` — used by purchase + promo redeem.
pub async fn materialize_upgrade_package_as_loot_box_in_tx<C: GenericClient>(
    client: &C,
    user_id: i64,
    upgrade_id: &str,
) -> Result<(String, String), UpgradesError> {
    let uid = pg_user_id(user_id).map_err(UpgradesError::transport)?;
    let rows = client
        .query(SELECT_PACKAGE_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;
    let Some(pkg) = rows.first() else {
        return Err(UpgradesError::conflict_code(
            ERR_UPGRADE_NOT_FOUND_MATERIALIZE,
            CODE_UPGRADE_NOT_FOUND,
        ));
    };
    let upgrade_name: String = pkg.get("name");
    let grant_usdc: Option<f64> = pkg.get("grant_usdc");
    materialize_as_loot_box(
        client,
        uid,
        upgrade_id,
        &upgrade_name,
        grant_usdc.unwrap_or(0.0),
    )
    .await
}

async fn materialize_as_loot_box<C: GenericClient>(
    client: &C,
    uid: i32,
    upgrade_id: &str,
    upgrade_name: &str,
    grant_usdc: f64,
) -> Result<(String, String), UpgradesError> {
    // Re-read for race (Node throws CONFLICT if gone mid-tx).
    let check = client
        .query(
            "SELECT id FROM admin_upgrades WHERE id = $1",
            &[&upgrade_id],
        )
        .await
        .map_err(UpgradesError::transport)?;
    if check.is_empty() {
        return Err(UpgradesError::conflict_code(
            ERR_UPGRADE_NOT_FOUND_MATERIALIZE,
            CODE_UPGRADE_NOT_FOUND,
        ));
    }

    let box_id = upgrade_package_box_id(upgrade_id);
    let base_name = upgrade_name.trim();
    let mut box_name = if base_name.is_empty() {
        format!("Pacote {upgrade_id}")
    } else {
        format!("Pacote {base_name}")
    };
    if box_name.len() > BOX_NAME_MAX_LENGTH {
        box_name.truncate(BOX_NAME_MAX_LENGTH);
    }
    let description =
        format!("Pacote de upgrade · abra para receber o conteúdo. (upgrade_package:{upgrade_id})");
    let price_zero: f64 = 0.0;
    let is_active = LOOT_BOX_INACTIVE;

    client
        .execute(
            UPSERT_LOOT_BOX_SQL,
            &[
                &box_id,
                &box_name,
                &description,
                &price_zero,
                &UPGRADE_PACKAGE_BOX_TRIGGER,
                &BOX_ICON,
                &is_active,
            ],
        )
        .await
        .map_err(UpgradesError::transport)?;

    let admin_items = client
        .query(SELECT_ADMIN_ITEMS_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;
    let admin_coins = client
        .query(SELECT_ADMIN_COINS_SQL, &[&upgrade_id])
        .await
        .map_err(UpgradesError::transport)?;

    #[derive(Clone)]
    struct Draft {
        item_type: String,
        item_id: String,
        min_qty: i32,
        max_qty: i32,
        probability: f64,
    }

    let mut drafts: Vec<Draft> = vec![Draft {
        item_type: "bundle".into(),
        item_id: upgrade_id.to_string(),
        min_qty: 1,
        max_qty: 1,
        probability: BUNDLE_DRAFT_PROBABILITY,
    }];

    for it in &admin_items {
        let qty: i32 = it.get("qty");
        let q = qty.max(0);
        if q <= 0 {
            continue;
        }
        let item_id: String = it.get("item_id");
        drafts.push(Draft {
            item_type: "item".into(),
            item_id,
            min_qty: q,
            max_qty: q,
            probability: FIXED_REWARD_PROBABILITY,
        });
    }

    let usdc = if grant_usdc.is_finite() {
        grant_usdc.max(0.0).floor() as i32
    } else {
        0
    };
    if usdc > 0 {
        drafts.push(Draft {
            item_type: "currency".into(),
            item_id: "usdc".into(),
            min_qty: usdc,
            max_qty: usdc,
            probability: FIXED_REWARD_PROBABILITY,
        });
    }

    for c in &admin_coins {
        let amount: f64 = c.get("amount");
        let amt = if amount.is_finite() {
            amount.max(0.0).floor() as i32
        } else {
            0
        };
        if amt <= 0 {
            continue;
        }
        let coin_id: String = c.get("coin_id");
        drafts.push(Draft {
            item_type: "coin".into(),
            item_id: coin_id,
            min_qty: amt,
            max_qty: amt,
            probability: FIXED_REWARD_PROBABILITY,
        });
    }

    client
        .execute(DELETE_LOOT_ITEMS_SQL, &[&box_id])
        .await
        .map_err(UpgradesError::transport)?;
    for d in &drafts {
        client
            .execute(
                INSERT_LOOT_ITEM_SQL,
                &[
                    &box_id,
                    &d.item_type,
                    &d.item_id,
                    &d.min_qty,
                    &d.max_qty,
                    &d.probability,
                ],
            )
            .await
            .map_err(UpgradesError::transport)?;
    }

    client
        .execute(UPSERT_UNOPENED_SQL, &[&uid, &box_id, &GRANT_QTY])
        .await
        .map_err(UpgradesError::transport)?;

    Ok((box_id, box_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_id_validation() {
        assert!(is_valid_package_id("pack_1"));
        assert!(is_valid_package_id("a.b-c_1"));
        assert!(!is_valid_package_id(""));
        assert!(!is_valid_package_id("id com espaço"));
        assert!(!is_valid_package_id(&"x".repeat(PACKAGE_ID_MAX_LEN + 1)));
    }

    #[test]
    fn fingerprint_stable() {
        let a = upgrade_purchase_fingerprint("pack_1", None);
        let b = upgrade_purchase_fingerprint("pack_1", None);
        assert_eq!(a, b);
        assert_eq!(a.len(), FINGERPRINT_HEX_LEN);
        assert_ne!(upgrade_purchase_fingerprint("pack_1", Some(1)), a);
        assert_ne!(upgrade_purchase_fingerprint("pack_2", None), a);
    }

    #[test]
    fn box_id_from_upgrade() {
        let id = upgrade_package_box_id("pack/1!");
        assert!(id.starts_with("upgrade_pkg_"));
        assert!(!id.contains('/'));
        assert!(!id.contains('!'));
        assert!(upgrade_package_box_id(&"x".repeat(300)).len() <= BOX_ID_MAX_LENGTH);
    }

    #[test]
    fn timeout_constants_match_node() {
        assert_eq!(PURCHASE_TX_TIMEOUT_MS, 60_000);
        assert_eq!(LOCK_TIMEOUT_MS, 45_000);
        assert!(TX_BUY_TIMEOUT_MS >= PURCHASE_TX_TIMEOUT_MS);
    }

    #[test]
    fn idem_payload_shape() {
        let out = PurchaseOutcome {
            new_usdc: 90.0,
            idempotent_replay: false,
            package_version: 1,
            box_info: Some(PurchasedBox {
                id: "box_1".into(),
                name: "Pacote 1".into(),
                quantity: 1,
            }),
        };
        let s = build_idem_payload(&out);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["newUsdc"], 90.0);
        assert_eq!(v["box"]["id"], "box_1");
        let parsed = parse_cached_ok(&s).unwrap();
        assert!(parsed.idempotent_replay);
        assert_eq!(parsed.new_usdc, 90.0);
    }
}
