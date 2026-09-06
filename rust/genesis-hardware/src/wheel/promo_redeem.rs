//! Promo-code redeem TX — Node `runPromoCodeRedeemInTransaction`.

use std::collections::BTreeMap;

use deadpool_postgres::{GenericClient, Pool};
use serde_json::{json, Value};

use crate::config::current_unix_ms;
use crate::market::errors::MarketError;
use crate::market::{assert_active_user, BUY_LOCK_TIMEOUT_MS, TX_BUY_TIMEOUT_MS};
use crate::persist::credit_stock;
use crate::pg_types::pg_user_id;
use crate::upgrades::errors::UpgradesError;
use crate::upgrades::purchase::materialize_upgrade_package_as_loot_box_in_tx;

use super::errors::{
    WheelError, CODE_UPGRADE_NOT_FOUND, ERR_ALREADY_REDEEMED_GLOBAL, ERR_ALREADY_REDEEMED_USER,
    ERR_CODE_DISABLED, ERR_CODE_EXPIRED_DOT, ERR_INVALID_CODE, ERR_INVALID_CODE_NOT_FOUND,
    ERR_INVALID_SESSION,
};
use super::promo_code::{
    normalize_promo_code, promo_code_row_eligible_for_roleta_flow, throw_if_promo_code_expired,
};

/// Node `TX_TIMEOUT_MS` (wheel / lucky-boxes controllers).
pub const TX_TIMEOUT_MS: u64 = 60_000;
/// Node `TX_MAX_WAIT_MS`.
pub const TX_MAX_WAIT_MS: u64 = 10_000;
/// Node `LOCK_TIMEOUT_MS` (promo-redeem).
pub const LOCK_TIMEOUT_MS: u64 = BUY_LOCK_TIMEOUT_MS;

const _: () = assert!(TX_TIMEOUT_MS == 60_000);
const _: () = assert!(TX_MAX_WAIT_MS == 10_000);
const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(TX_BUY_TIMEOUT_MS >= TX_TIMEOUT_MS);

pub const WHEEL_REDEEM_CODE_PATH: &str = "/v1/wheel/redeem-code";
/// Advisory lock label — Node `hashtext('promo_redeem')`.
pub const PROMO_REDEEM_LOCK_LABEL: &str = "promo_redeem";

const ADVISORY_LOCK_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))";
const SELECT_PROMO_SQL: &str = "SELECT code, loot_box_id, upgrade_id, admin_upgrade_id, type,
            is_active, expires_at
     FROM promo_codes WHERE code = $1";
const SELECT_PROMO_FOR_UPDATE_SQL: &str =
    "SELECT code, loot_box_id, upgrade_id, admin_upgrade_id, type,
            is_active, expires_at
     FROM promo_codes WHERE code = $1 FOR UPDATE";
const SELECT_ANY_REDEEM_SQL: &str =
    "SELECT code FROM promo_code_redemptions WHERE code = $1 LIMIT 1";
const SELECT_USER_REDEEM_SQL: &str =
    "SELECT reward_granted FROM promo_code_redemptions WHERE code = $1 AND user_id = $2";
const INSERT_REDEEM_ROLETA_SQL: &str = "INSERT INTO promo_code_redemptions
     (code, user_id, redeemed_at, reward_granted) VALUES ($1, $2, $3, 0)";
const INSERT_REDEEM_STANDARD_SQL: &str = "INSERT INTO promo_code_redemptions
     (code, user_id, redeemed_at) VALUES ($1, $2, $3)";
const UPSERT_UNOPENED_SQL: &str =
    "INSERT INTO unopened_boxes (user_id, box_id, qty) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, box_id) DO UPDATE SET qty = unopened_boxes.qty + 1";
const DEACTIVATE_PROMO_SQL: &str = "UPDATE promo_codes SET is_active = 0 WHERE code = $1";
const SELECT_BOXES_SQL: &str = "SELECT box_id, qty FROM unopened_boxes WHERE user_id = $1";
const SELECT_STOCK_SQL: &str = "SELECT item_id, qty FROM stock WHERE user_id = $1";

