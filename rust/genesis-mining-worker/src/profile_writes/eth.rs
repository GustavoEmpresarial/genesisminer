//! EIP-55 checksum + `ethers.verifyMessage` personal-sign recovery.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::player_reads::{PlayerReadError, HTTP_UNPROCESSABLE};

/// EVM address: `0x` + 40 hex.
const EVM_ADDR_HEX_LEN: usize = 40;
const EVM_ADDR_TOTAL_LEN: usize = 2 + EVM_ADDR_HEX_LEN;
/// Compact signature length (r||s||v).
const SIG_COMPACT_LEN: usize = 65;
/// Legacy Ethereum recovery id offset (27/28 → 0/1).
const LEGACY_RECOVERY_ID_OFFSET: u8 = 27;
/// Keccak digest / secp256k1 field size.
const HASH_LEN: usize = 32;
/// Uncompressed pubkey header byte.
const UNCOMPRESSED_PUBKEY_TAG: u8 = 0x04;
/// Address is last 20 bytes of keccak(pubkey).
const ADDR_BYTE_LEN: usize = 20;
const PUBKEY_XY_LEN: usize = 64;
const HTTP_BAD_REQUEST: u16 = 400;

const _: () = assert!(EVM_ADDR_TOTAL_LEN == 42);
const _: () = assert!(SIG_COMPACT_LEN == 65);
const _: () = assert!(HASH_LEN == 32);
const _: () = assert!(HTTP_UNPROCESSABLE == 422);

fn is_hex_digit(c: u8) -> bool {
    c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || (b'A'..=b'F').contains(&c)
}

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
pub fn normalize_eth_address(raw: &str) -> Result<String, PlayerReadError> {
    let trimmed = raw.trim();
    let body = parse_evm_hex_body(trimmed).ok_or_else(|| {
        PlayerReadError::controlled(HTTP_BAD_REQUEST, "Invalid address.", "VALIDATION")
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
    let hex_input = &trimmed[2..];
    let has_upper = hex_input.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = hex_input.bytes().any(|b| b.is_ascii_lowercase());
    if has_upper && has_lower && hex_input != &checksummed[2..] {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "bad address checksum",
            "VALIDATION",
        ));
    }
    Ok(checksummed)
}

fn eth_message_hash(message: &[u8]) -> [u8; HASH_LEN] {
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let mut hasher = Keccak256::new();
    hasher.update(prefix.as_bytes());
    hasher.update(message);
    let dig = hasher.finalize();
    let mut out = [0u8; HASH_LEN];
    out.copy_from_slice(&dig);
    out
}

fn decode_signature(sig_raw: &str) -> Result<[u8; SIG_COMPACT_LEN], PlayerReadError> {
    let t = sig_raw.trim();
    let hex_body = t
        .strip_prefix("0x")
        .or_else(|| t.strip_prefix("0X"))
        .unwrap_or(t);
    let bytes = hex::decode(hex_body).map_err(|_| {
        PlayerReadError::controlled(HTTP_BAD_REQUEST, "Invalid signature.", "VALIDATION")
    })?;
    if bytes.len() != SIG_COMPACT_LEN {
        return Err(PlayerReadError::controlled(
            HTTP_BAD_REQUEST,
            "Invalid signature.",
            "VALIDATION",
        ));
    }
    let mut out = [0u8; SIG_COMPACT_LEN];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// ethers `verifyMessage` — recover checksummed address from personal_sign.
pub fn verify_personal_message(message: &str, signature: &str) -> Result<String, PlayerReadError> {
    let sig_bytes = decode_signature(signature)?;
    let mut v = sig_bytes[HASH_LEN * 2];
    if v >= LEGACY_RECOVERY_ID_OFFSET {
        v -= LEGACY_RECOVERY_ID_OFFSET;
    }
    let recovery_id = RecoveryId::try_from(v).map_err(|_| {
        PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Invalid signature.",
            "SIGNATURE_INVALID",
        )
    })?;
    let signature = Signature::from_slice(&sig_bytes[..HASH_LEN * 2]).map_err(|_| {
        PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Invalid signature.",
            "SIGNATURE_INVALID",
        )
    })?;
    let hash = eth_message_hash(message.as_bytes());
    let vk = VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).map_err(|_| {
        PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Invalid signature.",
            "SIGNATURE_INVALID",
        )
    })?;
    let point = vk.to_encoded_point(false);
    let bytes = point.as_bytes();
    if bytes.len() != 1 + PUBKEY_XY_LEN || bytes[0] != UNCOMPRESSED_PUBKEY_TAG {
        return Err(PlayerReadError::controlled(
            HTTP_UNPROCESSABLE,
            "Invalid signature.",
            "SIGNATURE_INVALID",
        ));
    }
    let digest = Keccak256::digest(&bytes[1..]);
    let addr_hex = hex::encode(&digest[HASH_LEN - ADDR_BYTE_LEN..]);
    normalize_eth_address(&format!("0x{addr_hex}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_all_lower_ok() {
        let a = normalize_eth_address("0x1234567890abcdef1234567890abcdef12345678").unwrap();
        assert!(a.starts_with("0x"));
        assert_eq!(a.len(), EVM_ADDR_TOTAL_LEN);
    }
}
