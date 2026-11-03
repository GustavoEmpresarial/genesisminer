//! Constantes do domínio Gerente (account-manager).
//! Espelho de `server/modules/gerente/services/constants.ts`.

/// Percentagem do minerado do dono creditada ao gerente.
pub const ACCOUNT_MANAGER_SHARE_PERCENT: i64 = 5;

/// Multiplicador percentagem (`sharePercent` em GET /me).
pub const ACCOUNT_MANAGER_PERCENT_MULTIPLIER: f64 = 100.0;

/// Share do gerente sobre o minerado do dono (`SHARE_PERCENT / 100`).
pub const ACCOUNT_MANAGER_SHARE: f64 =
    ACCOUNT_MANAGER_SHARE_PERCENT as f64 / ACCOUNT_MANAGER_PERCENT_MULTIPLIER;

/// Dias de trava anti-fire após accept (`FIRE_LOCK_DAYS`).
pub const ACCOUNT_MANAGER_FIRE_LOCK_DAYS: i64 = 7;

/// Convite do dono → gerente aceita/recusa.
pub const ACCOUNT_MANAGER_STATUS_PENDING: &str = "pending";
/// Candidatura do gerente → dono aprova/rejeita.
pub const ACCOUNT_MANAGER_STATUS_APPLIED: &str = "applied";
/// Status de contrato activo (accrual só neste estado).
pub const ACCOUNT_MANAGER_STATUS_ACTIVE: &str = "active";
/// Contrato encerrado.
pub const ACCOUNT_MANAGER_STATUS_ENDED: &str = "ended";

const _: () = assert!(ACCOUNT_MANAGER_FIRE_LOCK_DAYS == 7);
const _: () = assert!(ACCOUNT_MANAGER_SHARE_PERCENT == 5);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_matches_percent_over_multiplier() {
        let percent = ACCOUNT_MANAGER_SHARE * ACCOUNT_MANAGER_PERCENT_MULTIPLIER;
        let expected = ACCOUNT_MANAGER_SHARE_PERCENT as f64;
        assert!((percent - expected).abs() < f64::EPSILON);
    }
}
