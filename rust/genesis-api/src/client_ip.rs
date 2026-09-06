//! Client IP — Node `getClientIpFromRequest` (XFF / CF when trusted).

use axum::http::HeaderMap;

use crate::config::ApiConfig;

const UNKNOWN: &str = "unknown";
const V4_MAP: &str = "::ffff:";

fn normalize(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some((first, _)) = s.split_once(',') {
        s = first.trim();
    }
    let n = s.strip_prefix(V4_MAP).unwrap_or(s);
    if n.is_empty() {
        None
    } else {
        Some(n.to_string())
    }
}

fn header_first(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(normalize)
}

fn is_usable_public(ip: &str) -> bool {
    if ip == UNKNOWN || ip == "::1" || ip == "127.0.0.1" {
        return false;
    }
    if let Some([a, b, _, _]) = parse_ipv4(ip) {
        if a == 10 || a == 127 || a == 0 {
            return false;
        }
        if a == 172 && (16..=31).contains(&b) {
            return false;
        }
        if a == 192 && b == 168 {
            return false;
        }
        if a == 169 && b == 254 {
            return false;
        }
        return true;
    }
    let lower = ip.to_ascii_lowercase();
    if lower == "::1"
        || lower.starts_with("fe80:")
        || lower.starts_with("fc")
        || lower.starts_with("fd")
    {
        return false;
    }
    true
}

fn parse_ipv4(ip: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n as u8;
    }
    Some(out)
}

pub fn get_client_ip(cfg: &ApiConfig, headers: &HeaderMap, remote: Option<&str>) -> String {
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |raw: Option<String>| {
        if let Some(n) = raw {
            candidates.push(n);
        }
    };
    if cfg.trust_cf_connecting_ip {
        push(header_first(headers, "cf-connecting-ip"));
        push(header_first(headers, "true-client-ip"));
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        for part in xff.split(',') {
            push(normalize(part));
        }
    }
    push(header_first(headers, "x-real-ip"));
    push(remote.and_then(normalize));
    for c in &candidates {
        if is_usable_public(c) {
            return c.clone();
        }
    }
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| UNKNOWN.into())
}
