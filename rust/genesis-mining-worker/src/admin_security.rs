//! Admin "Segurança e Auditoria" panel — 100% Rust.
//!
//! Ports `server/modules/admin/{security-stats,security-bulk,device-fingerprint}/`.
//! genesis-api (`admin_security.rs`) is the thin gate: tab `security` for the
//! reads, `Super` for the three destructive bulk-write endpoints.
//!
//! - `run_security_stats` — the scan (8 sections), IP filter = usable-public
//!   minus known Cloudflare edge ranges (Node `isUsefulSecurityScanIp`).
//! - `run_blacklist_add` / `run_blacklist_remove` — `ip_blacklist`.
//! - `run_device_fingerprints` — paged `device_fingerprint_logs` + user join.
//! - `run_bulk_config_{get,set}` — `settings` KV.
//! - `run_inactive_block_{preview,apply}` — block players idle > N days
//!   (super-admin + `{confirm:"BLOQUEAR"}`), wipe their sessions.
//! - `run_pw_reset_{preview,apply}` — force reset all player passwords
//!   (super-admin + `{confirm:"REDEFINIR"}`), wipe their sessions.

use deadpool_postgres::Pool;
use serde_json::{json, Value};

use crate::config::WorkerConfig;
use crate::player_reads::{i64_cell, now_ms, string_cell, PlayerReadError};
use crate::profile_writes::auth_client;

pub const SECURITY_STATS_PATH: &str = "/v1/admin/security/stats";
pub const SECURITY_BLACKLIST_ADD_PATH: &str = "/v1/admin/security/blacklist/add";
pub const SECURITY_BLACKLIST_REMOVE_PATH: &str = "/v1/admin/security/blacklist/remove";
pub const SECURITY_FINGERPRINTS_PATH: &str = "/v1/admin/security/device-fingerprints";
pub const SECURITY_BULK_CONFIG_GET_PATH: &str = "/v1/admin/security/bulk/config-get";
pub const SECURITY_BULK_CONFIG_SET_PATH: &str = "/v1/admin/security/bulk/config-set";
pub const SECURITY_INACTIVE_PREVIEW_PATH: &str = "/v1/admin/security/bulk/inactive-preview";
pub const SECURITY_INACTIVE_APPLY_PATH: &str = "/v1/admin/security/bulk/inactive-apply";
pub const SECURITY_PWRESET_PREVIEW_PATH: &str = "/v1/admin/security/bulk/pwreset-preview";
pub const SECURITY_PWRESET_APPLY_PATH: &str = "/v1/admin/security/bulk/pwreset-apply";

const MS_PER_DAY: i64 = 86_400_000;
const IP_MAX: usize = 64;
const REASON_MAX: usize = 500;
const ACCESS_LOGS_LIMIT: i64 = 100;
const DEFAULT_REASON: &str = "Banned by Admin";
const FP_DEFAULT_LIMIT: i64 = 50;
const FP_MAX_LIMIT: i64 = 200;
const FP_SEARCH_MAX: usize = 100;

const SETTING_INACTIVE_DAYS: &str = "security_inactive_block_days";
const SETTING_AUTO_ENABLED: &str = "security_inactive_auto_block_enabled";
const DEFAULT_INACTIVE_BLOCK_DAYS: i64 = 90;
const MIN_INACTIVE_DAYS: i64 = 1;
const MAX_INACTIVE_DAYS: i64 = 3650;

const PW_RESET_CONFIRM: &str = "REDEFINIR";
const INACTIVE_BLOCK_CONFIRM: &str = "BLOQUEAR";

// ---------------------------------------------------------------------------
// IP filter (Node scan-ip.ts)
// ---------------------------------------------------------------------------

fn parse_ipv4(ip: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n as u8;
    }
    Some(out)
}

