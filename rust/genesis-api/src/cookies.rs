//! Cookie Domain / Secure / SameSite parity with Node `cookies.ts`.

use crate::config::{COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_SID};

/// `www.genesisdao.tech` → `genesisdao.tech` (label + TLD).
const REGISTRABLE_DOMAIN_LABELS: usize = 2;
const CLEAR_COOKIE_MAX_AGE: u64 = 0;

#[derive(Debug, Clone)]
pub struct CookieConfig {
    pub secure: bool,
    /// `Domain=.example.com` or empty (host-only).
    pub domain_attr: Option<String>,
}

impl CookieConfig {
    pub fn from_env(is_production: bool) -> Self {
        Self {
            secure: is_production,
            domain_attr: resolve_cookie_domain(
                env_trim("COOKIE_DOMAIN"),
                env_trim("FRONTEND_URL"),
                env_trim("PUBLIC_URL"),
                env_trim("SITE_URL"),
            ),
        }
    }

    pub fn set_cookie(
        &self,
        name: &str,
        value: &str,
        max_age_sec: u64,
        same_site: SameSite,
    ) -> String {
        build_set_cookie(name, value, Some(max_age_sec), "/", same_site, self)
    }

    pub fn clear_cookie(&self, name: &str, same_site: SameSite) -> String {
        build_set_cookie(name, "", Some(CLEAR_COOKIE_MAX_AGE), "/", same_site, self)
    }

    pub fn sid_cookie(&self, sid: &str, max_age_sec: u64) -> String {
        self.set_cookie(COOKIE_SID, sid, max_age_sec, SameSite::Lax)
    }

    pub fn access_cookie(&self, token: &str, max_age_sec: u64) -> String {
        self.set_cookie(COOKIE_ACCESS, token, max_age_sec, SameSite::Strict)
    }

    pub fn refresh_cookie(&self, token: &str, max_age_sec: u64) -> String {
        self.set_cookie(COOKIE_REFRESH, token, max_age_sec, SameSite::Strict)
    }

    pub fn clear_sid(&self) -> String {
        self.clear_cookie(COOKIE_SID, SameSite::Lax)
    }

    pub fn clear_access(&self) -> String {
        self.clear_cookie(COOKIE_ACCESS, SameSite::Strict)
    }

    pub fn clear_refresh(&self) -> String {
        self.clear_cookie(COOKIE_REFRESH, SameSite::Strict)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    Lax,
    Strict,
}

impl SameSite {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lax => "Lax",
            Self::Strict => "Strict",
        }
    }
}

fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `COOKIE_DOMAIN` or apex of FRONTEND_URL / PUBLIC_URL / SITE_URL.
pub fn resolve_cookie_domain(
    explicit: Option<String>,
    frontend_url: Option<String>,
    public_url: Option<String>,
    site_url: Option<String>,
) -> Option<String> {
    if let Some(raw) = explicit {
        let d = raw.trim();
        if d.is_empty() {
            return None;
        }
        let with_dot = if d.starts_with('.') {
            d.to_string()
        } else {
            format!(".{d}")
        };
        return Some(format!("Domain={with_dot}"));
    }
    let base = frontend_url.or(public_url).or(site_url)?;
    let host = url_hostname(&base)?;
    if host == "localhost" || host.ends_with(".localhost") {
        return None;
    }
    let labels: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    if labels.len() >= REGISTRABLE_DOMAIN_LABELS {
        let apex = labels[labels.len() - REGISTRABLE_DOMAIN_LABELS..].join(".");
        return Some(format!("Domain=.{apex}"));
    }
    None
}

fn url_hostname(raw: &str) -> Option<String> {
    let parsed = raw.parse::<http::Uri>().ok()?;
    parsed.host().map(|h| h.to_ascii_lowercase())
}

