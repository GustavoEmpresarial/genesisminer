//! Public signup after Turnstile — Node `register.controller.ts` + `user-creation.ts`.

use deadpool_postgres::GenericClient;
use deadpool_postgres::Pool;
use serde::Deserialize;
use tokio_postgres::Row;
use tracing::{error, warn};

use crate::config::WorkerConfig;
use crate::db::current_unix_ms;
use crate::pg_types::pg_user_id;
use genesis_core::auth::constants::{
    DEFAULT_ACCESS_LEVEL_ID, DEFAULT_PLAYER_UNLOCKED_SLOTS, EMAIL_ADDRESS_MAX_LENGTH,
    EMAIL_VERIFICATION_TTL_HOURS, FINGERPRINT_IP_MAX_LENGTH, FINGERPRINT_USER_AGENT_MAX_LENGTH,
    IP_SIGNUP_LIMIT_MAX_ACCOUNTS, IP_SIGNUP_LIMIT_WINDOW_DAYS, IP_SIGNUP_LIMIT_WINDOW_MS,
    LOOT_TRIGGER_REGISTRATION, REFERRAL_CODE_CLASH_RETRY_MAX, WELCOME_BOX_QTY,
};
use genesis_core::auth::password::hash_password_register;
use genesis_core::calculator::constants::{ASIC_ROOM_ID, EXTRA_ROOM_ID};
use genesis_core::generate_referral_code;
use genesis_core::{
    assert_public_signup_email_allowed, build_signed_email_verification_token, hash_token_sha256,
    sanitize_device_fingerprint, validate_optional_polygon_wallet,
    validate_optional_referral_code_input, validate_signup_password, validate_signup_username,
    WalletValidation,
};

pub const REGISTER_PATH: &str = "/v1/auth/register";

const _: () = assert!(IP_SIGNUP_LIMIT_WINDOW_DAYS == 90);
const _: () = assert!(IP_SIGNUP_LIMIT_MAX_ACCOUNTS == 3);
const _: () = assert!(REFERRAL_CODE_CLASH_RETRY_MAX == 10);
const _: () = assert!(EMAIL_VERIFICATION_TTL_HOURS == 24);
const _: () = assert!(WELCOME_BOX_QTY == 1);
const _: () = assert!(DEFAULT_PLAYER_UNLOCKED_SLOTS == 0);

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_CONFLICT: u16 = 409;

const ERR_EMAIL_REQUIRED: &str = "Email is required to register.";
const ERR_INVALID_EMAIL: &str = "Invalid email.";
const ERR_EMAIL_ALREADY: &str = "This email is already registered. Please sign in.";
const ERR_PASSWORD_COMPLETE: &str = "Set a password to complete registration.";
const ERR_PASSWORD_REGISTER: &str = "Set a password for registration.";
const ERR_USERNAME_TAKEN: &str = "This username is already taken. Choose another.";
const ERR_IP_LIMIT: &str =
    "Não foi possível concluir o cadastro a partir desta ligação. Tente novamente mais tarde.";
const CODE_USERNAME_TAKEN: &str = "USERNAME_TAKEN";
const CODE_IP_LIMIT: &str = "IP_LIMIT_REACHED";
const FINGERPRINT_EVENT_REGISTER: &str = "register";
const REFERRAL_BIND_LOCK_NS: &str = "referral_bind";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub polygon_wallet: Option<String>,
    #[serde(default)]
    pub referred_by: Option<String>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub device_fingerprint: Option<serde_json::Value>,
}

impl std::fmt::Debug for RegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterRequest")
            .field("email", &self.email)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("polygon_wallet", &self.polygon_wallet)
            .field("referred_by", &self.referred_by)
            .field("ip", &self.ip)
            .field("user_agent", &self.user_agent)
            .finish()
    }
}

#[derive(Debug)]
pub struct RegisterOk;

#[derive(Debug)]
pub enum RegisterError {
    BadRequest { error: String },
    Forbidden { error: String, code: Option<String> },
    Conflict { error: String, code: String },
    Transport(anyhow::Error),
}