fn is_usable_public(ip: &str) -> bool {
    let ip = ip.trim();
    if ip.is_empty() || ip == "unknown" || ip == "::1" || ip == "127.0.0.1" {
        return false;
    }
    if let Some([a, b, _, _]) = parse_ipv4(ip) {
        if a == 10 || a == 127 || a == 0 {
            return false;
        }
        if a == 172 && (16..=31).contains(&b) {
            return false;
        }
        if a == 192 && b == 168 {
            return false;
        }
        if a == 169 && b == 254 {
            return false;
        }
        return true;
    }
    let lower = ip.to_ascii_lowercase();
    !(lower.starts_with("fe80:") || lower.starts_with("fc") || lower.starts_with("fd"))
}

/// Cloudflare edge IPv4 ranges (Node `CF_EDGE_CIDRS`).
const CF_EDGE_CIDRS: &[([u8; 4], u32)] = &[
    ([173, 245, 48, 0], 20),
    ([103, 21, 244, 0], 22),
    ([103, 22, 200, 0], 22),
    ([103, 31, 4, 0], 22),
    ([141, 101, 64, 0], 18),
    ([108, 162, 192, 0], 18),
    ([190, 93, 240, 0], 20),
    ([188, 114, 96, 0], 20),
    ([197, 234, 240, 0], 22),
    ([198, 41, 128, 0], 17),
    ([162, 158, 0, 0], 15),
    ([104, 16, 0, 0], 13),
    ([104, 24, 0, 0], 14),
    ([172, 64, 0, 0], 13),
    ([131, 0, 72, 0], 22),
];

fn ipv4_in_cidr(ip: &str, base: [u8; 4], prefix: u32) -> bool {
    let Some(parts) = parse_ipv4(ip) else {
        return false;
    };
    let ip_num = u32::from_be_bytes(parts);
    let base_num = u32::from_be_bytes(base);
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (ip_num & mask) == (base_num & mask)
}

fn is_cf_edge(ip: &str) -> bool {
    let ip = ip.trim();
    !ip.is_empty() && CF_EDGE_CIDRS.iter().any(|(b, p)| ipv4_in_cidr(ip, *b, *p))
}

fn is_useful_scan_ip(ip: &str) -> bool {
    is_usable_public(ip) && !is_cf_edge(ip)
}

// ---------------------------------------------------------------------------
// Security stats (scan)
// ---------------------------------------------------------------------------

fn wants(section: &str, name: &str) -> bool {
    section.is_empty() || section == "all" || section == name
}

fn row_value(r: &tokio_postgres::Row, col: &str) -> Value {
    r.try_get::<_, Value>(col).unwrap_or(Value::Null)
}

