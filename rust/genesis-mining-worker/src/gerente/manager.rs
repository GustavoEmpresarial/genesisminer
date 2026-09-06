//! Ciclo de vida do contrato Gerente — espelho de `manager.ts`.

use deadpool_postgres::{Client, Pool, Transaction};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::{json, Value};

use genesis_core::gerente::{
    ACCOUNT_MANAGER_FIRE_LOCK_DAYS, ACCOUNT_MANAGER_PERCENT_MULTIPLIER, ACCOUNT_MANAGER_SHARE,
    ACCOUNT_MANAGER_STATUS_ACTIVE, ACCOUNT_MANAGER_STATUS_APPLIED, ACCOUNT_MANAGER_STATUS_ENDED,
    ACCOUNT_MANAGER_STATUS_PENDING,
};
use genesis_core::time::MS_PER_DAY;
use genesis_core::utc_week::utc_week_start_ms;

use crate::config::WorkerConfig;
use crate::gerente::auth_session::{
    auth_session_load, auth_session_restore_from_original, auth_session_update_flags,
    SESSION_MANAGER_MODE_OFF, SESSION_MANAGER_MODE_ON,
};
use crate::player_reads::{f64_cell, i32_cell, i64_cell, now_ms, string_cell, PlayerReadError};
use crate::support::LOCK_TIMEOUT_MS;
use crate::users::{run_assert_active_user, AssertActiveRequest};

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_SERVICE_UNAVAILABLE: u16 = 503;

const _: () = assert!(LOCK_TIMEOUT_MS == 45_000);
const _: () = assert!(ACCOUNT_MANAGER_FIRE_LOCK_DAYS == 7);
const _: () = assert!(MS_PER_DAY == 86_400_000);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteMeRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub manager_user_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteActorRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteTargetRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteContractIdRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub contract_id: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteResignRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub manager_user_id: Option<i64>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub contract_id: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GerenteEnterRequest {
    pub user_id: i64,
    #[serde(default)]
    pub manager_mode: bool,
    #[serde(default)]
    pub manager_user_id: Option<i64>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub owner_user_id: Option<serde_json::Value>,
}

fn am_err(status: u16, code: &str, msg: impl Into<String>) -> PlayerReadError {
    PlayerReadError::controlled(status, msg, code)
}

fn require_feature(cfg: &WorkerConfig) -> Result<(), PlayerReadError> {
    if cfg.account_manager_enabled {
        Ok(())
    } else {
        Err(am_err(
            HTTP_SERVICE_UNAVAILABLE,
            "ACCOUNT_MANAGER_DISABLED",
            "Account management is disabled in this environment.",
        ))
    }
}

fn reject_manager_mode_msg(manager_mode: bool, msg: &str) -> Result<(), PlayerReadError> {
    if manager_mode {
        Err(am_err(HTTP_FORBIDDEN, "MANAGER_FORBIDDEN", msg))
    } else {
        Ok(())
    }
}

fn pg_uid(id: i64) -> Result<i32, PlayerReadError> {
    i32::try_from(id).map_err(|_| am_err(HTTP_BAD_REQUEST, "BAD_USER", "Invalid userId."))
}

fn parse_positive_id(raw: Option<&Value>, code: &str, msg: &str) -> Result<i32, PlayerReadError> {
    let Some(v) = raw else {
        return Err(am_err(HTTP_BAD_REQUEST, code, msg));
    };
    let n = v
        .as_i64()
        .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
        .or_else(|| {
            v.as_f64().and_then(|f| {
                if f.is_finite() && f.fract() == 0.0 {
                    Some(f as i64)
                } else {
                    None
                }
            })
        });
    match n {
        Some(id) if id > 0 => i32::try_from(id).map_err(|_| am_err(HTTP_BAD_REQUEST, code, msg)),
        _ => Err(am_err(HTTP_BAD_REQUEST, code, msg)),
    }
}

fn optional_positive_id(raw: Option<&Value>) -> Result<Option<i32>, PlayerReadError> {
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(v) => Ok(Some(parse_positive_id(
            Some(v),
            "BAD_CONTRACT",
            "Invalid contractId.",
        )?)),
    }
}

