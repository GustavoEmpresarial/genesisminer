//! `PUT /api/user` — Node `services/update.ts`.
//!
//! Target is always the `id` in the body, never the session. Admin/block flags
//! in the payload are ignored; only super admins may touch another admin's
//! e-mail or a super admin's password.

use deadpool_postgres::Pool;
use genesis_core::{
    is_reserved_profile_username, strip_invisible_username_chars, validate_login_email,
    validate_optional_polygon_wallet, validate_password_strength_policy, validate_signup_username,
    WalletValidation,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::config::WorkerConfig;
use crate::player_reads::{i32_cell, now_ms, opt_string, string_cell, PlayerReadError};
use crate::profile_writes::auth_client::{auth_hash_password, auth_revoke_refresh};

use super::{
    truthy_flag, CODE_FORBIDDEN, CODE_VALIDATION, HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
};

/// Node `HTTP_UNPROCESSABLE`.
const HTTP_UNPROCESSABLE: u16 = 422;
/// Node wallet-history caps reused for the `admin_changed` row.
const IP_ADDRESS_MAX_CHARS: usize = 80;
const USER_AGENT_MAX_CHARS: usize = 500;
const NETWORK_MAX_CHARS: usize = 32;
const ACTOR_TYPE_MAX_CHARS: usize = 24;
const SOURCE_MAX_CHARS: usize = 80;
/// Node `tryNormalizeWallet` truncation for unparseable input.
const WALLET_RAW_TRUNCATE_CHARS: usize = 200;
/// Postgres unique violation — Node maps Prisma `P2002` to the same 409.
const PG_UNIQUE_VIOLATION: &str = "23505";

const WALLET_HISTORY_NETWORK: &str = "polygon";
const WALLET_HISTORY_ACTION: &str = "admin_changed";
const WALLET_HISTORY_ACTOR: &str = "admin";
const WALLET_HISTORY_SOURCE: &str = "PUT /api/user";

const ERR_USER_ID_REQUIRED: &str = "User id is required.";
const ERR_USER_NOT_FOUND: &str = "User not found.";
const ERR_USERNAME_TAKEN: &str = "This username is already taken.";
const ERR_EMAIL_TAKEN: &str = "This email is already in use.";
const ERR_USERNAME_RESERVED: &str = "This username is reserved or not allowed.";
const ERR_ADMIN_EMAIL_SUPER_ONLY: &str =
    "Only super administrators can change another administrator's email.";
const ERR_SUPER_PASSWORD_SUPER_ONLY: &str =
    "Only super administrators can set a super administrator's password.";
const ERR_LEVELS_UNKNOWN: &str = "One or more access levels do not exist.";
const ERR_DUPLICATE: &str = "This email or username is already in use.";

const CODE_NOT_FOUND: &str = "NOT_FOUND";
const CODE_USERNAME_TAKEN: &str = "USERNAME_TAKEN";
const CODE_EMAIL_TAKEN: &str = "EMAIL_TAKEN";
const CODE_USERNAME_RESERVED: &str = "USERNAME_RESERVED";
const CODE_PASSWORD_WEAK: &str = "PASSWORD_WEAK";
const CODE_DUPLICATE: &str = "DUPLICATE";

const _: () = assert!(HTTP_UNPROCESSABLE == 422);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserUpdateRequest {
    pub actor_user_id: i64,
    #[serde(default)]
    pub actor_is_super_admin: bool,
    /// Node `parseTargetUserId(req.body?.id)` runs in the controller, so
    /// genesis-api sends the parsed id.
    pub target_id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub polygon_wallet: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub access_level_id: Value,
    #[serde(default)]
    pub access_level_ids: Value,
    #[serde(default)]
    pub ip_address: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

/// Node `parseTargetAccessLevels`.
#[derive(Debug)]
struct TargetAccessLevels {
    primary: Option<String>,
    ids: Vec<String>,
}

fn parse_target_access_levels(
    access_level_id: &Value,
    access_level_ids: &Value,
) -> Result<TargetAccessLevels, PlayerReadError> {
    if !matches!(access_level_ids, Value::Null | Value::Array(_)) {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "accessLevelIds must be an array.",
            CODE_VALIDATION,
        ));
    }
    let mut ids: Vec<String> = Vec::new();
    for x in access_level_ids
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let id = js_string(x).trim().to_string();
        if id.is_empty() || ids.contains(&id) {
            continue;
        }
        ids.push(id);
    }
    let mut primary = js_string(access_level_id).trim().to_string();
    if primary.is_empty() {
        primary = ids.first().cloned().unwrap_or_default();
    }
    if !primary.is_empty() && !ids.contains(&primary) {
        ids.insert(0, primary.clone());
    }
    Ok(TargetAccessLevels {
        primary: if primary.is_empty() {
            None
        } else {
            Some(primary)
        },
        ids,
    })
}

