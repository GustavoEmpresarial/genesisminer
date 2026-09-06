use super::types::{EmailVerificationFlags, LockoutStatus};
use crate::time::MS_PER_SECOND;

const DB_BOOL_TRUE: i64 = 1;

pub fn is_account_locked(login_locked_until_ms: Option<i64>, now_ms: i64) -> bool {
    match login_locked_until_ms {
        Some(until) => now_ms < until,
        None => false,
    }
}

pub fn account_lock_remaining_seconds(login_locked_until_ms: Option<i64>, now_ms: i64) -> u64 {
    match login_locked_until_ms {
        Some(until) if until > now_ms => {
            let rem = until - now_ms;
            ((rem + MS_PER_SECOND as i64 - 1) / MS_PER_SECOND as i64).max(0) as u64
        }
        _ => 0,
    }
}

pub fn lockout_status(login_locked_until_ms: Option<i64>, now_ms: i64) -> LockoutStatus {
    LockoutStatus {
        locked: is_account_locked(login_locked_until_ms, now_ms),
        remaining_seconds: account_lock_remaining_seconds(login_locked_until_ms, now_ms),
    }
}

pub fn get_email_verification_flags(
    email_verified: i64,
    email_verification_required: i64,
) -> EmailVerificationFlags {
    EmailVerificationFlags {
        email_verified: email_verified == DB_BOOL_TRUE,
        email_verification_required: email_verification_required == DB_BOOL_TRUE,
    }
}

pub fn user_requires_email_verification(
    email_verified: i64,
    email_verification_required: i64,
) -> bool {
    email_verification_required == DB_BOOL_TRUE && email_verified != DB_BOOL_TRUE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockout_active() {
        assert!(is_account_locked(Some(2000), 1000));
        assert_eq!(account_lock_remaining_seconds(Some(2500), 1000), 2);
    }

    #[test]
    fn requires_verification() {
        assert!(user_requires_email_verification(0, 1));
        assert!(!user_requires_email_verification(1, 1));
    }
}