impl RegisterError {
    fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest { error: msg.into() }
    }

    fn bad_ok_false(msg: impl Into<String>) -> Self {
        Self::BadRequest { error: msg.into() }
    }

    fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }

    pub fn status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::BadRequest { .. } => {
                StatusCode::from_u16(HTTP_BAD_REQUEST).unwrap_or(StatusCode::BAD_REQUEST)
            }
            Self::Forbidden { .. } => {
                StatusCode::from_u16(HTTP_FORBIDDEN).unwrap_or(StatusCode::FORBIDDEN)
            }
            Self::Conflict { .. } => {
                StatusCode::from_u16(HTTP_CONFLICT).unwrap_or(StatusCode::CONFLICT)
            }
            Self::Transport(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest { error, .. }
            | Self::Forbidden { error, .. }
            | Self::Conflict { error, .. } => error.clone(),
            Self::Transport(_) => "Internal server error during registration.".into(),
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Forbidden { code, .. } => code.as_deref(),
            Self::Conflict { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }
}

struct ExistingUser {
    id: i64,
    has_password: bool,
    referred_by: Option<String>,
}

fn existing_from_row(row: &Row) -> ExistingUser {
    let id: i32 = row.get("id");
    let password: Option<String> = row.get("password");
    ExistingUser {
        id: i64::from(id),
        has_password: password.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
        referred_by: row.get("referred_by"),
    }
}

fn resolve_registration_ip(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some((first, _)) = s.split_once(',') {
        s = first.trim();
    }
    const V4_MAP: &str = "::ffff:";
    let n = s.strip_prefix(V4_MAP).unwrap_or(s);
    if n == "unknown" || n == "::1" || n == "127.0.0.1" {
        return None;
    }
    if let Some(octets) = parse_ipv4(n) {
        let [a, b, _, _] = octets;
        if a == 10 || a == 127 || a == 0 {
            return None;
        }
        if a == 172 && (16..=31).contains(&b) {
            return None;
        }
        if a == 192 && b == 168 {
            return None;
        }
        if a == 169 && b == 254 {
            return None;
        }
        return Some(n.to_string());
    }
    let lower = n.to_ascii_lowercase();
    if lower == "::1" || lower.starts_with("fe80:") || lower.starts_with("fc") || lower.starts_with("fd")
    {
        return None;
    }
    Some(n.to_string())
}

fn parse_ipv4(ip: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    for (i, p) in parts.iter().enumerate() {
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n as u8;
    }
    Some(out)
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code().map(|c| c.code() == "23505").unwrap_or(false)
}

async fn find_user_by_email(
    pool: &Pool,
    email: &str,
) -> Result<Option<ExistingUser>, RegisterError> {
    let client = pool.get().await.map_err(RegisterError::transport)?;
    let row = client
        .query_opt(
            "SELECT id, password, referred_by FROM users WHERE lower(email) = $1",
            &[&email],
        )
        .await
        .map_err(RegisterError::transport)?;
    Ok(row.map(|r| existing_from_row(&r)))
}

async fn username_taken(
    pool: &Pool,
    username: &str,
    exclude_id: Option<i64>,
) -> Result<bool, RegisterError> {
    let client = pool.get().await.map_err(RegisterError::transport)?;
    let row = match exclude_id {
        Some(id) => {
            let uid = pg_user_id(id).map_err(RegisterError::transport)?;
            client
                .query_opt(
                    "SELECT id FROM users WHERE lower(username) = lower($1) AND id <> $2",
                    &[&username, &uid],
                )
                .await
                .map_err(RegisterError::transport)?
        }
        None => client
            .query_opt(
                "SELECT id FROM users WHERE lower(username) = lower($1)",
                &[&username],
            )
            .await
            .map_err(RegisterError::transport)?,
    };
    Ok(row.is_some())
}

async fn generate_unique_referral_code(
    client: &impl GenericClient,
    username_seed: &str,
) -> Result<String, RegisterError> {
    let mut code = generate_referral_code(username_seed);
    let mut tries = 0u32;
    while tries < REFERRAL_CODE_CLASH_RETRY_MAX {
        let clash = client
            .query_opt("SELECT id FROM users WHERE referral_code = $1", &[&code])
            .await
            .map_err(RegisterError::transport)?;
        if clash.is_none() {
            break;
        }
        code = generate_referral_code(username_seed);
        tries += 1;
    }
    Ok(code)
}