fn build_set_cookie(
    name: &str,
    value: &str,
    max_age_sec: Option<u64>,
    path: &str,
    same_site: SameSite,
    cfg: &CookieConfig,
) -> String {
    let mut parts = vec![
        format!("{name}={value}"),
        "HttpOnly".into(),
        format!("SameSite={}", same_site.as_str()),
        format!("Path={path}"),
    ];
    if let Some(d) = &cfg.domain_attr {
        parts.push(d.clone());
    }
    if cfg.secure {
        parts.push("Secure".into());
    }
    if let Some(age) = max_age_sec {
        parts.push(format!("Max-Age={age}"));
    }
    parts.join("; ")
}

pub fn parse_cookies(header: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(raw) = header else {
        return out;
    };
    for part in raw.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        out.insert(key.to_string(), v.trim().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_domain_from_explicit() {
        let d = resolve_cookie_domain(Some("genesisdao.tech".into()), None, None, None);
        assert_eq!(d.as_deref(), Some("Domain=.genesisdao.tech"));
        let d2 = resolve_cookie_domain(Some(".genesisdao.tech".into()), None, None, None);
        assert_eq!(d2.as_deref(), Some("Domain=.genesisdao.tech"));
    }

    #[test]
    fn cookie_domain_from_frontend_apex() {
        let d = resolve_cookie_domain(None, Some("https://www.genesisdao.tech".into()), None, None);
        assert_eq!(d.as_deref(), Some("Domain=.genesisdao.tech"));
    }

    #[test]
    fn cookie_domain_localhost_host_only() {
        let d = resolve_cookie_domain(None, Some("http://localhost:5173".into()), None, None);
        assert!(d.is_none());
    }

    #[test]
    fn cookie_domain_empty_host_only() {
        let d = resolve_cookie_domain(None, None, None, None);
        assert!(d.is_none());
    }

    #[test]
    fn secure_only_in_production() {
        let prod = CookieConfig {
            secure: true,
            domain_attr: Some("Domain=.genesisdao.tech".into()),
        };
        let h = prod.access_cookie("tok", 900);
        assert!(h.contains("gm_access=tok"));
        assert!(h.contains("HttpOnly"));
        assert!(h.contains("SameSite=Strict"));
        assert!(h.contains("Path=/"));
        assert!(h.contains("Secure"));
        assert!(h.contains("Max-Age=900"));
        assert!(h.contains("Domain=.genesisdao.tech"));
        assert!(!h.contains("; ;"));

        let dev = CookieConfig {
            secure: false,
            domain_attr: None,
        };
        let h2 = dev.access_cookie("tok", 900);
        assert!(!h2.contains("Secure"));
        assert!(!h2.contains("Domain="));
    }

    #[test]
    fn sid_is_lax_jwt_is_strict() {
        let cfg = CookieConfig {
            secure: true,
            domain_attr: None,
        };
        assert!(cfg.sid_cookie("abc", 100).contains("SameSite=Lax"));
        assert!(cfg.refresh_cookie("r", 100).contains("SameSite=Strict"));
    }

    #[test]
    fn clear_uses_max_age_zero_same_flags() {
        let cfg = CookieConfig {
            secure: true,
            domain_attr: Some("Domain=.genesisdao.tech".into()),
        };
        let h = cfg.clear_access();
        assert!(h.starts_with("gm_access=;"));
        assert!(h.contains("Max-Age=0"));
        assert!(h.contains("Secure"));
        assert!(h.contains("SameSite=Strict"));
        assert!(h.contains("Domain=.genesisdao.tech"));
        let sid = cfg.clear_sid();
        assert!(sid.starts_with("sid=;"));
        assert!(sid.contains("SameSite=Lax"));
        assert!(sid.contains("Max-Age=0"));
    }

    #[test]
    fn parse_cookie_header() {
        let m = parse_cookies(Some("sid=abc123; gm_access=tok1; gm_refresh=tok2"));
        assert_eq!(m.get("sid").map(String::as_str), Some("abc123"));
        assert_eq!(m.get("gm_access").map(String::as_str), Some("tok1"));
    }
}