const TYPE_GLOBAL_ONCE: &str = "global_once";
const TYPE_ROLETA_GLOBAL_1X: &str = "roleta_global_1x";
const TYPE_ROLETA_PLAYER_1X: &str = "roleta_player_1x";
const PG_UNIQUE_VIOLATION: &str = "23505";

#[derive(Debug, Clone)]
pub enum PromoRedeemOutcome {
    RoletaNew {
        code: String,
        #[allow(dead_code)]
        server_now_ms: i64,
    },
    RoletaReentry {
        code: String,
    },
    Standard {
        unopened_boxes: BTreeMap<String, i32>,
        stock: BTreeMap<String, i32>,
        loot_box_id: Option<String>,
        upgrade_id: Option<String>,
        admin_upgrade_id: Option<String>,
    },
}

impl PromoRedeemOutcome {
    pub fn to_wheel_json(&self) -> Value {
        match self {
            Self::RoletaNew { code, .. } | Self::RoletaReentry { code } => {
                json!({ "ok": true, "type": "roleta", "code": code })
            }
            Self::Standard {
                unopened_boxes,
                stock,
                loot_box_id,
                upgrade_id,
                admin_upgrade_id,
            } => json!({
                "ok": true,
                "unopenedBoxes": unopened_boxes,
                "stock": stock,
                "lootBoxId": loot_box_id,
                "upgradeId": upgrade_id,
                "adminUpgradeId": admin_upgrade_id,
            }),
        }
    }

    /// Lucky-boxes promocodes redeem body (adds `type` + `version: 1`).
    pub fn to_lucky_json(&self) -> Value {
        match self {
            Self::RoletaNew { code, .. } | Self::RoletaReentry { code } => {
                json!({ "ok": true, "type": "roleta", "code": code, "version": 1 })
            }
            Self::Standard {
                unopened_boxes,
                stock,
                loot_box_id,
                upgrade_id,
                admin_upgrade_id,
            } => json!({
                "ok": true,
                "type": "standard",
                "unopenedBoxes": unopened_boxes,
                "stock": stock,
                "lootBoxId": loot_box_id,
                "upgradeId": upgrade_id,
                "adminUpgradeId": admin_upgrade_id,
                "version": 1,
            }),
        }
    }
}

fn market_to_wheel(e: MarketError) -> WheelError {
    match e {
        MarketError::Domain {
            status,
            error,
            code,
            ..
        } => WheelError::Domain {
            status,
            error,
            code,
        },
        MarketError::Transport(err) => WheelError::Transport(err),
    }
}

fn upgrades_to_wheel(e: UpgradesError) -> WheelError {
    match e {
        UpgradesError::Domain {
            status,
            error,
            code,
        } => WheelError::Domain {
            status,
            error,
            code: code.or_else(|| Some(CODE_UPGRADE_NOT_FOUND.to_string())),
        },
        UpgradesError::Transport(err) => WheelError::Transport(err),
    }
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code()
        .map(|c| c.code() == PG_UNIQUE_VIOLATION)
        .unwrap_or(false)
}

pub(crate) async fn set_promo_tx_timeouts<C: GenericClient>(client: &C) -> Result<(), WheelError> {
    client
        .execute(
            &format!("SET LOCAL statement_timeout = {TX_TIMEOUT_MS}"),
            &[],
        )
        .await
        .map_err(WheelError::transport)?;
    client
        .execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"), &[])
        .await
        .map_err(WheelError::transport)?;
    Ok(())
}

struct PromoRow {
    code: String,
    loot_box_id: Option<String>,
    upgrade_id: Option<String>,
    admin_upgrade_id: Option<String>,
    promo_type: String,
    is_active: Option<i32>,
    expires_at: Option<i64>,
}

