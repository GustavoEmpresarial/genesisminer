//! Partners YouTube player I/O — Node `partners.controller` + services.

use deadpool_postgres::Pool;
use genesis_core::time::MS_PER_DAY;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio_postgres::error::SqlState;
use uuid::Uuid;

use crate::config::NFT_AUTO_ROOM_ID;
use crate::player_reads::{i64_cell, now_ms, pg_user_id, string_cell, PlayerReadError};
use crate::users::{run_assert_active_user, AssertActiveError, AssertActiveRequest};

pub const PARTNERS_STATE_PATH: &str = "/v1/partners/state";
pub const PARTNERS_VIDEOS_PATH: &str = "/v1/partners/videos";
pub const PARTNERS_VIDEO_BY_ID_PATH: &str = "/v1/partners/video-by-id";
pub const PARTNERS_MY_SUBMISSIONS_PATH: &str = "/v1/partners/my-submissions";
pub const PARTNERS_SUBMIT_PATH: &str = "/v1/partners/videos/submit";
pub const PARTNERS_APPLY_PATH: &str = "/v1/partners/youtube/apply";
pub const PARTNERS_PROFILE_PATH: &str = "/v1/partners/youtube/my-profile";

const DEFAULT_LIMIT: i64 = 24;
const MAX_LIMIT: i64 = 48;
const USER_SUBMISSIONS_TAKE: i64 = 50;
const TITLE_MAX_LENGTH: usize = 200;
const TITLE_MIN_LENGTH: usize = 3;
const DESCRIPTION_SHOWCASE_MAX: usize = 800;
const DESCRIPTION_SUBMIT_MAX: usize = 2000;
const REJECT_REASON_MAX_LENGTH: usize = 500;
const VIDEO_PUBLIC_ID_MAX_LENGTH: usize = 120;
const MAX_SUBMISSIONS_PER_UTC_DAY: i64 = 1;
const CHANNEL_NAME_MIN_LENGTH: usize = 2;
const CHANNEL_NAME_MAX_LENGTH: usize = 120;
const CHANNEL_DESCRIPTION_MAX_LENGTH: usize = 800;
const CHANNEL_URL_MAX_LENGTH: usize = 500;
const AVATAR_URL_MAX_LENGTH: usize = 800;
const CURSOR_ID_MAX_LENGTH: usize = 120;
const CURSOR_ID_MIN_LENGTH: usize = 8;
const NFT_ROOM_COMPLIANCE_REQUIRED_DAYS: i64 = 60;
const YEAR_MULTIPLIER: i64 = 10_000;
const MONTH_MULTIPLIER: i64 = 100;
const YOUTUBE_VIDEO_ID_LEN: usize = 11;
const SECONDS_PER_DAY: i64 = 86_400;
const DAYS_FROM_CIVIL_EPOCH_TO_UNIX: i64 = 719_468;
const ERA_DAYS: i64 = 146_097;
const ERA_YEARS: i64 = 400;

const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_FORBIDDEN: u16 = 403;
const HTTP_NOT_FOUND: u16 = 404;
const HTTP_CONFLICT: u16 = 409;
const HTTP_UNPROCESSABLE: u16 = 422;
const HTTP_CREATED: u16 = 201;
const HTTP_INTERNAL: u16 = 500;
const HTTP_OK: u16 = 200;

const PG_UNIQUE_VIOLATION: &str = "23505";

const _: () = assert!(DEFAULT_LIMIT == 24);
const _: () = assert!(MAX_LIMIT == 48);
const _: () = assert!(MAX_SUBMISSIONS_PER_UTC_DAY == 1);
const _: () = assert!(NFT_ROOM_COMPLIANCE_REQUIRED_DAYS == 60);
const _: () = assert!(MS_PER_DAY == 86_400_000);
const _: () = assert!(YOUTUBE_VIDEO_ID_LEN == 11);
const _: () = assert!(HTTP_CREATED == 201);

#[derive(Debug)]
pub struct PartnersError {
    pub http_status: u16,
    pub body: Value,
}

impl PartnersError {
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            http_status: HTTP_INTERNAL,
            body: json!({ "error": msg.into() }),
        }
    }
}

impl From<PlayerReadError> for PartnersError {
    fn from(e: PlayerReadError) -> Self {
        let mut m = serde_json::Map::new();
        m.insert("error".into(), json!(e.error));
        if let Some(c) = e.code {
            m.insert("code".into(), json!(c));
        }
        Self {
            http_status: e.http_status,
            body: Value::Object(m),
        }
    }
}

impl From<deadpool_postgres::PoolError> for PartnersError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::internal(e.to_string())
    }
}

impl From<tokio_postgres::Error> for PartnersError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::internal(e.to_string())
    }
}

fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code() == Some(&SqlState::UNIQUE_VIOLATION)
        || err
            .code()
            .map(|c| c.code() == PG_UNIQUE_VIOLATION)
            .unwrap_or(false)
}