pub async fn run_security_stats(pool: &Pool, section_raw: &str) -> Result<Value, PlayerReadError> {
    let section = section_raw.trim();
    let c = pool.get().await?;
    let mut out = json!({
        "multiAccounts": [],
        "historyMultiAccounts": [],
        "sharedRegistrationIps": [],
        "sharedDeviceIps": [],
        "sharedFingerprints": [],
        "suspectedAutoReferrals": [],
        "accessLogs": [],
        "blacklist": [],
        "blockedUsers": [],
    });

    if wants(section, "multiAccounts") {
        let rows = c
            .query(
                "SELECT registration_ip, COUNT(*) as account_count,
                        array_agg(username) as usernames,
                        array_agg(email) as emails,
                        array_agg(id) as ids
                   FROM users
                  WHERE registration_ip IS NOT NULL
                  GROUP BY registration_ip
                 HAVING COUNT(*) > 1
                  ORDER BY account_count DESC",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .filter(|r| is_useful_scan_ip(&string_cell(r, "registration_ip")))
            .map(|r| {
                json!({
                    "registration_ip": string_cell(r, "registration_ip"),
                    "account_count": i64_cell(r, "account_count"),
                    "usernames": r.try_get::<_, Vec<Option<String>>>("usernames").unwrap_or_default(),
                    "emails": r.try_get::<_, Vec<Option<String>>>("emails").unwrap_or_default(),
                    "ids": r.try_get::<_, Vec<Option<i32>>>("ids").unwrap_or_default(),
                })
            })
            .collect();
        out["multiAccounts"] = json!(list);
    }

    if wants(section, "historyMultiAccounts") {
        let rows = c
            .query(
                "SELECT ip, COUNT(DISTINCT user_id) as user_count,
                        array_agg(DISTINCT u.username) as usernames,
                        array_agg(DISTINCT u.email) as emails
                   FROM user_history_ips h
                   JOIN users u ON h.user_id = u.id
                  GROUP BY ip
                 HAVING COUNT(DISTINCT user_id) > 1
                  ORDER BY user_count DESC",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .filter(|r| is_useful_scan_ip(&string_cell(r, "ip")))
            .map(|r| {
                json!({
                    "ip": string_cell(r, "ip"),
                    "user_count": i64_cell(r, "user_count"),
                    "usernames": r.try_get::<_, Vec<Option<String>>>("usernames").unwrap_or_default(),
                    "emails": r.try_get::<_, Vec<Option<String>>>("emails").unwrap_or_default(),
                })
            })
            .collect();
        out["historyMultiAccounts"] = json!(list);
    }

    if wants(section, "sharedRegistrationIps") {
        let rows = c
            .query(
                "SELECT registration_ip AS ip, COUNT(*)::int AS user_count,
                        json_agg(json_build_object(
                            'id', id, 'username', username, 'email', email,
                            'registrationIp', registration_ip, 'lastUsedAt', NULL,
                            'isBlocked', COALESCE(is_blocked, 0) <> 0) ORDER BY id) AS users
                   FROM users
                  WHERE registration_ip IS NOT NULL AND length(trim(registration_ip)) > 0
                  GROUP BY registration_ip
                 HAVING COUNT(*) > 1
                  ORDER BY user_count DESC, registration_ip ASC",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .filter(|r| is_useful_scan_ip(&string_cell(r, "ip")))
            .map(|r| {
                json!({
                    "ip": string_cell(r, "ip"),
                    "userCount": i64_cell(r, "user_count"),
                    "users": row_value(r, "users"),
                })
            })
            .collect();
        out["sharedRegistrationIps"] = json!(list);
    }

    if wants(section, "sharedDeviceIps") {
        let rows = c
            .query(
                "SELECT h.ip, COUNT(DISTINCT h.user_id)::int AS user_count,
                        MAX(h.last_used_at) AS last_seen_at,
                        json_agg(DISTINCT jsonb_build_object(
                            'id', u.id, 'username', u.username, 'email', u.email,
                            'registrationIp', u.registration_ip, 'lastUsedAt', h.last_used_at,
                            'isBlocked', COALESCE(u.is_blocked, 0) <> 0)) AS users
                   FROM user_history_ips h
                   JOIN users u ON u.id = h.user_id
                  WHERE h.ip IS NOT NULL AND length(trim(h.ip)) > 0
                  GROUP BY h.ip
                 HAVING COUNT(DISTINCT h.user_id) > 1
                  ORDER BY user_count DESC, MAX(h.last_used_at) DESC NULLS LAST, h.ip ASC",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .filter(|r| is_useful_scan_ip(&string_cell(r, "ip")))
            .map(|r| {
                let last = i64_cell(r, "last_seen_at");
                json!({
                    "ip": string_cell(r, "ip"),
                    "userCount": i64_cell(r, "user_count"),
                    "lastSeenAt": if last > 0 { json!(last) } else { Value::Null },
                    "users": row_value(r, "users"),
                })
            })
            .collect();
        out["sharedDeviceIps"] = json!(list);
    }

    if wants(section, "sharedFingerprints") {
        let rows = c
            .query(
                "SELECT d.fingerprint_hash, COUNT(DISTINCT d.user_id)::int AS user_count,
                        MAX(d.created_at) AS last_seen_at,
                        json_agg(DISTINCT jsonb_build_object(
                            'id', u.id, 'username', u.username, 'email', u.email,
                            'lastIp', d.ip, 'lastSeenAt', d.created_at)) AS users
                   FROM device_fingerprint_logs d
                   JOIN users u ON u.id = d.user_id
                  WHERE d.fingerprint_hash IS NOT NULL AND length(trim(d.fingerprint_hash)) > 0
                  GROUP BY d.fingerprint_hash
                 HAVING COUNT(DISTINCT d.user_id) > 1
                  ORDER BY user_count DESC, MAX(d.created_at) DESC NULLS LAST",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .map(|r| {
                let last = i64_cell(r, "last_seen_at");
                json!({
                    "fingerprintHash": string_cell(r, "fingerprint_hash"),
                    "userCount": i64_cell(r, "user_count"),
                    "lastSeenAt": if last > 0 { json!(last) } else { Value::Null },
                    "users": row_value(r, "users"),
                })
            })
            .collect();
        out["sharedFingerprints"] = json!(list);
    }

    if wants(section, "suspectedAutoReferrals") {
        let rows = c
            .query(
                "SELECT u1.id as referrer_id, u1.username as referrer_username, u1.registration_ip as referrer_ip,
                        u2.id as referred_id, u2.username as referred_username, u2.registration_ip as referred_ip
                   FROM referrals r
                   JOIN users u1 ON r.user_id = u1.id
                   JOIN users u2 ON r.referred_username = u2.username
                  WHERE u1.registration_ip = u2.registration_ip
                     OR EXISTS (SELECT 1 FROM user_history_ips h1
                                JOIN user_history_ips h2 ON h1.ip = h2.ip
                               WHERE h1.user_id = u1.id AND h2.user_id = u2.id)",
                &[],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "referrer_id": i64_cell(r, "referrer_id"),
                    "referrer_username": string_cell(r, "referrer_username"),
                    "referrer_ip": string_cell(r, "referrer_ip"),
                    "referred_id": i64_cell(r, "referred_id"),
                    "referred_username": string_cell(r, "referred_username"),
                    "referred_ip": string_cell(r, "referred_ip"),
                })
            })
            .collect();
        out["suspectedAutoReferrals"] = json!(list);
    }

    if wants(section, "accessLogs") {
        let rows = c
            .query(
                "SELECT id, ip, attempted_url, user_agent, details, created_at
                   FROM admin_access_logs ORDER BY created_at DESC LIMIT $1",
                &[&ACCESS_LOGS_LIMIT],
            )
            .await?;
        let list: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "id": i64_cell(r, "id"),
                    "ip": string_cell(r, "ip"),
                    "attempted_url": string_cell(r, "attempted_url"),
                    "user_agent": r.try_get::<_, Option<String>>("user_agent").ok().flatten(),
                    "details": r.try_get::<_, Option<String>>("details").ok().flatten(),
                    "created_at": i64_cell(r, "created_at"),
                })
            })
            .collect();
        out["accessLogs"] = json!(list);
    }

    if wants(section, "blacklist") {
        let (bl, blocked) = load_blacklist_payload(&c).await?;
        out["blacklist"] = bl;
        out["blockedUsers"] = blocked;
    }

    Ok(out)
}