async fn count_recent_signups_from_ip(
    client: &impl GenericClient,
    ip: &str,
    window_start: i64,
) -> Result<i64, RegisterError> {
    let row = client
        .query_one(
            "SELECT COUNT(*)::bigint AS count
               FROM users u
               JOIN game_states gs ON gs.user_id = u.id
              WHERE u.registration_ip = $1
                AND gs.start_time >= $2",
            &[&ip, &window_start],
        )
        .await
        .map_err(RegisterError::transport)?;
    Ok(row.get("count"))
}

async fn grant_default_player_rooms(
    client: &impl GenericClient,
    uid: i32,
    now: i64,
) -> Result<(), RegisterError> {
    for room_id in [ASIC_ROOM_ID, EXTRA_ROOM_ID] {
        client
            .execute(
                "INSERT INTO user_rig_rooms (user_id, room_id, purchased_at, unlocked_slots)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id, room_id) DO NOTHING",
                &[&uid, &room_id, &now, &DEFAULT_PLAYER_UNLOCKED_SLOTS],
            )
            .await
            .map_err(RegisterError::transport)?;
    }
    Ok(())
}

async fn grant_registration_loot_boxes(
    client: &impl GenericClient,
    uid: i32,
    now: i64,
) -> Result<(), RegisterError> {
    let boxes = client
        .query(
            "SELECT id FROM loot_boxes WHERE trigger = $1",
            &[&LOOT_TRIGGER_REGISTRATION],
        )
        .await
        .map_err(RegisterError::transport)?;
    for row in boxes {
        let box_id: String = row.get("id");
        client
            .execute(
                "INSERT INTO unopened_boxes (user_id, box_id, qty)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, box_id)
                 DO UPDATE SET qty = unopened_boxes.qty + EXCLUDED.qty",
                &[&uid, &box_id, &WELCOME_BOX_QTY],
            )
            .await
            .map_err(RegisterError::transport)?;
        client
            .execute(
                "INSERT INTO player_claimed_boxes (user_id, box_id, claimed_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, box_id) DO NOTHING",
                &[&uid, &box_id, &now],
            )
            .await
            .map_err(RegisterError::transport)?;
    }
    Ok(())
}

async fn get_user_id_by_email(
    pool: &Pool,
    email: &str,
    ip: Option<&str>,
    preferred_username: &str,
) -> Result<i64, RegisterError> {
    let client = pool.get().await.map_err(RegisterError::transport)?;
    if let Some(row) = client
        .query_opt(
            "SELECT id, username, referral_code FROM users WHERE lower(email) = $1",
            &[&email],
        )
        .await
        .map_err(RegisterError::transport)?
    {
        let id: i32 = row.get("id");
        let username: String = row.get("username");
        let referral_code: Option<String> = row.get("referral_code");
        if referral_code.as_deref().unwrap_or("").is_empty() {
            let code = generate_unique_referral_code(&client, &username).await?;
            client
                .execute(
                    "UPDATE users SET referral_code = $2 WHERE id = $1",
                    &[&id, &code],
                )
                .await
                .map_err(RegisterError::transport)?;
        }
        return Ok(i64::from(id));
    }

    let policy = assert_public_signup_email_allowed(email);
    if !policy.is_ok() {
        return Err(RegisterError::bad_ok_false(
            policy.error.unwrap_or_else(|| ERR_INVALID_EMAIL.into()),
        ));
    }

    let registration_ip = resolve_registration_ip(ip);
    if let Some(ref rip) = registration_ip {
        let now = current_unix_ms();
        let window_ms = i64::try_from(IP_SIGNUP_LIMIT_WINDOW_MS).unwrap_or(i64::MAX);
        let window_start = now.saturating_sub(window_ms);
        let count = count_recent_signups_from_ip(&client, rip, window_start).await?;
        if count >= IP_SIGNUP_LIMIT_MAX_ACCOUNTS {
            return Err(RegisterError::Forbidden {
                error: ERR_IP_LIMIT.into(),
                code: Some(CODE_IP_LIMIT.into()),
            });
        }
    }

    let code = generate_unique_referral_code(&client, preferred_username).await?;
    let insert = client
        .query_one(
            "INSERT INTO users (username, email, referral_code, is_admin, is_blocked, registration_ip)
             VALUES ($1, $2, $3, 0, 0, $4)
             RETURNING id",
            &[&preferred_username, &email, &code, &registration_ip],
        )
        .await;
    let uid: i32 = match insert {
        Ok(row) => row.get("id"),
        Err(e) if is_unique_violation(&e) => {
            let retry = client
                .query_opt(
                    "SELECT id FROM users WHERE lower(email) = $1",
                    &[&email],
                )
                .await
                .map_err(RegisterError::transport)?;
            if let Some(row) = retry {
                let id: i32 = row.get("id");
                return Ok(i64::from(id));
            }
            return Err(RegisterError::transport(e));
        }
        Err(e) => return Err(RegisterError::transport(e)),
    };

    let now = current_unix_ms();
    if let Some(ref rip) = registration_ip {
        client
            .execute(
                "INSERT INTO user_history_ips (user_id, ip, last_used_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, ip) DO NOTHING",
                &[&uid, rip, &now],
            )
            .await
            .map_err(RegisterError::transport)?;
    }

    grant_registration_loot_boxes(&client, uid, now).await?;

    if let Err(e) = client
        .execute(
            "INSERT INTO game_states (
                user_id, usdc, start_time, last_updated_at,
                claimed_referrals, referral_bonus_claimed, black_market_balance
             ) VALUES ($1, 0, $2, $2, 0, 0, 0)
             ON CONFLICT (user_id) DO NOTHING",
            &[&uid, &now],
        )
        .await
    {
        if !is_unique_violation(&e) {
            error!(err = %e, "Failed to create game state");
            return Err(RegisterError::transport(e));
        }
    }

    grant_default_player_rooms(&client, uid, now).await?;
    Ok(i64::from(uid))
}

