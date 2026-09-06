//! Reserved profile usernames — mirror Node `reserved-username.ts`.

/// Zero-width space (U+200B).
const ZERO_WIDTH_SPACE: char = '\u{200B}';
/// Zero-width joiner (U+200D) — end of ZW range with ZWSP.
const ZERO_WIDTH_JOINER: char = '\u{200D}';
/// BOM (U+FEFF).
const BOM: char = '\u{FEFF}';

/// Exact reserved tokens (lowercase) — Node `RESERVED`.
const RESERVED: &[&str] = &[
    "admin",
    "administrator",
    "support",
    "suporte",
    "root",
    "genesis",
    "genesisminer",
    "genesis-miner",
    "minestation",
    "staff",
    "moderator",
    "mod",
    "official",
    "system",
    "equipe",
    "team",
    "helpdesk",
];

fn is_invisible_username_char(c: char) -> bool {
    (c >= ZERO_WIDTH_SPACE && c <= ZERO_WIDTH_JOINER) || c == BOM
}

/// Strip zero-width / BOM chars from a profile username candidate.
pub fn strip_invisible_username_chars(raw: &str) -> String {
    raw.chars()
        .filter(|c| !is_invisible_username_char(*c))
        .collect()
}

fn reserved_has(token: &str) -> bool {
    RESERVED.iter().any(|r| *r == token)
}

/// `true` when the username is reserved / empty / prefix of a reserved token.
pub fn is_reserved_profile_username(username: &str) -> bool {
    let t = username
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if t.is_empty() {
        return true;
    }
    let compact: String = t
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .collect();
    if reserved_has(&t) || reserved_has(&compact) {
        return true;
    }
    for r in RESERVED {
        if t.starts_with(&format!("{r} "))
            || t.starts_with(&format!("{r}_"))
            || t.starts_with(&format!("{r}-"))
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_exact_reserved() {
        assert!(is_reserved_profile_username("Admin"));
        assert!(is_reserved_profile_username("SUPORTE"));
    }

    #[test]
    fn rejects_compact_variants() {
        assert!(is_reserved_profile_username("genesis-miner"));
        assert!(is_reserved_profile_username("genesisminer"));
    }

    #[test]
    fn rejects_prefix_separator() {
        assert!(is_reserved_profile_username("admin_oficial"));
        assert!(is_reserved_profile_username("root-user"));
    }

    #[test]
    fn rejects_empty() {
        assert!(is_reserved_profile_username(""));
    }

    #[test]
    fn accepts_normal() {
        assert!(!is_reserved_profile_username("jogador123"));
    }

    #[test]
    fn strips_invisible() {
        let zwsp = ZERO_WIDTH_SPACE;
        let bom = BOM;
        assert_eq!(
            strip_invisible_username_chars(&format!("a{zwsp}b{bom}c")),
            "abc"
        );
        assert_eq!(strip_invisible_username_chars("jogador 123"), "jogador 123");
    }
}