async fn load_blacklist_payload(
    c: &deadpool_postgres::Object,
) -> Result<(Value, Value), PlayerReadError> {
    let blocked_rows = c
        .query(
            "SELECT u.id, u.username, u.email, u.registration_ip AS registration_ip
               FROM users u WHERE COALESCE(u.is_blocked, 0) <> 0 ORDER BY u.id DESC",
            &[],
        )
        .await?;
    let blocked: Vec<Value> = blocked_rows
        .iter()
        .map(|r| {
            json!({
                "id": i64_cell(r, "id"),
                "username": string_cell(r, "username"),
                "email": string_cell(r, "email"),
                "registrationIp": r.try_get::<_, Option<String>>("registration_ip").ok().flatten(),
                "blockedAt": Value::Null,
            })
        })
        .collect();

    let bl_rows = c
        .query(
            "SELECT ip, reason, added_at FROM ip_blacklist ORDER BY added_at DESC",
            &[],
        )
        .await?;
    let ip_keys: Vec<String> = bl_rows
        .iter()
        .map(|r| string_cell(r, "ip").trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut linked: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    if !ip_keys.is_empty() {
        let link_rows = c
            .query(
                "WITH ips AS (SELECT DISTINCT unnest($1::text[]) AS raw_ip)
                 SELECT lower(trim(ips.raw_ip::text)) AS ip_norm, u.id,
                        u.username::text AS username, u.email::text AS email, 'registro'::text AS via
                   FROM ips
                   JOIN users u ON u.registration_ip IS NOT NULL
                        AND lower(trim(u.registration_ip::text)) = lower(trim(ips.raw_ip::text))
                 UNION ALL
                 SELECT lower(trim(ips.raw_ip::text)), u.id, u.username::text, u.email::text, 'hist_login'::text
                   FROM ips
                   JOIN user_history_ips h ON lower(trim(h.ip::text)) = lower(trim(ips.raw_ip::text))
                   JOIN users u ON u.id = h.user_id",
                &[&ip_keys],
            )
            .await?;
        for r in &link_rows {
            let k = string_cell(r, "ip_norm").trim().to_ascii_lowercase();
            if k.is_empty() {
                continue;
            }
            let id = i64_cell(r, "id");
            let via = string_cell(r, "via");
            let arr = linked.entry(k).or_default();
            if let Some(existing) = arr.iter_mut().find(|e| e["id"] == json!(id)) {
                if !via.is_empty() {
                    let vias = existing["vias"].as_array_mut().unwrap();
                    if !vias.iter().any(|v| v == &json!(via)) {
                        vias.push(json!(via));
                    }
                }
            } else {
                arr.push(json!({
                    "id": id,
                    "username": string_cell(r, "username"),
                    "email": string_cell(r, "email"),
                    "vias": if via.is_empty() { json!([]) } else { json!([via]) },
                }));
            }
        }
    }

    let bl: Vec<Value> = bl_rows
        .iter()
        .map(|r| {
            let ip = string_cell(r, "ip");
            let norm = ip.trim().to_ascii_lowercase();
            json!({
                "ip": ip,
                "reason": r.try_get::<_, Option<String>>("reason").ok().flatten(),
                "added_at": i64_cell(r, "added_at"),
                "linkedUsers": linked.get(&norm).cloned().unwrap_or_default(),
            })
        })
        .collect();

    Ok((json!(bl), json!(blocked)))
}

// ---------------------------------------------------------------------------
// Blacklist add / remove
// ---------------------------------------------------------------------------

fn parse_blacklist_ip(v: Option<&Value>) -> Result<String, PlayerReadError> {
    let raw = match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if raw.is_empty() || raw.len() > IP_MAX {
        return Err(PlayerReadError::bad("IP requerido"));
    }
    Ok(raw)
}

pub async fn run_blacklist_add(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let ip = parse_blacklist_ip(body.get("ip"))?;
    let reason = match body.get("reason").and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() => s.chars().take(REASON_MAX).collect::<String>(),
        _ => DEFAULT_REASON.to_string(),
    };
    let at = now_ms();
    let c = pool.get().await?;
    c.execute(
        "INSERT INTO ip_blacklist (ip, reason, added_at) VALUES ($1, $2, $3)
         ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason",
        &[&ip, &reason, &at],
    )
    .await?;
    Ok(json!({ "ok": true }))
}

