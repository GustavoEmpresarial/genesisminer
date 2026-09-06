use crate::time::{
    HOURS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, SECONDS_PER_DAY, SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
};

pub const EMAIL_ADDRESS_MAX_LENGTH: usize = 50;
pub const PASSWORD_MAX_LENGTH: usize = 128;
pub const PASSWORD_MIN_LENGTH: usize = 6;
pub const PASSWORD_STRENGTH_MAX_LENGTH: usize = 50;

/// bcrypt cost for register / password-reset — keep in sync with Node auth paths.
pub const BCRYPT_ROUNDS_REGISTER: u32 = 12;
/// bcrypt cost for profile / admin / security-bulk — keep in sync with Node.
pub const BCRYPT_ROUNDS_PROFILE: u32 = 10;

/// Access JWT claim `typ` — keep in sync with Node `jwt-service.ts`.
pub const ACCESS_JWT_TYP: &str = "access";
/// Access JWT claim `ver`.
pub const ACCESS_JWT_VER: u32 = 1;
/// Default issuer — keep in sync with Node `config.ts`.
pub const ACCESS_JWT_DEFAULT_ISSUER: &str = "genesis-miner";
/// Default audience — keep in sync with Node `config.ts`.
pub const ACCESS_JWT_DEFAULT_AUDIENCE: &str = "genesis-miner-api";
/// Default access TTL (15 minutes) in seconds.
pub const ACCESS_JWT_TTL_DEFAULT_MINUTES: u64 = 15;
pub const ACCESS_JWT_TTL_DEFAULT_SEC: u64 = ACCESS_JWT_TTL_DEFAULT_MINUTES * SECONDS_PER_MINUTE;
/// Floor / ceiling for `JWT_ACCESS_TTL_SEC` — keep in sync with Node.
pub const ACCESS_JWT_TTL_FLOOR_SEC: u64 = SECONDS_PER_MINUTE;
pub const ACCESS_JWT_TTL_CEILING_SEC: u64 = SECONDS_PER_HOUR;
/// Production minimum `JWT_SECRET` length — keep in sync with Node.
pub const ACCESS_JWT_PROD_SECRET_MIN_LENGTH: usize = 32;

/// Refresh JWT default TTL (14 days) — keep in sync with Node `config.ts`.
pub const REFRESH_JWT_TTL_DEFAULT_DAYS: u64 = 14;
pub const REFRESH_JWT_TTL_DEFAULT_SEC: u64 = REFRESH_JWT_TTL_DEFAULT_DAYS * SECONDS_PER_DAY;
/// Floor / ceiling for `JWT_REFRESH_TTL_SEC` — keep in sync with Node.
pub const REFRESH_JWT_TTL_FLOOR_SEC: u64 = SECONDS_PER_HOUR;
pub const REFRESH_JWT_TTL_CEILING_DAYS: u64 = 60;
pub const REFRESH_JWT_TTL_CEILING_SEC: u64 = REFRESH_JWT_TTL_CEILING_DAYS * SECONDS_PER_DAY;
/// Raw refresh token entropy — keep in sync with Node `refresh-token-store.ts`.
pub const REFRESH_TOKEN_RAW_BYTES: usize = 48;

/// Session `last_seen_at` write throttle — keep in sync with Node repository.
pub const LAST_SEEN_UPDATE_INTERVAL_MINUTES: u64 = 5;
pub const LAST_SEEN_UPDATE_INTERVAL_MS: u64 = LAST_SEEN_UPDATE_INTERVAL_MINUTES * MS_PER_MINUTE;

/// Legacy `sid` cookie TTL — Node `SESSION_TTL_DAYS` in `login.controller.ts`.
pub const SESSION_TTL_DAYS: u64 = 30;
pub const SESSION_TTL_SECONDS: u64 = SESSION_TTL_DAYS * SECONDS_PER_DAY;

/// Node `REFERRAL_CODE_CLASH_RETRY_MAX` in auth repository / user-creation.
pub const REFERRAL_CODE_CLASH_RETRY_MAX: u32 = 10;

/// Node `IP_SIGNUP_LIMIT_WINDOW_DAYS` in `user-creation.ts`.
pub const IP_SIGNUP_LIMIT_WINDOW_DAYS: u64 = 90;
/// Node `IP_SIGNUP_LIMIT_MAX_ACCOUNTS` in `user-creation.ts`.
pub const IP_SIGNUP_LIMIT_MAX_ACCOUNTS: i64 = 3;
/// Signup IP window in ms — `days * HOURS_PER_DAY * MS_PER_HOUR`.
pub const IP_SIGNUP_LIMIT_WINDOW_MS: u64 =
    IP_SIGNUP_LIMIT_WINDOW_DAYS * HOURS_PER_DAY * MS_PER_HOUR;

/// Node `AUTH_FLOW_SECRET_MIN_LENGTH` in `auth-flow-secret.ts`.
pub const AUTH_FLOW_SECRET_MIN_LENGTH: usize = 16;