/// JS `String(x ?? '')` for the access-level payload, which the panel may send
/// as strings or numbers.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn truncate(raw: Option<&str>, max: usize) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    Some(s.chars().take(max).collect())
}

/// Node `normalizeWalletCompareKey` — checksum form lowercased, or `''`.
fn normalize_wallet_compare_key(raw: Option<&str>) -> String {
    let t = raw.map(str::trim).unwrap_or("");
    if t.is_empty() || t.eq_ignore_ascii_case("0x") || t.eq_ignore_ascii_case("null") {
        return String::new();
    }
    match validate_optional_polygon_wallet(Some(t)) {
        WalletValidation::Address(a) => a.to_lowercase(),
        _ => t
            .chars()
            .take(WALLET_RAW_TRUNCATE_CHARS)
            .collect::<String>()
            .to_lowercase(),
    }
}

/// Node `mapPrismaClientError` for `P2002` (unique violation).
fn map_db_error(e: tokio_postgres::Error) -> PlayerReadError {
    if e.code().map(|c| c.code()) == Some(PG_UNIQUE_VIOLATION) {
        return PlayerReadError::controlled(HTTP_CONFLICT, ERR_DUPLICATE, CODE_DUPLICATE);
    }
    PlayerReadError::internal(e.to_string())
}

