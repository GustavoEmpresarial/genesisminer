/**
 * Constantes do domínio Gerente (ex-account-manager).
 */
export const ACCOUNT_MANAGER_SHARE = 0.1;
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