fn resolve_target(body: &GerenteTargetRequest) -> String {
    body.email
        .as_deref()
        .or(body.username.as_deref())
        .or(body.target.as_deref())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn map_contract(row: &tokio_postgres::Row, now: i64) -> Value {
    let status = string_cell(row, "status");
    let fire_locked_until = opt_i64(row, "fire_locked_until");
    let can_fire = status == ACCOUNT_MANAGER_STATUS_ACTIVE
        && fire_locked_until.map(|u| now >= u).unwrap_or(true);
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(i32_cell(row, "id")));
    m.insert("ownerUserId".into(), json!(i32_cell(row, "owner_user_id")));
    m.insert(
        "managerUserId".into(),
        json!(i32_cell(row, "manager_user_id")),
    );
    m.insert("status".into(), json!(status));
    m.insert("hiredAt".into(), json!(opt_i64(row, "hired_at")));
    m.insert("endsAt".into(), json!(opt_i64(row, "ends_at")));
    m.insert("fireLockedUntil".into(), json!(fire_locked_until));
    m.insert("canFire".into(), json!(can_fire));
    m.insert("createdAt".into(), json!(i64_cell(row, "created_at")));
    m.insert("updatedAt".into(), json!(i64_cell(row, "updated_at")));
    if let Ok(u) = row.try_get::<_, String>("owner_username") {
        m.insert("ownerUsername".into(), json!(u));
    }
    if let Ok(u) = row.try_get::<_, String>("owner_email") {
        m.insert("ownerEmail".into(), json!(u));
    }
    if let Ok(u) = row.try_get::<_, String>("manager_username") {
        m.insert("managerUsername".into(), json!(u));
    }
    if let Ok(u) = row.try_get::<_, String>("manager_email") {
        m.insert("managerEmail".into(), json!(u));
    }
    Value::Object(m)
}

fn opt_i64(row: &tokio_postgres::Row, col: &str) -> Option<i64> {
    if let Ok(v) = row.try_get::<_, Option<i64>>(col) {
        return v;
    }
    if let Ok(v) = row.try_get::<_, Option<i32>>(col) {
        return v.map(i64::from);
    }
    None
}

async fn set_lock_timeout(tx: &Transaction<'_>) -> Result<(), PlayerReadError> {
    tx.batch_execute(&format!("SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"))
        .await
        .map_err(PlayerReadError::from)
}

struct UserRow {
    id: i32,
    username: String,
    email: String,
}

async fn end_open_competing_for_owner(
    tx: &Transaction<'_>,
    owner_user_id: i32,
    keep_contract_id: i32,
    t: i64,
) -> Result<(), PlayerReadError> {
    tx.execute(
        r#"UPDATE account_manager_contracts
              SET status = $1, ends_at = $2, updated_at = $2
            WHERE owner_user_id = $3
              AND id <> $4
              AND status IN ($5, $6)"#,
        &[
            &ACCOUNT_MANAGER_STATUS_ENDED,
            &t,
            &owner_user_id,
            &keep_contract_id,
            &ACCOUNT_MANAGER_STATUS_PENDING,
            &ACCOUNT_MANAGER_STATUS_APPLIED,
        ],
    )
    .await?;
    Ok(())
}

async fn assert_actor_active(pool: &Pool, user_id: i64) -> Result<(), PlayerReadError> {
    match run_assert_active_user(pool, AssertActiveRequest { user_id }).await {
        Ok(r) if r.ok => Ok(()),
        Ok(r) => Err(am_err(
            match r.code.as_deref() {
                Some("NOT_FOUND") => HTTP_NOT_FOUND,
                Some("FORBIDDEN") => HTTP_FORBIDDEN,
                _ => HTTP_FORBIDDEN,
            },
            r.code.as_deref().unwrap_or("FORBIDDEN"),
            r.error.unwrap_or_else(|| "Account check failed.".into()),
        )),
        Err(e) => Err(am_err(e.http_status, e.code, e.message)),
    }
}