pub async fn run_admin_update_user(
    pool: &Pool,
    http: &Client,
    cfg: &WorkerConfig,
    req: &AdminUserUpdateRequest,
) -> Result<Value, PlayerReadError> {
    let target_id = i32::try_from(req.target_id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            PlayerReadError::controlled(HTTP_BAD_REQUEST, ERR_USER_ID_REQUIRED, CODE_VALIDATION)
        })?;

    let mut conn = pool.get().await?;
    let target = conn
        .query_opt(
            "SELECT id, username, email, is_admin, is_super_admin, polygon_wallet
               FROM users WHERE id = $1",
            &[&target_id],
        )
        .await?
        .ok_or_else(|| {
            PlayerReadError::controlled(HTTP_NOT_FOUND, ERR_USER_NOT_FOUND, CODE_NOT_FOUND)
        })?;

    let target_is_admin = truthy_flag(Some(i32_cell(&target, "is_admin")));
    let target_is_super = truthy_flag(Some(i32_cell(&target, "is_super_admin")));
    let target_wallet = opt_string(&target, "polygon_wallet");
    let editing_other = req.actor_user_id != i64::from(target_id);

    let raw_username = strip_invisible_username_chars(req.username.as_deref().unwrap_or(""));
    let vu = validate_signup_username(Some(&raw_username));
    if !vu.ok {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            vu.error.unwrap_or_else(|| "Invalid username.".into()),
            CODE_VALIDATION,
        ));
    }
    let next_username = vu.username.unwrap_or_default();
    if is_reserved_profile_username(&next_username) {
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            ERR_USERNAME_RESERVED,
            CODE_USERNAME_RESERVED,
        ));
    }

    let email_check = validate_login_email(req.email.as_deref());
    if !email_check.ok {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            email_check.error.unwrap_or_else(|| "Invalid email.".into()),
            CODE_VALIDATION,
        ));
    }
    let next_email = req.email.as_deref().unwrap_or("").trim().to_lowercase();
    let prev_email = string_cell(&target, "email").trim().to_lowercase();
    let email_changing = next_email != prev_email;

    if email_changing && editing_other && target_is_admin && !req.actor_is_super_admin {
        return Err(PlayerReadError::controlled(
            HTTP_FORBIDDEN,
            ERR_ADMIN_EMAIL_SUPER_ONLY,
            CODE_FORBIDDEN,
        ));
    }

    let password_raw = req.password.as_deref().filter(|p| !p.trim().is_empty());
    if password_raw.is_some() && editing_other && target_is_super && !req.actor_is_super_admin {
        return Err(PlayerReadError::controlled(
            HTTP_FORBIDDEN,
            ERR_SUPER_PASSWORD_SUPER_ONLY,
            CODE_FORBIDDEN,
        ));
    }
    if let Some(p) = password_raw {
        let strength = validate_password_strength_policy(p);
        if !strength.ok {
            return Err(PlayerReadError::controlled(
                HTTP_UNPROCESSABLE,
                strength.error.unwrap_or_else(|| "Weak password.".into()),
                CODE_PASSWORD_WEAK,
            ));
        }
    }

    let wallet_raw = req
        .polygon_wallet
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let wallet_provided = !wallet_raw.is_empty();
    let mut next_wallet: Option<String> = None;
    if wallet_provided {
        match validate_optional_polygon_wallet(Some(&wallet_raw)) {
            WalletValidation::Err { error } => {
                return Err(PlayerReadError::controlled(
                    HTTP_BAD_REQUEST,
                    error,
                    CODE_VALIDATION,
                ));
            }
            WalletValidation::Address(a) => next_wallet = Some(a),
            WalletValidation::Null => next_wallet = None,
        }
    }

    let levels = parse_target_access_levels(&req.access_level_id, &req.access_level_ids)?;
    if !levels.ids.is_empty() {
        let found = conn
            .query(
                "SELECT id FROM access_levels WHERE id = ANY($1)",
                &[&levels.ids],
            )
            .await?;
        let found_ids: Vec<String> = found.iter().map(|r| string_cell(r, "id")).collect();
        if levels.ids.iter().any(|id| !found_ids.contains(id)) {
            return Err(PlayerReadError::controlled(
                HTTP_BAD_REQUEST,
                ERR_LEVELS_UNKNOWN,
                CODE_VALIDATION,
            ));
        }
    }

    let username_changing =
        !next_username.eq_ignore_ascii_case(string_cell(&target, "username").as_str());
    if username_changing
        && conflicting_user_id(&conn, "username", &next_username, target_id).await?
    {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            ERR_USERNAME_TAKEN,
            CODE_USERNAME_TAKEN,
        ));
    }
    if email_changing && conflicting_user_id(&conn, "email", &next_email, target_id).await? {
        return Err(PlayerReadError::controlled(
            HTTP_CONFLICT,
            ERR_EMAIL_TAKEN,
            CODE_EMAIL_TAKEN,
        ));
    }

    let wallet_changing = wallet_provided
        && normalize_wallet_compare_key(next_wallet.as_deref())
            != normalize_wallet_compare_key(target_wallet.as_deref());

    let password_hash = match password_raw {
        Some(p) => Some(auth_hash_password(http, cfg, p).await?),
        None => None,
    };

    let tx = conn.transaction().await?;
    if username_changing {
        let updated = tx
            .execute(
                "UPDATE users SET username = $1
                  WHERE id = $2
                    AND NOT EXISTS (
                      SELECT 1 FROM users u2
                       WHERE LOWER(u2.username) = LOWER($1) AND u2.id <> $2
                    )",
                &[&next_username, &target_id],
            )
            .await
            .map_err(map_db_error)?;
        if updated == 0 {
            return Err(PlayerReadError::controlled(
                HTTP_CONFLICT,
                ERR_USERNAME_TAKEN,
                CODE_USERNAME_TAKEN,
            ));
        }
    }
    if email_changing {
        let updated = tx
            .execute(
                "UPDATE users SET email = $1
                  WHERE id = $2
                    AND NOT EXISTS (
                      SELECT 1 FROM users u2
                       WHERE LOWER(u2.email) = LOWER($1) AND u2.id <> $2
                    )",
                &[&next_email, &target_id],
            )
            .await
            .map_err(map_db_error)?;
        if updated == 0 {
            return Err(PlayerReadError::controlled(
                HTTP_CONFLICT,
                ERR_EMAIL_TAKEN,
                CODE_EMAIL_TAKEN,
            ));
        }
    }

    // Node always writes `access_level_id` (possibly NULL); wallet and password
    // only when the payload carried them.
    tx.execute(
        "UPDATE users SET access_level_id = $2 WHERE id = $1",
        &[&target_id, &levels.primary],
    )
    .await
    .map_err(map_db_error)?;
    if wallet_provided {
        tx.execute(
            "UPDATE users SET polygon_wallet = $2 WHERE id = $1",
            &[&target_id, &next_wallet],
        )
        .await
        .map_err(map_db_error)?;
    }
    if let Some(ref hash) = password_hash {
        tx.execute(
            "UPDATE users SET password = $2 WHERE id = $1",
            &[&target_id, hash],
        )
        .await
        .map_err(map_db_error)?;
    }

    tx.execute(
        "DELETE FROM user_access_levels WHERE user_id = $1",
        &[&target_id],
    )
    .await
    .map_err(map_db_error)?;
    if !levels.ids.is_empty() {
        let granted_at = now_ms();
        tx.execute(
            "INSERT INTO user_access_levels (user_id, access_level_id, granted_at)
             SELECT $1, level_id, $3 FROM UNNEST($2::text[]) AS level_id",
            &[&target_id, &levels.ids, &granted_at],
        )
        .await
        .map_err(map_db_error)?;
    }

    if wallet_changing {
        append_admin_wallet_history(
            &tx,
            target_id,
            req,
            target_wallet.as_deref(),
            next_wallet.as_deref(),
        )
        .await?;
    }

    tx.commit().await?;

    if password_hash.is_some() {
        auth_revoke_refresh(http, cfg, i64::from(target_id)).await?;
    }

    let grants = conn
        .query(
            "SELECT access_level_id FROM user_access_levels WHERE user_id = $1",
            &[&target_id],
        )
        .await?;
    let refreshed = conn
        .query_opt(
            "SELECT id, username, email, polygon_wallet, access_level_id,
                    is_admin, is_super_admin, is_blocked
               FROM users WHERE id = $1",
            &[&target_id],
        )
        .await?
        .ok_or_else(|| {
            PlayerReadError::controlled(HTTP_NOT_FOUND, ERR_USER_NOT_FOUND, CODE_NOT_FOUND)
        })?;

    let access_level_id = opt_string(&refreshed, "access_level_id");
    let mut access_level_ids: Vec<String> = Vec::new();
    for id in grants
        .iter()
        .map(|r| string_cell(r, "access_level_id"))
        .chain(access_level_id.clone())
    {
        if !access_level_ids.contains(&id) {
            access_level_ids.push(id);
        }
    }

    let mut user = Map::new();
    user.insert("id".into(), json!(i32_cell(&refreshed, "id")));
    user.insert(
        "username".into(),
        json!(string_cell(&refreshed, "username")),
    );
    user.insert("email".into(), json!(string_cell(&refreshed, "email")));
    if let Some(w) = opt_string(&refreshed, "polygon_wallet") {
        user.insert("polygonWallet".into(), Value::String(w));
    }
    if let Some(ref lvl) = access_level_id {
        user.insert("accessLevelId".into(), Value::String(lvl.clone()));
    }
    user.insert("accessLevelIds".into(), json!(access_level_ids));
    user.insert(
        "isAdmin".into(),
        json!(truthy_flag(Some(i32_cell(&refreshed, "is_admin")))),
    );
    user.insert(
        "isSuperAdmin".into(),
        json!(truthy_flag(Some(i32_cell(&refreshed, "is_super_admin")))),
    );
    user.insert(
        "isBlocked".into(),
        json!(i32_cell(&refreshed, "is_blocked") == super::BLOCKED_FLAG),
    );

    Ok(json!({ "user": Value::Object(user) }))
}

