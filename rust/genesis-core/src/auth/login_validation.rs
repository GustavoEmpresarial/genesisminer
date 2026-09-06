use super::constants::{EMAIL_ADDRESS_MAX_LENGTH, PASSWORD_MAX_LENGTH};
use super::types::PolicyResult;

fn forbidden_email_char(c: char) -> bool {
    matches!(c, '<' | '>' | '\'' | '"' | '\\')
}

pub fn validate_login_fields_present(
    raw_email: Option<&str>,
    raw_password: Option<&str>,
) -> PolicyResult {
    let email_str = raw_email.unwrap_or("");
    let password_str = raw_password.unwrap_or("");
    let has_email = !email_str.trim().is_empty();
    let has_password = !password_str.is_empty();
    if !has_email && !has_password {
        return PolicyResult::err("Enter your email and password.");
    }
    if !has_email {
        return PolicyResult::err("Enter your email.");
    }
    if !has_password {
        return PolicyResult::err("Enter your password.");
    }
    PolicyResult::ok()
}

pub fn validate_login_email(raw: Option<&str>) -> PolicyResult {
    let Some(raw) = raw else {
        return PolicyResult::err("Enter your email.");
    };
    let normalized = raw.trim().to_lowercase();
    if normalized.is_empty() {
        return PolicyResult::err("Enter your email.");
    }
    if normalized.len() > EMAIL_ADDRESS_MAX_LENGTH {
        return PolicyResult::err(format!(
            "Email may be at most {EMAIL_ADDRESS_MAX_LENGTH} characters."
        ));
    }
    let at = match normalized.rfind('@') {
        Some(i) if i >= 1 && i < normalized.len() - 1 => i,
        _ => return PolicyResult::err("Invalid email."),
    };
    let local = &normalized[..at];
    let domain = &normalized[at + 1..];
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
    PolicyResult::ok()
}

pub fn validate_login_password(raw: Option<&str>) -> PolicyResult {
    let Some(raw) = raw else {
        return PolicyResult::err("Enter your password.");
    };
    if raw.len() > PASSWORD_MAX_LENGTH {
        return PolicyResult::err(format!(
            "Password is too long (maximum {PASSWORD_MAX_LENGTH} characters)."
        ));
    }
    PolicyResult::ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_both_missing() {
        assert!(!validate_login_fields_present(Some(""), Some("")).is_ok());
    }

    #[test]
    fn email_ok() {
        assert!(validate_login_email(Some("a@b.com")).is_ok());
    }

    #[test]
    fn email_forbidden_chars() {
        assert!(!validate_login_email(Some("a<script>@b.com")).is_ok());
    }
}