async fn default_access_level_id(client: &impl GenericClient) -> Result<String, RegisterError> {
    let row = client
        .query_opt(
            "SELECT id FROM access_levels
              WHERE is_default = 1 AND is_active = 1
              ORDER BY id ASC
              LIMIT 1",
            &[],
        )
        .await
        .map_err(RegisterError::transport)?;
    Ok(row
        .map(|r| r.get::<_, String>("id"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ACCESS_LEVEL_ID.to_string()))
}

async fn bind_referral_and_accrue(
    client: &impl GenericClient,
    referrer_id: i32,
    referred_username: &str,
    now: i64,
) -> Result<(), RegisterError> {
    let lock_key = format!("{referrer_id}:{referred_username}");
    client
        .execute(
            "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
            &[&REFERRAL_BIND_LOCK_NS, &lock_key],
        )
        .await
        .map_err(RegisterError::transport)?;
    let existing = client
        .query_opt(
            "SELECT 1 FROM referrals WHERE user_id = $1 AND referred_username = $2",
            &[&referrer_id, &referred_username],
        )
        .await
        .map_err(RegisterError::transport)?;
    if existing.is_some() {
        return Ok(());
    }
    client
        .execute(
            "INSERT INTO referrals (user_id, referred_username) VALUES ($1, $2)",
            &[&referrer_id, &referred_username],
        )
        .await
        .map_err(RegisterError::transport)?;
    let upd = client
        .execute(
            "UPDATE game_states
                SET claimed_referrals = claimed_referrals + 1, last_updated_at = $2
              WHERE user_id = $1",
            &[&referrer_id, &now],
        )
        .await
        .map_err(RegisterError::transport)?;
    if upd == 0 {
        client
            .execute(
                "INSERT INTO game_states (
                    user_id, usdc, start_time, last_updated_at,
                    claimed_referrals, referral_bonus_claimed, black_market_balance
                 ) VALUES ($1, 0, $2, $2, 1, 0, 0)
                 ON CONFLICT (user_id) DO UPDATE
                   SET claimed_referrals = game_states.claimed_referrals + 1,
                       last_updated_at = EXCLUDED.last_updated_at",
                &[&referrer_id, &now],
            )
            .await
            .map_err(RegisterError::transport)?;
    }
    Ok(())
}

async fn persist_verification_token(
    pool: &Pool,
    email: &str,
    secret: &str,
) -> Result<String, RegisterError> {
    let now = current_unix_ms();
    let ttl = i64::try_from(genesis_core::auth::constants::EMAIL_VERIFICATION_TTL_MS)
        .map_err(RegisterError::transport)?;
    let token = build_signed_email_verification_token(email, now.saturating_add(ttl), secret);
    let token_hash = hash_token_sha256(&token);
    let client = pool.get().await.map_err(RegisterError::transport)?;
    client
        .execute(
            "UPDATE users SET email_verification_token_hash = $2 WHERE lower(email) = $1",
            &[&email, &token_hash],
        )
        .await
        .map_err(RegisterError::transport)?;
    Ok(token)
}