/// Node `getConflictingUserIdBy{Username,Email}` — case-insensitive, excluding
/// the row being edited. `column` is a fixed literal, never user input.
async fn conflicting_user_id(
    conn: &deadpool_postgres::Client,
    column: &'static str,
    value: &str,
    exclude_id: i32,
) -> Result<bool, PlayerReadError> {
    let row = conn
        .query_opt(
            &format!("SELECT id FROM users WHERE LOWER({column}) = LOWER($1) AND id <> $2 LIMIT 1"),
            &[&value, &exclude_id],
        )
        .await?;
    Ok(row.is_some())
}

/// Node `appendUserWalletHistory` with `action: 'admin_changed'`.
async fn append_admin_wallet_history(
    tx: &deadpool_postgres::Transaction<'_>,
    target_id: i32,
    req: &AdminUserUpdateRequest,
    previous: Option<&str>,
    next: Option<&str>,
) -> Result<(), PlayerReadError> {
    let network: String = WALLET_HISTORY_NETWORK
        .chars()
        .take(NETWORK_MAX_CHARS)
        .collect();
    let actor: String = WALLET_HISTORY_ACTOR
        .chars()
        .take(ACTOR_TYPE_MAX_CHARS)
        .collect();
    let source: String = WALLET_HISTORY_SOURCE
        .chars()
        .take(SOURCE_MAX_CHARS)
        .collect();
    let ip = truncate(req.ip_address.as_deref(), IP_ADDRESS_MAX_CHARS);
    let ua = truncate(req.user_agent.as_deref(), USER_AGENT_MAX_CHARS);
    let actor_user_id = i32::try_from(req.actor_user_id).ok();
    let next_owned = next.map(str::to_string);
    let previous_owned = previous.map(str::to_string);
    tx.execute(
        "INSERT INTO user_wallet_history (
            user_id, action, network, wallet_address, previous_wallet_address, new_wallet_address,
            ip_address, user_agent, signature_address, signature_message, created_at, metadata,
            actor_type, actor_user_id, source, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,NULL,$10,$11,$12,NULL)",
        &[
            &target_id,
            &WALLET_HISTORY_ACTION,
            &network,
            &next_owned,
            &previous_owned,
            &next_owned,
            &ip,
            &ua,
            &now_ms(),
            &actor,
            &actor_user_id,
            &source,
        ],
    )
    .await
    .map_err(map_db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_levels_promote_primary_to_the_front() {
        let out = parse_target_access_levels(&json!("gold"), &json!(["silver", "bronze"])).unwrap();
        assert_eq!(out.primary.as_deref(), Some("gold"));
        assert_eq!(out.ids, vec!["gold", "silver", "bronze"]);
    }

    #[test]
    fn access_levels_fall_back_to_the_first_id() {
        let out = parse_target_access_levels(&Value::Null, &json!([" silver ", "silver"])).unwrap();
        assert_eq!(out.primary.as_deref(), Some("silver"));
        assert_eq!(out.ids, vec!["silver"]);
    }

    #[test]
    fn access_levels_allow_clearing_everything() {
        let out = parse_target_access_levels(&json!(""), &json!([])).unwrap();
        assert!(out.primary.is_none());
        assert!(out.ids.is_empty());
    }

    #[test]
    fn access_levels_reject_non_arrays() {
        let e = parse_target_access_levels(&json!("gold"), &json!("silver")).unwrap_err();
        assert_eq!(e.http_status, HTTP_BAD_REQUEST);
        assert_eq!(e.code.as_deref(), Some(CODE_VALIDATION));
        assert!(parse_target_access_levels(&json!("gold"), &Value::Null).is_ok());
    }

    #[test]
    fn access_levels_keep_the_primary_once() {
        let out = parse_target_access_levels(&json!("gold"), &json!(["gold", "silver"])).unwrap();
        assert_eq!(out.ids, vec!["gold", "silver"]);
    }

    #[test]
    fn wallet_compare_key_ignores_case_and_blanks() {
        let addr = "0x52908400098527886E0F7030069857D2E4169EE7";
        assert_eq!(
            normalize_wallet_compare_key(Some(addr)),
            normalize_wallet_compare_key(Some(&addr.to_lowercase()))
        );
        assert_eq!(normalize_wallet_compare_key(None), "");
        assert_eq!(normalize_wallet_compare_key(Some("  ")), "");
        assert_eq!(normalize_wallet_compare_key(Some("0x")), "");
        assert_eq!(normalize_wallet_compare_key(Some("NULL")), "");
    }

    #[test]
    fn wallet_history_row_is_capped_like_node() {
        assert_eq!(
            truncate(Some(&"x".repeat(200)), IP_ADDRESS_MAX_CHARS)
                .unwrap()
                .len(),
            IP_ADDRESS_MAX_CHARS
        );
        assert_eq!(truncate(Some("   "), IP_ADDRESS_MAX_CHARS), None);
        assert_eq!(truncate(None, IP_ADDRESS_MAX_CHARS), None);
    }

    #[test]
    fn wallet_history_constants_match_node() {
        assert_eq!(WALLET_HISTORY_ACTION, "admin_changed");
        assert_eq!(WALLET_HISTORY_ACTOR, "admin");
        assert_eq!(WALLET_HISTORY_SOURCE, "PUT /api/user");
        assert_eq!(WALLET_HISTORY_NETWORK, "polygon");
    }
}
