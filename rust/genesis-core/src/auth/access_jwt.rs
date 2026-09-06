//! Access JWT (HS256) — mirrors Node `jwt-service.ts` + `config.ts` claims.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::constants::{
    ACCESS_JWT_DEFAULT_AUDIENCE, ACCESS_JWT_DEFAULT_ISSUER, ACCESS_JWT_TTL_CEILING_SEC,
    ACCESS_JWT_TTL_DEFAULT_SEC, ACCESS_JWT_TTL_FLOOR_SEC, ACCESS_JWT_TYP, ACCESS_JWT_VER,
};
use crate::time::MS_PER_SECOND;

#[derive(Clone)]
pub struct AccessJwtConfig {
    pub secret: String,
    pub issuer: String,
    pub audience: String,
    pub access_ttl_sec: u64,
}

impl std::fmt::Debug for AccessJwtConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessJwtConfig")
            .field("secret", &"<redacted>")
            .field("issuer", &self.issuer)
            .field("audience", &self.audience)
            .field("access_ttl_sec", &self.access_ttl_sec)
            .finish()
    }
}

impl AccessJwtConfig {
    pub fn clamp_ttl(raw: u64) -> u64 {
        raw.clamp(ACCESS_JWT_TTL_FLOOR_SEC, ACCESS_JWT_TTL_CEILING_SEC)
    }

    pub fn with_defaults(secret: impl Into<String>) -> Self {
        Self {
            secret: secret.into(),
            issuer: ACCESS_JWT_DEFAULT_ISSUER.to_string(),
            audience: ACCESS_JWT_DEFAULT_AUDIENCE.to_string(),
            access_ttl_sec: ACCESS_JWT_TTL_DEFAULT_SEC,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    pub typ: String,
    pub ver: u32,
    pub sub: String,
    pub iss: String,
    pub aud: String,
    pub jti: String,
    pub exp: u64,
    pub iat: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAccess {
    pub user_id: i64,
    pub jti: Option<String>,
    pub exp: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessJwtError {
    InvalidUserId,
    SignFailed,
    InvalidToken,
    Expired,
    BadTyp,
    BadSubject,
}

impl AccessJwtError {
    /// Mirror jsonwebtoken Error names used by Node `http-auth.ts`.
    pub fn error_name(&self) -> &'static str {
        match self {
            Self::Expired => "TokenExpiredError",
            Self::InvalidUserId => "ValidationError",
            _ => "JsonWebTokenError",
        }
    }
}

impl std::fmt::Display for AccessJwtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUserId => write!(f, "Identificador de utilizador inválido para token."),
            Self::SignFailed => write!(f, "JWT sign failed"),
            Self::InvalidToken => write!(f, "invalid token"),
            Self::Expired => write!(f, "jwt expired"),
            Self::BadTyp => write!(f, "Tipo de token inválido"),
            Self::BadSubject => write!(f, "Subject inválido"),
        }
    }
}

impl std::error::Error for AccessJwtError {}

fn now_unix_sec() -> u64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs(),
        Err(_) => 0,
    }
}

fn parse_user_id_digits(raw: &str) -> Result<i64, AccessJwtError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AccessJwtError::InvalidUserId);
    }
    let id: i64 = raw.parse().map_err(|_| AccessJwtError::InvalidUserId)?;
    if id <= 0 {
        return Err(AccessJwtError::InvalidUserId);
    }
    Ok(id)
}

/// Sign an access token for `user_id` (digits-only subject, same as Node).
pub fn sign_access_token(
    cfg: &AccessJwtConfig,
    user_id: impl AsRef<str>,
) -> Result<String, AccessJwtError> {
    let sub = user_id.as_ref().trim();
    let _ = parse_user_id_digits(sub)?;
    let iat = now_unix_sec();
    let ttl = AccessJwtConfig::clamp_ttl(cfg.access_ttl_sec);
    let exp = iat.saturating_add(ttl);
    let claims = AccessClaims {
        typ: ACCESS_JWT_TYP.to_string(),
        ver: ACCESS_JWT_VER,
        sub: sub.to_string(),
        iss: cfg.issuer.clone(),
        aud: cfg.audience.clone(),
        jti: Uuid::new_v4().to_string(),
        exp,
        iat,
    };
    let mut header = Header::new(Algorithm::HS256);
    header.typ = Some("JWT".to_string());
    encode(
        &header,
        &claims,
        &EncodingKey::from_secret(cfg.secret.as_bytes()),
    )
    .map_err(|_| AccessJwtError::SignFailed)
}