async fn insert_fingerprint_log(
    pool: &Pool,
    user_id: i64,
    fingerprint: &serde_json::Value,
    ip: &str,
    user_agent: &str,
) {
    let Some(fp) = sanitize_device_fingerprint(fingerprint) else {
        return;
    };
    let Ok(uid) = pg_user_id(user_id) else {
        return;
    };
    let ip_trunc: String = ip.chars().take(FINGERPRINT_IP_MAX_LENGTH).collect();
    let ua_trunc: String = user_agent.chars().take(FINGERPRINT_USER_AGENT_MAX_LENGTH).collect();
    let now = current_unix_ms();
    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(err = %e, "fingerprint pool");
            return;
        }
    };
    if let Err(e) = client
        .execute(
            "INSERT INTO device_fingerprint_logs
                (user_id, event_type, fingerprint_hash, payload_json, ip, user_agent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &uid,
                &FINGERPRINT_EVENT_REGISTER,
                &fp.fingerprint_hash,
                &fp.payload_json,
                &ip_trunc,
                &ua_trunc,
                &now,
            ],
        )
        .await
    {
        warn!(err = %e, "fingerprint insert");
    }
}

async fn hash_register_password(password: String) -> Result<String, RegisterError> {
    tokio::task::spawn_blocking(move || hash_password_register(&password))
        .await
        .map_err(RegisterError::transport)?
        .map_err(|e| RegisterError::transport(anyhow::anyhow!(e.to_string())))
}

