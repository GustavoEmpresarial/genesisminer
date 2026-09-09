//! Wheel / roleta TX workers (`POST /v1/wheel/*`, `/v1/roleta/claim`).

pub mod admin;
pub mod claim;
pub mod errors;
pub mod http;
pub mod paid_spin;
pub mod promo_code;
pub mod promo_redeem;
pub mod roll;

pub use admin::{
    WHEEL_ADMIN_PLAYERS_ADD_PATH, WHEEL_ADMIN_PLAYERS_PATH, WHEEL_ADMIN_PLAYERS_REMOVE_PATH,
    WHEEL_ADMIN_PRIZES_PATH,
    WHEEL_ADMIN_PRIZES_REPLACE_PATH, WHEEL_ADMIN_RUNTIME_CONFIG_PATH,
    WHEEL_ADMIN_RUNTIME_CONFIG_SET_PATH,
};
pub use claim::ROLETA_CLAIM_PATH;
pub use paid_spin::WHEEL_PAID_SPIN_PATH;
pub use promo_redeem::WHEEL_REDEEM_CODE_PATH;
pub use roll::WHEEL_ROLL_PATH;
