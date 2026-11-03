//! Public (pré-login) support tickets — create + lookup by contact email.
//!
//! Contract mirrors `client/src/shared/api/public-support.ts`:
//! - `POST /api/public/support/tickets` (multipart)
//! - `GET  /api/public/support/tickets?email=`
//! - `GET  /api/public/support/tickets/:id?email=`

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::client_ip::get_client_ip;
use crate::config::AppState;
use crate::facade::forward_mining;
use crate::player::{
    is_multipart, upload_support_file, SupportFilePart, SUPPORT_MULTIPART_BODY_LIMIT_BYTES,
};
use crate::rate_limit::{
    enforce, scoped_actor_key, PARTNERS_APPLY_RATE_LIMIT_MAX, PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS,
    PROFILE_IDENTITY_LIMIT_MAX, PROFILE_RATE_LIMIT_WINDOW_MS,
};
use crate::session::json_status;
use crate::workers::{post_auth, WorkerCallError};

const TURNSTILE_VERIFY_PATH: &str = "/v1/auth/turnstile/verify";
const SUPPORT_GUEST_SUBMIT_PATH: &str = "/v1/support/guest-submit";
const SUPPORT_GUEST_LIST_PATH: &str = "/v1/support/guest-list";
const SUPPORT_GUEST_GET_PATH: &str = "/v1/support/guest-get";
const GUEST_UPLOAD_USER_ID: i64 = 0;
const GUEST_NAME_PREFIX: &str = "support";

/// Client `SUPPORT_CONTACT_NAME_MAX`.
const CONTACT_NAME_MAX: usize = 80;
/// Client `SUPPORT_CONTACT_EMAIL_MAX` / RFC 5321.
const CONTACT_EMAIL_MAX: usize = 254;
/// Same as authenticated support subject/message caps.
const SUBJECT_MAX: usize = 180;
const MESSAGE_MAX: usize = 8000;
/// Worker `TICKET_ID_MAX_LENGTH`.
const TICKET_ID_MAX: usize = 80;
/// Node `SUPPORT_UPLOAD_MAX_FILES`.
const SUPPORT_UPLOAD_MAX_FILES: usize = 5;

const SCOPE_PUBLIC_SUPPORT_SUBMIT: &str = "public_support_submit";
const SCOPE_PUBLIC_SUPPORT_LOOKUP: &str = "public_support_lookup";

const ERR_CAPTCHA_REQUIRED: &str = "Complete the captcha before continuing.";
const ERR_MULTIPART_REQUIRED: &str = "Multipart form required.";
const ERR_RATE_SUBMIT: &str = "Too many support tickets. Try again later.";
const ERR_RATE_LOOKUP: &str = "Too many lookups. Try again later.";

const HTTP_BAD_REQUEST: u16 = 400;
const _: () = assert!(CONTACT_NAME_MAX == 80);
const _: () = assert!(CONTACT_EMAIL_MAX == 254);
const _: () = assert!(TICKET_ID_MAX == 80);
const _: () = assert!(SUPPORT_UPLOAD_MAX_FILES == 5);
const _: () = assert!(HTTP_BAD_REQUEST == 400);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/public/support/tickets",
            post(post_create)
                .layer(DefaultBodyLimit::max(SUPPORT_MULTIPART_BODY_LIMIT_BYTES))
                .get(get_list),
        )
        .route("/api/public/support/tickets/{ticket_id}", get(get_one))
}

#[derive(Debug, Deserialize)]
struct EmailQuery {
    email: Option<String>,
}

fn trim_field(raw: &str, max: usize) -> String {
    raw.trim().chars().take(max).collect()
}

fn validate_contact_email(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("Enter your email.".into());
    }
    if normalized.len() > CONTACT_EMAIL_MAX {
        return Err(format!(
            "Email may be at most {CONTACT_EMAIL_MAX} characters."
        ));
    }
    let at = match normalized.rfind('@') {
        Some(i) if i >= 1 && i < normalized.len() - 1 => i,
        _ => return Err("Invalid email.".into()),
    };
    let local = &normalized[..at];
    let domain = &normalized[at + 1..];
    if local.is_empty()
        || domain.is_empty()
        || domain.contains("..")
        || domain.starts_with('.')
        || domain.ends_with('.')
        || local.chars().any(|c| matches!(c, '<' | '>' | '\'' | '"' | '\\'))
        || domain
            .chars()
            .any(|c| matches!(c, '<' | '>' | '\'' | '"' | '\\'))
    {
        return Err("Invalid email.".into());
    }
    Ok(normalized)
}