pub async fn run_me(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: GerenteMeRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    // Node: requireActiveUser(session/JWT uid), depois effective = manager se manager_mode.
    assert_actor_active(pool, body.user_id).await?;
    let effective = if body.manager_mode {
        body.manager_user_id
            .filter(|i| *i > 0)
            .unwrap_or(body.user_id)
    } else {
        body.user_id
    };
    let uid = pg_uid(effective)?;
    let client = pool.get().await?;

    let as_owner = client
        .query(
            r#"SELECT c.*, m.username AS manager_username, m.email AS manager_email
                 FROM account_manager_contracts c
                 JOIN users m ON m.id = c.manager_user_id
                WHERE c.owner_user_id = $1
                  AND c.status IN ($2, $3, $4)
                ORDER BY c.created_at DESC"#,
            &[
                &uid,
                &ACCOUNT_MANAGER_STATUS_PENDING,
                &ACCOUNT_MANAGER_STATUS_APPLIED,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
            ],
        )
        .await?;
    let as_manager = client
        .query(
            r#"SELECT c.*, o.username AS owner_username, o.email AS owner_email
                 FROM account_manager_contracts c
                 JOIN users o ON o.id = c.owner_user_id
                WHERE c.manager_user_id = $1
                  AND c.status IN ($2, $3, $4)
                ORDER BY c.created_at DESC"#,
            &[
                &uid,
                &ACCOUNT_MANAGER_STATUS_PENDING,
                &ACCOUNT_MANAGER_STATUS_APPLIED,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
            ],
        )
        .await?;

    let now = now_ms();
    let week_start = utc_week_start_ms(now);
    let mut active_ids: Vec<i32> = Vec::new();
    for r in as_owner.iter().chain(as_manager.iter()) {
        if string_cell(r, "status") == ACCOUNT_MANAGER_STATUS_ACTIVE {
            active_ids.push(i32_cell(r, "id"));
        }
    }

    let mut accruals = Vec::new();
    if !active_ids.is_empty() {
        let acc = client
            .query(
                r#"SELECT contract_id, coin_id, week_start, owner_mined_amount, manager_share_amount, paid_at
                     FROM account_manager_mining_accrual
                    WHERE contract_id = ANY($1::int[])
                      AND week_start = $2"#,
                &[&active_ids, &week_start],
            )
            .await?;
        for r in acc {
            accruals.push(json!({
                "contractId": i32_cell(&r, "contract_id"),
                "coinId": string_cell(&r, "coin_id"),
                "weekStart": i64_cell(&r, "week_start"),
                "ownerMinedAmount": f64_cell(&r, "owner_mined_amount"),
                "managerShareAmount": f64_cell(&r, "manager_share_amount"),
                "paidAt": opt_i64(&r, "paid_at"),
            }));
        }
    }

    let manager_earnings = load_manager_earnings_summary(&client, uid).await?;
    let active_managed_count = as_manager
        .iter()
        .filter(|r| string_cell(r, "status") == ACCOUNT_MANAGER_STATUS_ACTIVE)
        .count();

    Ok(json!({
        "sharePercent": ACCOUNT_MANAGER_SHARE * ACCOUNT_MANAGER_PERCENT_MULTIPLIER,
        "fireLockDays": ACCOUNT_MANAGER_FIRE_LOCK_DAYS,
        "activeManagedCount": active_managed_count,
        "weekStart": week_start,
        "asOwner": as_owner.iter().map(|r| map_contract(r, now)).collect::<Vec<_>>(),
        "asManager": as_manager.iter().map(|r| map_contract(r, now)).collect::<Vec<_>>(),
        "weekAccruals": accruals,
        "managerEarnings": manager_earnings,
    }))
}

