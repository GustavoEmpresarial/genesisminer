//! Admin referral models — `referral_models` table CRUD.
//!
//! Public twins: `GET/POST /api/admin/referral-models`,
//! `DELETE /api/admin/referral-models/:id`.

use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::player_reads::{f64_cell, i32_cell, opt_string, string_cell, PlayerReadError};

use super::{CODE_VALIDATION, HTTP_BAD_REQUEST};

pub const ADMIN_REFERRAL_MODELS_LIST_PATH: &str = "/v1/admin/users/referral-models/list";
pub const ADMIN_REFERRAL_MODELS_UPSERT_PATH: &str = "/v1/admin/users/referral-models/upsert";
pub const ADMIN_REFERRAL_MODELS_DELETE_PATH: &str = "/v1/admin/users/referral-models/delete";

const LIST_SQL: &str = "SELECT id, name, description,
       sender_reward_usdc, receiver_reward_usdc,
       sender_loot_box_id, receiver_loot_box_id,
       deposit_commission_percent, hardware_commission_percent,
       black_market_commission_percent, is_active
  FROM referral_models
 ORDER BY id ASC";

const INSERT_SQL: &str = "INSERT INTO referral_models
   (name, description, sender_reward_usdc, receiver_reward_usdc,
    sender_loot_box_id, receiver_loot_box_id,
    deposit_commission_percent, hardware_commission_percent,
    black_market_commission_percent, is_active)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 RETURNING id";

const UPDATE_SQL: &str = "UPDATE referral_models SET
   name = $2,
   description = $3,
   sender_reward_usdc = $4,
   receiver_reward_usdc = $5,
   sender_loot_box_id = $6,
   receiver_loot_box_id = $7,
   deposit_commission_percent = COALESCE($8, deposit_commission_percent),
   hardware_commission_percent = COALESCE($9, hardware_commission_percent),
   black_market_commission_percent = COALESCE($10, black_market_commission_percent),
   is_active = $11
 WHERE id = $1";

const DELETE_SQL: &str = "DELETE FROM referral_models WHERE id = $1";

const LOAD_ONE_SQL: &str = "SELECT id, name, description,
       sender_reward_usdc, receiver_reward_usdc,
       sender_loot_box_id, receiver_loot_box_id,
       deposit_commission_percent, hardware_commission_percent,
       black_market_commission_percent, is_active
  FROM referral_models WHERE id = $1";

const ERR_NAME_REQUIRED: &str = "Nome do modelo é obrigatório.";
const ERR_INVALID_ID: &str = "Id inválido.";
const IS_ACTIVE_DEFAULT: i32 = 1;
const ZERO_F64: f64 = 0.0;