async fn require_active(pool: &Pool, user_id: i64) -> Result<(), PartnersError> {
    match run_assert_active_user(pool, AssertActiveRequest { user_id }).await {
        Ok(_) => Ok(()),
        Err(AssertActiveError {
            http_status,
            message,
            code,
        }) => Err(PartnersError {
            http_status,
            body: json!({ "error": message, "code": code }),
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersStateRequest {
    pub user_id: Option<i64>,
    pub limit: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersVideosRequest {
    pub limit: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersVideoByIdRequest {
    pub public_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersUserRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersSubmitRequest {
    pub user_id: i64,
    pub title: Option<Value>,
    pub youtube_url: Option<Value>,
    pub description: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersApplyRequest {
    pub user_id: i64,
    pub channel_name: Option<Value>,
    pub channel_url: Option<Value>,
    pub avatar_url: Option<Value>,
    pub description: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnersProfileRequest {
    pub user_id: i64,
    pub channel_name: Option<Value>,
    pub avatar_url: Option<Value>,
}

fn is_youtube_video_id(id: &str) -> bool {
    id.len() == YOUTUBE_VIDEO_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Civil YYYY-MM-DD from Unix seconds (Howard Hinnant algorithm).
fn utc_ymd_from_unix_secs(secs: i64) -> (i32, u32, u32) {
    let z = secs.div_euclid(SECONDS_PER_DAY) + DAYS_FROM_CIVIL_EPOCH_TO_UNIX;
    let era = if z >= 0 { z } else { z - ERA_DAYS + 1 }.div_euclid(ERA_DAYS);
    let doe = (z - era * ERA_DAYS) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * ERA_YEARS;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn partner_youtube_utc_day_key_yyyyymmdd(ts: i64) -> i64 {
    let ms = if ts > 0 { ts } else { now_ms() };
    let secs = ms / 1000;
    let (y, m, d) = utc_ymd_from_unix_secs(secs);
    i64::from(y) * YEAR_MULTIPLIER + i64::from(m) * MONTH_MULTIPLIER + i64::from(d)
}

fn strip_www(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

fn starts_with_http_scheme(s: &str) -> bool {
    let lower: String = s.chars().take(8).collect::<String>().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn parse_host_path_query(raw: &str) -> Option<(String, String, String)> {
    let with_proto = if starts_with_http_scheme(raw) {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let rest = with_proto
        .strip_prefix("https://")
        .or_else(|| with_proto.strip_prefix("http://"))
        .or_else(|| {
            let l = with_proto.to_ascii_lowercase();
            if l.starts_with("https://") {
                Some(&with_proto["https://".len()..])
            } else if l.starts_with("http://") {
                Some(&with_proto["http://".len()..])
            } else {
                None
            }
        })?;
    // case-insensitive strip already handled via with_proto construction for https prefer
    let rest = if with_proto.to_ascii_lowercase().starts_with("https://") {
        &with_proto[8..]
    } else if with_proto.to_ascii_lowercase().starts_with("http://") {
        &with_proto[7..]
    } else {
        rest
    };
    let (authority, path_q) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => match rest.find('?') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        },
    };
    let host = authority
        .split('@')
        .next_back()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let (path, query) = match path_q.find('?') {
        Some(i) => (&path_q[..i], &path_q[i + 1..]),
        None => (path_q, ""),
    };
    Some((host, path.to_string(), query.to_string()))
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for part in query.split('&') {
        let mut it = part.splitn(2, '=');
        let k = it.next()?;
        if k == key {
            return Some(it.next().unwrap_or("").to_string());
        }
    }
    None
}

fn extract_youtube_video_id(raw_url: &str) -> String {
    let u = raw_url.trim();
    if u.is_empty() {
        return String::new();
    }
    let Some((host, path, query)) = parse_host_path_query(u) else {
        return String::new();
    };
    let host = strip_www(&host);
    if host == "youtu.be" {
        let id = path.trim_start_matches('/').split('/').next().unwrap_or("");
        return if is_youtube_video_id(id) {
            id.to_string()
        } else {
            String::new()
        };
    }
    if host == "youtube.com" || host == "m.youtube.com" {
        let p = path.to_ascii_lowercase();
        if p.starts_with("/watch") {
            let v = query_param(&query, "v").unwrap_or_default();
            return if is_youtube_video_id(&v) {
                v
            } else {
                String::new()
            };
        }
        if let Some(rest) = p.strip_prefix("/embed/") {
            let id = rest.split('/').next().unwrap_or("").trim();
            return if is_youtube_video_id(id) {
                id.to_string()
            } else {
                String::new()
            };
        }
        if let Some(rest) = p.strip_prefix("/shorts/") {
            let id = rest.split('/').next().unwrap_or("").trim();
            return if is_youtube_video_id(id) {
                id.to_string()
            } else {
                String::new()
            };
        }
    }
    String::new()
}

fn validate_and_canonical_youtube_url(raw: &str) -> Option<(String, String)> {
    let t = raw.trim();
    if t.is_empty() || t.len() > CHANNEL_URL_MAX_LENGTH {
        return None;
    }
    if t.chars().any(|c| {
        matches!(
            c,
            '\0'..='\u{08}' | '\u{0b}' | '\u{0c}' | '\u{0e}'..='\u{1f}' | '<' | '>'
        )
    }) {
        return None;
    }
    let lower = t.to_ascii_lowercase();
    if lower.contains("javascript:") || lower.contains("data:") || lower.contains("vbscript:") {
        return None;
    }
    if !lower.starts_with("https://") && starts_with_http_scheme(t) {
        return None;
    }
    let with_https = if lower.starts_with("https://") {
        t.to_string()
    } else {
        format!("https://{}", t.trim_start_matches('/'))
    };
    let (host, _, _) = parse_host_path_query(&with_https)?;
    let host = strip_www(&host);
    if host != "youtube.com" && host != "m.youtube.com" && host != "youtu.be" {
        return None;
    }
    let video_id = extract_youtube_video_id(t);
    if video_id.is_empty() {
        return None;
    }
    Some((
        video_id.clone(),
        format!("https://www.youtube.com/watch?v={video_id}"),
    ))
}

fn youtube_thumbnail_url(video_id: &str) -> String {
    if !is_youtube_video_id(video_id) {
        return String::new();
    }
    format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")
}

fn youtube_embed_url(video_id: &str) -> String {
    if !is_youtube_video_id(video_id) {
        return String::new();
    }
    format!("https://www.youtube.com/embed/{video_id}")
}

fn sanitize_channel_name(raw: &str) -> String {
    raw.trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(CHANNEL_NAME_MAX_LENGTH)
        .collect()
}

fn sanitize_channel_description(raw: &str) -> String {
    raw.trim()
        .chars()
        .take(CHANNEL_DESCRIPTION_MAX_LENGTH)
        .collect()
}

fn sanitize_channel_url(raw: &str) -> String {
    let t: String = raw.trim().chars().take(CHANNEL_URL_MAX_LENGTH).collect();
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    let with_proto = if lower.starts_with("https://") {
        t.clone()
    } else if starts_with_http_scheme(&t) {
        return String::new();
    } else {
        format!("https://{}", t.trim_start_matches('/'))
    };
    let Some((host, path, _)) = parse_host_path_query(&with_proto) else {
        return String::new();
    };
    let host = strip_www(&host);
    if host == "youtube.com" || host == "m.youtube.com" {
        let p = path.to_ascii_lowercase();
        if p.starts_with("/watch") || p.starts_with("/shorts/") || p.starts_with("/embed/") {
            return String::new();
        }
        if p == "/" || p.is_empty() {
            return String::new();
        }
        return with_proto;
    }
    String::new()
}

fn sanitize_avatar_url(raw: &str) -> String {
    let t: String = raw.trim().chars().take(AVATAR_URL_MAX_LENGTH).collect();
    if t.is_empty() {
        return String::new();
    }
    if t.to_ascii_lowercase().starts_with("https://") {
        // minimal absolute URL check
        if parse_host_path_query(&t).is_some() {
            return t;
        }
        return String::new();
    }
    if t.contains("..") {
        return String::new();
    }
    if t.starts_with('/') {
        let ok = t.chars().enumerate().all(|(i, c)| {
            if i == 0 {
                return true;
            }
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '?' | '#' | '+' | '%')
        }) && t.len() <= 701;
        if ok {
            return t;
        }
    }
    String::new()
}

const PARTNER_LEVEL_IDS: &[&str] = &["partners", "parceiros", "partner", "parceiro"];

fn user_access_has_partner(id_set: &HashSet<String>) -> bool {
    id_set.iter().any(|x| {
        let l = x.to_ascii_lowercase();
        PARTNER_LEVEL_IDS.contains(&l.trim())
    })
}

fn encode_cursor(sort_ts: i64, id: &str) -> String {
    format!("{sort_ts}_{id}")
}

fn parse_cursor(raw: Option<&str>) -> Option<(i64, String)> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let i = s.find('_')?;
    if i == 0 {
        return None;
    }
    let ts_part = &s[..i];
    let id = &s[i + 1..];
    if !ts_part.chars().all(|c| c.is_ascii_digit())
        || id.is_empty()
        || id.len() > CURSOR_ID_MAX_LENGTH
        || id.len() < CURSOR_ID_MIN_LENGTH
    {
        return None;
    }
    let sort_ts: i64 = ts_part.parse().ok()?;
    Some((sort_ts, id.to_string()))
}

fn clamp_limit(raw: Option<&str>) -> i64 {
    let n = raw
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    n.clamp(1, MAX_LIMIT)
}

fn value_str(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| other.to_string()),
        None => String::new(),
    }
}

fn map_approved_row(r: &tokio_postgres::Row) -> Value {
    let reviewed = i64_cell(r, "reviewed_at");
    let created = i64_cell(r, "created_at");
    let published_at = if reviewed > 0 { reviewed } else { created };
    let vid = string_cell(r, "youtube_video_id");
    let display = {
        let d = string_cell(r, "partner_display_name");
        if d.is_empty() {
            "Parceiro".to_string()
        } else {
            d
        }
    };
    let title: String = string_cell(r, "title")
        .chars()
        .take(TITLE_MAX_LENGTH)
        .collect();
    let description: String = string_cell(r, "description")
        .chars()
        .take(DESCRIPTION_SHOWCASE_MAX)
        .collect();
    json!({
        "publicId": string_cell(r, "id"),
        "title": title,
        "youtubeUrl": string_cell(r, "youtube_url"),
        "youtubeVideoId": vid,
        "thumbnailUrl": youtube_thumbnail_url(&vid),
        "embedUrl": youtube_embed_url(&vid),
        "description": description,
        "publishedAt": published_at,
        "creator": {
            "displayName": display,
            "channelUrl": string_cell(r, "partner_channel_url"),
            "avatarUrl": string_cell(r, "partner_avatar_url"),
        }
    })
}

const APPROVED_SELECT: &str = r#"
      SELECT s.id, s.title, s.youtube_url, s.youtube_video_id, s.description, s.created_at, s.reviewed_at,
             u.id AS user_id,
             u.username,
             COALESCE(NULLIF(BTRIM(p.channel_name), ''), u.username) AS partner_display_name,
             COALESCE(NULLIF(BTRIM(p.channel_url), ''), '') AS partner_channel_url,
             COALESCE(NULLIF(BTRIM(p.avatar_url), ''), '') AS partner_avatar_url
      FROM partner_youtube_submissions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN partner_youtube_creator_profiles p ON p.user_id = u.id
      WHERE s.status = 'approved'
"#;

async fn list_approved(
    pool: &Pool,
    lim: i64,
    cursor: Option<(i64, String)>,
) -> Result<Vec<tokio_postgres::Row>, PartnersError> {
    let conn = pool.get().await?;
    if let Some((sort_ts, id)) = cursor {
        Ok(conn
            .query(
                &format!(
                    "{APPROVED_SELECT}
      AND (
        COALESCE(s.reviewed_at, s.created_at) < $1
        OR (COALESCE(s.reviewed_at, s.created_at) = $1 AND s.id < $2)
      )
      ORDER BY COALESCE(s.reviewed_at, s.created_at) DESC, s.id DESC
      LIMIT $3"
                ),
                &[&sort_ts, &id, &lim],
            )
            .await?)
    } else {
        Ok(conn
            .query(
                &format!(
                    "{APPROVED_SELECT}
      ORDER BY COALESCE(s.reviewed_at, s.created_at) DESC, s.id DESC
      LIMIT $1"
                ),
                &[&lim],
            )
            .await?)
    }
}

async fn get_access_level_ids(pool: &Pool, uid: i32) -> Result<HashSet<String>, PartnersError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            r#"
            SELECT DISTINCT LOWER(TRIM(COALESCE(al, ''))) AS lid FROM (
              SELECT access_level_id::text AS al FROM users WHERE id = $1
              UNION ALL
              SELECT access_level_id::text AS al FROM user_access_levels WHERE user_id = $1
            ) q WHERE TRIM(COALESCE(al, '')) <> ''
            "#,
            &[&uid],
        )
        .await?;
    Ok(rows.iter().map(|r| string_cell(r, "lid")).collect())
}

async fn is_manual_allowlisted(pool: &Pool, uid: i32) -> Result<bool, PartnersError> {
    let conn = pool.get().await?;
    Ok(conn
        .query_opt(
            "SELECT user_id FROM partner_youtube_manual_allowlist WHERE user_id = $1",
            &[&uid],
        )
        .await?
        .is_some())
}

async fn count_submissions_today(pool: &Pool, uid: i32, day: i64) -> Result<i64, PartnersError> {
    let conn = pool.get().await?;
    // `submit_utc_day` is an int4 YYYYMMDD column — bind i32, not i64.
    let day_i32 = day as i32;
    let row = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS c FROM partner_youtube_submissions
              WHERE user_id = $1 AND submit_utc_day = $2",
            &[&uid, &day_i32],
        )
        .await?;
    Ok(i64_cell(&row, "c"))
}

async fn list_by_user(pool: &Pool, uid: i32) -> Result<Vec<Value>, PartnersError> {
    let conn = pool.get().await?;
    let rows = conn
        .query(
            "SELECT id, title, youtube_url, youtube_video_id, description, status,
                    created_at, reviewed_at, reject_reason
               FROM partner_youtube_submissions
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT $2",
            &[&uid, &USER_SUBMISSIONS_TAKE],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let reject = string_cell(r, "reject_reason");
            let reject = if reject.is_empty() {
                None
            } else {
                Some(
                    reject
                        .chars()
                        .take(REJECT_REASON_MAX_LENGTH)
                        .collect::<String>(),
                )
            };
            let reviewed = i64_cell(r, "reviewed_at");
            let mut obj = json!({
                "publicId": string_cell(r, "id"),
                "title": string_cell(r, "title"),
                "youtubeUrl": string_cell(r, "youtube_url"),
                "youtubeVideoId": string_cell(r, "youtube_video_id"),
                "description": string_cell(r, "description"),
                "status": string_cell(r, "status"),
                "createdAt": i64_cell(r, "created_at"),
            });
            if reviewed > 0 {
                obj["reviewedAt"] = json!(reviewed);
            }
            if let Some(rr) = reject {
                obj["rejectReasonPublic"] = json!(rr);
            }
            obj
        })
        .collect())
}

async fn get_application(pool: &Pool, uid: i32) -> Result<Option<Value>, PartnersError> {
    let conn = pool.get().await?;
    let row = conn
        .query_opt(
            "SELECT id, channel_name, channel_url, avatar_url, description, status,
                    created_at, reject_reason
               FROM partner_youtube_applications
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT 1",
            &[&uid],
        )
        .await?;
    Ok(row.map(|r| {
        let reject = string_cell(&r, "reject_reason");
        let mut obj = json!({
            "id": string_cell(&r, "id"),
            "status": string_cell(&r, "status"),
            "channelName": string_cell(&r, "channel_name"),
            "channelUrl": string_cell(&r, "channel_url"),
            "avatarUrl": string_cell(&r, "avatar_url"),
            "description": string_cell(&r, "description"),
            "createdAt": i64_cell(&r, "created_at"),
        });
        if !reject.is_empty() {
            obj["rejectReason"] = json!(reject
                .chars()
                .take(REJECT_REASON_MAX_LENGTH)
                .collect::<String>());
        }
        obj
    }))
}

async fn get_creator_profile(pool: &Pool, uid: i32) -> Result<Option<Value>, PartnersError> {
    let conn = pool.get().await?;
    let row = conn
        .query_opt(
            "SELECT channel_name, channel_url, avatar_url, description
               FROM partner_youtube_creator_profiles WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    Ok(row.map(|r| {
        json!({
            "channelName": string_cell(&r, "channel_name").trim(),
            "channelUrl": string_cell(&r, "channel_url").trim(),
            "avatarUrl": string_cell(&r, "avatar_url").trim(),
            "description": string_cell(&r, "description").trim(),
            "canEditChannelUrl": false,
        })
    }))
}

async fn build_nft_room_status(pool: &Pool, uid: i32) -> Result<Value, PartnersError> {
    let window_ms = NFT_ROOM_COMPLIANCE_REQUIRED_DAYS * (MS_PER_DAY as i64);
    let conn = pool.get().await?;
    let active = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS c FROM user_rig_rooms WHERE user_id = $1 AND room_id = $2",
            &[&uid, &NFT_AUTO_ROOM_ID],
        )
        .await
        .map(|r| i64_cell(&r, "c") > 0)?;
    let last_row = conn
        .query_opt(
            "SELECT COALESCE(reviewed_at, created_at) AS ts
               FROM partner_youtube_submissions
              WHERE user_id = $1 AND status = 'approved'
              ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
              LIMIT 1",
            &[&uid],
        )
        .await?;
    let last_approved_at = last_row.and_then(|r| {
        let ts = i64_cell(&r, "ts");
        if ts > 0 {
            Some(ts)
        } else {
            None
        }
    });
    let since60 = now_ms() - window_ms;
    let approved_last = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS c FROM partner_youtube_submissions
              WHERE user_id = $1 AND status = 'approved'
                AND COALESCE(reviewed_at, created_at) >= $2",
            &[&uid, &since60],
        )
        .await
        .map(|r| i64_cell(&r, "c"))?;
    let last_ms = last_approved_at.unwrap_or(0);
    let next_deadline = if last_ms > 0 {
        Some(last_ms + window_ms)
    } else {
        None
    };
    let overdue = active && approved_last == 0;
    let compliant = !active || !overdue;
    Ok(json!({
        "active": active,
        "compliant": compliant,
        "overdue": overdue,
        "requiredIntervalDays": NFT_ROOM_COMPLIANCE_REQUIRED_DAYS,
        "lastApprovedAt": last_approved_at,
        "nextDeadlineAt": next_deadline,
        "approvedLast60d": approved_last,
    }))
}

pub async fn run_partners_state(
    pool: &Pool,
    req: PartnersStateRequest,
) -> Result<Value, PartnersError> {
    let lim = clamp_limit(req.limit.as_deref());
    let cursor = parse_cursor(req.cursor.as_deref());
    let rows = list_approved(pool, lim, cursor).await?;
    let videos: Vec<Value> = rows.iter().map(map_approved_row).collect();
    let next_cursor = if rows.len() as i64 == lim {
        rows.last().map(|r| {
            let reviewed = i64_cell(r, "reviewed_at");
            let created = i64_cell(r, "created_at");
            let ts = if reviewed > 0 { reviewed } else { created };
            encode_cursor(ts, &string_cell(r, "id"))
        })
    } else {
        None
    };
    let page = json!({
        "limit": lim,
        "videos": videos,
        "pagination": { "nextCursor": next_cursor, "limit": lim },
        "empty": videos.is_empty() && req.cursor.as_deref().unwrap_or("").is_empty(),
    });
    let mut base = json!({
        "ok": true,
        "page": {
            "title": "Parceiros YouTube",
            "subtitle": "Vídeos aprovados pela equipa — vitrine ao estilo comunidade. Parceiros podem enviar até 1 vídeo por dia (UTC).",
            "emptyMessage": "Ainda não há vídeos aprovados. Volta mais tarde!",
            "rules": {
                "maxSubmissionsPerUtcDay": MAX_SUBMISSIONS_PER_UTC_DAY,
                "allowedHosts": ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]
            }
        },
        "showcase": page,
    });

    let Some(user_id) = req.user_id.filter(|u| *u > 0) else {
        base["auth"] = json!({ "authenticated": false });
        return Ok(base);
    };
    let uid = pg_user_id(user_id)?;
    let id_set = get_access_level_ids(pool, uid).await?;
    let manual = is_manual_allowlisted(pool, uid).await?;
    let is_partner = user_access_has_partner(&id_set) || manual;
    let day_key = partner_youtube_utc_day_key_yyyyymmdd(now_ms());
    let used_today = count_submissions_today(pool, uid, day_key).await?;
    let list_rows = list_by_user(pool, uid).await?;
    let application = get_application(pool, uid).await?;
    let creator = get_creator_profile(pool, uid).await?;
    let nft_room = if is_partner {
        Some(build_nft_room_status(pool, uid).await?)
    } else {
        None
    };
    let app_status = application
        .as_ref()
        .and_then(|a| a.get("status").and_then(|s| s.as_str()))
        .unwrap_or("");
    let can_apply = !is_partner && (application.is_none() || app_status == "rejected");

    base["auth"] = json!({
        "authenticated": true,
        "isPartner": is_partner,
        "canSubmitToday": is_partner && used_today < MAX_SUBMISSIONS_PER_UTC_DAY,
        "submissionsToday": used_today,
        "application": application,
        "canApply": can_apply,
    });
    base["creatorProfile"] = creator.unwrap_or(Value::Null);
    base["nftRoom"] = nft_room.unwrap_or(Value::Null);
    base["mySubmissions"] = Value::Array(list_rows);
    Ok(base)
}

pub async fn run_partners_videos(
    pool: &Pool,
    req: PartnersVideosRequest,
) -> Result<Value, PartnersError> {
    let st = run_partners_state(
        pool,
        PartnersStateRequest {
            user_id: None,
            limit: req.limit,
            cursor: req.cursor,
        },
    )
    .await?;
    let showcase = st.get("showcase").cloned().unwrap_or(json!({}));
    Ok(json!({
        "ok": true,
        "videos": showcase.get("videos").cloned().unwrap_or(json!([])),
        "pagination": showcase.get("pagination").cloned().unwrap_or(json!({
            "nextCursor": Value::Null,
            "limit": DEFAULT_LIMIT,
        })),
    }))
}

pub async fn run_partners_video_by_id(
    pool: &Pool,
    public_id: &str,
) -> Result<(u16, Value), PartnersError> {
    let id: String = public_id
        .trim()
        .chars()
        .take(VIDEO_PUBLIC_ID_MAX_LENGTH)
        .collect();
    if id.is_empty() {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid ID.", "code": "VALIDATION" }),
        ));
    }
    let conn = pool.get().await?;
    let row = conn
        .query_opt(&format!("{APPROVED_SELECT} AND s.id = $1 LIMIT 1"), &[&id])
        .await?;
    match row {
        Some(r) => Ok((
            HTTP_OK,
            json!({ "ok": true, "video": map_approved_row(&r) }),
        )),
        None => Ok((
            HTTP_NOT_FOUND,
            json!({ "error": "Video not found.", "code": "NOT_FOUND" }),
        )),
    }
}

