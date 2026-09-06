//! `mining_eligibility_events` INSERT — 1:1 with `mining-eligibility-events.ts`.

use deadpool_postgres::GenericClient;
use tokio_postgres::error::SqlState;

use crate::config::current_unix_ms;
use crate::pg_types::pg_user_id;

/// Named event types — same strings as Node `MINING_ELIGIBILITY_EVENT_TYPES`.
pub const EVENT_MINER_EQUIPPED: &str = "MINER_EQUIPPED";
pub const EVENT_MINER_UNEQUIPPED: &str = "MINER_UNEQUIPPED";
pub const EVENT_RACK_POWER_CHANGED: &str = "RACK_POWER_CHANGED";
pub const EVENT_RACK_COIN_CHANGED: &str = "RACK_COIN_CHANGED";
pub const EVENT_ASIC_EXPIRED: &str = "ASIC_EXPIRED";
pub const EVENT_RACK_WIRING_CHANGED: &str = "RACK_WIRING_CHANGED";
pub const EVENT_RACK_BATTERY_CHANGED: &str = "RACK_BATTERY_CHANGED";
pub const EVENT_RACK_MULTIPLIER_CHANGED: &str = "RACK_MULTIPLIER_CHANGED";
pub const EVENT_CHECKIN_RECORDED: &str = "CHECKIN_RECORDED";

pub const IDENTITY_LEASE: &str = "lease";
pub const IDENTITY_PLACEMENT: &str = "placement";
pub const IDENTITY_RACK: &str = "rack";
pub const IDENTITY_USER: &str = "user";

/// Node `MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT` = `Date.UTC(2026, 7, 21, 12, 0, 0, 0)`.
pub const MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT: i64 = 1_787_313_600_000;

/// `rack_id` / `coin_id` slice(0, 120) in Node.
pub const ELIGIBILITY_RACK_ID_MAX_LEN: usize = 120;
/// `catalog_item_id` slice(0, 200) in Node.
pub const ELIGIBILITY_CATALOG_ITEM_ID_MAX_LEN: usize = 200;
/// `coin_id` slice(0, 120) in Node.
pub const ELIGIBILITY_COIN_ID_MAX_LEN: usize = 120;

const CUTOVER_ENV: &str = "MINING_ELIGIBILITY_HISTORY_CUTOVER_MS";

pub fn mining_eligibility_history_cutover_ms() -> i64 {
    match std::env::var(CUTOVER_ENV) {
        Ok(raw) if !raw.trim().is_empty() => {
            let n: f64 = raw.trim().parse().unwrap_or(f64::NAN);
            if n.is_finite() && n > 0.0 {
                n.floor() as i64
            } else {
                MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT
            }
        }
        _ => MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT,
    }
}

fn is_event_type(v: &str) -> bool {
    matches!(
        v,
        EVENT_MINER_EQUIPPED
            | EVENT_MINER_UNEQUIPPED
            | EVENT_RACK_POWER_CHANGED
            | EVENT_RACK_COIN_CHANGED
            | EVENT_ASIC_EXPIRED
            | EVENT_RACK_WIRING_CHANGED
            | EVENT_RACK_BATTERY_CHANGED
            | EVENT_RACK_MULTIPLIER_CHANGED
            | EVENT_CHECKIN_RECORDED
    )
}

fn is_identity_kind(v: &str) -> bool {
    matches!(
        v,
        IDENTITY_LEASE | IDENTITY_PLACEMENT | IDENTITY_RACK | IDENTITY_USER
    )
}

fn trim_opt(raw: Option<&str>, max_len: usize) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let cut = if s.len() > max_len { &s[..max_len] } else { s };
    Some(cut.to_string())
}