const _: () = assert!(IS_ACTIVE_DEFAULT == 1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralModelUpsertRequest {
    #[serde(default)]
    pub model: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralModelDeleteRequest {
    pub id: i64,
}

fn opt_f64_field(body: &Value, key: &str) -> Option<f64> {
    let v = body.get(key)?;
    match v {
        Value::Null => None,
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn f64_field_or(body: &Value, key: &str, fallback: f64) -> f64 {
    opt_f64_field(body, key).unwrap_or(fallback)
}

fn opt_string_field(body: &Value, key: &str) -> Option<String> {
    match body.get(key)? {
        Value::Null => None,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn string_field_or_empty(body: &Value, key: &str) -> String {
    opt_string_field(body, key).unwrap_or_default()
}

/// `is_active` as 0/1 — JS truthy for bool; numbers floored; default 1 when absent.
fn is_active_field(body: &Value) -> i32 {
    match body.get("is_active") {
        None | Some(Value::Null) => IS_ACTIVE_DEFAULT,
        Some(Value::Bool(b)) => i32::from(*b),
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.is_finite() && f != 0.0 {
                1
            } else {
                0
            }
        }
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() || t == "0" || t.eq_ignore_ascii_case("false") {
                0
            } else {
                1
            }
        }
        Some(_) => IS_ACTIVE_DEFAULT,
    }
}

fn parse_positive_id(body: &Value) -> Option<i32> {
    let v = body.get("id")?;
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let floored = n.floor() as i64;
    i32::try_from(floored).ok().filter(|i| *i > 0)
}

fn map_referral_row(r: &tokio_postgres::Row) -> Value {
    let mut obj = Map::new();
    obj.insert("id".into(), json!(i32_cell(r, "id")));
    obj.insert("name".into(), json!(string_cell(r, "name")));
    obj.insert(
        "description".into(),
        json!(opt_string(r, "description").unwrap_or_default()),
    );
    obj.insert(
        "sender_reward_usdc".into(),
        json!(f64_cell(r, "sender_reward_usdc")),
    );
    obj.insert(
        "receiver_reward_usdc".into(),
        json!(f64_cell(r, "receiver_reward_usdc")),
    );
    obj.insert(
        "sender_loot_box_id".into(),
        match opt_string(r, "sender_loot_box_id") {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    obj.insert(
        "receiver_loot_box_id".into(),
        match opt_string(r, "receiver_loot_box_id") {
            Some(s) => Value::String(s),
            None => Value::Null,
        },
    );
    obj.insert(
        "deposit_commission_percent".into(),
        json!(f64_cell(r, "deposit_commission_percent")),
    );
    obj.insert(
        "hardware_commission_percent".into(),
        json!(f64_cell(r, "hardware_commission_percent")),
    );
    obj.insert(
        "black_market_commission_percent".into(),
        json!(f64_cell(r, "black_market_commission_percent")),
    );
    obj.insert("is_active".into(), json!(i32_cell(r, "is_active")));
    Value::Object(obj)
}

pub async fn run_referral_models_list(pool: &Pool) -> Result<Value, PlayerReadError> {
    let conn = pool.get().await?;
    let rows = conn.query(LIST_SQL, &[]).await?;
    let items: Vec<Value> = rows.iter().map(map_referral_row).collect();
    Ok(json!({ "items": items }))
}

pub async fn run_referral_models_upsert(
    pool: &Pool,
    req: &ReferralModelUpsertRequest,
) -> Result<Value, PlayerReadError> {
    let body = &req.model;
    let conn = pool.get().await?;
    if let Some(id) = parse_positive_id(body) {
        let Some(existing) = conn.query_opt(LOAD_ONE_SQL, &[&id]).await? else {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_INVALID_ID,
                CODE_VALIDATION,
            ));
        };
        let name = body
            .get("name")
            .map(|_| string_field_or_empty(body, "name"))
            .unwrap_or_else(|| string_cell(&existing, "name"));
        if name.is_empty() {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_NAME_REQUIRED,
                CODE_VALIDATION,
            ));
        }
        let description = if body.get("description").is_some() {
            opt_string_field(body, "description")
        } else {
            opt_string(&existing, "description")
        };
        let sender_reward = body
            .get("sender_reward_usdc")
            .map(|_| f64_field_or(body, "sender_reward_usdc", ZERO_F64))
            .unwrap_or_else(|| f64_cell(&existing, "sender_reward_usdc"));
        let receiver_reward = body
            .get("receiver_reward_usdc")
            .map(|_| f64_field_or(body, "receiver_reward_usdc", ZERO_F64))
            .unwrap_or_else(|| f64_cell(&existing, "receiver_reward_usdc"));
        let sender_lb = if body.get("sender_loot_box_id").is_some() {
            opt_string_field(body, "sender_loot_box_id")
        } else {
            opt_string(&existing, "sender_loot_box_id")
        };
        let receiver_lb = if body.get("receiver_loot_box_id").is_some() {
            opt_string_field(body, "receiver_loot_box_id")
        } else {
            opt_string(&existing, "receiver_loot_box_id")
        };
        let deposit_pct = if body.get("deposit_commission_percent").is_some() {
            opt_f64_field(body, "deposit_commission_percent")
        } else {
            Some(f64_cell(&existing, "deposit_commission_percent"))
        };
        let hardware_pct = if body.get("hardware_commission_percent").is_some() {
            opt_f64_field(body, "hardware_commission_percent")
        } else {
            Some(f64_cell(&existing, "hardware_commission_percent"))
        };
        let black_pct = if body.get("black_market_commission_percent").is_some() {
            opt_f64_field(body, "black_market_commission_percent")
        } else {
            Some(f64_cell(&existing, "black_market_commission_percent"))
        };
        let is_active = if body.get("is_active").is_some() {
            is_active_field(body)
        } else {
            i32_cell(&existing, "is_active")
        };
        conn.execute(
            UPDATE_SQL,
            &[
                &id,
                &name,
                &description,
                &sender_reward,
                &receiver_reward,
                &sender_lb,
                &receiver_lb,
                &deposit_pct,
                &hardware_pct,
                &black_pct,
                &is_active,
            ],
        )
        .await?;
        Ok(json!({ "id": id }))
    } else {
        let name = string_field_or_empty(body, "name");
        if name.is_empty() {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_NAME_REQUIRED,
                CODE_VALIDATION,
            ));
        }
        let description = opt_string_field(body, "description");
        let sender_reward = f64_field_or(body, "sender_reward_usdc", ZERO_F64);
        let receiver_reward = f64_field_or(body, "receiver_reward_usdc", ZERO_F64);
        let sender_lb = opt_string_field(body, "sender_loot_box_id");
        let receiver_lb = opt_string_field(body, "receiver_loot_box_id");
        let deposit = opt_f64_field(body, "deposit_commission_percent").unwrap_or(ZERO_F64);
        let hardware = opt_f64_field(body, "hardware_commission_percent").unwrap_or(ZERO_F64);
        let black = opt_f64_field(body, "black_market_commission_percent").unwrap_or(ZERO_F64);
        let is_active = is_active_field(body);
        let row = conn
            .query_one(
                INSERT_SQL,
                &[
                    &name,
                    &description,
                    &sender_reward,
                    &receiver_reward,
                    &sender_lb,
                    &receiver_lb,
                    &deposit,
                    &hardware,
                    &black,
                    &is_active,
                ],
            )
            .await?;
        let id: i32 = row.get("id");
        Ok(json!({ "id": id }))
    }
}

