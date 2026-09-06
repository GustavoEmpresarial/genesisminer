//! Wheel / roleta TX workers (`POST /v1/wheel/*`, `/v1/roleta/claim`).

pub mod claim;
pub mod errors;
pub mod http;
pub mod paid_spin;
pub mod promo_code;
pub mod promo_redeem;
pub mod roll;

pub use claim::ROLETA_CLAIM_PATH;
pub use paid_spin::WHEEL_PAID_SPIN_PATH;
pub use promo_redeem::WHEEL_REDEEM_CODE_PATH;
pub use roll::WHEEL_ROLL_PATH;
