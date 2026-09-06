use super::constants::{
    RANDOM_HEX_SUFFIX_LENGTH, RANDOM_NUMERIC_SUFFIX_MAX, RANDOM_NUMERIC_SUFFIX_PAD,
    USERNAME_SLUG_MAX_LENGTH,
};

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).expect("getrandom");
    buf
}

/// Mirror of TS `generateReferralCode` — slug + 8 hex chars + `_` + 5-digit pad.
pub fn generate_referral_code(username: &str) -> String {
    let lower = username.to_lowercase();
    let spaced = lower.split_whitespace().collect::<Vec<_>>().join("-");
    let mut slug = String::new();
    for c in spaced.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            slug.push(c);
        } else {
            slug.push('-');
        }
    }
    let mut slug: String = slug.chars().take(USERNAME_SLUG_MAX_LENGTH).collect();
    if slug.is_empty() {
        slug = "user".into();
    }
    // 8 hex chars like UUID fragment (4 random bytes).
    let rand = hex::encode(random_bytes(RANDOM_HEX_SUFFIX_LENGTH / 2));
    let num_bytes = random_bytes(4);
    let num_raw = u32::from_le_bytes([num_bytes[0], num_bytes[1], num_bytes[2], num_bytes[3]])
        % RANDOM_NUMERIC_SUFFIX_MAX;
    let num = format!("{num_raw:0width$}", width = RANDOM_NUMERIC_SUFFIX_PAD);
    format!("{slug}-{rand}_{num}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_with_slug() {
        let code = generate_referral_code("Cool Player");
        assert!(code.contains('_'));
        assert!(code.len() > 10);
    }
}
