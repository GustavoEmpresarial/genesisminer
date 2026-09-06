//! Domain vs transport errors for `/v1/market/*`.
//! Domain → real HTTP 400/403/404/409/422 + `{ ok:false, error, code? }`.
//! Transport / pool → 500 (Node fail-closed).

use tokio_postgres::error::SqlState;

use crate::adjust::INSUFFICIENT_STOCK;

pub const HTTP_OK: u16 = 200;
pub const HTTP_BAD_REQUEST: u16 = 400;
pub const HTTP_UNAUTHORIZED: u16 = 401;
pub const HTTP_FORBIDDEN: u16 = 403;
pub const HTTP_NOT_FOUND: u16 = 404;
pub const HTTP_CONFLICT: u16 = 409;
pub const HTTP_UNPROCESSABLE_ENTITY: u16 = 422;

pub const ERR_INSUFFICIENT_STOCK_TO_LIST: &str = "Insufficient stock to list.";
pub const ERR_LISTING_INSTANCES_MISSING: &str = "Listing instances missing.";
pub const ERR_LISTING_INSTANCE_COUNT: &str = "Listing instance count mismatch.";
pub const ERR_LISTING_INSTANCES_UNAVAILABLE: &str = "Listing instances no longer available.";
pub const ERR_USER_NOT_FOUND: &str = "User not found.";
pub const ERR_ACCOUNT_BLOCKED: &str = "Account blocked.";
pub const ERR_INVALID_ITEM: &str = "Invalid item.";
pub const ERR_INVALID_PRICE: &str = "Invalid price.";
pub const ERR_INVALID_QTY: &str = "Invalid quantity.";
pub const ERR_ITEM_NOT_SELLABLE: &str = "This item cannot be sold on the parallel market.";
pub const ERR_LISTING_NOT_FOUND: &str = "Listing not found.";
pub const ERR_LISTING_NOT_CANCELLABLE: &str = "This listing can no longer be cancelled.";
pub const ERR_LISTING_RESERVED: &str =
    "Listing has an active reservation or purchase in progress. Try again later.";
pub const ERR_LISTING_NOT_AVAILABLE: &str = "Listing is no longer available.";
pub const ERR_LISTING_EXPIRED: &str = "Listing expired.";
pub const ERR_SELF_TRADE: &str = "You cannot buy your own item.";
pub const ERR_RESERVED_BY_OTHER: &str = "Listing reserved by another operator.";
pub const ERR_QTY_REQUIRED_MULTI: &str =
    "For listings with more than 1 unit, send the qty field (number of units to buy). E.g. qty: 1 to buy only one.";
pub const ERR_INVALID_LISTING_PRICE: &str = "Invalid listing price.";
pub const ERR_PRICE_OUTSIDE_SHOP_BOUNDS: &str =
    "This listing price is outside allowed limits (shop bounds). Refresh the list — purchase not possible.";
pub const ERR_INSUFFICIENT_USDC: &str = "Insufficient USDC";
pub const ERR_LISTING_NO_ITEM: &str = "Listing has no item.";
pub const ERR_LISTING_QTY_MISMATCH: &str =
    "Listing unavailable or server quantity mismatch (refresh the list and try again).";
pub const ERR_LISTING_ALREADY_SOLD: &str = "Listing already sold or quantity unavailable.";
pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_IDEMPOTENCY_CONFLICT: &str =
    "Purchase already recorded with this idempotency key. Repeat the request to get the result.";
pub const ERR_NO_PROCEEDS: &str = "No proceeds to settle.";
pub const ERR_NO_CUSTODY: &str = "No items in custody to claim.";
pub const ERR_CUSTODY_NOT_FOUND: &str = "Item not found or already collected.";
pub const CODE_NOT_FOUND: &str = "NOT_FOUND";
pub const CODE_FORBIDDEN: &str = "FORBIDDEN";
pub const CODE_IDEMPOTENCY_KEY_REQUIRED: &str = "IDEMPOTENCY_KEY_REQUIRED";
pub const CODE_IDEMPOTENCY_CONFLICT: &str = "IDEMPOTENCY_CONFLICT";

#[derive(Debug)]
pub enum MarketError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        missing: Option<f64>,
    },
    Transport(anyhow::Error),
}

impl MarketError {
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

    pub fn not_found(error: impl Into<String>, code: Option<&str>) -> Self {
        match code {
            Some(c) => Self::domain_code(HTTP_NOT_FOUND, error, c),
            None => Self::domain(HTTP_NOT_FOUND, error),
        }
    }

    pub fn forbidden(error: impl Into<String>, code: Option<&str>) -> Self {
        match code {
            Some(c) => Self::domain_code(HTTP_FORBIDDEN, error, c),
            None => Self::domain(HTTP_FORBIDDEN, error),
        }
    }

    pub fn conflict(error: impl Into<String>) -> Self {
        Self::domain(HTTP_CONFLICT, error)
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

    pub fn transport<E: Into<anyhow::Error>>(err: E) -> Self {
        Self::Transport(err.into())
    }

    pub fn from_p2p(err: anyhow::Error) -> Self {
        let msg = err.to_string();
        if msg.starts_with(INSUFFICIENT_STOCK) {
            return Self::bad(ERR_INSUFFICIENT_STOCK_TO_LIST);
        }
        Self::Transport(err)
    }

    pub fn from_unique(err: tokio_postgres::Error) -> Self {
        if err.code() == Some(&SqlState::UNIQUE_VIOLATION) {
            return Self::conflict_code(ERR_IDEMPOTENCY_CONFLICT, CODE_IDEMPOTENCY_CONFLICT);
        }
        Self::Transport(err.into())
    }
}

impl std::fmt::Display for MarketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Domain { error, .. } => write!(f, "{error}"),
            Self::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MarketError {}

impl From<tokio_postgres::Error> for MarketError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::from_unique(e)
    }
}

impl From<anyhow::Error> for MarketError {
    fn from(e: anyhow::Error) -> Self {
        Self::Transport(e)
    }
}

impl From<deadpool_postgres::PoolError> for MarketError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::transport(e)
    }
}