/// Verify access token; rejects non-`access` typ and non-positive digit `sub`.
pub fn verify_access_token(
    cfg: &AccessJwtConfig,
    token: &str,
) -> Result<VerifiedAccess, AccessJwtError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&[cfg.issuer.as_str()]);
    validation.set_audience(&[cfg.audience.as_str()]);
    validation.validate_exp = true;
    // leeway 0 — same fail-closed posture as Node default.
    validation.leeway = 0;

    let data = decode::<AccessClaims>(
        token,
        &DecodingKey::from_secret(cfg.secret.as_bytes()),
        &validation,
    )
    .map_err(|e| match e.kind() {
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => AccessJwtError::Expired,
        _ => AccessJwtError::InvalidToken,
    })?;

    let claims = data.claims;
    if claims.typ != ACCESS_JWT_TYP {
        return Err(AccessJwtError::BadTyp);
    }
    let user_id = parse_user_id_digits(&claims.sub).map_err(|_| AccessJwtError::BadSubject)?;
    Ok(VerifiedAccess {
        user_id,
        jti: if claims.jti.is_empty() {
            None
        } else {
            Some(claims.jti)
        },
        exp: Some(claims.exp),
    })
}

/// Helper for tests / clock skew fixtures — unused in prod paths.
#[allow(dead_code)]
pub fn ms_to_unix_sec(ms: u64) -> u64 {
    ms / MS_PER_SECOND
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg() -> AccessJwtConfig {
        AccessJwtConfig::with_defaults("a".repeat(32))
    }

    #[test]
    fn sign_verify_round_trip() {
        let cfg = test_cfg();
        let token = sign_access_token(&cfg, "42").expect("sign");
        let v = verify_access_token(&cfg, &token).expect("verify");
        assert_eq!(v.user_id, 42);
        assert!(v.jti.is_some());
        assert!(v.exp.is_some());
    }

    #[test]
    fn rejects_non_digit_user_id_on_sign() {
        let cfg = test_cfg();
        assert_eq!(
            sign_access_token(&cfg, "abc"),
            Err(AccessJwtError::InvalidUserId)
        );
    }

    #[test]
    fn rejects_zero_user_id_on_sign() {
        let cfg = test_cfg();
        assert_eq!(
            sign_access_token(&cfg, "0"),
            Err(AccessJwtError::InvalidUserId)
        );
    }

    #[test]
    fn rejects_wrong_secret() {
        let cfg = test_cfg();
        let token = sign_access_token(&cfg, "1").expect("sign");
        let other = AccessJwtConfig::with_defaults("b".repeat(32));
        assert_eq!(
            verify_access_token(&other, &token),
            Err(AccessJwtError::InvalidToken)
        );
    }

    #[test]
    fn rejects_wrong_issuer() {
        let mut cfg = test_cfg();
        let token = sign_access_token(&cfg, "1").expect("sign");
        cfg.issuer = "outro-issuer".into();
        assert_eq!(
            verify_access_token(&cfg, &token),
            Err(AccessJwtError::InvalidToken)
        );
    }

    #[test]
    fn rejects_bad_typ() {
        let cfg = test_cfg();
        // Manually craft claims with typ=refresh using encode.
        let iat = now_unix_sec();
        let claims = AccessClaims {
            typ: "refresh".into(),
            ver: ACCESS_JWT_VER,
            sub: "1".into(),
            iss: cfg.issuer.clone(),
            aud: cfg.audience.clone(),
            jti: Uuid::new_v4().to_string(),
            exp: iat + ACCESS_JWT_TTL_DEFAULT_SEC,
            iat,
        };
        let token = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(cfg.secret.as_bytes()),
        )
        .expect("encode");
        assert_eq!(
            verify_access_token(&cfg, &token),
            Err(AccessJwtError::BadTyp)
        );
    }

    #[test]
    fn clamp_ttl_respects_floor_ceiling() {
        assert_eq!(AccessJwtConfig::clamp_ttl(1), ACCESS_JWT_TTL_FLOOR_SEC);
        assert_eq!(
            AccessJwtConfig::clamp_ttl(u64::MAX),
            ACCESS_JWT_TTL_CEILING_SEC
        );
        assert_eq!(
            AccessJwtConfig::clamp_ttl(ACCESS_JWT_TTL_DEFAULT_SEC),
            ACCESS_JWT_TTL_DEFAULT_SEC
        );
    }
}
