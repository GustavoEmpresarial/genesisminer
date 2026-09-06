//! Domain errors for `/v1/upgrades/*`.

pub use crate::market::errors::{
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE_ENTITY,
};

pub const CODE_IDEMPOTENCY_KEY_REQUIRED: &str = "IDEMPOTENCY_KEY_REQUIRED";
pub const CODE_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";
pub const CODE_PACKAGE_ACCESS_DENIED: &str = "PACKAGE_ACCESS_DENIED";
pub const CODE_UPGRADE_NOT_FOUND: &str = "UPGRADE_NOT_FOUND";

pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "Same idempotency key with a different request.";
pub const ERR_INVALID_PACKAGE: &str = "Invalid package.";
pub const ERR_USER_NOT_FOUND: &str = "User not found.";
pub const ERR_PACKAGE_NOT_FOUND: &str = "Package not found.";
pub const ERR_PACKAGE_INACTIVE: &str = "Package unavailable or inactive.";
pub const ERR_PACKAGE_NOT_ON_SALE: &str = "Package is not on sale yet.";
pub const ERR_PACKAGE_EXPIRED: &str = "Package expired.";
pub const ERR_PACKAGE_ACCESS_DENIED: &str =
    "This package is exclusive — your access level does not grant access to it.";
pub const ERR_PACKAGE_VERSION_STALE: &str =
    "This offer was updated — reload the page and try again.";
pub const ERR_SOLD_OUT: &str = "Sold out: no more units of this package.";
pub const ERR_GAME_STATE_MISSING: &str =
    "Game state has not been created yet. Enter the game (load your save) and try purchasing again.";
pub const ERR_INSUFFICIENT_USDC: &str = "Insufficient USDC balance.";
pub const ERR_UPGRADE_NOT_FOUND_MATERIALIZE: &str = "Upgrade not found when materializing box.";
pub const ERR_MISSING_ACCESS_LEVEL: &str =
    "Package has invalid configuration: missing access level. Contact support.";

#[derive(Debug)]
pub enum UpgradesError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
    },
    Transport(anyhow::Error),
}

impl UpgradesError {
    pub fn domain(status: u16, error: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: None,
        }
    }

    pub fn domain_code(status: u16, error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: Some(code.into()),
        }
    }

    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn bad_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_BAD_REQUEST, error, code)
    }

    pub fn not_found(error: impl Into<String>) -> Self {
        Self::domain(HTTP_NOT_FOUND, error)
    }

    pub fn unprocessable(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNPROCESSABLE_ENTITY, error)
    }

    pub fn conflict(error: impl Into<String>) -> Self {
        Self::domain(HTTP_CONFLICT, error)
    }

    pub fn conflict_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_CONFLICT, error, code)
    }

    pub fn forbidden_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_FORBIDDEN, error, code)
    }

    pub fn transport(err: impl Into<anyhow::Error>) -> Self {
        Self::Transport(err.into())
    }
}

impl From<deadpool_postgres::PoolError> for UpgradesError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}
