//! Reverse proxy to Express — HTTP (admin). Websocket upgrades for `/socket.io`
//! are owned by genesis-api socketioxide (not proxied).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::copy_bidirectional;
use tracing::warn;

use crate::config::{ApiConfig, AppState, EXPRESS_PROXY_TIMEOUT_MS};
use crate::owned::{is_owned_route, should_proxy_express};

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
];

fn is_hop_by_hop(name: &HeaderName) -> bool {
    HOP_BY_HOP
        .iter()
        .any(|h| name.as_str().eq_ignore_ascii_case(h))
}

fn is_websocket_upgrade(req: &Request<Body>) -> bool {
    req.headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

fn express_target(
    cfg: &ApiConfig,
    req: &Request<Body>,
) -> Result<(http::Uri, HeaderValue), StatusCode> {
    let base = cfg
        .express_url
        .as_deref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let pq = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let joined = format!("{base}{pq}");
    let uri: http::Uri = joined.parse().map_err(|_| StatusCode::BAD_GATEWAY)?;
    let host = uri
        .authority()
        .map(|a| a.as_str())
        .ok_or(StatusCode::BAD_GATEWAY)?;
    let host_hv = HeaderValue::from_str(host).map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok((uri, host_hv))
}

pub async fn proxy_to_express(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Result<Response, StatusCode> {
    debug_assert!(
        should_proxy_express(req.method(), req.uri().path())
            && !is_owned_route(req.method(), req.uri().path()),
        "owned route leaked into Express proxy"
    );
    if state.cfg.express_url.is_none() {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({
                "error": "GENESIS_EXPRESS_URL unset",
                "code": "EXPRESS_UNAVAILABLE"
            })),
        )
            .into_response());
    }
    if is_websocket_upgrade(&req) {
        return proxy_websocket(state, req).await;
    }
    proxy_http(state, req).await
}

async fn proxy_http(state: Arc<AppState>, req: Request<Body>) -> Result<Response, StatusCode> {
    let (uri, host) = express_target(&state.cfg, &req)?;
    let method = req.method().clone();
    let mut headers = req.headers().clone();
    headers.remove(header::HOST);
    for name in headers.keys().cloned().collect::<Vec<_>>() {
        if is_hop_by_hop(&name) {
            headers.remove(&name);
        }
    }
    headers.insert(header::HOST, host);
    let body_bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let timeout = std::time::Duration::from_millis(EXPRESS_PROXY_TIMEOUT_MS);
    let builder = state
        .http
        .request(method, uri.to_string())
        .timeout(timeout)
        .headers(headers)
        .body(body_bytes);

    let res = builder.send().await.map_err(|e| {
        warn!(err = %e, "express proxy http");
        StatusCode::BAD_GATEWAY
    })?;

    let status = res.status();
    let mut out_headers = res.headers().clone();
    for name in out_headers.keys().cloned().collect::<Vec<_>>() {
        if is_hop_by_hop(&name) {
            out_headers.remove(&name);
        }
    }
    let bytes = res.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    Ok(response)
}

async fn proxy_websocket(
    state: Arc<AppState>,
    mut req: Request<Body>,
) -> Result<Response, StatusCode> {
    let (uri, host) = express_target(&state.cfg, &req)?;
    let on_upgrade = req
        .extensions_mut()
        .remove::<hyper::upgrade::OnUpgrade>()
        .ok_or(StatusCode::BAD_REQUEST)?;

    let (parts, _body) = req.into_parts();
    let mut upstream = hyper::Request::builder()
        .method(parts.method)
        .uri(uri)
        .body(http_body_util::Empty::<Bytes>::new())
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    for (k, v) in parts.headers.iter() {
        if k == header::HOST {
            continue;
        }
        if is_hop_by_hop(k) && k != header::CONNECTION && k != header::UPGRADE {
            continue;
        }
        upstream.headers_mut().append(k, v.clone());
    }
    upstream.headers_mut().insert(header::HOST, host);

    let client = hyper_util::client::legacy::Client::builder(TokioExecutor::new()).build_http();
    let timeout = std::time::Duration::from_millis(EXPRESS_PROXY_TIMEOUT_MS);
    let mut upstream_res = tokio::time::timeout(timeout, client.request(upstream))
        .await
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
        .map_err(|e| {
            warn!(err = %e, "express proxy ws");
            StatusCode::BAD_GATEWAY
        })?;

    let upstream_upgrade = upstream_res
        .extensions_mut()
        .remove::<hyper::upgrade::OnUpgrade>();

    if let Some(up) = upstream_upgrade {
        tokio::spawn(async move {
            match (on_upgrade.await, up.await) {
                (Ok(client_io), Ok(upstream_io)) => {
                    let mut c = TokioIo::new(client_io);
                    let mut u = TokioIo::new(upstream_io);
                    let _ = copy_bidirectional(&mut c, &mut u).await;
                }
                (Err(e), _) => warn!(err = %e, "ws client upgrade"),
                (_, Err(e)) => warn!(err = %e, "ws upstream upgrade"),
            }
        });
    }

    let status = upstream_res.status();
    let headers = std::mem::take(upstream_res.headers_mut());
    let body = upstream_res
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
