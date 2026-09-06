//! Shared TX helpers (advisory lock, active user, EIP-55 address).

use deadpool_postgres::GenericClient;
use sha3::{Digest, Keccak256};

use crate::errors::{
    WalletError, CODE_FORBIDDEN, CODE_NOT_FOUND, ERR_ACCOUNT_BLOCKED, ERR_USER_NOT_FOUND,
    HTTP_FORBIDDEN, HTTP_NOT_FOUND,
};
use crate::pg_types::pg_user_id;

/// Node `BLOCKED_FLAG` in assert-active-user-tx.
const BLOCKED_FLAG: i32 = 1;

/// Node `FINGERPRINT_MAX_LENGTH`.
pub const FINGERPRINT_MAX_LENGTH: usize = 64;

/// Node `FNV_OFFSET_BASIS` / shop checkout.
const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
/// Node `FNV_PRIME`.
const FNV_PRIME: u32 = 16_777_619;
const USER_ID_MASK_16BIT: u64 = 0xffff;
const USER_ID_SHIFT_BITS: u32 = 32;
const INT63_MASK: u64 = (1u64 << 63) - 1;

/// EVM address: `0x` + 40 hex (Node `EVM_ADDR_RE`).
const EVM_ADDR_HEX_LEN: usize = 40;
const EVM_ADDR_TOTAL_LEN: usize = 2 + EVM_ADDR_HEX_LEN;

const ASSERT_ACTIVE_SQL: &str = "SELECT is_blocked FROM users WHERE id = $1 FOR NO KEY UPDATE";

