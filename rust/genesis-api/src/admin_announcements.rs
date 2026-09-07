//! Admin in-app announcements / Mini Blog CRUD
//! (`/api/admin/announcements*`, `/api/admin/in-app-announcements*`).
//!
//! Replaces `server/modules/announcements/` (Express). `require_admin` gates on
//! tab `settings:news` (route table in [`crate::admin_auth`]). Server-side
//! validation (`validation.ts`) is ported here; the DB writes run in
//! `genesis-mining-worker` (`announcements.rs`). Player pending / mini-blog /
//! mark-read stay in [`crate::player`].

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::session::json_status;
use crate::workers::{post_mining, WorkerJson};

const P_LIST_CREATE: &str = "/api/admin/announcements";
const P_ITEM: &str = "/api/admin/announcements/{id}";
const P_LIST_CREATE_ALIAS: &str = "/api/admin/in-app-announcements";
const P_ITEM_ALIAS: &str = "/api/admin/in-app-announcements/{id}";

const W_ADMIN_LIST: &str = "/v1/announcements/admin-list";
const W_CREATE: &str = "/v1/announcements/create";
const W_UPDATE: &str = "/v1/announcements/update";
const W_DELETE: &str = "/v1/announcements/delete";
const W_GET: &str = "/v1/announcements/get";

const TITLE_MAX: usize = 120;
const MESSAGE_MAX: usize = 4000;
const LINK_MAX: usize = 2048;
const PRIORITY_MIN: i64 = 0;
const PRIORITY_MAX: i64 = 1000;
const MS_PER_DAY: i64 = 86_400_000;
const SCHEDULE_MAX_MS: i64 = 2 * 365 * MS_PER_DAY;
const SCHEDULE_MS_UPPER_BOUND: i64 = 9_000_000_000_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --------------------------------------------------------------------------
// Validation (ported from server/modules/announcements/services/validation.ts)
// --------------------------------------------------------------------------

#[derive(Debug)]
struct ValErr {
    message: String,
    code: &'static str,
}
impl ValErr {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: "VALIDATION" }
    }
    fn image(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: "INVALID_IMAGE_URL" }
    }
    fn response(&self) -> Response {
        let msg = if self.code == "INVALID_IMAGE_URL" {
            "Invalid image. Use internal upload only (PNG, JPG, or GIF).".to_string()
        } else {
            self.message.clone()
        };
        json_status(400, json!({ "error": msg, "code": self.code }))
    }
}

fn is_ctrl_to_strip(c: char) -> bool {
    let u = c as u32;
    (u <= 0x08)
        || u == 0x0B
        || u == 0x0C
        || (0x0E..=0x1F).contains(&u)
        || u == 0x7F
        || (0x80..=0x9F).contains(&u)
}

fn is_zw_or_bidi(c: char) -> bool {
    let u = c as u32;
    (0x200B..=0x200D).contains(&u) || u == 0xFEFF || (0x202A..=0x202E).contains(&u)
}

fn strip_plain_text(raw: Option<&str>, max_len: usize) -> Result<String, ValErr> {
    let Some(raw) = raw else {
        return Ok(String::new());
    };
    let mut s: String = raw
        .chars()
        .filter(|c| !is_zw_or_bidi(*c))
        .map(|c| if is_ctrl_to_strip(c) { ' ' } else { c })
        .collect();
    s = s.trim().to_string();
    let lower = s.to_ascii_lowercase();
    let dangerous_scheme = lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("vbscript:")
        || lower.trim_start().starts_with("javascript :")
        || lower.trim_start().starts_with("data :")
        || lower.trim_start().starts_with("vbscript :");
    if dangerous_scheme || lower.contains("<script") {
        return Err(ValErr::new("Conteúdo de texto não permitido."));
    }
    if s.chars().count() > max_len {
        s = s.chars().take(max_len).collect();
    }
    Ok(s)
}

fn parse_plain_title(raw: Option<&str>) -> Result<String, ValErr> {
    let s = strip_plain_text(raw, TITLE_MAX)?;
    if s.is_empty() {
        return Err(ValErr::new("Título é obrigatório."));
    }
    Ok(s)
}

fn parse_plain_message(raw: Option<&str>) -> Result<String, ValErr> {
    let s = strip_plain_text(raw, MESSAGE_MAX)?;
    if s.is_empty() {
        return Err(ValErr::new("Mensagem é obrigatória."));
    }
    Ok(s)
}