async fn load_manager_earnings_summary(
    client: &Client,
    manager_user_id: i32,
) -> Result<Value, PlayerReadError> {
    let counts = client
        .query_one(
            r#"SELECT
                 COUNT(*) FILTER (WHERE status = $2)::text AS active,
                 COUNT(*) FILTER (WHERE status = $3)::text AS ended,
                 COUNT(*) FILTER (WHERE status IN ($2, $3))::text AS total
               FROM account_manager_contracts
               WHERE manager_user_id = $1"#,
            &[
                &manager_user_id,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
                &ACCOUNT_MANAGER_STATUS_ENDED,
            ],
        )
        .await?;

    let by_coin_rows = client
        .query(
            r#"SELECT
                 a.coin_id,
                 COALESCE(NULLIF(BTRIM(mc.symbol), ''), NULLIF(BTRIM(mc.name), ''), a.coin_id) AS symbol,
                 COALESCE(NULLIF(BTRIM(mc.name), ''), a.coin_id) AS name,
                 COALESCE(SUM(a.manager_share_amount), 0)::float8 AS total_share,
                 COALESCE(SUM(a.manager_share_amount) FILTER (WHERE a.paid_at IS NOT NULL), 0)::float8 AS paid_share,
                 COALESCE(SUM(a.manager_share_amount) FILTER (WHERE a.paid_at IS NULL), 0)::float8 AS pending_share
               FROM account_manager_mining_accrual a
               INNER JOIN account_manager_contracts c ON c.id = a.contract_id
               LEFT JOIN mining_coins mc ON mc.id = a.coin_id
               WHERE c.manager_user_id = $1
                 AND c.status IN ($2, $3)
               GROUP BY a.coin_id, mc.symbol, mc.name
               HAVING COALESCE(SUM(a.manager_share_amount), 0) > 0
               ORDER BY total_share DESC"#,
            &[
                &manager_user_id,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
                &ACCOUNT_MANAGER_STATUS_ENDED,
            ],
        )
        .await?;

    let by_coin: Vec<Value> = by_coin_rows
        .iter()
        .map(|r| {
            let coin_id = string_cell(r, "coin_id");
            json!({
                "coinId": coin_id.clone(),
                "symbol": string_cell(r, "symbol").if_empty(&coin_id),
                "name": string_cell(r, "name").if_empty(&coin_id),
                "totalShare": f64_cell(r, "total_share"),
                "paidShare": f64_cell(r, "paid_share"),
                "pendingShare": f64_cell(r, "pending_share"),
            })
        })
        .collect();

    let parse_count = |col: &str| -> i64 {
        counts
            .try_get::<_, String>(col)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };

    Ok(json!({
        "activeContracts": parse_count("active"),
        "endedContracts": parse_count("ended"),
        "managedContracts": parse_count("total"),
        "byCoin": by_coin,
    }))
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}
impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

pub async fn run_hire(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: GerenteTargetRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    reject_manager_mode_msg(body.manager_mode, "You cannot hire while in manager mode.")?;
    assert_actor_active(pool, body.user_id).await?;
    let target = resolve_target(&body);
    if target.is_empty() {
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "TARGET_REQUIRED",
            "Provide email or username.",
        ));
    }
    let owner_id = pg_uid(body.user_id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_lock_timeout(&tx).await?;

    let manager = find_user_by_email_or_username_tx(&tx, &target).await?;
    let Some(manager) = manager else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_NOT_FOUND,
            "USER_NOT_FOUND",
            "Jogador não encontrado.",
        ));
    };
    if manager.id == owner_id {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "SELF_HIRE",
            "Não podes contratar-te a ti próprio.",
        ));
    }

    let existing = tx
        .query_opt(
            r#"SELECT id, status FROM account_manager_contracts
                WHERE owner_user_id = $1 AND status IN ($2, $3)
                LIMIT 1 FOR UPDATE"#,
            &[
                &owner_id,
                &ACCOUNT_MANAGER_STATUS_PENDING,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
            ],
        )
        .await?;
    if let Some(ex) = existing {
        let status: String = ex.get("status");
        tx.rollback().await.ok();
        let msg = if status == ACCOUNT_MANAGER_STATUS_PENDING {
            "Já tens um pedido de gerência pendente."
        } else {
            "Já tens um gerente ativo. Demite-o antes de contratar outro."
        };
        return Err(am_err(HTTP_BAD_REQUEST, "ALREADY_HAS_MANAGER", msg));
    }

    let t = now_ms();
    tx.execute(
        r#"UPDATE account_manager_contracts
              SET status = $1, ends_at = $2, updated_at = $2
            WHERE owner_user_id = $3 AND status = $4"#,
        &[
            &ACCOUNT_MANAGER_STATUS_ENDED,
            &t,
            &owner_id,
            &ACCOUNT_MANAGER_STATUS_APPLIED,
        ],
    )
    .await?;

    let ins = tx
        .query_one(
            r#"INSERT INTO account_manager_contracts
                 (owner_user_id, manager_user_id, status, hired_at, ends_at, fire_locked_until, created_at, updated_at)
               VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $4)
               RETURNING *"#,
            &[&owner_id, &manager.id, &ACCOUNT_MANAGER_STATUS_PENDING, &t],
        )
        .await?;
    tx.commit().await?;

    let mut mapped = map_contract(&ins, t);
    if let Some(obj) = mapped.as_object_mut() {
        obj.insert("managerUsername".into(), json!(manager.username));
        obj.insert("managerEmail".into(), json!(manager.email));
    }
    Ok(json!({ "contract": mapped }))
}