pub struct EligibilityEvent<'a> {
    pub user_id: i64,
    pub event_type: &'a str,
    pub at_ms: i64,
    pub identity_kind: &'a str,
    pub lease_id: Option<&'a str>,
    pub rack_id: Option<&'a str>,
    pub slot_index: Option<i64>,
    pub catalog_item_id: Option<&'a str>,
    pub coin_id: Option<&'a str>,
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordEligibilityResult {
    Inserted,
    SkippedInvalid,
    SkippedDuplicateExpired,
}

pub async fn record_mining_eligibility_event<C: GenericClient>(
    client: &C,
    input: EligibilityEvent<'_>,
) -> anyhow::Result<RecordEligibilityResult> {
    let Ok(user_id) = pg_user_id(input.user_id) else {
        return Ok(RecordEligibilityResult::SkippedInvalid);
    };
    if user_id <= 0 {
        return Ok(RecordEligibilityResult::SkippedInvalid);
    }
    if !is_event_type(input.event_type) {
        return Ok(RecordEligibilityResult::SkippedInvalid);
    }
    if input.at_ms <= 0 {
        return Ok(RecordEligibilityResult::SkippedInvalid);
    }
    if !is_identity_kind(input.identity_kind) {
        return Ok(RecordEligibilityResult::SkippedInvalid);
    }

    let lease_raw = trim_opt(input.lease_id, usize::MAX);
    let lease_id: Option<uuid::Uuid> = match lease_raw.as_deref() {
        None => None,
        Some(s) => match uuid::Uuid::parse_str(s) {
            Ok(u) => Some(u),
            Err(_) => return Ok(RecordEligibilityResult::SkippedInvalid),
        },
    };
    let rack_id = trim_opt(input.rack_id, ELIGIBILITY_RACK_ID_MAX_LEN);
    let catalog_item_id = trim_opt(input.catalog_item_id, ELIGIBILITY_CATALOG_ITEM_ID_MAX_LEN);
    let coin_id = trim_opt(input.coin_id, ELIGIBILITY_COIN_ID_MAX_LEN);
    let slot_index: Option<i32> = input.slot_index.and_then(|i| i32::try_from(i).ok());

    let mut payload_json: Option<serde_json::Value> = None;
    if let Some(serde_json::Value::Object(mut map)) = input.payload {
        map.insert(
            "cutoverMs".into(),
            serde_json::json!(mining_eligibility_history_cutover_ms()),
        );
        payload_json = Some(serde_json::Value::Object(map));
    }

    let created_at = current_unix_ms();
    match client
        .execute(
            "INSERT INTO mining_eligibility_events (
               user_id, event_type, at_ms, identity_kind, lease_id, rack_id, slot_index,
               catalog_item_id, coin_id, payload, created_at
             ) VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10::jsonb, $11)",
            &[
                &user_id,
                &input.event_type,
                &input.at_ms,
                &input.identity_kind,
                &lease_id,
                &rack_id,
                &slot_index,
                &catalog_item_id,
                &coin_id,
                &payload_json,
                &created_at,
            ],
        )
        .await
    {
        Ok(_) => Ok(RecordEligibilityResult::Inserted),
        Err(e) => {
            if e.code() == Some(&SqlState::UNIQUE_VIOLATION)
                && input.event_type == EVENT_ASIC_EXPIRED
            {
                return Ok(RecordEligibilityResult::SkippedDuplicateExpired);
            }
            Err(e.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_default_matches_node_date_utc() {
        assert_eq!(
            MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT,
            1_787_313_600_000
        );
    }

    #[test]
    fn event_type_set_matches_node() {
        assert!(is_event_type(EVENT_MINER_EQUIPPED));
        assert!(is_event_type(EVENT_ASIC_EXPIRED));
        assert!(is_event_type(EVENT_RACK_WIRING_CHANGED));
        assert!(is_event_type(EVENT_RACK_POWER_CHANGED));
        assert!(is_event_type(EVENT_RACK_COIN_CHANGED));
        assert!(!is_event_type("UNKNOWN"));
    }
}
