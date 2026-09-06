//! Domain vs transport errors for `/v1/shop/*`.

pub use crate::market::errors::{
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_UNPROCESSABLE_ENTITY,
};

/// Node checkout `HTTP_UNAUTHORIZED`.
pub const HTTP_UNAUTHORIZED: u16 = 401;

pub const ERR_INVALID_SESSION: &str = "Invalid session.";
pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "Same idempotency key with a different request.";
pub const ERR_CART_EMPTY_OR_INVALID: &str = "Cart empty or invalid.";
pub const ERR_CART_NOT_FOUND: &str = "Cart not found.";
pub const ERR_CART_IS_EMPTY: &str = "Cart is empty.";
pub const ERR_HARDWARE_MARKET_PAUSED: &str = "Hardware market paused.";
pub const ERR_CART_ITEMS_MISSING: &str = "One or more cart items do not exist.";
pub const ERR_INVALID_ITEM_PRICE: &str = "Invalid item price.";
pub const ERR_INVALID_PURCHASE_AMOUNT: &str = "Invalid purchase amount.";
pub const ERR_INSUFFICIENT_BALANCE: &str = "Insufficient balance";
pub const ERR_SOLD_OUT_RACE: &str =
    "This item sold out while you were confirming the purchase. Refresh the page and try again.";
pub const CODE_IDEMPOTENCY_KEY_REQUIRED: &str = "IDEMPOTENCY_KEY_REQUIRED";
pub const CODE_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";

#[derive(Debug)]
pub enum ShopError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        missing: Option<f64>,
    },
    Transport(anyhow::Error),
}

impl ShopError {
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

    pub fn unauthorized(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNAUTHORIZED, error)
    }

    pub fn forbidden(error: impl Into<String>) -> Self {
        Self::domain(HTTP_FORBIDDEN, error)
    }

    pub fn conflict_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self::domain_code(HTTP_CONFLICT, error, code)
    }

    pub fn unprocessable(error: impl Into<String>, missing: Option<f64>) -> Self {
        Self::Domain {
            status: HTTP_UNPROCESSABLE_ENTITY,
            error: error.into(),
            code: None,
            missing,
        }
    }

    pub fn transport(e: impl Into<anyhow::Error>) -> Self {
        Self::Transport(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for ShopError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}

impl From<tokio_postgres::Error> for ShopError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}