async fn find_user_by_email_or_username_tx(
    tx: &Transaction<'_>,
    raw: &str,
) -> Result<Option<UserRow>, PlayerReadError> {
    let q = raw.trim();
    if q.is_empty() {
        return Ok(None);
    }
    let by_email = tx
        .query_opt(
            "SELECT id, username, email FROM users WHERE lower(email) = lower($1) LIMIT 1",
            &[&q],
        )
        .await?;
    if let Some(r) = by_email {
        return Ok(Some(UserRow {
            id: r.get("id"),
            username: r.get("username"),
            email: r.get("email"),
        }));
    }
    let by_user = tx
        .query_opt(
            "SELECT id, username, email FROM users WHERE lower(username) = lower($1) LIMIT 1",
            &[&q],
        )
        .await?;
    Ok(by_user.map(|r| UserRow {
        id: r.get("id"),
        username: r.get("username"),
        email: r.get("email"),
    }))
}

pub async fn run_apply(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: GerenteTargetRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    reject_manager_mode_msg(body.manager_mode, "You cannot apply while in manager mode.")?;
    assert_actor_active(pool, body.user_id).await?;
    let target = resolve_target(&body);
    if target.is_empty() {
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "TARGET_REQUIRED",
            "Provide the owner email or username.",
        ));
    }
    let manager_id = pg_uid(body.user_id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_lock_timeout(&tx).await?;

    let owner = find_user_by_email_or_username_tx(&tx, &target).await?;
    let Some(owner) = owner else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_NOT_FOUND,
            "USER_NOT_FOUND",
            "Jogador não encontrado.",
        ));
    };
    if owner.id == manager_id {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "SELF_APPLY",
            "Não podes candidatar-te à tua própria conta.",
        ));
    }

    let owner_busy = tx
        .query_opt(
            r#"SELECT id, status FROM account_manager_contracts
                WHERE owner_user_id = $1 AND status IN ($2, $3)
                LIMIT 1 FOR UPDATE"#,
            &[
                &owner.id,
                &ACCOUNT_MANAGER_STATUS_PENDING,
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
            ],
        )
        .await?;
    if let Some(busy) = owner_busy {
        let status: String = busy.get("status");
        tx.rollback().await.ok();
        let msg = if status == ACCOUNT_MANAGER_STATUS_ACTIVE {
            "Esta conta já tem gerente ativo."
        } else {
            "Esta conta já tem um convite de gerência pendente."
        };
        return Err(am_err(HTTP_BAD_REQUEST, "OWNER_BUSY", msg));
    }

    let dup = tx
        .query_opt(
            r#"SELECT id FROM account_manager_contracts
                WHERE owner_user_id = $1 AND manager_user_id = $2 AND status = $3
                LIMIT 1"#,
            &[&owner.id, &manager_id, &ACCOUNT_MANAGER_STATUS_APPLIED],
        )
        .await?;
    if dup.is_some() {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "ALREADY_APPLIED",
            "Já enviaste candidatura a esta conta. Aguarda aprovação ou rejeição.",
        ));
    }

    let t = now_ms();
    let ins = tx
        .query_one(
            r#"INSERT INTO account_manager_contracts
                 (owner_user_id, manager_user_id, status, hired_at, ends_at, fire_locked_until, created_at, updated_at)
               VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $4)
               RETURNING *"#,
            &[&owner.id, &manager_id, &ACCOUNT_MANAGER_STATUS_APPLIED, &t],
        )
        .await?;
    tx.commit().await?;

    let mut mapped = map_contract(&ins, t);
    if let Some(obj) = mapped.as_object_mut() {
        obj.insert("ownerUsername".into(), json!(owner.username));
        obj.insert("ownerEmail".into(), json!(owner.email));
    }
    Ok(json!({ "contract": mapped }))
}

