//! Admin upgrade package purchase (USDC debit + loot materialize + idem) HTTP surface.

pub mod errors;
pub mod http;
pub mod purchase;

pub use purchase::UPGRADE_PACKAGE_PURCHASE_PATH;