pub async fn run_register(
    pool: &Pool,
    cfg: &WorkerConfig,
    body: RegisterRequest,
) -> Result<RegisterOk, RegisterError> {
    let normalized_email = body
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if body.email.as_deref().unwrap_or("").is_empty() {
        return Err(RegisterError::bad(ERR_EMAIL_REQUIRED));
    }
    if !normalized_email.contains('@') || normalized_email.len() > EMAIL_ADDRESS_MAX_LENGTH {
        return Err(RegisterError::bad(ERR_INVALID_EMAIL));
    }

    let user_vu = validate_signup_username(body.username.as_deref());
    if !user_vu.ok {
        return Err(RegisterError::bad(
            user_vu.error.unwrap_or_else(|| "Username is required.".into()),
        ));
    }
    let nickname = user_vu.username.unwrap_or_default();

    let existing = find_user_by_email(pool, &normalized_email).await?;
    if existing.as_ref().is_some_and(|e| e.has_password) {
        return Err(RegisterError::Forbidden {
            error: ERR_EMAIL_ALREADY.into(),
            code: None,
        });
    }

    let password_raw = body.password.as_deref().unwrap_or("");
    let has_password = !password_raw.trim().is_empty();
    if existing.is_some() && !existing.as_ref().unwrap().has_password && !has_password {
        return Err(RegisterError::bad(ERR_PASSWORD_COMPLETE));
    }
    if existing.is_none() && !has_password {
        return Err(RegisterError::bad(ERR_PASSWORD_REGISTER));
    }
    if has_password {
        let pv = validate_signup_password(Some(password_raw), true);
        if !pv.is_ok() {
            return Err(RegisterError::bad(
                pv.error.unwrap_or_else(|| "Set a password.".into()),
            ));
        }
    }

    let polygon_for_db = match validate_optional_polygon_wallet(body.polygon_wallet.as_deref()) {
        WalletValidation::Err { error } => return Err(RegisterError::bad(error)),
        WalletValidation::Address(addr) => Some(addr),
        WalletValidation::Null => None,
    };

    let ref_in = validate_optional_referral_code_input(body.referred_by.as_deref());
    if !ref_in.ok {
        return Err(RegisterError::bad(
            ref_in.error.unwrap_or_else(|| "Invalid referral code.".into()),
        ));
    }
    let referred_by_for_db = ref_in.code;

    let uid = if let Some(ex) = existing.as_ref() {
        if username_taken(pool, &nickname, Some(ex.id)).await? {
            return Err(RegisterError::Conflict {
                error: ERR_USERNAME_TAKEN.into(),
                code: CODE_USERNAME_TAKEN.into(),
            });
        }
        ex.id
    } else {
        let ev = assert_public_signup_email_allowed(&normalized_email);
        if !ev.is_ok() {
            return Err(RegisterError::bad_ok_false(
                ev.error.unwrap_or_else(|| ERR_INVALID_EMAIL.into()),
            ));
        }
        if username_taken(pool, &nickname, None).await? {
            return Err(RegisterError::Conflict {
                error: ERR_USERNAME_TAKEN.into(),
                code: CODE_USERNAME_TAKEN.into(),
            });
        }
        get_user_id_by_email(pool, &normalized_email, body.ip.as_deref(), &nickname).await?
    };

    let password_hash = if has_password {
        Some(hash_register_password(password_raw.to_string()).await?)
    } else {
        None
    };

    let referral_already_bound = existing
        .as_ref()
        .and_then(|e| e.referred_by.as_deref())
        .is_some_and(|s| !s.is_empty());
    let mut referrer_id: Option<i32> = None;
    if let Some(ref code) = referred_by_for_db {
        if !referral_already_bound {
            let client = pool.get().await.map_err(RegisterError::transport)?;
            if let Some(row) = client
                .query_opt(
                    "SELECT id FROM users WHERE lower(referral_code) = lower($1)",
                    &[code],
                )
                .await
                .map_err(RegisterError::transport)?
            {
                let rid: i32 = row.get("id");
                if i64::from(rid) != uid {
                    referrer_id = Some(rid);
                }
            }
        }
    }

    let pg_uid = pg_user_id(uid).map_err(RegisterError::transport)?;
    let mut client = pool.get().await.map_err(RegisterError::transport)?;
    let tx = client.transaction().await.map_err(RegisterError::transport)?;
    let access_level = default_access_level_id(&tx).await?;
    tx.execute(
        "UPDATE users SET
            username = $2,
            email = $3,
            access_level_id = $4,
            referred_by = $5,
            polygon_wallet = COALESCE($6, polygon_wallet),
            password = COALESCE($7, password)
          WHERE id = $1",
        &[
            &pg_uid,
            &nickname,
            &normalized_email,
            &access_level,
            &referred_by_for_db,
            &polygon_for_db,
            &password_hash,
        ],
    )
    .await
    .map_err(RegisterError::transport)?;
    if let Some(rid) = referrer_id {
        bind_referral_and_accrue(&tx, rid, &nickname, current_unix_ms()).await?;
    }
    tx.execute(
        "UPDATE users SET email_verification_required = 1, email_verified = 0 WHERE id = $1",
        &[&pg_uid],
    )
    .await
    .map_err(RegisterError::transport)?;
    tx.commit().await.map_err(RegisterError::transport)?;

    if let Some(fp) = body.device_fingerprint.as_ref() {
        let ip = body.ip.clone().unwrap_or_default();
        let ua = body.user_agent.clone().unwrap_or_default();
        insert_fingerprint_log(pool, uid, fp, &ip, &ua).await;
    }

    match persist_verification_token(pool, &normalized_email, &cfg.auth_flow_token_secret).await {
        Ok(token) => {
            if let Err(e) = crate::mail::send_verification_email(
                &cfg.mail,
                &normalized_email,
                &token,
                Some(u32::try_from(EMAIL_VERIFICATION_TTL_HOURS).unwrap_or(u32::MAX)),
            )
            .await
            {
                error!(err = %e, "registration verification mail");
            }
        }
        Err(e) => {
            error!(err = ?e, "registration verification token persist");
        }
    }

    Ok(RegisterOk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ip_not_counted() {
        assert!(resolve_registration_ip(Some("127.0.0.1")).is_none());
        assert!(resolve_registration_ip(Some("10.0.0.2")).is_none());
        assert!(resolve_registration_ip(Some("192.168.1.1")).is_none());
        assert_eq!(
            resolve_registration_ip(Some("8.8.8.8")).as_deref(),
            Some("8.8.8.8")
        );
    }

    #[test]
    fn node_status_codes() {
        assert_eq!(HTTP_BAD_REQUEST, 400);
        assert_eq!(HTTP_FORBIDDEN, 403);
        assert_eq!(HTTP_CONFLICT, 409);
    }
}