fn map_promo_row(row: &tokio_postgres::Row) -> PromoRow {
    PromoRow {
        code: row.get("code"),
        loot_box_id: row.get("loot_box_id"),
        upgrade_id: row.get("upgrade_id"),
        admin_upgrade_id: row.get("admin_upgrade_id"),
        promo_type: row.get("type"),
        is_active: row.get("is_active"),
        expires_at: row.get("expires_at"),
    }
}

fn is_single_use_type(ty: &str) -> bool {
    ty == TYPE_GLOBAL_ONCE || ty == TYPE_ROLETA_GLOBAL_1X || ty == TYPE_ROLETA_PLAYER_1X
}

/// Shared redeem body (caller owns BEGIN/COMMIT + timeouts optional).
pub async fn run_promo_code_redeem_in_transaction<C: GenericClient>(
    client: &C,
    user_id: i64,
    normalized_code: &str,
    server_now_ms: i64,
) -> Result<PromoRedeemOutcome, WheelError> {
    let uid_pg = pg_user_id(user_id).map_err(WheelError::transport)?;
    client
        .execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"), &[])
        .await
        .map_err(WheelError::transport)?;
    let lock_payload = format!("{user_id}:{normalized_code}");
    client
        .execute(
            ADVISORY_LOCK_SQL,
            &[&PROMO_REDEEM_LOCK_LABEL, &lock_payload],
        )
        .await
        .map_err(WheelError::transport)?;

    let promo_rows = client
        .query(SELECT_PROMO_SQL, &[&normalized_code])
        .await
        .map_err(WheelError::transport)?;
    let mut promo = match promo_rows.first() {
        Some(r) => map_promo_row(r),
        None => return Err(WheelError::not_found(ERR_INVALID_CODE_NOT_FOUND)),
    };
    if promo.is_active.unwrap_or(0) == 0 {
        return Err(WheelError::bad(ERR_CODE_DISABLED));
    }
    throw_if_promo_code_expired(promo.expires_at, server_now_ms)?;

    let treat_as_roleta = promo_code_row_eligible_for_roleta_flow(
        client,
        &promo.promo_type,
        promo.loot_box_id.as_deref(),
    )
    .await?;

    if is_single_use_type(&promo.promo_type) {
        let locked = client
            .query(SELECT_PROMO_FOR_UPDATE_SQL, &[&normalized_code])
            .await
            .map_err(WheelError::transport)?;
        let Some(raw) = locked.first() else {
            return Err(WheelError::not_found(ERR_INVALID_CODE_NOT_FOUND));
        };
        promo = map_promo_row(raw);
        if promo.is_active.unwrap_or(0) == 0 {
            return Err(WheelError::not_found(ERR_CODE_EXPIRED_DOT));
        }
        throw_if_promo_code_expired(promo.expires_at, server_now_ms)?;
        let global = client
            .query(SELECT_ANY_REDEEM_SQL, &[&promo.code])
            .await
            .map_err(WheelError::transport)?;
        if !global.is_empty() {
            return Err(WheelError::bad(ERR_ALREADY_REDEEMED_GLOBAL));
        }
    }

    let existing = client
        .query(SELECT_USER_REDEEM_SQL, &[&promo.code, &uid_pg])
        .await
        .map_err(WheelError::transport)?;
    if let Some(row) = existing.first() {
        let rg: Option<i32> = row.get("reward_granted");
        let rg = rg.unwrap_or(1);
        if treat_as_roleta && rg == 0 {
            return Ok(PromoRedeemOutcome::RoletaReentry {
                code: promo.code.clone(),
            });
        }
        return Err(WheelError::bad(ERR_ALREADY_REDEEMED_USER));
    }

    let redeemed_at = server_now_ms;
    if treat_as_roleta {
        match client
            .execute(
                INSERT_REDEEM_ROLETA_SQL,
                &[&promo.code, &uid_pg, &redeemed_at],
            )
            .await
        {
            Ok(_) => {
                return Ok(PromoRedeemOutcome::RoletaNew {
                    code: promo.code,
                    server_now_ms,
                });
            }
            Err(e) if is_unique_violation(&e) => {
                return Err(WheelError::bad(ERR_ALREADY_REDEEMED_USER));
            }
            Err(e) => return Err(WheelError::transport(e)),
        }
    }

    match client
        .execute(
            INSERT_REDEEM_STANDARD_SQL,
            &[&promo.code, &uid_pg, &redeemed_at],
        )
        .await
    {
        Ok(_) => {}
        Err(e) if is_unique_violation(&e) => {
            return Err(WheelError::bad(ERR_ALREADY_REDEEMED_USER));
        }
        Err(e) => return Err(WheelError::transport(e)),
    }

    if let Some(bid) = promo
        .loot_box_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        client
            .execute(UPSERT_UNOPENED_SQL, &[&uid_pg, &bid])
            .await
            .map_err(WheelError::transport)?;
    } else if let Some(iid) = promo
        .upgrade_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        credit_stock(client, user_id, iid, 1, None, None)
            .await
            .map_err(WheelError::transport)?;
    } else if let Some(aid) = promo
        .admin_upgrade_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        materialize_upgrade_package_as_loot_box_in_tx(client, user_id, aid)
            .await
            .map_err(upgrades_to_wheel)?;
    }

    if promo.promo_type == TYPE_GLOBAL_ONCE {
        client
            .execute(DEACTIVATE_PROMO_SQL, &[&normalized_code])
            .await
            .map_err(WheelError::transport)?;
    }

    let boxes_res = client
        .query(SELECT_BOXES_SQL, &[&uid_pg])
        .await
        .map_err(WheelError::transport)?;
    let mut unopened_boxes = BTreeMap::new();
    for r in &boxes_res {
        let box_id: String = r.get("box_id");
        let qty: i32 = r.get("qty");
        unopened_boxes.insert(box_id, qty);
    }

    let stock_res = client
        .query(SELECT_STOCK_SQL, &[&uid_pg])
        .await
        .map_err(WheelError::transport)?;
    let mut stock = BTreeMap::new();
    for r in &stock_res {
        let item_id: String = r.get("item_id");
        let qty: i32 = r.get("qty");
        stock.insert(item_id, qty);
    }

    Ok(PromoRedeemOutcome::Standard {
        unopened_boxes,
        stock,
        loot_box_id: promo.loot_box_id,
        upgrade_id: promo.upgrade_id,
        admin_upgrade_id: promo.admin_upgrade_id,
    })
}

