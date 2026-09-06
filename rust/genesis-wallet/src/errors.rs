//! Domain vs transport errors for `/v1/wallet/*`.

pub const HTTP_BAD_REQUEST: u16 = 400;
pub const HTTP_UNAUTHORIZED: u16 = 401;
pub const HTTP_FORBIDDEN: u16 = 403;
pub const HTTP_NOT_FOUND: u16 = 404;
pub const HTTP_CONFLICT: u16 = 409;
pub const HTTP_UNPROCESSABLE: u16 = 422;
pub const HTTP_INTERNAL: u16 = 500;

pub const CODE_NOT_FOUND: &str = "NOT_FOUND";
pub const CODE_FORBIDDEN: &str = "FORBIDDEN";
pub const CODE_VALIDATION: &str = "VALIDATION";
pub const CODE_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";

pub const ERR_USER_NOT_FOUND: &str = "User not found.";
pub const ERR_ACCOUNT_BLOCKED: &str = "Account blocked.";

#[derive(Debug)]
pub enum WalletError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        force_reload: Option<bool>,
    },
    Transport(anyhow::Error),
}

impl WalletError {
    pub fn domain(status: u16, error: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: None,
            force_reload: None,
        }
    }

    pub fn domain_code(status: u16, error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: Some(code.into()),
            force_reload: None,
        }
    }

    pub fn conflict_mismatch(error: impl Into<String>) -> Self {
        Self::Domain {
            status: HTTP_CONFLICT,
            error: error.into(),
            code: Some(CODE_IDEMPOTENCY_PAYLOAD_MISMATCH.into()),
            force_reload: Some(true),
        }
    }

    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn bad_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_BAD_REQUEST, error, code)
    }

    pub fn unauthorized(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNAUTHORIZED, error)
    }

    pub fn not_found(error: impl Into<String>) -> Self {
        Self::domain_code(HTTP_NOT_FOUND, error, CODE_NOT_FOUND)
    }

    pub fn unprocessable(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNPROCESSABLE, error)
    }

    pub fn conflict(error: impl Into<String>) -> Self {
        Self::domain(HTTP_CONFLICT, error)
    }

    pub fn internal(error: impl Into<String>) -> Self {
        Self::domain(HTTP_INTERNAL, error)
    }

    pub fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }
}