/// Node `EMAIL_RESEND_COOLDOWN_MINUTES` in email-verification.controller.
pub const EMAIL_RESEND_COOLDOWN_MINUTES: u64 = 5;
pub const EMAIL_RESEND_COOLDOWN_MS: u64 = EMAIL_RESEND_COOLDOWN_MINUTES * MS_PER_MINUTE;
/// Node `ANTI_TIMING_DELAY_MS` — constant delay against email enumeration.
pub const ANTI_TIMING_DELAY_MS: u64 = 100;
/// Node `COOLDOWN_MAP_MAX_SIZE`.
pub const COOLDOWN_MAP_MAX_SIZE: usize = 10_000;

/// Node `WELCOME_BOX_QTY` in `user-creation.ts`.
pub const WELCOME_BOX_QTY: i32 = 1;
/// Node `loot_boxes.trigger = 'registration'`.
pub const LOOT_TRIGGER_REGISTRATION: &str = "registration";
/// Node `DEFAULT_ACCESS_LEVEL_ID` / register fallback.
pub const DEFAULT_ACCESS_LEVEL_ID: &str = "normal";
/// Node `DEFAULT_ASIC_UNLOCKED_SLOTS` in grant-default-asic-room.
pub const DEFAULT_PLAYER_UNLOCKED_SLOTS: i32 = 0;

/// Node `device-fingerprint.ts` `IP_MAX_LENGTH`.
pub const FINGERPRINT_IP_MAX_LENGTH: usize = 128;
/// Node `device-fingerprint.ts` `USER_AGENT_MAX_LENGTH`.
pub const FINGERPRINT_USER_AGENT_MAX_LENGTH: usize = 512;

pub const USERNAME_MIN_LENGTH: usize = 3;
pub const USERNAME_MAX_LENGTH: usize = 50;
pub const REFERRAL_CODE_MAX_LENGTH: usize = 50;

pub const LOGIN_MAX_FAILURES: u32 = 10;
pub const LOGIN_LOCKOUT_MINUTES: u64 = 15;
pub const LOGIN_LOCKOUT_MS: u64 = LOGIN_LOCKOUT_MINUTES * MS_PER_MINUTE;

pub const PASSWORD_RESET_VALIDITY_MINUTES: u64 = 60;
pub const PASSWORD_RESET_TTL_MS: u64 = PASSWORD_RESET_VALIDITY_MINUTES * MS_PER_MINUTE;

pub const EMAIL_VERIFICATION_TTL_HOURS: u64 = 24;
pub const EMAIL_VERIFICATION_TTL_MS: u64 = EMAIL_VERIFICATION_TTL_HOURS * MS_PER_HOUR;

pub const PURPOSE_PASSWORD_RESET: &str = "password_reset";
pub const PURPOSE_EMAIL_VERIFICATION: &str = "email_verification";

pub const USERNAME_SLUG_MAX_LENGTH: usize = 12;
pub const RANDOM_HEX_SUFFIX_LENGTH: usize = 8;
pub const RANDOM_NUMERIC_SUFFIX_MAX: u32 = 100_000;
pub const RANDOM_NUMERIC_SUFFIX_PAD: usize = 5;

pub const MAX_FINGERPRINT_PAYLOAD_CHARS: usize = 12_000;
pub const MAX_COMPONENT_STRING_LENGTH: usize = 600;
pub const VISITOR_ID_MAX_LENGTH: usize = 128;

pub const SIGNUP_ALLOWED_DOMAINS: &[&str] = &[
    "gmail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "ymail.com",
];

pub const DISPOSABLE_EMAIL_DOMAINS: &[&str] = &[
    "mailinator.com",
    "guerrillamail.com",
    "guerrillamailblock.com",
    "sharklasers.com",
    "yopmail.com",
    "yopmail.fr",
    "tempmail.com",
    "temp-mail.org",
    "throwaway.email",
    "trashmail.com",
    "10minutemail.com",
    "10minutemail.net",
    "fakeinbox.com",
    "getnada.com",
    "maildrop.cc",
    "dispostable.com",
    "emailondeck.com",
    "burnermail.io",
    "moakt.com",
    "tmpmail.org",
    "mailcatch.com",
    "spam4.me",
    "grr.la",
    "mailnesia.com",
    "trashmail.de",
    "discard.email",
    "discardmail.com",
    "wegwerfmail.de",
    "trashmail.ws",
    "armyspy.com",
    "cuvox.de",
    "dayrep.com",
    "einrot.com",
    "fleckens.hu",
    "gustr.com",
    "jourrapide.com",
    "rhyta.com",
    "superrito.com",
    "teleworm.us",
];

pub const COMMON_WEAK_PASSWORDS: &[&str] = &[
    "password",
    "12345678",
    "123456789",
    "qwerty123",
    "genesis",
    "genesisminer",
    "welcome1",
    "senha123",
    "palavrapasse",
    "abc123456",
];

pub const ALLOW_COMPONENT_KEYS: &[&str] = &[
    "userAgent",
    "language",
    "languages",
    "platform",
    "hardwareConcurrency",
    "deviceMemory",
    "timezone",
    "timezoneOffset",
    "screenResolution",
    "colorDepth",
    "pixelRatio",
    "touchSupport",
    "cookiesEnabled",
    "pdfViewerEnabled",
    "localStorage",
    "sessionStorage",
    "vendor",
    "maxTouchPoints",
    "webglVendor",
    "webglRenderer",
];
