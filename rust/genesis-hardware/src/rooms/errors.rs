//! Domain errors for `/v1/rooms/*`.

use crate::market::errors::{HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED};

pub use crate::market::errors::{
    HTTP_BAD_REQUEST as ROOMS_HTTP_BAD_REQUEST, HTTP_CONFLICT as ROOMS_HTTP_CONFLICT,
    HTTP_NOT_FOUND as ROOMS_HTTP_NOT_FOUND, HTTP_UNAUTHORIZED as ROOMS_HTTP_UNAUTHORIZED,
};

pub const CODE_IDEMPOTENCY_KEY_REQUIRED: &str = "IDEMPOTENCY_KEY_REQUIRED";
pub const CODE_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";
pub const CODE_ROOM_ACCESS_DENIED: &str = "ROOM_ACCESS_DENIED";

pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "Same idempotency key with a different request.";
pub const ERR_ROOM_NOT_AVAILABLE: &str = "Room not available.";
pub const ERR_ROOM_ACCESS_DENIED: &str =
    "This room is exclusive — your plan or season pass does not unlock it.";
pub const ERR_MAX_CAPACITY: &str = "Maximum capacity reached.";
pub const ERR_INVALID_PRICE: &str = "Invalid room price configuration.";
pub const ERR_INSUFFICIENT_BALANCE: &str = "Insufficient USDC balance.";

#[derive(Debug)]
pub enum RoomsError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        missing: Option<f64>,
    },
    Transport(anyhow::Error),
}

impl RoomsError {
    pub fn domain(status: u16, error: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: None,
            missing: None,
        }
    }

    pub fn domain_code(status: u16, error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: Some(code.into()),
            missing: None,
        }
    }

    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn bad_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_BAD_REQUEST, error, code)
    }

    pub fn unauthorized_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_UNAUTHORIZED, error, code)
    }

    pub fn not_found(error: impl Into<String>) -> Self {
        Self::domain(HTTP_NOT_FOUND, error)
    }

    pub fn conflict_mismatch(error: impl Into<String>) -> Self {
        Self::Domain {
            status: HTTP_CONFLICT,
            error: error.into(),
            code: Some(CODE_IDEMPOTENCY_PAYLOAD_MISMATCH.into()),
            missing: None,
        }
    }

    pub fn insufficient(missing: f64) -> Self {
        Self::Domain {
            status: HTTP_BAD_REQUEST,
            error: ERR_INSUFFICIENT_BALANCE.into(),
            code: None,
            missing: Some(missing),
        }
    }

    pub fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }
}
