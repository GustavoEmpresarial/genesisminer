//! Promo-code validation helpers — Node `promo-code.ts` + `validation.ts`.

use deadpool_postgres::GenericClient;

use super::errors::{WheelError, ERR_CODE_EXPIRED};

/// Node `PROMO_CODE_MAX_LENGTH`.
pub const PROMO_CODE_MAX_LENGTH: usize = 120;
/// Node `PROMO_CODE_MIN_LENGTH`.
pub const PROMO_CODE_MIN_LENGTH: usize = 1;
/// Node `PROMO_CODE_MAX_LENGTH_UPPER`.
pub const PROMO_CODE_MAX_LENGTH_UPPER: usize = 80;
/// Node `SAFE_ITEM_ID_RE` max length.
pub const WON_ITEM_ID_MAX_LENGTH: usize = 200;
/// Node roleta type prefix.
pub const ROLETA_TYPE_PREFIX: &str = "roleta_";
/// Node loot-box trigger for roleta promo codes.
pub const ROLETA_CODE_TRIGGER: &str = "roleta_code";

const SELECT_LB_TRIGGER_SQL: &str = "SELECT trigger FROM loot_boxes WHERE id = $1 LIMIT 1";

/// Node `normalizePromoCode`.
pub fn normalize_promo_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > PROMO_CODE_MAX_LENGTH {
        return None;
    }
    if trimmed.chars().any(|c| {
        let u = c as u32;
        (u <= 0x08) || u == 0x0b || u == 0x0c || ((0x0e..=0x1f).contains(&u))
    }) {
        return None;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper.len() < PROMO_CODE_MIN_LENGTH || upper.len() > PROMO_CODE_MAX_LENGTH_UPPER {
        return None;
    }
    Some(upper)
}

/// Node `parseWonItemId`.
pub fn parse_won_item_id(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > WON_ITEM_ID_MAX_LENGTH {
        return None;
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return None;
    }
    Some(s.to_string())
}

/// Node `throwIfPromoCodeExpired`.
pub fn throw_if_promo_code_expired(
    expires_at: Option<i64>,
    server_now_ms: i64,
) -> Result<(), WheelError> {
    let Some(exp) = expires_at else {
        return Ok(());
    };
    if exp <= 0 {
        return Ok(());
    }
    if server_now_ms > exp {
        return Err(WheelError::bad(ERR_CODE_EXPIRED));
    }
    Ok(())
}

/// Node `promoTypeLiteralIsRoleta`.
pub fn promo_type_literal_is_roleta(ty: &str) -> bool {
    ty.starts_with(ROLETA_TYPE_PREFIX)
}

/// Node `promoCodeRowEligibleForRoletaFlow`.
pub async fn promo_code_row_eligible_for_roleta_flow<C: GenericClient>(
    client: &C,
    promo_type: &str,
    loot_box_id: Option<&str>,
) -> Result<bool, WheelError> {
    if promo_type_literal_is_roleta(promo_type) {
        return Ok(true);
    }
    let Some(bid) = loot_box_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    let rows = client
        .query(SELECT_LB_TRIGGER_SQL, &[&bid])
        .await
        .map_err(WheelError::transport)?;
    let trigger: String = rows
        .first()
        .map(|r| r.get::<_, Option<String>>("trigger").unwrap_or_default())
        .unwrap_or_default();
    Ok(trigger == ROLETA_CODE_TRIGGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_promo_code_ok() {
        assert_eq!(
            normalize_promo_code("  abc123  ").as_deref(),
            Some("ABC123")
        );
    }

    #[test]
    fn normalize_promo_code_rejects() {
        assert!(normalize_promo_code("").is_none());
        assert!(normalize_promo_code(&"a".repeat(PROMO_CODE_MAX_LENGTH + 1)).is_none());
        assert!(normalize_promo_code(&"a".repeat(PROMO_CODE_MAX_LENGTH_UPPER + 1)).is_none());
        assert!(normalize_promo_code("ab\x01c").is_none());
    }

    #[test]
    fn parse_won_item_id_ok() {
        assert_eq!(
            parse_won_item_id("upg_123-abc.def").as_deref(),
            Some("upg_123-abc.def")
        );
    }

    #[test]
    fn parse_won_item_id_rejects() {
        assert!(parse_won_item_id("").is_none());
        assert!(parse_won_item_id("has space").is_none());
    }

    #[test]
    fn expired_check() {
        assert!(throw_if_promo_code_expired(None, 100).is_ok());
        assert!(throw_if_promo_code_expired(Some(0), 100).is_ok());
        assert!(throw_if_promo_code_expired(Some(200), 100).is_ok());
        assert!(throw_if_promo_code_expired(Some(50), 100).is_err());
    }
}
