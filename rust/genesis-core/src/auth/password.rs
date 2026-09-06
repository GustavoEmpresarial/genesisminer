//! bcrypt hash / verify — Node-compatible (`$2a$` / `$2b$` via bcryptjs).

use crate::auth::constants::{BCRYPT_ROUNDS_PROFILE, BCRYPT_ROUNDS_REGISTER};

pub use crate::auth::constants::{
    BCRYPT_ROUNDS_PROFILE as PROFILE_ROUNDS, BCRYPT_ROUNDS_REGISTER as REGISTER_ROUNDS,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordCryptoError {
    HashFailed,
    VerifyFailed,
    InvalidRounds,
}

impl std::fmt::Display for PasswordCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HashFailed => write!(f, "bcrypt hash failed"),
            Self::VerifyFailed => write!(f, "bcrypt verify failed"),
            Self::InvalidRounds => write!(f, "bcrypt rounds out of range"),
        }
    }
}

impl std::error::Error for PasswordCryptoError {}

/// bcrypt cost floor/ceiling accepted by the `bcrypt` crate (same as OpenBSD).
const BCRYPT_COST_MIN: u32 = 4;
const BCRYPT_COST_MAX: u32 = 31;

fn clamp_rounds(rounds: u32) -> Result<u32, PasswordCryptoError> {
    if !(BCRYPT_COST_MIN..=BCRYPT_COST_MAX).contains(&rounds) {
        return Err(PasswordCryptoError::InvalidRounds);
    }
    Ok(rounds)
}

/// Hash `plain` with the given bcrypt cost (`BCRYPT_ROUNDS_REGISTER` / `BCRYPT_ROUNDS_PROFILE`).
pub fn hash_password(plain: &str, rounds: u32) -> Result<String, PasswordCryptoError> {
    let cost = clamp_rounds(rounds)?;
    bcrypt::hash(plain, cost).map_err(|_| PasswordCryptoError::HashFailed)
}

/// Verify `plain` against a bcrypt hash (`$2a$` / `$2b$` from bcryptjs or this crate).
pub fn verify_password(plain: &str, hash: &str) -> Result<bool, PasswordCryptoError> {
    bcrypt::verify(plain, hash).map_err(|_| PasswordCryptoError::VerifyFailed)
}

/// Convenience: register / password-reset cost.
pub fn hash_password_register(plain: &str) -> Result<String, PasswordCryptoError> {
    hash_password(plain, BCRYPT_ROUNDS_REGISTER)
}

/// Convenience: profile / admin / bulk cost.
pub fn hash_password_profile(plain: &str) -> Result<String, PasswordCryptoError> {
    hash_password(plain, BCRYPT_ROUNDS_PROFILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_verify_round_trip_register_cost() {
        let hash = hash_password_register("senhaForte99").expect("hash");
        assert!(hash.starts_with("$2"));
        assert!(verify_password("senhaForte99", &hash).expect("verify"));
        assert!(!verify_password("wrong", &hash).expect("verify"));
    }

    #[test]
    fn hash_verify_round_trip_profile_cost() {
        let hash = hash_password_profile("outraSenha1").expect("hash");
        assert!(verify_password("outraSenha1", &hash).expect("verify"));
    }

    #[test]
    fn rejects_out_of_range_rounds() {
        assert_eq!(
            hash_password("x", 3),
            Err(PasswordCryptoError::InvalidRounds)
        );
    }

    /// OpenWall sample `$2a$` vector (cost 5) — proves `$2a$` prefix compatibility.
    #[test]
    fn verifies_openwall_2a_sample() {
        // From OpenBSD bcrypt samples: password "U*U", cost 5.
        let hash = "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW";
        assert!(verify_password("U*U", hash).expect("verify"));
        assert!(!verify_password("U*U*", hash).expect("verify"));
    }

    #[test]
    fn register_and_profile_round_constants() {
        assert_eq!(BCRYPT_ROUNDS_REGISTER, 12);
        assert_eq!(BCRYPT_ROUNDS_PROFILE, 10);
    }
}