pub async fn run_referral_models_delete(
    pool: &Pool,
    req: &ReferralModelDeleteRequest,
) -> Result<Value, PlayerReadError> {
    if req.id <= 0 {
        return Ok(json!({ "deleted": false }));
    }
    let id = match i32::try_from(req.id) {
        Ok(i) if i > 0 => i,
        _ => return Ok(json!({ "deleted": false })),
    };
    let conn = pool.get().await?;
    let n = conn.execute(DELETE_SQL, &[&id]).await?;
    Ok(json!({ "deleted": n > 0 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_stable() {
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
    }

    #[test]
    fn parse_id_and_is_active() {
        assert_eq!(parse_positive_id(&json!({ "id": 7 })), Some(7));
        assert_eq!(parse_positive_id(&json!({ "id": "3" })), Some(3));
        assert_eq!(parse_positive_id(&json!({ "id": 0 })), None);
        assert_eq!(parse_positive_id(&json!({})), None);
        assert_eq!(is_active_field(&json!({})), 1);
        assert_eq!(is_active_field(&json!({ "is_active": 0 })), 0);
        assert_eq!(is_active_field(&json!({ "is_active": true })), 1);
        assert_eq!(is_active_field(&json!({ "is_active": "0" })), 0);
    }

    #[test]
    fn string_and_f64_fields() {
        let body = json!({
            "name": "  Gold  ",
            "sender_reward_usdc": "1.5",
            "sender_loot_box_id": "",
            "deposit_commission_percent": 2
        });
        assert_eq!(string_field_or_empty(&body, "name"), "Gold");
        assert_eq!(f64_field_or(&body, "sender_reward_usdc", 0.0), 1.5);
        assert!(opt_string_field(&body, "sender_loot_box_id").is_none());
        assert_eq!(opt_f64_field(&body, "deposit_commission_percent"), Some(2.0));
    }
}