fn auth_infra_response(err: &WorkerCallError) -> axum::response::Response {
    json_status(
        503,
        json!({
            "error": err.message(),
            "code": "AUTH_UNAVAILABLE"
        }),
    )
}

async fn enforce_turnstile(
    state: &AppState,
    headers: &HeaderMap,
    token: &str,
) -> Result<(), axum::response::Response> {
    let token = token.trim();
    if state.cfg.turnstile_enabled && token.is_empty() {
        return Err(json_status(
            HTTP_BAD_REQUEST,
            json!({ "error": ERR_CAPTCHA_REQUIRED, "code": "TURNSTILE_FAILED" }),
        ));
    }
    let ip = get_client_ip(&state.cfg, headers, None);
    let remoteip = if ip != "unknown" {
        Some(ip.as_str())
    } else {
        None
    };
    match post_auth(
        &state.cfg,
        &state.http,
        TURNSTILE_VERIFY_PATH,
        &json!({ "token": token, "remoteip": remoteip }),
    )
    .await
    {
        Ok(r) if r.status == 200 && r.body["ok"] == true => Ok(()),
        Ok(r) => Err(json_status(
            r.status,
            json!({
                "error": r.body["error"].as_str().unwrap_or("captcha failed"),
                "code": "TURNSTILE_FAILED"
            }),
        )),
        Err(e) => Err(auth_infra_response(&e)),
    }
}

struct GuestMultipart {
    name: String,
    email: String,
    subject: String,
    message: String,
    turnstile_token: String,
    attachments: Vec<Value>,
}

async fn parse_guest_multipart(
    state: &AppState,
    mut multipart: Multipart,
) -> Result<GuestMultipart, axum::response::Response> {
    let mut name = String::new();
    let mut email = String::new();
    let mut subject = String::new();
    let mut message = String::new();
    let mut turnstile_token = String::new();
    let mut files: Vec<SupportFilePart> = Vec::new();

    while let Some(field) = match multipart.next_field().await {
        Ok(f) => f,
        Err(e) => {
            return Err(json_status(
                HTTP_BAD_REQUEST,
                json!({ "error": e.to_string(), "code": "UPLOAD" }),
            ));
        }
    } {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "files" | "file" => {
                if files.len() >= SUPPORT_UPLOAD_MAX_FILES {
                    let _ = field.bytes().await;
                    continue;
                }
                let original_name = field.file_name().unwrap_or("file.bin").to_string();
                let mime = field.content_type().unwrap_or("").to_string();
                let bytes = match field.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        return Err(json_status(
                            HTTP_BAD_REQUEST,
                            json!({ "error": e.to_string(), "code": "UPLOAD" }),
                        ));
                    }
                };
                if !bytes.is_empty() {
                    files.push(SupportFilePart {
                        original_name,
                        mime,
                        bytes,
                    });
                }
            }
            "name" => {
                if let Ok(t) = field.text().await {
                    name = t;
                }
            }
            "email" => {
                if let Ok(t) = field.text().await {
                    email = t;
                }
            }
            "subject" => {
                if let Ok(t) = field.text().await {
                    subject = t;
                }
            }
            "message" => {
                if let Ok(t) = field.text().await {
                    message = t;
                }
            }
            "turnstileToken" | "turnstile_token" => {
                if let Ok(t) = field.text().await {
                    turnstile_token = t;
                }
            }
            _ => {
                let _ = field.bytes().await;
            }
        }
    }

    let mut attachments = Vec::new();
    for file in files {
        attachments
            .push(upload_support_file(state, GUEST_UPLOAD_USER_ID, GUEST_NAME_PREFIX, file).await?);
    }

    Ok(GuestMultipart {
        name: trim_field(&name, CONTACT_NAME_MAX),
        email: trim_field(&email, CONTACT_EMAIL_MAX),
        subject: trim_field(&subject, SUBJECT_MAX),
        message: trim_field(&message, MESSAGE_MAX),
        turnstile_token,
        attachments,
    })
}