pub async fn run_my_submissions(pool: &Pool, user_id: i64) -> Result<Value, PartnersError> {
    require_active(pool, user_id).await?;
    let st = run_partners_state(
        pool,
        PartnersStateRequest {
            user_id: Some(user_id),
            limit: None,
            cursor: None,
        },
    )
    .await?;
    Ok(json!({
        "ok": true,
        "mySubmissions": st.get("mySubmissions").cloned().unwrap_or(json!([])),
        "auth": st.get("auth").cloned().unwrap_or(json!({})),
    }))
}

pub async fn run_submit_video(
    pool: &Pool,
    req: PartnersSubmitRequest,
) -> Result<(u16, Value), PartnersError> {
    require_active(pool, req.user_id).await?;
    let title: String = value_str(&req.title)
        .trim()
        .chars()
        .take(TITLE_MAX_LENGTH)
        .collect();
    if title.len() < TITLE_MIN_LENGTH {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid title (min. 3 characters).", "code": "VALIDATION" }),
        ));
    }
    let Some((video_id, canonical)) =
        validate_and_canonical_youtube_url(&value_str(&req.youtube_url))
    else {
        return Ok((
            HTTP_UNPROCESSABLE,
            json!({
                "error": "Invalid YouTube URL (use only youtube.com, m.youtube.com, or youtu.be).",
                "code": "INVALID_URL"
            }),
        ));
    };
    let uid = pg_user_id(req.user_id)?;
    let id_set = get_access_level_ids(pool, uid).await?;
    let manual = is_manual_allowlisted(pool, uid).await?;
    if !user_access_has_partner(&id_set) && !manual {
        return Ok((
            HTTP_FORBIDDEN,
            json!({
                "error": "Only accounts with Partners level or added by admin in YouTube Partners can submit videos.",
                "code": "NOT_PARTNER"
            }),
        ));
    }
    let conn = pool.get().await?;
    let dup = conn
        .query_one(
            "SELECT COUNT(*)::bigint AS c FROM partner_youtube_submissions
              WHERE youtube_video_id = $1 AND status IN ('pending', 'approved')",
            &[&video_id],
        )
        .await
        .map(|r| i64_cell(&r, "c"))?;
    if dup > 0 {
        return Ok((
            HTTP_CONFLICT,
            json!({
                "error": "This video is already in the review queue or showcase. Choose another link.",
                "code": "DUPLICATE_VIDEO"
            }),
        ));
    }
    let description: String = value_str(&req.description)
        .trim()
        .chars()
        .take(DESCRIPTION_SUBMIT_MAX)
        .collect();
    // `submit_utc_day` is an int4 YYYYMMDD column — bind i32, not i64.
    let day_key = partner_youtube_utc_day_key_yyyyymmdd(now_ms()) as i32;
    let id = Uuid::new_v4().to_string();
    let created = now_ms();
    match conn
        .execute(
            "INSERT INTO partner_youtube_submissions
                (id, user_id, title, youtube_url, youtube_video_id, description, status, created_at, submit_utc_day)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)",
            &[
                &id,
                &uid,
                &title,
                &canonical,
                &video_id,
                &description,
                &created,
                &day_key,
            ],
        )
        .await
    {
        Ok(_) => Ok((
            HTTP_CREATED,
            json!({ "ok": true, "publicId": id, "id": id, "status": "pending" }),
        )),
        Err(e) if is_unique_violation(&e) => Ok((
            HTTP_CONFLICT,
            json!({
                "error": "Daily limit of 1 submission (UTC) reached or submission conflict. Try again in a moment.",
                "code": "DAILY_LIMIT_OR_CONFLICT"
            }),
        )),
        Err(e) => Err(e.into()),
    }
}