pub async fn run_blacklist_remove(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let ip = parse_blacklist_ip(body.get("ip"))?;
    let c = pool.get().await?;
    c.execute("DELETE FROM ip_blacklist WHERE ip = $1", &[&ip]).await?;
    Ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Device fingerprints
// ---------------------------------------------------------------------------

pub async fn run_device_fingerprints(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let limit = body
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(FP_DEFAULT_LIMIT)
        .clamp(1, FP_MAX_LIMIT);
    let offset = body.get("offset").and_then(Value::as_i64).unwrap_or(0).max(0);
    let event_type = match body.get("eventType").and_then(Value::as_str) {
        Some("login") => Some("login"),
        Some("register") => Some("register"),
        _ => None,
    };
    let user_id = body.get("userId").and_then(Value::as_i64).filter(|n| *n > 0);
    let q: String = body
        .get("q")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .replace(['%', '_'], "")
        .chars()
        .take(FP_SEARCH_MAX)
        .collect();

    let c = pool.get().await?;

    let mut where_sql = String::from(" WHERE 1=1");
    let mut binds: Vec<Box<dyn tokio_postgres::types::ToSql + Sync + Send>> = Vec::new();
    if let Some(et) = event_type {
        binds.push(Box::new(et.to_string()));
        where_sql.push_str(&format!(" AND d.event_type = ${}", binds.len()));
    }
    if let Some(uid) = user_id {
        binds.push(Box::new(uid as i32));
        where_sql.push_str(&format!(" AND d.user_id = ${}", binds.len()));
    }
    if !q.is_empty() {
        binds.push(Box::new(format!("%{q}%")));
        let p = binds.len();
        where_sql.push_str(&format!(
            " AND (d.fingerprint_hash ILIKE ${p} OR d.ip ILIKE ${p}
                  OR d.user_id IN (SELECT id FROM users WHERE email ILIKE ${p} OR username ILIKE ${p}))"
        ));
    }

    let refs: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = binds
        .iter()
        .map(|b| b.as_ref() as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();

    let total: i64 = c
        .query_one(
            &format!("SELECT COUNT(*)::bigint AS n FROM device_fingerprint_logs d{where_sql}"),
            &refs,
        )
        .await?
        .get("n");

    let list_sql = format!(
        "SELECT d.id, d.user_id, d.event_type, d.fingerprint_hash, d.payload_json, d.ip,
                d.user_agent, d.created_at, u.email, u.username
           FROM device_fingerprint_logs d
           LEFT JOIN users u ON u.id = d.user_id
          {where_sql}
          ORDER BY d.created_at DESC
          LIMIT {limit} OFFSET {offset}"
    );
    let rows = c.query(&list_sql, &refs).await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": i64_cell(r, "id").to_string(),
                "userId": i64_cell(r, "user_id"),
                "email": r.try_get::<_, Option<String>>("email").ok().flatten(),
                "username": r.try_get::<_, Option<String>>("username").ok().flatten(),
                "eventType": string_cell(r, "event_type"),
                "fingerprintHash": string_cell(r, "fingerprint_hash"),
                "payloadJson": r.try_get::<_, Option<String>>("payload_json").ok().flatten(),
                "ip": r.try_get::<_, Option<String>>("ip").ok().flatten(),
                "userAgent": r.try_get::<_, Option<String>>("user_agent").ok().flatten(),
                "createdAt": i64_cell(r, "created_at"),
            })
        })
        .collect();

    Ok(json!({ "rows": out, "total": total, "limit": limit, "offset": offset }))
}

