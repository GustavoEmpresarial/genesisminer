use super::constants::{
    DISPOSABLE_EMAIL_DOMAINS, EMAIL_ADDRESS_MAX_LENGTH, REFERRAL_CODE_MAX_LENGTH,
    SIGNUP_ALLOWED_DOMAINS, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH,
};
use super::password_policy::validate_password_strength_policy;
use super::types::{PolicyResult, ReferralCodeValidation, UsernameValidation, WalletValidation};

fn forbidden_email_char(c: char) -> bool {
    matches!(c, '<' | '>' | '\'' | '"' | '\\')
}

pub fn assert_public_signup_email_allowed(normalized_email: &str) -> PolicyResult {
    if normalized_email.len() > EMAIL_ADDRESS_MAX_LENGTH {
        return PolicyResult::err("Email too long.");
    }
    let at = match normalized_email.rfind('@') {
        Some(i) if i >= 1 && i < normalized_email.len() - 1 => i,
        _ => return PolicyResult::err("Invalid email."),
    };
    let local = &normalized_email[..at];
    let domain = normalized_email[at + 1..].trim().to_lowercase();
    if local.is_empty()
        || domain.is_empty()
        || local.len() + 1 + domain.len() > EMAIL_ADDRESS_MAX_LENGTH
        || domain.contains("..")
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return PolicyResult::err("Invalid email.");
    }
    if local.chars().any(forbidden_email_char) || domain.chars().any(forbidden_email_char) {
        return PolicyResult::err("Email contains disallowed characters.");
    }
    if DISPOSABLE_EMAIL_DOMAINS.contains(&domain.as_str()) || domain.ends_with(".yopmail.com") {
        return PolicyResult::err(
            "Temporary or disposable emails are not accepted. Use Gmail, Outlook, Hotmail, Live, or Yahoo.",
        );
    }
    if SIGNUP_ALLOWED_DOMAINS.contains(&domain.as_str()) {
        return PolicyResult::ok();
    }
    PolicyResult::err(
        "Signup allowed only with Gmail (@gmail.com), Outlook (@outlook.com), Hotmail (@hotmail.com), Live (@live.com), or Yahoo (@yahoo.com, @ymail.com).",
    )
}

fn username_forbidden(c: char) -> bool {
    matches!(
        c,
        '<' | '>' | '\'' | '"' | '&' | '`' | '{' | '}' | '[' | ']' | '\\' | '/' | ';'
    )
}

fn username_allowed_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == ' ' || c == '-'
}

pub fn validate_signup_username(raw: Option<&str>) -> UsernameValidation {
    let Some(raw) = raw else {
        return UsernameValidation::err("Username is required.");
    };
    let trimmed = raw.trim();
    if trimmed.len() < USERNAME_MIN_LENGTH || trimmed.len() > USERNAME_MAX_LENGTH {
        return UsernameValidation::err(format!(
            "Username must be between {USERNAME_MIN_LENGTH} and {USERNAME_MAX_LENGTH} characters."
        ));
    }
    if trimmed.chars().any(username_forbidden) || trimmed.to_lowercase().contains("script") {
        return UsernameValidation::err("Username contains disallowed characters.");
    }
    if !trimmed.chars().all(username_allowed_char) {
        return UsernameValidation::err(
            "Use only letters (A–Z), numbers, spaces, underscore (_), and hyphen (-).",
        );
    }
    UsernameValidation::ok(trimmed.to_string())
}

pub fn validate_signup_password(raw: Option<&str>, required: bool) -> PolicyResult {
    if !required {
        return PolicyResult::ok();
    }
    let Some(raw) = raw else {
        return PolicyResult::err("Set a password.");
    };
    if raw.is_empty() {
        return PolicyResult::err("Set a password.");
    }
    validate_password_strength_policy(raw)
}

pub fn validate_optional_referral_code_input(raw: Option<&str>) -> ReferralCodeValidation {
    let Some(raw) = raw else {
        return ReferralCodeValidation::ok_code(None);
    };
    if raw.is_empty() {
        return ReferralCodeValidation::ok_code(None);
    }
    let t = raw.trim();
    if t.is_empty() {
        return ReferralCodeValidation::ok_code(None);
    }
    if t.len() > REFERRAL_CODE_MAX_LENGTH {
        return ReferralCodeValidation::err(format!(
            "Referral code may be at most {REFERRAL_CODE_MAX_LENGTH} characters."
        ));
    }
    if t.chars()
        .any(|c| matches!(c, '<' | '>' | '\'' | '"' | '&' | '`' | '\\'))
    {
        return ReferralCodeValidation::err("Referral code contains disallowed characters.");
    }
    ReferralCodeValidation::ok_code(Some(t.to_string()))
}

pub fn validate_optional_polygon_wallet(raw: Option<&str>) -> WalletValidation {
    let Some(raw) = raw else {
        return WalletValidation::Null;
    };
    if raw.is_empty() {
        return WalletValidation::Null;
    }
    let t = raw.trim();
    if t.is_empty() {
        return WalletValidation::Null;
    }
    if !(t.starts_with("0x") || t.starts_with("0X")) || t.len() != 42 {
        return WalletValidation::Err {
            error: "Polygon wallet address must be a valid Ethereum address (0x + 40 hex).".into(),
        };
    }
    if !t[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return WalletValidation::Err {
            error: "Polygon wallet address must be a valid Ethereum address (0x + 40 hex).".into(),
        };
    }
    WalletValidation::Address(t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gmail_allowed() {
        assert!(assert_public_signup_email_allowed("user@gmail.com").is_ok());
    }

    #[test]
    fn disposable_rejected() {
        assert!(!assert_public_signup_email_allowed("a@mailinator.com").is_ok());
    }

    #[test]
    fn username_ok() {
        let v = validate_signup_username(Some("Player One"));
        assert!(v.ok);
        assert_eq!(v.username.as_deref(), Some("Player One"));
    }

    #[test]
    fn wallet_ok() {
        let w =
            validate_optional_polygon_wallet(Some("0x1234567890abcdef1234567890abcdef12345678"));
        assert!(matches!(w, WalletValidation::Address(_)));
    }
}
