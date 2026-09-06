use super::constants::{COMMON_WEAK_PASSWORDS, PASSWORD_MIN_LENGTH, PASSWORD_STRENGTH_MAX_LENGTH};
use super::types::PolicyResult;

pub fn validate_password_strength_policy(new_password: &str) -> PolicyResult {
    let p = new_password;
    if p.len() < PASSWORD_MIN_LENGTH {
        return PolicyResult::err(format!(
            "Password must be at least {PASSWORD_MIN_LENGTH} characters."
        ));
    }
    if p.len() > PASSWORD_STRENGTH_MAX_LENGTH {
        return PolicyResult::err("The new password is too long.");
    }
    let lower = p.to_lowercase();
    if COMMON_WEAK_PASSWORDS.contains(&lower.as_str()) {
        return PolicyResult::err("This password is too common. Choose another.");
    }
    PolicyResult::ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short() {
        assert!(!validate_password_strength_policy("12345").is_ok());
    }

    #[test]
    fn rejects_weak() {
        assert!(!validate_password_strength_policy("password").is_ok());
    }

    #[test]
    fn accepts_reasonable() {
        assert!(validate_password_strength_policy("hunter2x").is_ok());
    }
}
