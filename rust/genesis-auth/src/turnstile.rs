//! Cloudflare Turnstile siteverify — mirrors Node `cloudflare-turnstile.ts`.

use serde::Deserialize;

/// Cloudflare siteverify endpoint — keep in sync with Node fetch URL.
pub const TURNSTILE_SITEVERIFY_URL: &str =
    "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/// Domain messages — keep in sync with Node `verifyTurnstileToken`.
pub const ERR_CAPTCHA_REQUIRED: &str = "Complete the captcha before continuing.";
pub const ERR_CAPTCHA_FAILED: &str = "Captcha validation failed. Refresh the page and try again.";
pub const ERR_CAPTCHA_UNAVAILABLE: &str =
    "Could not validate captcha right now. Please try again in a moment.";
/// ENABLED=1 but secret missing — fail-closed (never `{ok:true}` bypass).
pub const ERR_TURNSTILE_MISCONFIGURED: &str = "Turnstile misconfigured.";

#[derive(Clone)]
pub struct TurnstileConfig {
    /// `CLOUDFLARE_TURNSTILE_ENABLED=1`.
    pub enabled_flag: bool,
    pub secret_key: String,
    /// Overridable in tests; production uses [`TURNSTILE_SITEVERIFY_URL`].
    pub siteverify_url: String,
}

impl std::fmt::Debug for TurnstileConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnstileConfig")
            .field("enabled_flag", &self.enabled_flag)
            .field(
                "secret_key",
                &if self.secret_key.is_empty() {
                    "<empty>"
                } else {
                    "<redacted>"
                },
            )
            .field("siteverify_url", &self.siteverify_url)
            .finish()
    }
}

impl TurnstileConfig {
    /// Worker gate: ENABLED + SECRET (site key lives on Node/`app` only).
    pub fn from_env() -> Self {
        let secret_key = env_trim("CLOUDFLARE_TURNSTILE_SECRET_KEY");
        let enabled_flag = env_trim("CLOUDFLARE_TURNSTILE_ENABLED") == "1";
        Self {
            enabled_flag,
            secret_key,
            siteverify_url: TURNSTILE_SITEVERIFY_URL.to_string(),
        }
    }

    /// Ready to enforce siteverify (flag on + secret present).
    pub fn is_enforcement_ready(&self) -> bool {
        self.enabled_flag && !self.secret_key.is_empty()
    }
}

fn env_trim(key: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
struct SiteverifyResponse {
    success: Option<bool>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TurnstileVerifyOutcome {
    Ok,
    BadRequest(&'static str),
    BadGateway(&'static str),
    ServiceUnavailable(&'static str),
}

/// Verify Turnstile token against Cloudflare (or no-op when disabled).
///
/// - `ENABLED≠1` → Ok (feature off)
/// - `ENABLED=1` without secret → 503 misconfigured (never Ok bypass)
/// - empty token when enforcing → 400
pub async fn verify_turnstile_token(
    cfg: &TurnstileConfig,
    http: &reqwest::Client,
    token: &str,
    remoteip: Option<&str>,
) -> TurnstileVerifyOutcome {
    if !cfg.enabled_flag {
        return TurnstileVerifyOutcome::Ok;
    }
    if cfg.secret_key.is_empty() {
        return TurnstileVerifyOutcome::ServiceUnavailable(ERR_TURNSTILE_MISCONFIGURED);
    }
    let response = token.trim();
    if response.is_empty() {
        return TurnstileVerifyOutcome::BadRequest(ERR_CAPTCHA_REQUIRED);
    }

    let mut form = vec![
        ("secret", cfg.secret_key.as_str()),
        ("response", response),
    ];
    if let Some(ip) = remoteip {
        let ip = ip.trim();
        if !ip.is_empty() && ip != "unknown" {
            form.push(("remoteip", ip));
        }
    }

    match http
        .post(&cfg.siteverify_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
    {
        Ok(res) => {
            let status_ok = res.status().is_success();
            let data: SiteverifyResponse = match res.json().await {
                Ok(d) => d,
                Err(_) => SiteverifyResponse { success: None },
            };
            if !status_ok || data.success != Some(true) {
                return TurnstileVerifyOutcome::BadRequest(ERR_CAPTCHA_FAILED);
            }
            TurnstileVerifyOutcome::Ok
        }
        Err(_) => TurnstileVerifyOutcome::BadGateway(ERR_CAPTCHA_UNAVAILABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled_cfg() -> TurnstileConfig {
        TurnstileConfig {
            enabled_flag: false,
            secret_key: String::new(),
            siteverify_url: TURNSTILE_SITEVERIFY_URL.to_string(),
        }
    }

    fn enabled_cfg(url: &str) -> TurnstileConfig {
        TurnstileConfig {
            enabled_flag: true,
            secret_key: "secret-key".into(),
            siteverify_url: url.to_string(),
        }
    }

    fn misconfigured_cfg() -> TurnstileConfig {
        TurnstileConfig {
            enabled_flag: true,
            secret_key: String::new(),
            siteverify_url: TURNSTILE_SITEVERIFY_URL.to_string(),
        }
    }

    #[tokio::test]
    async fn disabled_approves_without_http() {
        let http = reqwest::Client::new();
        let out = verify_turnstile_token(&disabled_cfg(), &http, "any", None).await;
        assert_eq!(out, TurnstileVerifyOutcome::Ok);
    }

    #[tokio::test]
    async fn enabled_empty_token_is_400() {
        let http = reqwest::Client::new();
        let out = verify_turnstile_token(&enabled_cfg("http://127.0.0.1:1/nope"), &http, "  ", None)
            .await;
        assert_eq!(
            out,
            TurnstileVerifyOutcome::BadRequest(ERR_CAPTCHA_REQUIRED)
        );
    }

    #[tokio::test]
    async fn enabled_without_secret_is_503_never_ok() {
        let http = reqwest::Client::new();
        let out = verify_turnstile_token(&misconfigured_cfg(), &http, "", None).await;
        assert_eq!(
            out,
            TurnstileVerifyOutcome::ServiceUnavailable(ERR_TURNSTILE_MISCONFIGURED)
        );
        let out2 = verify_turnstile_token(&misconfigured_cfg(), &http, "tok", None).await;
        assert_eq!(
            out2,
            TurnstileVerifyOutcome::ServiceUnavailable(ERR_TURNSTILE_MISCONFIGURED)
        );
    }

    #[test]
    fn enforcement_ready_needs_flag_and_secret() {
        assert!(!disabled_cfg().is_enforcement_ready());
        assert!(!misconfigured_cfg().is_enforcement_ready());
        assert!(enabled_cfg("http://x").is_enforcement_ready());
    }
}