pub async fn run_accept(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: GerenteContractIdRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    reject_manager_mode_msg(
        body.manager_mode,
        "You cannot accept while in manager mode.",
    )?;
    assert_actor_active(pool, body.user_id).await?;
    let contract_id = parse_positive_id(
        body.contract_id.as_ref(),
        "BAD_CONTRACT",
        "Invalid contractId.",
    )?;
    let actor = pg_uid(body.user_id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_lock_timeout(&tx).await?;

    let row = tx
        .query_opt(
            "SELECT * FROM account_manager_contracts WHERE id = $1 FOR UPDATE",
            &[&contract_id],
        )
        .await?;
    let Some(row) = row else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_NOT_FOUND,
            "NOT_FOUND",
            "Contrato não encontrado.",
        ));
    };
    let status: String = row.get("status");
    let owner_user_id: i32 = row.get("owner_user_id");
    let manager_user_id: i32 = row.get("manager_user_id");

    if status == ACCOUNT_MANAGER_STATUS_PENDING {
        if manager_user_id != actor {
            tx.rollback().await.ok();
            return Err(am_err(
                HTTP_FORBIDDEN,
                "FORBIDDEN",
                "Só o gerente convidado pode aceitar este pedido.",
            ));
        }
    } else if status == ACCOUNT_MANAGER_STATUS_APPLIED {
        if owner_user_id != actor {
            tx.rollback().await.ok();
            return Err(am_err(
                HTTP_FORBIDDEN,
                "FORBIDDEN",
                "Só o dono da conta pode aprovar esta candidatura.",
            ));
        }
    } else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "INVALID_STATUS",
            "Este pedido já não está pendente.",
        ));
    }

    let owner_busy = tx
        .query_opt(
            r#"SELECT id FROM account_manager_contracts
                WHERE owner_user_id = $1 AND status = $2 AND id <> $3
                LIMIT 1"#,
            &[&owner_user_id, &ACCOUNT_MANAGER_STATUS_ACTIVE, &contract_id],
        )
        .await?;
    if owner_busy.is_some() {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "OWNER_HAS_MANAGER",
            "O dono já tem outro gerente ativo.",
        ));
    }

    let t = now_ms();
    end_open_competing_for_owner(&tx, owner_user_id, contract_id, t).await?;
    let lock_until = t + ACCOUNT_MANAGER_FIRE_LOCK_DAYS * MS_PER_DAY as i64;
    let upd = tx
        .query_one(
            r#"UPDATE account_manager_contracts
                  SET status = $1, hired_at = $2, fire_locked_until = $3, updated_at = $2
                WHERE id = $4
                RETURNING *"#,
            &[
                &ACCOUNT_MANAGER_STATUS_ACTIVE,
                &t,
                &lock_until,
                &contract_id,
            ],
        )
        .await?;
    tx.commit().await?;
    Ok(json!({ "contract": map_contract(&upd, t) }))
}

pub async fn run_decline(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: GerenteContractIdRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    reject_manager_mode_msg(
        body.manager_mode,
        "You cannot decline while in manager mode.",
    )?;
    assert_actor_active(pool, body.user_id).await?;
    let contract_id = parse_positive_id(
        body.contract_id.as_ref(),
        "BAD_CONTRACT",
        "Invalid contractId.",
    )?;
    let actor = pg_uid(body.user_id)?;
    let client = pool.get().await?;

    let row = client
        .query_opt(
            "SELECT * FROM account_manager_contracts WHERE id = $1",
            &[&contract_id],
        )
        .await?;
    let Some(row) = row else {
        return Err(am_err(
            HTTP_NOT_FOUND,
            "NOT_FOUND",
            "Contrato não encontrado.",
        ));
    };
    let status: String = row.get("status");
    let owner_user_id: i32 = row.get("owner_user_id");
    let manager_user_id: i32 = row.get("manager_user_id");

    if status == ACCOUNT_MANAGER_STATUS_PENDING {
        if manager_user_id != actor {
            return Err(am_err(
                HTTP_FORBIDDEN,
                "FORBIDDEN",
                "Só o gerente convidado pode recusar este pedido.",
            ));
        }
    } else if status == ACCOUNT_MANAGER_STATUS_APPLIED {
        if owner_user_id != actor {
            return Err(am_err(
                HTTP_FORBIDDEN,
                "FORBIDDEN",
                "Só o dono da conta pode rejeitar esta candidatura.",
            ));
        }
    } else {
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "INVALID_STATUS",
            "Este pedido já não está pendente.",
        ));
    }

    let t = now_ms();
    client
        .execute(
            r#"UPDATE account_manager_contracts
                  SET status = $1, ends_at = $2, updated_at = $2
                WHERE id = $3"#,
            &[&ACCOUNT_MANAGER_STATUS_ENDED, &t, &contract_id],
        )
        .await?;
    Ok(json!({}))
}

