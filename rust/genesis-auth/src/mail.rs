//! Transactional SMTP (reset + verification) — mirrors Node `mailer.ts`.

use lettre::message::{header::ContentType, Mailbox, Message};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::{SUBMISSION_PORT, SUBMISSIONS_PORT};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use tracing::warn;

/// Keep in sync with Node `DEFAULT_RESET_LINK_VALIDITY_MINUTES`.
pub const DEFAULT_RESET_LINK_VALIDITY_MINUTES: u32 = 60;
/// Keep in sync with Node `DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS`.
pub const DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS: u32 = 24;

const DEFAULT_MAIL_HOST_PROD: &str = "smtp.hostinger.com";
const DEFAULT_MAIL_FROM_PROD: &str = "\"Genesis Miner\" <no-reply@genesisdao.tech>";
const DEFAULT_PUBLIC_BASE_URL_PROD: &str = "https://genesisdao.tech";
const DEFAULT_MAIL_HOST_DEV: &str = "127.0.0.1";
const DEFAULT_MAIL_FROM_DEV: &str = "\"Genesis Miner Dev\" <dev@localhost>";
const DEFAULT_PUBLIC_BASE_URL_DEV: &str = "http://localhost:5173";
/// Prod default = STARTTLS submission (lettre `SUBMISSION_PORT` / 587).
const DEFAULT_MAIL_PORT_PROD: u16 = SUBMISSION_PORT;
const DEFAULT_MAIL_PORT_DEV: u16 = 1025;

/// SMTP TLS strategy — mirrors nodemailer `secure` + port semantics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmtpTlsMode {
    /// Plain / MailHog-style (no TLS).
    None,
    /// SMTPS implicit TLS (`relay` / Wrapper) — port 465 or `MAIL_SECURE=1`.
    Wrapper,
    /// Explicit STARTTLS (`starttls_relay`) — typically port 587.
    StartTls,
}

#[derive(Clone)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub tls_mode: SmtpTlsMode,
    pub user: Option<String>,
    pub pass: Option<String>,
    pub from: String,
    pub public_base_url: String,
}

impl std::fmt::Debug for MailConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("tls_mode", &self.tls_mode)
            .field("user", &self.user.as_ref().map(|_| "<redacted>"))
            .field("pass", &self.pass.as_ref().map(|_| "<redacted>"))
            .field("from", &self.from)
            .field("public_base_url", &self.public_base_url)
            .finish()
    }
}

/// Resolve TLS from port + `MAIL_SECURE` (never force Wrapper solely because prod).
///
/// - port 465 (`SUBMISSIONS_PORT`) or `MAIL_SECURE=1` → SMTPS Wrapper
/// - port 587 (`SUBMISSION_PORT`) → STARTTLS
/// - otherwise → plain (dev / MailHog)
pub fn resolve_smtp_tls_mode(port: u16, mail_secure: &str) -> SmtpTlsMode {
    if port == SUBMISSIONS_PORT || mail_secure.trim() == "1" {
        SmtpTlsMode::Wrapper
    } else if port == SUBMISSION_PORT {
        SmtpTlsMode::StartTls
    } else {
        SmtpTlsMode::None
    }
}

impl MailConfig {
    pub fn from_env() -> Self {
        let is_prod = is_production();
        let user = env_nonempty("MAIL_USER");
        let pass = env_nonempty("MAIL_PASS");
        if user.is_none() || pass.is_none() {
            warn!("[mailer] MAIL_USER/MAIL_PASS não configurados — envio de email vai falhar no primeiro send.");
        }
        let host = env_nonempty("MAIL_HOST").unwrap_or_else(|| {
            let fallback = if is_prod {
                DEFAULT_MAIL_HOST_PROD
            } else {
                DEFAULT_MAIL_HOST_DEV
            };
            if is_prod {
                warn!(
                    "[mailer] MAIL_HOST não definido — fallback produção ({}).",
                    fallback
                );
            } else {
                warn!(
                    "[mailer] MAIL_HOST não definido (dev) — {} (não SMTP de produção).",
                    fallback
                );
            }
            fallback.to_string()
        });
        let from = env_nonempty("MAIL_FROM").unwrap_or_else(|| {
            let fallback = if is_prod {
                DEFAULT_MAIL_FROM_PROD
            } else {
                DEFAULT_MAIL_FROM_DEV
            };
            if is_prod {
                warn!("[mailer] MAIL_FROM não definido — fallback produção (no-reply@genesisdao.tech).");
            } else {
                warn!("[mailer] MAIL_FROM não definido (dev) — {}.", fallback);
            }
            fallback.to_string()
        });
        let port = env_u16_or(
            "MAIL_PORT",
            if is_prod {
                DEFAULT_MAIL_PORT_PROD
            } else {
                DEFAULT_MAIL_PORT_DEV
            },
        );
        let tls_mode = resolve_smtp_tls_mode(port, &env_trim("MAIL_SECURE"));
        let public_base_url = resolve_public_base_url(is_prod);
        Self {
            host,
            port,
            tls_mode,
            user,
            pass,
            from,
            public_base_url,
        }
    }
}