fn parse_optional_https_link(raw: Option<&str>) -> Result<Option<String>, ValErr> {
    let Some(raw) = raw else { return Ok(None) };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.len() > LINK_MAX {
        return Err(ValErr::new("Link demasiado longo."));
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("data:") || lower.starts_with("vbscript:")
    {
        return Err(ValErr::new("Link não permitido."));
    }
    if !lower.starts_with("https://") {
        return Err(ValErr::new("Link deve usar HTTPS."));
    }
    let authority: &str = t["https://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if authority.is_empty() {
        return Err(ValErr::new("Link inválido."));
    }
    if authority.contains('@') {
        return Err(ValErr::new("Link não permitido."));
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() {
        return Err(ValErr::new("Link inválido."));
    }
    Ok(Some(t.chars().take(LINK_MAX).collect()))
}

fn valid_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp")
}

/// Mirrors `SAFE_ANNOUNCEMENT_IMAGE_PATH_RE`:
/// `^/img/(?:uploads/[a-zA-Z0-9._-]+|ad-[0-9]+-[0-9a-zA-Z]+)\.(png|jpe?g|gif|webp)$`
fn is_safe_announcement_image_path(p: &str) -> bool {
    let Some(rest) = p.strip_prefix("/img/") else {
        return false;
    };
    let Some((stem, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    if !valid_image_ext(&ext.to_ascii_lowercase()) {
        return false;
    }
    if let Some(name) = stem.strip_prefix("uploads/") {
        return !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    }
    if let Some(tail) = stem.strip_prefix("ad-") {
        if let Some((digits, alnum)) = tail.split_once('-') {
            return !digits.is_empty()
                && digits.chars().all(|c| c.is_ascii_digit())
                && !alnum.is_empty()
                && alnum.chars().all(|c| c.is_ascii_alphanumeric());
        }
    }
    false
}

fn parse_optional_self_image_path(raw: Option<&str>) -> Result<Option<String>, ValErr> {
    let Some(raw) = raw else { return Ok(None) };
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let lower = t.to_ascii_lowercase();
    if t.contains("..")
        || t.contains("//")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("data:")
        || t.starts_with("//")
    {
        return Err(ValErr::image("URL de imagem não permitida."));
    }
    let normalized = if t.starts_with("/img/") {
        t.to_string()
    } else if let Some(stripped) = t.strip_prefix("img/") {
        format!("/img/{stripped}")
    } else {
        return Err(ValErr::image(
            "Imagem deve ser um ficheiro em /img/ (upload interno).",
        ));
    };
    if !is_safe_announcement_image_path(&normalized) {
        return Err(ValErr::image(
            "Imagem deve ser um ficheiro em /img/ (upload interno).",
        ));
    }
    Ok(Some(normalized))
}

fn value_to_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().map(|f| f.trunc() as i64),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().map(|f| f.trunc() as i64),
        _ => None,
    }
}

fn parse_priority(v: Option<&Value>) -> i64 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::String(s)) if s.trim().is_empty() => 0,
        other => value_to_i64(other).unwrap_or(0).clamp(PRIORITY_MIN, PRIORITY_MAX),
    }
}

fn is_empty_val(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
        || matches!(v, Some(Value::String(s)) if s.is_empty())
}

fn parse_optional_schedule_ms(v: Option<&Value>) -> Result<Option<i64>, ValErr> {
    if is_empty_val(v) {
        return Ok(None);
    }
    let n = match v {
        Some(Value::Number(num)) => num.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(n) = n else {
        return Err(ValErr::new("Data de agendamento inválida."));
    };
    if !n.is_finite() || n < 0.0 || n > SCHEDULE_MS_UPPER_BOUND as f64 {
        return Err(ValErr::new("Data de agendamento inválida."));
    }
    Ok(Some(n.trunc() as i64))
}

fn parse_is_active(v: Option<&Value>, default_active: bool) -> bool {
    match v {
        None | Some(Value::Null) => default_active,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => match n.as_i64() {
            Some(0) => false,
            Some(1) => true,
            _ => default_active,
        },
        Some(Value::String(s)) => match s.as_str() {
            "0" | "false" => false,
            "1" | "true" => true,
            _ => default_active,
        },
        _ => default_active,
    }
}

fn validate_schedule_range(starts_at: Option<i64>, ends_at: Option<i64>) -> Result<(), ValErr> {
    if let (Some(s), Some(e)) = (starts_at, ends_at) {
        if e < s {
            return Err(ValErr::new("Data de fim deve ser posterior ao início."));
        }
        if e - s > SCHEDULE_MAX_MS {
            return Err(ValErr::new("Intervalo de agendamento demasiado longo."));
        }
    }
    if let Some(e) = ends_at {
        if e < now_ms() - SCHEDULE_MAX_MS {
            return Err(ValErr::new("Data de fim inválida."));
        }
    }
    Ok(())
}

fn parse_announcement_id(raw: &str) -> Option<String> {
    let id = raw.trim().to_ascii_lowercase();
    if id.len() != 36 {
        return None;
    }
    let b = id.as_bytes();
    for (i, ch) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *ch != b'-' {
                    return None;
                }
            }
            14 => {
                if *ch != b'4' {
                    return None;
                }
            }
            19 => {
                if !matches!(ch, b'8' | b'9' | b'a' | b'b') {
                    return None;
                }
            }
            _ => {
                if !ch.is_ascii_hexdigit() {
                    return None;
                }
            }
        }
    }
    Some(id)
}

