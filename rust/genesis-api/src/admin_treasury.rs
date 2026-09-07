//! Admin treasury USDC transactions
//! (`GET /api/admin/etherscan/treasury-token-txs`).
//!
//! Replaces `server/modules/admin/etherscan/` (Express). `require_admin` gates
//! on tab `reports` (route table in [`crate::admin_auth`]); the Etherscan proxy
//! (+ API-key redaction) runs in `genesis-wallet`, which already holds
//! `ETHERSCAN_API_KEY` for deposit-receipt verification.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use crate::admin_auth::require_admin;
use crate::config::AppState;
use crate::facade::forward_wallet;

const PATH: &str = "/api/admin/etherscan/treasury-token-txs";
const W_PATH: &str = "/v1/wallet/admin/treasury-token-txs";

#[derive(Debug, Default, Deserialize)]
struct TxQuery {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    offset: Option<String>,
    #[serde(default)]
    address: Option<String>,
}

async fn treasury_token_txs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TxQuery>,
) -> Response {
    if let Err(e) = require_admin(&state, &headers, &Method::GET, PATH).await {
        return e;
    }
    let mut res = forward_wallet(
        &state,
        W_PATH,
        json!({ "page": q.page, "offset": q.offset, "address": q.address }),
    )
    .await;
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(PATH, get(treasury_token_txs))
}