fn is_production() -> bool {
    std::env::var("NODE_ENV")
        .map(|v| v.trim().eq_ignore_ascii_case("production"))
        .unwrap_or(false)
}

fn env_trim(key: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn env_nonempty(key: &str) -> Option<String> {
    let s = env_trim(key);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn env_u16_or(key: &str, fallback: u16) -> u16 {
    match std::env::var(key) {
        Ok(raw) => raw.trim().parse::<u16>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn resolve_public_base_url(is_prod: bool) -> String {
    let configured = env_nonempty("FRONTEND_URL")
        .or_else(|| env_nonempty("PUBLIC_URL"))
        .or_else(|| env_nonempty("SITE_URL"));
    let fallback = if is_prod {
        DEFAULT_PUBLIC_BASE_URL_PROD
    } else {
        DEFAULT_PUBLIC_BASE_URL_DEV
    };
    if configured.is_none() {
        warn!(
            "[mailer] FRONTEND_URL/PUBLIC_URL/SITE_URL não definidos — links → {}.",
            fallback
        );
    }
    let base = configured.unwrap_or_else(|| fallback.to_string());
    base.trim_end_matches('/').to_string()
}

fn build_transactional_email_html(
    title: &str,
    intro: &str,
    cta_label: &str,
    cta_link: &str,
    expiry_note: &str,
) -> String {
    format!(
        r#"
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #b45309; text-align: center;">{title}</h2>
      <p>Olá,</p>
      <p>{intro}</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="{cta_link}" style="background-color: #d97706; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">{cta_label}</a>
      </div>
      <p style="font-size: 13px; color: #475569;">{expiry_note}</p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
      <p style="font-size: 11px; color: #94a3b8; word-break: break-all;">{cta_link}</p>
      <p style="font-size: 12px; color: #64748b; text-align: center;">Genesis Miner</p>
    </div>
  "#
    )
}

fn percent_encode_token(token: &str) -> String {
    // encodeURIComponent-compatible for path segment (RFC 3986 unreserved kept).
    let mut out = String::with_capacity(token.len());
    for b in token.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn build_reset_email(cfg: &MailConfig, email: &str, reset_token: &str, validity_minutes: u32) -> Result<Message, String> {
    let minutes = if validity_minutes > 0 {
        validity_minutes
    } else {
        DEFAULT_RESET_LINK_VALIDITY_MINUTES
    };
    let reset_link = format!(
        "{}/redefinir-senha/{}",
        cfg.public_base_url,
        percent_encode_token(reset_token)
    );
    let html = build_transactional_email_html(
        "Password reset",
        "We received a request to reset the password for your <strong>Genesis Miner</strong> account. Use the button below (or copy the link if the button does not open):",
        "Reset my password",
        &reset_link,
        &format!(
            "This link expires in about <strong>{minutes} minutes</strong>. If you did not request this, ignore this email — your password will not change."
        ),
    );
    build_message(&cfg.from, email, "Password reset — Genesis Miner", &html)
}

pub fn build_verification_email(
    cfg: &MailConfig,
    email: &str,
    verification_token: &str,
    validity_hours: u32,
) -> Result<Message, String> {
    let hours = if validity_hours > 0 {
        validity_hours
    } else {
        DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS
    };
    let verify_link = format!(
        "{}/verificar-email/{}",
        cfg.public_base_url,
        percent_encode_token(verification_token)
    );
    let html = build_transactional_email_html(
        "Ative a sua conta",
        "Para ativar a sua nova conta no <strong>Genesis Miner</strong>, confirme o seu email clicando no botão abaixo:",
        "Confirmar email",
        &verify_link,
        &format!(
            "Este link expira em cerca de <strong>{hours} horas</strong>. Depois de confirmar, já poderá entrar normalmente na sua conta."
        ),
    );
    build_message(
        &cfg.from,
        email,
        "Confirme o seu email — Genesis Miner",
        &html,
    )
}

fn build_message(from: &str, to: &str, subject: &str, html: &str) -> Result<Message, String> {
    let from_mb: Mailbox = from
        .parse()
        .map_err(|e| format!("invalid MAIL_FROM: {e}"))?;
    let to_mb: Mailbox = to
        .parse()
        .map_err(|e| format!("invalid recipient: {e}"))?;
    Message::builder()
        .from(from_mb)
        .to(to_mb)
        .subject(subject)
        .header(ContentType::TEXT_HTML)
        .body(html.to_string())
        .map_err(|e| format!("build message: {e}"))
}

async fn smtp_transport(cfg: &MailConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let builder = match cfg.tls_mode {
        SmtpTlsMode::Wrapper => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
            .map_err(|e| format!("smtp relay (SMTPS): {e}"))?
            .port(cfg.port),
        SmtpTlsMode::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .map_err(|e| format!("smtp starttls_relay: {e}"))?
            .port(cfg.port),
        SmtpTlsMode::None => {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host).port(cfg.port)
        }
    };
    let builder = match (&cfg.user, &cfg.pass) {
        (Some(u), Some(p)) => builder.credentials(Credentials::new(u.clone(), p.clone())),
        _ => builder,
    };
    Ok(builder.build())
}

pub async fn send_mail(cfg: &MailConfig, message: Message) -> Result<(), String> {
    let transport = smtp_transport(cfg).await?;
    transport
        .send(message)
        .await
        .map(|_| ())
        .map_err(|e| format!("smtp send: {e}"))
}

pub async fn send_reset_email(
    cfg: &MailConfig,
    email: &str,
    reset_token: &str,
    validity_minutes: Option<u32>,
) -> Result<(), String> {
    let minutes = validity_minutes
        .filter(|m| *m > 0)
        .unwrap_or(DEFAULT_RESET_LINK_VALIDITY_MINUTES);
    let msg = build_reset_email(cfg, email, reset_token, minutes)?;
    send_mail(cfg, msg).await
}

pub async fn send_verification_email(
    cfg: &MailConfig,
    email: &str,
    verification_token: &str,
    validity_hours: Option<u32>,
) -> Result<(), String> {
    let hours = validity_hours
        .filter(|h| *h > 0)
        .unwrap_or(DEFAULT_VERIFICATION_LINK_VALIDITY_HOURS);
    let msg = build_verification_email(cfg, email, verification_token, hours)?;
    send_mail(cfg, msg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> MailConfig {
        MailConfig {
            host: DEFAULT_MAIL_HOST_DEV.into(),
            port: DEFAULT_MAIL_PORT_DEV,
            tls_mode: SmtpTlsMode::None,
            user: None,
            pass: None,
            from: DEFAULT_MAIL_FROM_DEV.into(),
            public_base_url: "https://app.example.com".into(),
        }
    }

    #[test]
    fn tls_mode_465_or_secure_is_wrapper() {
        assert_eq!(
            resolve_smtp_tls_mode(SUBMISSIONS_PORT, "0"),
            SmtpTlsMode::Wrapper
        );
        assert_eq!(
            resolve_smtp_tls_mode(SUBMISSION_PORT, "1"),
            SmtpTlsMode::Wrapper
        );
    }

    #[test]
    fn tls_mode_587_without_secure_is_starttls() {
        assert_eq!(
            resolve_smtp_tls_mode(SUBMISSION_PORT, "0"),
            SmtpTlsMode::StartTls
        );
        assert_eq!(
            resolve_smtp_tls_mode(SUBMISSION_PORT, ""),
            SmtpTlsMode::StartTls
        );
    }

    #[test]
    fn tls_mode_dev_port_is_none() {
        assert_eq!(
            resolve_smtp_tls_mode(DEFAULT_MAIL_PORT_DEV, "0"),
            SmtpTlsMode::None
        );
    }

    fn formatted_utf8(msg: &Message) -> String {
        String::from_utf8_lossy(&msg.formatted()).into_owned()
    }

    #[test]
    fn reset_html_contains_path_token_and_default_minutes() {
        let msg = build_reset_email(&test_cfg(), "user@example.com", "tok en+/", 0).unwrap();
        let body = formatted_utf8(&msg);
        assert!(body.contains("https://app.example.com/redefinir-senha/tok%20en%2B%2F"));
        assert!(body.contains("60 minutes"));
    }

    #[test]
    fn verification_html_contains_path_and_default_hours() {
        let msg = build_verification_email(&test_cfg(), "user@example.com", "vtok", 0).unwrap();
        let body = formatted_utf8(&msg);
        assert!(body.contains("https://app.example.com/verificar-email/vtok"));
        assert!(body.contains("24 horas"));
    }

    #[test]
    fn custom_validity_minutes() {
        let msg = build_reset_email(&test_cfg(), "user@example.com", "tok", 15).unwrap();
        let body = formatted_utf8(&msg);
        assert!(body.contains("15 minutes"));
    }
}