pub async fn run_fire(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &HttpClient,
    body: GerenteActorRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    reject_manager_mode_msg(body.manager_mode, "You cannot fire while in manager mode.")?;
    assert_actor_active(pool, body.user_id).await?;
    let owner_id = pg_uid(body.user_id)?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_lock_timeout(&tx).await?;

    let row = tx
        .query_opt(
            r#"SELECT * FROM account_manager_contracts
                WHERE owner_user_id = $1 AND status = $2
                LIMIT 1 FOR UPDATE"#,
            &[&owner_id, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await?;
    let Some(row) = row else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_NOT_FOUND,
            "NOT_FOUND",
            "Não tens gerente ativo.",
        ));
    };
    let lock_until = opt_i64(&row, "fire_locked_until").unwrap_or(0);
    let t = now_ms();
    if lock_until > t {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_FORBIDDEN,
            "FIRE_LOCKED",
            fire_locked_message(lock_until),
        ));
    }
    let contract_id: i32 = row.get("id");
    tx.execute(
        r#"UPDATE account_manager_contracts
              SET status = $1, ends_at = $2, updated_at = $2
            WHERE id = $3"#,
        &[&ACCOUNT_MANAGER_STATUS_ENDED, &t, &contract_id],
    )
    .await?;

    auth_session_restore_from_original(http, cfg, i64::from(owner_id), None).await?;
    tx.commit().await?;
    Ok(json!({}))
}

fn fire_locked_message(lock_until_ms: i64) -> String {
    // Node: `Não podes demitir… Liberado em ${new Date(lockUntil).toISOString()}.`
    // Sem crate de calendário no worker — espelha o instante em ms (mesmo eixo que a UI/API já usam).
    format!("Não podes demitir durante a primeira semana. Liberado em {lock_until_ms}.")
}

pub async fn run_resign(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &HttpClient,
    body: GerenteResignRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    let actor = if body.manager_mode {
        body.manager_user_id
            .filter(|i| *i > 0)
            .unwrap_or(body.user_id)
    } else {
        body.user_id
    };
    assert_actor_active(pool, actor).await?;
    let manager_id = pg_uid(actor)?;
    let contract_id_opt = optional_positive_id(body.contract_id.as_ref())?;

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    set_lock_timeout(&tx).await?;

    let row = if let Some(cid) = contract_id_opt {
        tx.query_opt(
            "SELECT * FROM account_manager_contracts WHERE id = $1 FOR UPDATE",
            &[&cid],
        )
        .await?
    } else {
        tx.query_opt(
            r#"SELECT * FROM account_manager_contracts
                WHERE manager_user_id = $1 AND status = $2
                ORDER BY hired_at DESC NULLS LAST
                LIMIT 1 FOR UPDATE"#,
            &[&manager_id, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await?
    };
    let Some(row) = row else {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_NOT_FOUND,
            "NOT_FOUND",
            "Contrato ativo não encontrado.",
        ));
    };
    let row_manager: i32 = row.get("manager_user_id");
    if row_manager != manager_id {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_FORBIDDEN,
            "FORBIDDEN",
            "Este contrato não é teu.",
        ));
    }
    let status: String = row.get("status");
    if status != ACCOUNT_MANAGER_STATUS_ACTIVE
        && status != ACCOUNT_MANAGER_STATUS_PENDING
        && status != ACCOUNT_MANAGER_STATUS_APPLIED
    {
        tx.rollback().await.ok();
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "INVALID_STATUS",
            "Contrato já terminado.",
        ));
    }
    let t = now_ms();
    let contract_id: i32 = row.get("id");
    let owner_user_id: i32 = row.get("owner_user_id");
    tx.execute(
        r#"UPDATE account_manager_contracts
              SET status = $1, ends_at = $2, updated_at = $2
            WHERE id = $3"#,
        &[&ACCOUNT_MANAGER_STATUS_ENDED, &t, &contract_id],
    )
    .await?;

    auth_session_restore_from_original(
        http,
        cfg,
        i64::from(owner_user_id),
        Some(i64::from(manager_id)),
    )
    .await?;
    tx.commit().await?;

    // Se estava em manager mode nesta sessão, sair (best-effort — Node warn-only).
    let mut out = json!({});
    if body.manager_mode {
        if let Some(sid) = body.session_id.as_deref().filter(|s| !s.is_empty()) {
            match leave_managed_account(http, cfg, sid).await {
                Ok(left) => {
                    out = json!({ "leftManagerUserId": left });
                }
                Err(e) => {
                    tracing::warn!(
                        user_id = actor,
                        err = %e.error,
                        "account_manager_resign_leave_session_failed"
                    );
                }
            }
        }
    }
    Ok(out)
}