fn field<'a>(body: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    body.get(camel).or_else(|| body.get(snake))
}

fn has_field(body: &Value, camel: &str, snake: &str) -> bool {
    body.get(camel).is_some() || body.get(snake).is_some()
}

fn str_field<'a>(body: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    field(body, camel, snake).and_then(Value::as_str)
}

// --------------------------------------------------------------------------
// Worker response reshaping (worker row -> client AnnouncementAdminDto)
// --------------------------------------------------------------------------

fn reshape_row(row: &Value, read_count: i64) -> Value {
    let link = str_field(row, "link", "link")
        .and_then(|s| parse_optional_https_link(Some(s)).ok().flatten());
    let image_url = str_field(row, "imageUrl", "image_url")
        .and_then(|s| parse_optional_self_image_path(Some(s)).ok().flatten());
    let priority = value_to_i64(field(row, "priority", "priority")).unwrap_or(0);
    let created_at = value_to_i64(field(row, "createdAt", "created_at")).unwrap_or_else(now_ms);
    let is_active = value_to_i64(field(row, "isActive", "is_active")) == Some(1)
        || field(row, "isActive", "is_active") == Some(&Value::Bool(true));
    json!({
        "id": row.get("id").cloned().unwrap_or(Value::Null),
        "title": row.get("title").cloned().unwrap_or(Value::Null),
        "message": row.get("message").cloned().unwrap_or(Value::Null),
        "link": link,
        "imageUrl": image_url,
        "priority": priority,
        "createdAt": created_at,
        "isActive": is_active,
        "startsAt": value_to_i64(field(row, "startsAt", "starts_at")),
        "endsAt": value_to_i64(field(row, "endsAt", "ends_at")),
        "createdBy": value_to_i64(field(row, "createdBy", "created_by")),
        "readCount": read_count,
    })
}

fn read_count_of(body: &Value) -> i64 {
    value_to_i64(body.get("readCount")).unwrap_or(0)
}

fn worker_err_to_response(w: &WorkerJson) -> Response {
    let code = w.body.get("code").and_then(Value::as_str).unwrap_or("");
    let status = if w.status == 0 { 502 } else { w.status };
    let msg = w
        .body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Worker error.");
    json_status(status, json!({ "error": msg, "code": code }))
}

async fn call_worker(state: &AppState, path: &str, body: Value) -> Result<WorkerJson, Response> {
    match post_mining(&state.cfg, &state.http, path, &body).await {
        Ok(w) => Ok(w),
        Err(e) => Err(json_status(
            crate::workers::worker_infra_status(&e),
            crate::workers::worker_unavailable_body(&e),
        )),
    }
}

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------

async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, P_LIST_CREATE).await {
        return e;
    }
    let w = match call_worker(&state, W_ADMIN_LIST, json!({})).await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if w.body.get("ok").and_then(Value::as_bool) != Some(true) {
        return worker_err_to_response(&w);
    }
    let rows = w.body.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let announcements: Vec<Value> = rows
        .iter()
        .map(|item| reshape_row(item, read_count_of(item)))
        .collect();
    json_status(200, json!({ "ok": true, "announcements": announcements }))
}

