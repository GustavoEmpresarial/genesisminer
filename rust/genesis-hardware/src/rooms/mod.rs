//! Room slot purchase (USDC debit + unlock slots + idem) HTTP surface.

pub mod errors;
pub mod http;
pub mod purchase_slot;

pub use purchase_slot::{purchase_slot, ROOM_PURCHASE_SLOT_PATH};
