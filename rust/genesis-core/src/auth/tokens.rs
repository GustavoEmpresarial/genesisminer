use super::constants::{PURPOSE_EMAIL_VERIFICATION, PURPOSE_PASSWORD_RESET};
use super::types::{ParseTokenFail, ParsedAuthToken};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

fn timing_safe_hex_equal(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return false;
    }
    let Ok(aa) = hex::decode(a) else {
        return false;
    };
    let Ok(bb) = hex::decode(b) else {
        return false;
    };
    bool::from(aa.ct_eq(&bb))
}

pub fn hash_token_sha256(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn build_signed_token(email: &str, expiry_ms: i64, purpose: &str, secret: &str) -> String {
    let payload = serde_json::json!({
        "email": email.trim(),
        "expiry": expiry_ms,
        "purpose": purpose,
    })
    .to_string();
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    format!("{}.{}", B64.encode(payload.as_bytes()), signature)
}

pub fn build_signed_password_reset_token(email: &str, expiry_ms: i64, secret: &str) -> String {
    build_signed_token(email, expiry_ms, PURPOSE_PASSWORD_RESET, secret)
}

pub fn build_signed_email_verification_token(email: &str, expiry_ms: i64, secret: &str) -> String {
    let normalized = email.trim().to_lowercase();
    build_signed_token(&normalized, expiry_ms, PURPOSE_EMAIL_VERIFICATION, secret)
}

fn parse_signed_token(
    raw_token: &str,
    secret: &str,
    expected_purpose: &str,
    now_ms: i64,
    check_expiry: bool,
) -> Result<ParsedAuthToken, ParseTokenFail> {
    let trimmed = raw_token.trim();
    if trimmed.is_empty() {
        return Err(ParseTokenFail {
            error: "Incomplete data.".into(),
            status: 400,
        });
    }
    let mut parts = trimmed.splitn(2, '.');
    let Some(payload_b64) = parts.next() else {
        return Err(ParseTokenFail {
            error: "Invalid token.".into(),
            status: 400,
        });
    };
    let Some(signature) = parts.next() else {
        return Err(ParseTokenFail {
            error: "Invalid token.".into(),
            status: 400,
        });
    };
    if payload_b64.is_empty() || signature.is_empty() {
        return Err(ParseTokenFail {
            error: "Invalid token.".into(),
            status: 400,
        });
    }
    let Ok(payload_bytes) = B64.decode(payload_b64) else {
        return Err(ParseTokenFail {
            error: "Invalid token.".into(),
            status: 400,
        });
    };
    let payload_raw = String::from_utf8_lossy(&payload_bytes);
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload_raw.as_bytes());
    let expected_sig = hex::encode(mac.finalize().into_bytes());
    if !timing_safe_hex_equal(signature, &expected_sig) {
        return Err(ParseTokenFail {
            error: "Token tampered or invalid.".into(),
            status: 403,
        });
    }
    let payload: serde_json::Value = match serde_json::from_str(&payload_raw) {
        Ok(v) => v,
        Err(_) => {
            return Err(ParseTokenFail {
                error: "Invalid token.".into(),
                status: 400,
            })
        }
    };
    let expiry = payload.get("expiry").and_then(|v| v.as_i64()).unwrap_or(-1);
    let purpose = payload
        .get("purpose")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let email = payload
        .get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if email.is_empty() || purpose != expected_purpose {
        return Err(ParseTokenFail {
            error: "Invalid token.".into(),
            status: 400,
        });
    }
    if check_expiry && now_ms > expiry {
        return Err(ParseTokenFail {
            error: if expected_purpose == PURPOSE_PASSWORD_RESET {
                "Recovery session expired.".into()
            } else {
                "Verification link expired. Request a new one.".into()
            },
            status: 403,
        });
    }
    Ok(ParsedAuthToken { email, expiry })
}

pub fn parse_signed_password_reset_token(
    raw_token: &str,
    secret: &str,
    now_ms: i64,
) -> Result<ParsedAuthToken, ParseTokenFail> {
    parse_signed_token(raw_token, secret, PURPOSE_PASSWORD_RESET, now_ms, true)
}

/// Email verification parse — returns None on any failure (matches TS).
pub fn parse_signed_email_verification_token(
    raw_token: &str,
    secret: &str,
) -> Option<ParsedAuthToken> {
    match parse_signed_token(raw_token, secret, PURPOSE_EMAIL_VERIFICATION, 0, false) {
        Ok(p) => Some(p),
        Err(_) => None,
    }
}

pub fn timing_safe_token_hash_equal(a: &str, b: &str) -> bool {
    timing_safe_hex_equal(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_password_reset() {
        let secret = "test-secret";
        let token = build_signed_password_reset_token("User@Gmail.com", 9_999_999_999_999, secret);
        let parsed = parse_signed_password_reset_token(&token, secret, 1_000).unwrap();
        assert_eq!(parsed.email, "user@gmail.com");
    }

    #[test]
    fn tampered_rejected() {
        let secret = "test-secret";
        let mut token = build_signed_password_reset_token("a@b.com", 9_999_999_999_999, secret);
        token.push('x');
        assert!(parse_signed_password_reset_token(&token, secret, 1_000).is_err());
    }

    #[test]
    fn email_verify_roundtrip() {
        let secret = "sec";
        let token = build_signed_email_verification_token("A@B.COM", 100, secret);
        let p = parse_signed_email_verification_token(&token, secret).unwrap();
        assert_eq!(p.email, "a@b.com");
    }
}
