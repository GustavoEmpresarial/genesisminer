//! Domain vs transport errors for `/v1/lucky-boxes/*`.

pub use crate::market::errors::{
    HTTP_BAD_REQUEST, HTTP_CONFLICT, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_OK,
    HTTP_UNPROCESSABLE_ENTITY,
};

pub const HTTP_UNAUTHORIZED: u16 = 401;
pub const HTTP_INTERNAL_SERVER_ERROR: u16 = 500;

pub const ERR_INVALID_SESSION: &str = "Invalid session.";
pub const ERR_IDEMPOTENCY_KEY_REQUIRED: &str =
    "Invalid or missing idempotencyKey (8–128 safe characters).";
pub const ERR_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "Same idempotency key with a different request.";
pub const ERR_IDEMPOTENCY_IN_FLIGHT: &str =
    "Pedido duplicado em curso. Recarrega ou usa outra chave de idempotência.";
pub const ERR_IDEMPOTENCY_CORRUPT: &str =
    "Cached idempotency payload is corrupt. Retry with a new idempotency key.";
pub const ERR_BOX_NOT_FOUND: &str = "Box not found.";
pub const ERR_BOX_NOT_FOR_SALE: &str = "This box is not for sale in the shop.";
pub const ERR_INVALID_BOX_PRICE: &str = "Invalid box price or not configured for sale.";
pub const ERR_SHOP_ONCE_QTY: &str =
    "Esta caixa de compra única só pode ser adquirida uma unidade de cada vez.";
pub const ERR_NO_PRIZES_CONFIGURED_SALE: &str =
    "This box has no prizes configured and cannot be sold. Contact support.";
pub const ERR_MAX_PER_USER: &str = "Limite por jogador para esta caixa excedido.";
pub const ERR_SHOP_ONCE_CLAIMED: &str = "Esta caixa de compra única já foi resgatada.";
pub const ERR_GAME_STATE_MISSING: &str =
    "Game state has not been created yet. Entre no jogo e tente novamente.";
pub const ERR_INSUFFICIENT_USDC: &str = "Insufficient USDC balance.";
pub const ERR_STOCK_SOLD_OUT: &str =
    "Stock sold out or changed during purchase. Balance was not debited twice — reload the shop.";
pub const ERR_NO_BOXES_INVENTORY: &str = "You have no boxes of this type in inventory.";
pub const ERR_NO_PRIZES_OPEN: &str =
    "This box has no prizes configured. Contact support — the box was not consumed.";
pub const ERR_ROLETA_ITEM_MISSING: &str =
    "This prize box points to an item that no longer exists. Contact support for compensation — the box was not consumed.";
pub const ERR_GAME_STATE_OPEN: &str = "Game state has not been created yet.";
pub const ERR_UPGRADE_NOT_FOUND: &str = "Upgrade not found.";
pub const CODE_IDEMPOTENCY_KEY_REQUIRED: &str = "IDEMPOTENCY_KEY_REQUIRED";
pub const CODE_IDEMPOTENCY_PAYLOAD_MISMATCH: &str = "IDEMPOTENCY_PAYLOAD_MISMATCH";
pub const CODE_LUCKY_BOX_BUY: &str = "LUCKY_BOX_BUY";
pub const CODE_LUCKY_BOX_OPEN: &str = "LUCKY_BOX_OPEN";
pub const CODE_UPGRADE_NOT_FOUND: &str = "UPGRADE_NOT_FOUND";

#[derive(Debug)]
pub enum LuckyBoxError {
    Domain {
        status: u16,
        error: String,
        code: Option<String>,
        missing: Option<f64>,
    },
    Transport(anyhow::Error),
}

impl LuckyBoxError {
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

    pub fn buy(status: u16, error: impl Into<String>, missing: Option<f64>) -> Self {
        Self::Domain {
            status,
            error: error.into(),
            code: Some(CODE_LUCKY_BOX_BUY.to_string()),
            missing,
        }
    }

    pub fn open(status: u16, error: impl Into<String>) -> Self {
        Self::domain_code(status, error, CODE_LUCKY_BOX_OPEN)
    }

    pub fn bad(error: impl Into<String>) -> Self {
        Self::domain(HTTP_BAD_REQUEST, error)
    }

    pub fn unauthorized(error: impl Into<String>) -> Self {
        Self::domain(HTTP_UNAUTHORIZED, error)
    }

    pub fn transport(e: impl Into<anyhow::Error>) -> Self {
        Self::Transport(e.into())
    }
}

impl From<deadpool_postgres::PoolError> for LuckyBoxError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Transport(e.into())
    }
}

impl From<tokio_postgres::Error> for LuckyBoxError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Transport(e.into())
    }
}
