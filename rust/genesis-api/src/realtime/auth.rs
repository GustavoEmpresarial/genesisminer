//! Resolve chat actor from Socket.IO handshake Cookie header.

use std::collections::HashMap;
use std::sync::Arc;

use tracing::warn;

use crate::config::{AppState, COOKIE_ACCESS, COOKIE_SID};
use crate::cookies::parse_cookies;
use crate::workers::post_auth;

const JWT_VERIFY_PATH: &str = "/v1/auth/jwt/verify";
const SESSION_LOAD_PATH: &str = "/v1/auth/session/load";
/// Prisma / Node `sessions.manager_mode = 1`.
const SESSION_MANAGER_MODE_ON: i64 = 1;

#[derive(Debug, Clone)]
pub struct ChatActor {
    /// JWT / `sessions.user_id` (owner when managing).
    pub session_user_id: i64,
    /// Human: manager when `manager_mode`, else session user.
    pub real_user_id: i64,
    pub manager_mode: bool,
    pub sid: Option<String>,
}

pub fn cookies_from_header(cookie_header: Option<&str>) -> HashMap<String, String> {
    parse_cookies(cookie_header)
}

pub async fn resolve_chat_actor(
    state: &AppState,
    cookie_header: Option<&str>,
) -> Option<ChatActor> {
    let cookies = cookies_from_header(cookie_header);
    let sid = cookies.get(COOKIE_SID).cloned().filter(|s| !s.is_empty());
    let mut session_user_id: Option<i64> = None;

    if let Some(access) = cookies.get(COOKIE_ACCESS).filter(|s| !s.is_empty()) {
        match post_auth(
            &state.cfg,
            &state.http,
            JWT_VERIFY_PATH,
            &serde_json::json!({ "token": access }),
        )
        .await
        {
            Ok(r) if r.status == 200 && r.body["ok"] == true => {
                session_user_id = r.body["userId"].as_i64().filter(|i| *i > 0);
            }
            Ok(_) => {}
            Err(e) => {
                warn!(err = %e.message(), "chat socket jwt verify");
                return None;
            }
        }
    }

    if session_user_id.is_none() {
        if let Some(ref session_id) = sid {
            match post_auth(
                &state.cfg,
                &state.http,
                SESSION_LOAD_PATH,
                &serde_json::json!({ "sessionId": session_id }),
            )
            .await
            {
                Ok(r) if r.status == 200 && r.body["ok"] == true => {
                    session_user_id = r.body["userId"].as_i64().filter(|i| *i > 0);
                }
                Ok(_) => {}
                Err(e) => {
                    warn!(err = %e.message(), "chat socket session load");
                    return None;
                }
            }
        }
    }

    let session_user_id = session_user_id?;

    let mut manager_mode = false;
    let mut manager_user_id: Option<i64> = None;
    if let Some(ref session_id) = sid {
        match post_auth(
            &state.cfg,
            &state.http,
            SESSION_LOAD_PATH,
            &serde_json::json!({ "sessionId": session_id, "includeExpired": true }),
        )
        .await
        {
            Ok(r) if r.status == 200 && r.body["ok"] == true => {
                let mode = r.body["managerMode"].as_i64().unwrap_or(0);
                if mode == SESSION_MANAGER_MODE_ON {
                    manager_mode = true;
                    manager_user_id = r.body["originalUserId"].as_i64().filter(|i| *i > 0);
                }
            }
            Ok(_) => {}
            Err(e) => warn!(err = %e.message(), "chat socket manager flags"),
        }
    }

    let real_user_id = if manager_mode {
        manager_user_id.unwrap_or(session_user_id)
    } else {
        session_user_id
    };

    Some(ChatActor {
        session_user_id,
        real_user_id,
        manager_mode,
        sid,
    })
}

pub async fn resolve_chat_actor_arc(
    state: &Arc<AppState>,
    cookie_header: Option<&str>,
) -> Option<ChatActor> {
    resolve_chat_actor(state.as_ref(), cookie_header).await
}
