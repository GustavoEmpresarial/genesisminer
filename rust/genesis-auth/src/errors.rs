//! Domain vs transport errors for session / refresh PG endpoints.

use axum::http::StatusCode;

pub const CODE_INVALID: &str = "invalid";
pub const CODE_EXPIRED: &str = "expired";

#[derive(Debug)]
pub enum AuthPgError {
    BadRequest(String),
    Unauthorized {
        error: String,
        code: Option<String>,
    },
    Transport(anyhow::Error),
}

impl AuthPgError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::Unauthorized {
            error: msg.into(),
            code: None,
        }
    }

    pub fn unauthorized_code(msg: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Unauthorized {
            error: msg.into(),
            code: Some(code.into()),
        }
    }

    pub fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized { .. } => StatusCode::UNAUTHORIZED,
            Self::Transport(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn error_message(&self) -> String {
        match self {
            Self::BadRequest(m) | Self::Unauthorized { error: m, .. } => m.clone(),
            Self::Transport(_) => "persist failed".into(),
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Unauthorized { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}
