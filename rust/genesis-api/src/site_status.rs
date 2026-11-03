//! Host filter for the public kill-switch.
//!
//! The setting is global (`settings.site_maintenance`) because prod and
//! `dev.genesisdao.tech` share this VM. The screen only arms on the principal
//! public host (`genesisdao.tech` / `www.`), matching mailer
//! `DEFAULT_PUBLIC_BASE_URL_PROD`.

use axum::http::{header, HeaderMap};

/// Hostname of `https://genesisdao.tech` (genesis-auth `DEFAULT_PUBLIC_BASE_URL_PROD`).
pub const PRINCIPAL_PUBLIC_HOST: &str = "genesisdao.tech";
/// Cookie twin of the apex (`cookies.rs`: `www.genesisdao.tech` → apex).
const PRINCIPAL_WWW_HOST: &str = "www.genesisdao.tech";

pub fn normalize_request_host(raw: &str) -> String {
    let host = raw.trim().to_ascii_lowercase();
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name.to_string(),
        _ => host,
    }
}

pub fn request_host(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::HOST)?.to_str().ok()?;
    let host = normalize_request_host(raw);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

pub fn is_principal_public_host(host: &str) -> bool {
    let host = normalize_request_host(host);
    host == PRINCIPAL_PUBLIC_HOST || host == PRINCIPAL_WWW_HOST
}

/// Setting on + this request is the principal public site.
pub fn effective_maintenance(setting_on: bool, host: Option<&str>) -> bool {
    setting_on && host.map(is_principal_public_host).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn principal_is_genesisdao_apex_and_www() {
        assert!(is_principal_public_host("genesisdao.tech"));
        assert!(is_principal_public_host("GenesisDAO.tech"));
        assert!(is_principal_public_host("www.genesisdao.tech"));
        assert!(is_principal_public_host("genesisdao.tech:443"));
        assert!(!is_principal_public_host("dev.genesisdao.tech"));
        assert!(!is_principal_public_host("test.genesisdao.tech"));
        assert!(!is_principal_public_host("spot.genesisdao.tech"));
        assert!(!is_principal_public_host("localhost"));
        assert!(!is_principal_public_host(""));
    }

    #[test]
    fn effective_requires_setting_and_principal_host() {
        assert!(effective_maintenance(true, Some("genesisdao.tech")));
        assert!(effective_maintenance(true, Some("www.genesisdao.tech")));
        assert!(!effective_maintenance(true, Some("dev.genesisdao.tech")));
        assert!(!effective_maintenance(false, Some("genesisdao.tech")));
        assert!(!effective_maintenance(true, None));
    }

    #[test]
    fn request_host_reads_host_header() {
        let mut h = HeaderMap::new();
        h.insert(
            header::HOST,
            HeaderValue::from_static("dev.genesisdao.tech"),
        );
        assert_eq!(request_host(&h).as_deref(), Some("dev.genesisdao.tech"));
    }
}
