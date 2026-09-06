//! Constantes do domínio Gerente (account-manager).
//! Espelho de `server/modules/gerente/services/constants.ts`.

/// Share do gerente sobre o minerado do dono (10%).
pub const ACCOUNT_MANAGER_SHARE: f64 = 0.1;

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

/// Multiplicador percentagem (`sharePercent` em GET /me).
pub const ACCOUNT_MANAGER_PERCENT_MULTIPLIER: f64 = 100.0;

const _: () = assert!(ACCOUNT_MANAGER_FIRE_LOCK_DAYS == 7);
