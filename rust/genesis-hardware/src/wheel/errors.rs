//! Domain vs transport errors for `/v1/wheel/*`.

pub use crate::market::errors::{
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_UNPROCESSABLE_ENTITY,
};

pub const HTTP_UNAUTHORIZED: u16 = 401;
pub const HTTP_INTERNAL_SERVER_ERROR: u16 = 500;

pub const ERR_INVALID_SESSION: &str = "Invalid session.";
pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_PAID_WHEEL_DISABLED: &str = "Paid wheel is disabled.";
pub const ERR_PAID_WHEEL_NOT_YET: &str = "Paid wheel is not available yet.";
pub const ERR_PAID_WHEEL_ENDED: &str = "Paid wheel has ended.";
pub const ERR_INVALID_SPIN_PRICE: &str = "Invalid spin price in configuration.";
pub const ERR_DAILY_LIMIT: &str = "Daily paid spin limit reached.";
pub const ERR_COOLDOWN: &str = "Wait for the cooldown between paid spins.";
pub const ERR_GAME_STATE_NOT_FOUND: &str = "Game state not found.";
pub const ERR_INSUFFICIENT_USDC_SPIN: &str = "Insufficient USDC for a spin (0.10 USDC per spin).";
pub const ERR_NO_PRIZES: &str = "No active basic prizes on the wheel.";
pub const ERR_INVALID_WEIGHTS: &str = "Invalid wheel configuration (weights).";
pub const ERR_WHEEL_CONFIG: &str = "Wheel configuration unavailable.";
pub const ERR_INVALID_CODE: &str = "Invalid code.";
pub const ERR_INVALID_OR_MISSING_CODE: &str = "Invalid or missing code.";
pub const ERR_INVALID_CLAIM_DATA: &str = "Invalid data or missing required fields.";
pub const ERR_CODE_DISABLED: &str = "Code disabled";
pub const ERR_INVALID_CODE_NOT_FOUND: &str = "Invalid code";
pub const ERR_CODE_EXPIRED_DOT: &str = "Expired.";
pub const ERR_CODE_EXPIRED: &str = "Code expired.";
pub const ERR_ALREADY_REDEEMED_GLOBAL: &str = "This code has already been redeemed.";
pub const ERR_ALREADY_REDEEMED_USER: &str = "You have already redeemed this code.";
pub const ERR_MUST_REDEEM_FIRST: &str = "You must redeem the code first.";
pub const ERR_CODE_FULLY_USED: &str = "This code has been fully used.";
pub const ERR_CODE_NO_WHEEL: &str = "This code does not allow a wheel spin.";
pub const ERR_WHEEL_CONFIG_NOT_FOUND: &str = "Wheel configuration not found.";
pub const ERR_ROLL_CONFLICT: &str = "Could not record the spin. Try again.";
pub const ERR_CODE_NOT_REDEEMED: &str = "Code not redeemed.";
pub const ERR_REWARD_ALREADY_CLAIMED: &str = "Reward already claimed.";
pub const ERR_MUST_SPIN_FIRST: &str = "You must spin the wheel first.";
pub const ERR_CLAIM_INTEGRITY: &str =
    "Draw integrity violated. Claimed item does not match the drawn item.";
pub const ERR_INVALID_CODE_TYPE: &str = "Invalid code type.";
pub const ERR_CLAIM_FINALIZE: &str = "Failed to finalize code redemption (no rows updated).";
pub const CODE_UPGRADE_NOT_FOUND: &str = "UPGRADE_NOT_FOUND";

#[derive(Debug)]
pub enum WheelError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
    },
    Transport(anyhow::Error),
}

impl WheelError {
    pub fn domain(status: u16, error: impl Into<String>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: None,
        }
    }

    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn not_found(error: impl Into<String>) -> Self {
        Self::domain(HTTP_NOT_FOUND, error)
    }

    pub fn forbidden(error: impl Into<String>) -> Self {
        Self::domain(HTTP_FORBIDDEN, error)
    }

    pub fn conflict(error: impl Into<String>) -> Self {
        Self::domain(HTTP_CONFLICT, error)
    }

    pub fn unauthorized(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNAUTHORIZED, error)
    }

    pub fn unprocessable(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNPROCESSABLE_ENTITY, error)
    }

    pub fn internal(error: impl Into<String>) -> Self {
        Self::domain(HTTP_INTERNAL_SERVER_ERROR, error)
    }

    pub fn transport(e: impl Into<anyhow::Error>) -> Self {
        Self::Transport(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for WheelError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}

impl From<tokio_postgres::Error> for WheelError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}