pub async fn run_apply(
    pool: &Pool,
    req: PartnersApplyRequest,
) -> Result<(u16, Value), PartnersError> {
    require_active(pool, req.user_id).await?;
    let uid = pg_user_id(req.user_id)?;
    let id_set = get_access_level_ids(pool, uid).await?;
    let manual = is_manual_allowlisted(pool, uid).await?;
    if user_access_has_partner(&id_set) || manual {
        return Ok((
            HTTP_CONFLICT,
            json!({ "error": "You are already a YouTube partner.", "code": "ALREADY_PARTNER" }),
        ));
    }
    let conn = pool.get().await?;
    let pending = conn
        .query_opt(
            "SELECT id FROM partner_youtube_applications
              WHERE user_id = $1 AND status = 'pending'
              ORDER BY created_at DESC LIMIT 1",
            &[&uid],
        )
        .await?;
    if pending.is_some() {
        return Ok((
            HTTP_CONFLICT,
            json!({ "error": "You already have a pending application.", "code": "PENDING_APPLICATION" }),
        ));
    }
    let channel_name = sanitize_channel_name(&value_str(&req.channel_name));
    if channel_name.len() < CHANNEL_NAME_MIN_LENGTH {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid channel name (min. 2 characters).", "code": "VALIDATION" }),
        ));
    }
    let channel_url = sanitize_channel_url(&value_str(&req.channel_url));
    if channel_url.is_empty() {
        return Ok((
            HTTP_UNPROCESSABLE,
            json!({
                "error": "Invalid channel URL. Use an https:// YouTube link (e.g. /@yourchannel or /channel/...).",
                "code": "INVALID_CHANNEL_URL"
            }),
        ));
    }
    let avatar_url = sanitize_avatar_url(&value_str(&req.avatar_url));
    if avatar_url.is_empty() {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Upload a channel photo/cover (PNG, JPG, or WEBP).", "code": "AVATAR_REQUIRED" }),
        ));
    }
    let description = sanitize_channel_description(&value_str(&req.description));
    let id = Uuid::new_v4().to_string();
    let created = now_ms();
    match conn
        .execute(
            "INSERT INTO partner_youtube_applications
                (id, user_id, channel_name, channel_url, avatar_url, description, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)",
            &[
                &id,
                &uid,
                &channel_name,
                &channel_url,
                &avatar_url,
                &description,
                &created,
            ],
        )
        .await
    {
        Ok(_) => Ok((
            HTTP_CREATED,
            json!({ "ok": true, "id": id, "status": "pending" }),
        )),
        Err(e) if is_unique_violation(&e) => Ok((
            HTTP_CONFLICT,
            json!({ "error": "A pending application already exists.", "code": "PENDING_APPLICATION" }),
        )),
        Err(e) => Err(e.into()),
    }
}

