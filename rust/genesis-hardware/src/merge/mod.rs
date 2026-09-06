//! Merge fee + adjust + history TX worker (`POST /v1/merge/execute`).

pub mod execute;
pub mod http;
pub mod resolve;

pub use execute::MERGE_EXECUTE_PATH;