pub async fn redeem_code(
    pool: &Pool,
    user_id: i64,
    code: &str,
    server_now_ms: Option<i64>,
) -> Result<PromoRedeemOutcome, WheelError> {
    if user_id <= 0 {
        return Err(WheelError::unauthorized(ERR_INVALID_SESSION));
    }
    let Some(normalized) = normalize_promo_code(code) else {
        return Err(WheelError::bad(ERR_INVALID_CODE));
    };
    let now_ms = server_now_ms
        .filter(|n| *n > 0)
        .unwrap_or_else(current_unix_ms);

    let mut conn = pool.get().await?;
    let tx = conn.transaction().await.map_err(WheelError::transport)?;
    set_promo_tx_timeouts(&tx).await?;
    assert_active_user(&tx, user_id)
        .await
        .map_err(market_to_wheel)?;
    match run_promo_code_redeem_in_transaction(&tx, user_id, &normalized, now_ms).await {
        Ok(v) => {
            tx.commit().await.map_err(WheelError::transport)?;
            Ok(v)
        }
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_consts_match_node() {
        assert_eq!(TX_TIMEOUT_MS, 60_000);
        assert_eq!(TX_MAX_WAIT_MS, 10_000);
        assert_eq!(LOCK_TIMEOUT_MS, 45_000);
    }

    #[test]
    fn wheel_json_roleta() {
        let out = PromoRedeemOutcome::RoletaNew {
            code: "ABC".into(),
            server_now_ms: 1,
        };
        let v = out.to_wheel_json();
        assert_eq!(v["ok"], true);
        assert_eq!(v["type"], "roleta");
        assert_eq!(v["code"], "ABC");
    }
}
