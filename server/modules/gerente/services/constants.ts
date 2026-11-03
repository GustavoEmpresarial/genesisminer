/**
 * Constantes do domínio Gerente (ex-account-manager).
 * Espelho: `rust/genesis-core/src/gerente.rs`.
 */

/** Percentagem do minerado do dono creditada ao gerente. */
export const ACCOUNT_MANAGER_SHARE_PERCENT = 5;
/** Multiplicador percentagem (`sharePercent` em GET /me). */
export const ACCOUNT_MANAGER_PERCENT_MULTIPLIER = 100;
/** Fração do minerado do dono creditada ao gerente. */
export const ACCOUNT_MANAGER_SHARE = ACCOUNT_MANAGER_SHARE_PERCENT / ACCOUNT_MANAGER_PERCENT_MULTIPLIER;
export const ACCOUNT_MANAGER_FIRE_LOCK_DAYS = 7;

export const ACCOUNT_MANAGER_STATUS = {
  /** Convite do dono → gerente aceita/recusa. */
  PENDING: 'pending',
  /** Candidatura do gerente → dono aprova/rejeita. */
  APPLIED: 'applied',
  ACTIVE: 'active',
  ENDED: 'ended'
} as const;

export type AccountManagerStatus = (typeof ACCOUNT_MANAGER_STATUS)[keyof typeof ACCOUNT_MANAGER_STATUS];