pub async fn run_profile_update(
    pool: &Pool,
    req: PartnersProfileRequest,
) -> Result<(u16, Value), PartnersError> {
    require_active(pool, req.user_id).await?;
    let uid = pg_user_id(req.user_id)?;
    let id_set = get_access_level_ids(pool, uid).await?;
    let manual = is_manual_allowlisted(pool, uid).await?;
    if !user_access_has_partner(&id_set) && !manual {
        return Ok((
            HTTP_FORBIDDEN,
            json!({ "error": "Only YouTube partners can edit the profile.", "code": "NOT_PARTNER" }),
        ));
    }
    let conn = pool.get().await?;
    let existing = conn
        .query_opt(
            "SELECT channel_url FROM partner_youtube_creator_profiles WHERE user_id = $1",
            &[&uid],
        )
        .await?;
    let Some(ex) = existing else {
        return Ok((
            HTTP_NOT_FOUND,
            json!({ "error": "Partner profile not found.", "code": "NOT_FOUND" }),
        ));
    };
    let channel_name = sanitize_channel_name(&value_str(&req.channel_name));
    if channel_name.len() < CHANNEL_NAME_MIN_LENGTH {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid channel name (min. 2 characters).", "code": "VALIDATION" }),
        ));
    }
    let avatar_url = sanitize_avatar_url(&value_str(&req.avatar_url));
    if avatar_url.is_empty() {
        return Ok((
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid cover/photo.", "code": "AVATAR_REQUIRED" }),
        ));
    }
    let updated = now_ms();
    conn.execute(
        "UPDATE partner_youtube_creator_profiles
            SET channel_name = $2, avatar_url = $3, updated_at = $4, updated_by = $1
          WHERE user_id = $1",
        &[&uid, &channel_name, &avatar_url, &updated],
    )
    .await?;
    Ok((
        HTTP_OK,
        json!({
            "ok": true,
            "channelName": channel_name,
            "avatarUrl": avatar_url,
            "channelUrl": string_cell(&ex, "channel_url"),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match() {
        assert_eq!(PARTNERS_STATE_PATH, "/v1/partners/state");
        assert_eq!(PARTNERS_SUBMIT_PATH, "/v1/partners/videos/submit");
        assert_eq!(PARTNERS_VIDEO_BY_ID_PATH, "/v1/partners/video-by-id");
    }

    #[test]
    fn youtube_canonical() {
        let (id, url) =
            validate_and_canonical_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .expect("ok");
        assert_eq!(id, "dQw4w9WgXcQ");
        assert_eq!(url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        let (id2, _) =
            validate_and_canonical_youtube_url("https://youtu.be/dQw4w9WgXcQ").expect("be");
        assert_eq!(id2, "dQw4w9WgXcQ");
    }

    #[test]
    fn day_key_stable() {
        // 2024-01-15 12:00:00 UTC
        let ts = 1_705_320_000_000i64;
        assert_eq!(partner_youtube_utc_day_key_yyyyymmdd(ts), 20240115);
    }

    #[test]
    fn cursor_roundtrip() {
        let enc = encode_cursor(100, "abcdefghij");
        let (ts, id) = parse_cursor(Some(&enc)).expect("parse");
        assert_eq!(ts, 100);
        assert_eq!(id, "abcdefghij");
    }
}