/// Node `computeAdvisoryLockKey64` (FNV-1a + userId high bits, 63-bit mask).
pub fn compute_advisory_lock_key64(user_id: i64, scope: &str, idempotency_key: &str) -> i64 {
    let composite = format!("{user_id}\0{scope}\0{idempotency_key}");
    let mut hash: u32 = FNV_OFFSET_BASIS;
    for ch in composite.chars() {
        hash ^= u32::from(ch as u8);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    let low_bits = u64::from(hash);
    let high_bits = (user_id as u64 & USER_ID_MASK_16BIT) << USER_ID_SHIFT_BITS;
    let key = (high_bits | low_bits) & INT63_MASK;
    i64::try_from(key).unwrap_or(i64::MAX)
}

pub async fn assert_active_user<C: GenericClient>(
    client: &C,
    user_id: i64,
) -> Result<(), WalletError> {
    let uid = pg_user_id(user_id).map_err(WalletError::transport)?;
    let rows = client
        .query(ASSERT_ACTIVE_SQL, &[&uid])
        .await
        .map_err(WalletError::transport)?;
    let Some(row) = rows.first() else {
        return Err(WalletError::domain_code(
            HTTP_NOT_FOUND,
            ERR_USER_NOT_FOUND,
            CODE_NOT_FOUND,
        ));
    };
    let blocked: Option<i32> = row.get("is_blocked");
    if blocked.unwrap_or(0) == BLOCKED_FLAG {
        return Err(WalletError::domain_code(
            HTTP_FORBIDDEN,
            ERR_ACCOUNT_BLOCKED,
            CODE_FORBIDDEN,
        ));
    }
    Ok(())
}

pub fn clamp_fingerprint(raw: Option<&str>) -> Option<String> {
    let t = raw.map(str::trim).filter(|s| !s.is_empty())?;
    Some(t.chars().take(FINGERPRINT_MAX_LENGTH).collect())
}

fn is_hex_digit(c: u8) -> bool {
    c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || (b'A'..=b'F').contains(&c)
}

/// Validates `0x` + 40 hex; returns lowercase hex body (no `0x`) or None.
fn parse_evm_hex_body(raw: &str) -> Option<[u8; EVM_ADDR_HEX_LEN]> {
    let t = raw.trim();
    if t.len() != EVM_ADDR_TOTAL_LEN || !t.as_bytes()[..2].eq_ignore_ascii_case(b"0x") {
        return None;
    }
    let mut out = [0u8; EVM_ADDR_HEX_LEN];
    for (i, b) in t.as_bytes()[2..].iter().enumerate() {
        if !is_hex_digit(*b) {
            return None;
        }
        out[i] = b.to_ascii_lowercase();
    }
    Some(out)
}

/// EIP-55 checksum address (ethers `getAddress` parity).
/// All-lower / all-upper → normalize. Mixed case must already match checksum or reject.
pub fn checksum_evm_address(raw: &str) -> Result<String, WalletError> {
    let trimmed = raw.trim();
    let body = parse_evm_hex_body(trimmed).ok_or_else(|| {
        WalletError::bad_code(
            "Informe uma carteira Polygon (EVM) válida (0x + 40 hex).",
            crate::errors::CODE_VALIDATION,
        )
    })?;
    let hex_lower = std::str::from_utf8(&body).expect("ascii hex");
    let hash = Keccak256::digest(hex_lower.as_bytes());
    let hash_hex = hex::encode(hash);
    let mut checksummed = String::with_capacity(EVM_ADDR_TOTAL_LEN);
    checksummed.push_str("0x");
    for (i, c) in hex_lower.chars().enumerate() {
        let nibble = u8::from_str_radix(&hash_hex[i..=i], 16).unwrap_or(0);
        if nibble >= 8 {
            checksummed.push(c.to_ascii_uppercase());
        } else {
            checksummed.push(c);
        }
    }
    // ethers: mixed case with wrong checksum → throw (do not silently recompute).
    let hex_input = &trimmed[2..];
    let has_upper = hex_input.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = hex_input.bytes().any(|b| b.is_ascii_lowercase());
    if has_upper && has_lower && hex_input != &checksummed[2..] {
        return Err(WalletError::bad_code(
            "bad address checksum",
            crate::errors::CODE_VALIDATION,
        ));
    }
    Ok(checksummed)
}

/// Require non-empty fingerprint when an idempotency key is bound.
/// Node wallet controllers always send a fingerprint with the key; worker enforces.
pub fn require_idem_fingerprint(raw: Option<&str>) -> Result<String, WalletError> {
    clamp_fingerprint(raw).ok_or_else(|| {
        WalletError::bad_code(
            "requestFingerprint required with idempotencyKey.",
            crate::errors::CODE_VALIDATION,
        )
    })
}

/// Fail-closed finite number from idempotent replay JSON (no default 0).
pub fn require_finite_json_f64(obj: &serde_json::Value, key: &str) -> Result<f64, WalletError> {
    let v = obj.get(key).and_then(|x| x.as_f64());
    match v {
        Some(n) if n.is_finite() => Ok(n),
        _ => Err(WalletError::conflict(
            "Cached idempotent response missing money fields. Reload wallet state.",
        )),
    }
}

pub fn require_nonempty_json_str(
    obj: &serde_json::Value,
    key: &str,
) -> Result<String, WalletError> {
    match obj.get(key).and_then(|x| x.as_str()).map(str::trim) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(WalletError::conflict(
            "Cached idempotent response incomplete. Reload wallet state.",
        )),
    }
}

pub fn normalize_evm_address_lower(raw: &str) -> Option<String> {
    let body = parse_evm_hex_body(raw)?;
    let mut s = String::with_capacity(EVM_ADDR_TOTAL_LEN);
    s.push_str("0x");
    s.push_str(std::str::from_utf8(&body).ok()?);
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_known_hardhat_account() {
        // ethers getAddress of lowercase hardhat #1
        let raw = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
        let out = checksum_evm_address(raw).unwrap();
        assert_eq!(out, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    }

    #[test]
    fn reject_bad_address() {
        assert!(checksum_evm_address("0xzz").is_err());
        assert!(checksum_evm_address("not-a-wallet").is_err());
    }

    #[test]
    fn reject_mixed_wrong_checksum() {
        // ethers getAddress example — mixed case with bad checksum
        let bad = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";
        assert!(checksum_evm_address(bad).is_err());
    }

    #[test]
    fn accept_correct_checksum_mixed() {
        let good = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        assert_eq!(checksum_evm_address(good).unwrap(), good);
    }

    #[test]
    fn require_idem_fingerprint_rejects_empty() {
        assert!(require_idem_fingerprint(None).is_err());
        assert!(require_idem_fingerprint(Some("")).is_err());
        assert!(require_idem_fingerprint(Some("  ")).is_err());
        assert_eq!(require_idem_fingerprint(Some("fp-abc")).unwrap(), "fp-abc");
    }
}