pub async fn run_enter(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &HttpClient,
    body: GerenteEnterRequest,
) -> Result<Value, PlayerReadError> {
    require_feature(cfg)?;
    let actor = if body.manager_mode {
        body.manager_user_id
            .filter(|i| *i > 0)
            .unwrap_or(body.user_id)
    } else {
        body.user_id
    };
    assert_actor_active(pool, actor).await?;
    let sid = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            am_err(
                HTTP_BAD_REQUEST,
                "SESSION_REQUIRED",
                "Session (sid cookie) required to enter the account.",
            )
        })?;
    let owner_user_id = parse_positive_id(
        body.owner_user_id.as_ref(),
        "BAD_OWNER",
        "Invalid ownerUserId.",
    )?;
    let manager_id = pg_uid(actor)?;

    let client = pool.get().await?;
    let c = client
        .query_opt(
            r#"SELECT id FROM account_manager_contracts
                WHERE owner_user_id = $1 AND manager_user_id = $2 AND status = $3
                LIMIT 1"#,
            &[&owner_user_id, &manager_id, &ACCOUNT_MANAGER_STATUS_ACTIVE],
        )
        .await?;
    if c.is_none() {
        return Err(am_err(
            HTTP_FORBIDDEN,
            "NO_CONTRACT",
            "Não tens contrato ativo com esta conta.",
        ));
    }

    let loaded = match auth_session_load(http, cfg, sid).await {
        Ok(s) => s,
        Err(e) if e.http_status == 401 => {
            return Err(am_err(HTTP_BAD_REQUEST, "NO_SESSION", "Session required."));
        }
        Err(e) => return Err(e),
    };
    let already_managing = loaded.manager_mode == SESSION_MANAGER_MODE_ON
        && loaded.original_user_id == Some(i64::from(manager_id));
    if !already_managing && loaded.user_id != i64::from(manager_id) {
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "WRONG_SESSION",
            "Entra na tua conta de gerente antes de gerir outra.",
        ));
    }

    auth_session_update_flags(
        http,
        cfg,
        json!({
            "sessionId": sid,
            "userId": owner_user_id,
            "originalUserId": manager_id,
            "managerMode": SESSION_MANAGER_MODE_ON,
            "actingAsOwnerId": owner_user_id,
        }),
    )
    .await?;

    Ok(json!({ "ownerUserId": owner_user_id, "reissueUserId": owner_user_id }))
}

pub async fn run_leave(
    pool: &Pool,
    cfg: &WorkerConfig,
    http: &HttpClient,
    body: GerenteEnterRequest,
) -> Result<Value, PlayerReadError> {
    // Leave não checa feature flag (Node escape path).
    assert_actor_active(pool, body.user_id).await?;
    let sid = body
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| am_err(HTTP_BAD_REQUEST, "SESSION_REQUIRED", "Session required."))?;
    let manager_user_id = leave_managed_account(http, cfg, sid).await?;
    Ok(json!({
        "managerUserId": manager_user_id,
        "reissueUserId": manager_user_id,
    }))
}

async fn leave_managed_account(
    http: &HttpClient,
    cfg: &WorkerConfig,
    session_id: &str,
) -> Result<i64, PlayerReadError> {
    let loaded = match auth_session_load(http, cfg, session_id).await {
        Ok(s) => s,
        Err(e) if e.http_status == 401 => {
            return Err(am_err(
                HTTP_BAD_REQUEST,
                "NOT_MANAGING",
                "Não estás a gerir nenhuma conta.",
            ));
        }
        Err(e) => return Err(e),
    };
    if loaded.manager_mode != SESSION_MANAGER_MODE_ON || loaded.original_user_id.is_none() {
        return Err(am_err(
            HTTP_BAD_REQUEST,
            "NOT_MANAGING",
            "Não estás a gerir nenhuma conta.",
        ));
    }
    let manager_user_id = loaded.original_user_id.unwrap();
    auth_session_update_flags(
        http,
        cfg,
        json!({
            "sessionId": session_id,
            "userId": manager_user_id,
            "originalUserId": Value::Null,
            "managerMode": SESSION_MANAGER_MODE_OFF,
            "actingAsOwnerId": Value::Null,
        }),
    )
    .await?;
    Ok(manager_user_id)
}
