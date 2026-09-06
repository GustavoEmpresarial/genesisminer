//! Profile writes twin — Node `modules/profile` leftovers (identity / password /
//! security-events / wallet SIWE / referral bind+overview+state).

mod audit;
pub(crate) mod auth_client;
mod eth;
mod identity;
mod password;
mod referral;
mod wallet;

use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::player_reads::{fail_read, ok_payload, PlayerReadBody, PlayerReadError};

pub use audit::list_profile_security_events;
pub use identity::run_patch_identity;
pub use password::run_change_password;
pub use referral::{run_referral_bind, run_referral_overview, run_referral_state};
pub use wallet::{run_wallet_challenge, run_wallet_get, run_wallet_remove, run_wallet_verify};

pub const PROFILE_IDENTITY_PATH: &str = "/v1/profile/identity";
pub const PROFILE_PASSWORD_CHANGE_PATH: &str = "/v1/profile/password/change";
pub const PROFILE_SECURITY_EVENTS_PATH: &str = "/v1/profile/security-events";
pub const PROFILE_WALLET_CHALLENGE_PATH: &str = "/v1/profile/wallet/connect/challenge";
pub const PROFILE_WALLET_VERIFY_PATH: &str = "/v1/profile/wallet/connect/verify";
pub const PROFILE_WALLET_GET_PATH: &str = "/v1/profile/wallet";
pub const PROFILE_WALLET_REMOVE_PATH: &str = "/v1/profile/wallet/remove";
pub const PROFILE_REFERRAL_BIND_PATH: &str = "/v1/profile/referral/bind";
pub const PROFILE_REFERRAL_STATE_PATH: &str = "/v1/profile/referral/state";
pub const PROFILE_REFERRAL_OVERVIEW_PATH: &str = "/v1/profile/referral/overview";

/// Node `SECURITY_EVENTS_DEFAULT_LIMIT` (controller hard-codes 50).
pub const SECURITY_EVENTS_CONTROLLER_LIMIT: i64 = 50;
/// Node `OVERVIEW_HISTORY_LIMIT` in referral.controller.
pub const OVERVIEW_HISTORY_LIMIT: i64 = 80;
/// Node `WALLET_HISTORY_LIMIT_DEFAULT`.
pub const WALLET_HISTORY_LIMIT_DEFAULT: i64 = 100;
/// Node `WALLET_HISTORY_LIMIT_MAX`.
pub const WALLET_HISTORY_LIMIT_MAX: i64 = 200;
/// Node `REQUEST_ID_MAX_CHARS`.
pub const REQUEST_ID_MAX_CHARS: usize = 64;

const _: () = assert!(SECURITY_EVENTS_CONTROLLER_LIMIT == 50);
const _: () = assert!(OVERVIEW_HISTORY_LIMIT == 80);
const _: () = assert!(WALLET_HISTORY_LIMIT_DEFAULT == 100);
const _: () = assert!(WALLET_HISTORY_LIMIT_MAX == 200);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileIdentityRequest {
    pub user_id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePasswordChangeRequest {
    pub user_id: i64,
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub new_password: Option<String>,
    #[serde(default)]
    pub confirm_password: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSecurityEventsRequest {
    pub user_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWalletUserRequest {
    pub user_id: i64,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub client_ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub history_limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileWalletVerifyRequest {
    pub user_id: i64,
    #[serde(default)]
    pub challenge_id: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub chain_id: Option<serde_json::Value>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub client_ip: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReferralBindRequest {
    pub user_id: i64,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReferralReadRequest {
    pub user_id: i64,
    #[serde(default)]
    pub invite_base_url: Option<String>,
    #[serde(default)]
    pub history_limit: Option<i64>,
}

pub fn ok_write(payload: Value) -> (StatusCode, Json<PlayerReadBody>) {
    ok_payload(payload)
}

pub fn fail_write(e: PlayerReadError) -> (StatusCode, Json<PlayerReadBody>) {
    fail_read(e)
}

pub(crate) fn clamp_request_id(raw: Option<&str>) -> Option<String> {
    let t = raw.map(str::trim).filter(|s| !s.is_empty())?;
    Some(t.chars().take(REQUEST_ID_MAX_CHARS).collect())
}