async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = match require_admin(&state, &headers, &Method::POST, P_LIST_CREATE).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let title = match parse_plain_title(str_field(&body, "title", "title")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let message = match parse_plain_message(str_field(&body, "message", "message")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let link = match parse_optional_https_link(str_field(&body, "link", "link")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let image_url = match parse_optional_self_image_path(str_field(&body, "imageUrl", "image_url")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let priority = parse_priority(field(&body, "priority", "priority"));
    let is_active = parse_is_active(field(&body, "isActive", "is_active"), true);
    let starts_at = match parse_optional_schedule_ms(field(&body, "startsAt", "starts_at")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let ends_at = match parse_optional_schedule_ms(field(&body, "endsAt", "ends_at")) {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    if let Err(e) = validate_schedule_range(starts_at, ends_at) {
        return e.response();
    }

    let payload = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "title": title,
        "message": message,
        "link": link,
        "imageUrl": image_url,
        "isActive": is_active,
        "priority": priority,
        "startsAt": starts_at,
        "endsAt": ends_at,
        "createdAt": now_ms(),
        "createdBy": ctx.user_id,
    });
    let w = match call_worker(&state, W_CREATE, payload).await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if w.body.get("ok").and_then(Value::as_bool) != Some(true) {
        return worker_err_to_response(&w);
    }
    let Some(row) = w.body.get("row") else {
        return json_status(502, json!({ "error": "mining worker announcement create empty row" }));
    };
    json_status(
        201,
        json!({ "ok": true, "announcement": reshape_row(row, read_count_of(&w.body)) }),
    )
}

async fn update(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::PUT, P_LIST_CREATE).await {
        return e;
    }
    let Some(id) = parse_announcement_id(&id) else {
        return json_status(
            400,
            json!({ "error": "Invalid announcement identifier.", "code": "VALIDATION" }),
        );
    };

    // Partial parse — only provided fields.
    let mut new_title: Option<String> = None;
    let mut new_message: Option<String> = None;
    let mut new_link: Option<Option<String>> = None;
    let mut new_image: Option<Option<String>> = None;
    let mut new_priority: Option<i64> = None;
    let mut new_active: Option<bool> = None;
    let mut new_starts: Option<Option<i64>> = None;
    let mut new_ends: Option<Option<i64>> = None;

    macro_rules! bail {
        ($r:expr) => {
            match $r {
                Ok(v) => v,
                Err(e) => return e.response(),
            }
        };
    }
    if body.get("title").is_some() {
        new_title = Some(bail!(parse_plain_title(str_field(&body, "title", "title"))));
    }
    if body.get("message").is_some() {
        new_message = Some(bail!(parse_plain_message(str_field(&body, "message", "message"))));
    }
    if body.get("link").is_some() {
        new_link = Some(bail!(parse_optional_https_link(str_field(&body, "link", "link"))));
    }
    if has_field(&body, "imageUrl", "image_url") {
        new_image = Some(bail!(parse_optional_self_image_path(str_field(
            &body, "imageUrl", "image_url"
        ))));
    }
    if body.get("priority").is_some() {
        new_priority = Some(parse_priority(body.get("priority")));
    }
    if has_field(&body, "isActive", "is_active") {
        new_active = Some(parse_is_active(field(&body, "isActive", "is_active"), true));
    }
    if has_field(&body, "startsAt", "starts_at") {
        new_starts = Some(bail!(parse_optional_schedule_ms(field(
            &body, "startsAt", "starts_at"
        ))));
    }
    if has_field(&body, "endsAt", "ends_at") {
        new_ends = Some(bail!(parse_optional_schedule_ms(field(&body, "endsAt", "ends_at"))));
    }

    // Load existing.
    let got = match call_worker(&state, W_GET, json!({ "id": id })).await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if got.body.get("ok").and_then(Value::as_bool) != Some(true) {
        if got.body.get("code").and_then(Value::as_str) == Some("NOT_FOUND") || got.status == 404 {
            return json_status(404, json!({ "error": "Announcement not found.", "code": "NOT_FOUND" }));
        }
        return worker_err_to_response(&got);
    }
    let Some(existing) = got.body.get("row") else {
        return json_status(404, json!({ "error": "Announcement not found.", "code": "NOT_FOUND" }));
    };

    let ex_i64 = |camel: &str, snake: &str| value_to_i64(field(existing, camel, snake));

    let merged_starts = match new_starts {
        Some(v) => v,
        None => ex_i64("startsAt", "starts_at"),
    };
    let merged_ends = match new_ends {
        Some(v) => v,
        None => ex_i64("endsAt", "ends_at"),
    };
    if new_starts.is_some() || new_ends.is_some() {
        if let Err(e) = validate_schedule_range(merged_starts, merged_ends) {
            return e.response();
        }
    }

    let payload = json!({
        "id": id,
        "title": new_title.unwrap_or_else(|| existing.get("title").and_then(Value::as_str).unwrap_or("").to_string()),
        "message": new_message.unwrap_or_else(|| existing.get("message").and_then(Value::as_str).unwrap_or("").to_string()),
        "link": match new_link {
            Some(v) => v,
            None => str_field(existing, "link", "link").and_then(|s| parse_optional_https_link(Some(s)).ok().flatten()),
        },
        "imageUrl": match new_image {
            Some(v) => v,
            None => str_field(existing, "imageUrl", "image_url").and_then(|s| parse_optional_self_image_path(Some(s)).ok().flatten()),
        },
        "isActive": new_active.unwrap_or_else(|| ex_i64("isActive", "is_active") == Some(1)),
        "priority": new_priority.unwrap_or_else(|| ex_i64("priority", "priority").unwrap_or(0)),
        "startsAt": merged_starts,
        "endsAt": merged_ends,
    });

    let w = match call_worker(&state, W_UPDATE, payload).await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if w.body.get("ok").and_then(Value::as_bool) != Some(true) {
        if w.body.get("code").and_then(Value::as_str) == Some("NOT_FOUND") || w.status == 404 {
            return json_status(404, json!({ "error": "Announcement not found.", "code": "NOT_FOUND" }));
        }
        return worker_err_to_response(&w);
    }
    let Some(row) = w.body.get("row") else {
        return json_status(502, json!({ "error": "mining worker announcement update empty row" }));
    };
    json_status(
        200,
        json!({ "ok": true, "announcement": reshape_row(row, read_count_of(&w.body)) }),
    )
}

async fn delete_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::DELETE, P_LIST_CREATE).await {
        return e;
    }
    let Some(id) = parse_announcement_id(&id) else {
        return json_status(
            400,
            json!({ "error": "Invalid announcement identifier.", "code": "VALIDATION" }),
        );
    };
    let w = match call_worker(&state, W_DELETE, json!({ "id": id })).await {
        Ok(w) => w,
        Err(r) => return r,
    };
    if w.body.get("ok").and_then(Value::as_bool) == Some(true) {
        return json_status(200, json!({ "ok": true }));
    }
    if w.body.get("code").and_then(Value::as_str) == Some("NOT_FOUND") || w.status == 404 {
        return json_status(404, json!({ "error": "Announcement not found.", "code": "NOT_FOUND" }));
    }
    worker_err_to_response(&w)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(P_LIST_CREATE, get(list).post(create))
        .route(P_ITEM, axum::routing::put(update).delete(delete_one))
        .route(P_LIST_CREATE_ALIAS, get(list).post(create))
        .route(P_ITEM_ALIAS, axum::routing::put(update).delete(delete_one))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_v4_gate() {
        assert!(parse_announcement_id("550e8400-e29b-41d4-a716-446655440000").is_some());
        assert!(parse_announcement_id("550E8400-E29B-41D4-A716-446655440000").is_some());
        assert!(parse_announcement_id("not-a-uuid").is_none());
        assert!(parse_announcement_id("550e8400-e29b-11d4-a716-446655440000").is_none());
    }

    #[test]
    fn image_path_gate() {
        assert!(is_safe_announcement_image_path("/img/uploads/abc-1.png"));
        assert!(is_safe_announcement_image_path("/img/ad-123-9xZ.webp"));
        assert!(!is_safe_announcement_image_path("/img/uploads/../x.png"));
        assert!(!is_safe_announcement_image_path("/img/uploads/x.svg"));
        assert!(!is_safe_announcement_image_path("/etc/passwd"));
    }

    #[test]
    fn dangerous_text_rejected() {
        assert!(strip_plain_text(Some("<script>x"), 100).is_err());
        assert!(strip_plain_text(Some("javascript:alert(1)"), 100).is_err());
        assert_eq!(strip_plain_text(Some("  hi\u{200b}there  "), 100).unwrap(), "hithere");
    }

    #[test]
    fn https_link_rules() {
        assert_eq!(parse_optional_https_link(Some("")).unwrap(), None);
        assert!(parse_optional_https_link(Some("http://x.com")).is_err());
        assert!(parse_optional_https_link(Some("https://user:pw@x.com")).is_err());
        assert_eq!(
            parse_optional_https_link(Some("https://x.com/a")).unwrap(),
            Some("https://x.com/a".to_string())
        );
    }
}