async fn post_create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    request: axum::http::Request<axum::body::Body>,
) -> axum::response::Response {
    let ip = get_client_ip(&state.cfg, &headers, None);
    if let Some(limited) = enforce(
        &state,
        &scoped_actor_key(SCOPE_PUBLIC_SUPPORT_SUBMIT, None, &ip),
        PARTNERS_APPLY_RATE_LIMIT_MAX,
        PARTNERS_APPLY_RATE_LIMIT_WINDOW_MS,
        ERR_RATE_SUBMIT,
    )
    .await
    {
        return limited;
    }

    if !is_multipart(&headers) {
        return json_status(
            HTTP_BAD_REQUEST,
            json!({ "error": ERR_MULTIPART_REQUIRED, "code": "VALIDATION" }),
        );
    }

    let multipart = match Multipart::from_request(request, &state).await {
        Ok(m) => m,
        Err(e) => {
            return json_status(
                HTTP_BAD_REQUEST,
                json!({ "error": e.to_string(), "code": "UPLOAD" }),
            );
        }
    };

    let parsed = match parse_guest_multipart(&state, multipart).await {
        Ok(v) => v,
        Err(e) => return e,
    };

    if let Err(e) = enforce_turnstile(&state, &headers, &parsed.turnstile_token).await {
        return e;
    }

    if parsed.name.is_empty() {
        return json_status(
            HTTP_BAD_REQUEST,
            json!({ "error": "Enter your name.", "code": "VALIDATION" }),
        );
    }
    let email = match validate_contact_email(&parsed.email) {
        Ok(e) => e,
        Err(msg) => {
            return json_status(
                HTTP_BAD_REQUEST,
                json!({ "error": msg, "code": "VALIDATION" }),
            );
        }
    };

    let payload = json!({
        "contactName": parsed.name,
        "contactEmail": email,
        "subject": parsed.subject,
        "message": parsed.message,
        "attachments": parsed.attachments,
    });
    forward_mining(&state, SUPPORT_GUEST_SUBMIT_PATH, payload).await
}

async fn get_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<EmailQuery>,
) -> axum::response::Response {
    let ip = get_client_ip(&state.cfg, &headers, None);
    if let Some(limited) = enforce(
        &state,
        &scoped_actor_key(SCOPE_PUBLIC_SUPPORT_LOOKUP, None, &ip),
        PROFILE_IDENTITY_LIMIT_MAX,
        PROFILE_RATE_LIMIT_WINDOW_MS,
        ERR_RATE_LOOKUP,
    )
    .await
    {
        return limited;
    }
    let email = match validate_contact_email(&q.email.unwrap_or_default()) {
        Ok(e) => e,
        Err(msg) => {
            return json_status(
                HTTP_BAD_REQUEST,
                json!({ "error": msg, "code": "VALIDATION" }),
            );
        }
    };
    forward_mining(
        &state,
        SUPPORT_GUEST_LIST_PATH,
        json!({ "contactEmail": email }),
    )
    .await
}

async fn get_one(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
    Query(q): Query<EmailQuery>,
) -> axum::response::Response {
    let ip = get_client_ip(&state.cfg, &headers, None);
    if let Some(limited) = enforce(
        &state,
        &scoped_actor_key(SCOPE_PUBLIC_SUPPORT_LOOKUP, None, &ip),
        PROFILE_IDENTITY_LIMIT_MAX,
        PROFILE_RATE_LIMIT_WINDOW_MS,
        ERR_RATE_LOOKUP,
    )
    .await
    {
        return limited;
    }
    let email = match validate_contact_email(&q.email.unwrap_or_default()) {
        Ok(e) => e,
        Err(msg) => {
            return json_status(
                HTTP_BAD_REQUEST,
                json!({ "error": msg, "code": "VALIDATION" }),
            );
        }
    };
    let ticket_id: String = ticket_id.trim().chars().take(TICKET_ID_MAX).collect();
    if ticket_id.is_empty() {
        return json_status(
            HTTP_BAD_REQUEST,
            json!({ "error": "Invalid request.", "code": "VALIDATION" }),
        );
    }
    forward_mining(
        &state,
        SUPPORT_GUEST_GET_PATH,
        json!({ "contactEmail": email, "ticketId": ticket_id }),
    )
    .await
}