// ---------------------------------------------------------------------------
// Bulk tools — config
// ---------------------------------------------------------------------------

fn parse_inactive_days(v: Option<&Value>) -> Option<i64> {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().map(|f| f as i64),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }?;
    if (MIN_INACTIVE_DAYS..=MAX_INACTIVE_DAYS).contains(&n) {
        Some(n)
    } else {
        None
    }
}

fn parse_bool_setting(v: Option<&str>) -> bool {
    matches!(
        v.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

async fn read_setting(c: &deadpool_postgres::Object, key: &str) -> Option<String> {
    c.query_opt("SELECT value FROM settings WHERE key = $1", &[&key])
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<_, Option<String>>("value").ok().flatten())
}

pub async fn run_bulk_config_get(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let days = parse_inactive_days(read_setting(&c, SETTING_INACTIVE_DAYS).await.map(Value::String).as_ref())
        .unwrap_or(DEFAULT_INACTIVE_BLOCK_DAYS);
    let auto = parse_bool_setting(read_setting(&c, SETTING_AUTO_ENABLED).await.as_deref());
    Ok(json!({ "ok": true, "inactiveBlockDays": days, "autoBlockEnabled": auto }))
}

pub async fn run_bulk_config_set(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let Some(days) = parse_inactive_days(body.get("inactiveBlockDays")) else {
        return Err(PlayerReadError::bad("Informe dias entre 1 e 3650."));
    };
    let auto = body
        .get("autoBlockEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let c = pool.get().await?;
    for (k, v) in [
        (SETTING_INACTIVE_DAYS, days.to_string()),
        (SETTING_AUTO_ENABLED, if auto { "1".into() } else { "0".into() }),
    ] {
        c.execute(
            "INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            &[&k, &v],
        )
        .await?;
    }
    Ok(json!({ "ok": true, "inactiveBlockDays": days, "autoBlockEnabled": auto }))
}

// ---------------------------------------------------------------------------
// Bulk tools — inactive block
// ---------------------------------------------------------------------------

const INACTIVE_FILTER_SQL: &str = "
    FROM users u
    LEFT JOIN game_states gs ON gs.user_id = u.id
   WHERE COALESCE(u.is_admin, 0) = 0
     AND COALESCE(u.is_super_admin, 0) = 0
     AND COALESCE(u.is_blocked, 0) = 0
     AND COALESCE(u.last_active_at, gs.last_updated_at) IS NOT NULL
     AND COALESCE(u.last_active_at, gs.last_updated_at) < $1";

async fn effective_days(c: &deadpool_postgres::Object, v: Option<&Value>) -> i64 {
    parse_inactive_days(v).unwrap_or({
        parse_inactive_days(read_setting(c, SETTING_INACTIVE_DAYS).await.map(Value::String).as_ref())
            .unwrap_or(DEFAULT_INACTIVE_BLOCK_DAYS)
    })
}

pub async fn run_inactive_block_preview(pool: &Pool, body: &Value) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let days = effective_days(&c, body.get("days")).await;
    let cutoff = now_ms() - days * MS_PER_DAY;
    let count: i64 = c
        .query_one(&format!("SELECT COUNT(*)::bigint AS n {INACTIVE_FILTER_SQL}"), &[&cutoff])
        .await?
        .get("n");
    Ok(json!({
        "ok": true, "days": days, "inactiveCount": count,
        "cutoffMs": cutoff, "excludesAdmins": true,
    }))
}

pub async fn run_inactive_block_apply(
    pool: &Pool,
    http: &reqwest::Client,
    cfg: &WorkerConfig,
    body: &Value,
) -> Result<Value, PlayerReadError> {
    let confirm = body
        .get("confirm")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    if confirm != INACTIVE_BLOCK_CONFIRM {
        return Err(PlayerReadError::bad(
            "Confirmação inválida. Envie { \"confirm\": \"BLOQUEAR\" } no corpo.",
        ));
    }
    let c = pool.get().await?;
    let days = effective_days(&c, body.get("days")).await;
    let cutoff = now_ms() - days * MS_PER_DAY;
    let id_rows = c
        .query(&format!("SELECT u.id {INACTIVE_FILTER_SQL}"), &[&cutoff])
        .await?;
    let ids: Vec<i64> = id_rows.iter().map(|r| i64_cell(r, "id")).collect();
    if ids.is_empty() {
        return Ok(json!({ "ok": true, "days": days, "blockedCount": 0 }));
    }
    let ids32: Vec<i32> = ids.iter().map(|&x| x as i32).collect();
    c.execute(
        "UPDATE users SET is_blocked = 1 WHERE id = ANY($1::int[])",
        &[&ids32],
    )
    .await?;
    auth_client::auth_session_delete_by_users(http, cfg, &ids).await?;
    Ok(json!({ "ok": true, "days": days, "blockedCount": ids.len() }))
}

// ---------------------------------------------------------------------------
// Bulk tools — force password reset
// ---------------------------------------------------------------------------

const PW_TARGET_FILTER: &str =
    "FROM users u WHERE COALESCE(u.is_admin, 0) = 0 AND COALESCE(u.is_super_admin, 0) = 0";

pub async fn run_pw_reset_preview(pool: &Pool) -> Result<Value, PlayerReadError> {
    let c = pool.get().await?;
    let count: i64 = c
        .query_one(&format!("SELECT COUNT(*)::bigint AS n {PW_TARGET_FILTER}"), &[])
        .await?
        .get("n");
    Ok(json!({
        "ok": true, "targetCount": count,
        "excludesAdmins": true, "excludesSuperAdmins": true,
    }))
}

pub async fn run_pw_reset_apply(
    pool: &Pool,
    http: &reqwest::Client,
    cfg: &WorkerConfig,
    body: &Value,
) -> Result<Value, PlayerReadError> {
    let confirm = body
        .get("confirm")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    if confirm != PW_RESET_CONFIRM {
        return Err(PlayerReadError::bad(
            "Confirmação inválida. Envie { \"confirm\": \"REDEFINIR\" } no corpo.",
        ));
    }
    let c = pool.get().await?;
    let id_rows = c
        .query(&format!("SELECT u.id {PW_TARGET_FILTER}"), &[])
        .await?;
    let ids: Vec<i64> = id_rows
        .iter()
        .map(|r| i64_cell(r, "id"))
        .filter(|&x| x > 0)
        .collect();
    if ids.is_empty() {
        return Ok(json!({ "ok": true, "resetCount": 0 }));
    }

    // One shared bcrypt hash of a random secret — players use "forgot password".
    let mut secret = [0u8; 32];
    getrandom::getrandom(&mut secret).map_err(|e| PlayerReadError::internal(format!("rng: {e}")))?;
    let secret_hex = hex::encode(secret);
    let hash = auth_client::auth_hash_password(http, cfg, &secret_hex).await?;

    let updated = c
        .execute(
            "UPDATE users
                SET password = $1, login_failure_count = 0, login_locked_until = NULL,
                    password_reset_token_hash = NULL, password_reset_token_expires_at = NULL
              WHERE COALESCE(is_admin, 0) = 0 AND COALESCE(is_super_admin, 0) = 0",
            &[&hash],
        )
        .await?;

    auth_client::auth_session_delete_by_users(http, cfg, &ids).await?;

    let n = if updated > 0 { updated as i64 } else { ids.len() as i64 };
    Ok(json!({
        "ok": true, "resetCount": n,
        "message": "Senhas alteradas. Jogadores devem usar \"Esqueci a senha\" para definir uma nova.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_ip_filter() {
        assert!(!is_useful_scan_ip("127.0.0.1"));
        assert!(!is_useful_scan_ip("10.0.0.4"));
        assert!(!is_useful_scan_ip("162.158.1.1")); // CF edge 162.158.0.0/15
        assert!(!is_useful_scan_ip("104.16.5.5")); // CF edge 104.16.0.0/13
        assert!(is_useful_scan_ip("201.13.173.87"));
        assert!(is_useful_scan_ip("2804:14c:d0:2075:7180:b193:c262:133a"));
    }

    #[test]
    fn inactive_days_bounds() {
        assert_eq!(parse_inactive_days(Some(&json!(90))), Some(90));
        assert_eq!(parse_inactive_days(Some(&json!("30"))), Some(30));
        assert_eq!(parse_inactive_days(Some(&json!(0))), None);
        assert_eq!(parse_inactive_days(Some(&json!(4000))), None);
    }

    #[test]
    fn paths_stable() {
        assert_eq!(SECURITY_STATS_PATH, "/v1/admin/security/stats");
    }
}
