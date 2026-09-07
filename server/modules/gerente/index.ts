/**
 * Módulo `gerente`: serviços de gerência de conta (contratar/candidatar-se,
 * aceitar/recusar, demitir/resignar, entrar/sair da conta gerida) e o guard
 * de allowlist que restringe o que um gerente pode fazer em "modo gerência".
 *
 * Kill-switch: `ACCOUNT_MANAGER_ENABLED=1` (default desligado).
 * HTTP `/api/account-manager/*` owned por genesis-api + mining-worker twins.
 *
 * `services/accrual.ts` (10% do minerado do dono creditado ao gerente) é
 * chamada por `modules/mining-engine/services/progress-computer.ts`, na
 * mesma transação do crédito de mineração ao dono (e pelo worker Rust).
 *
 * O poll horário do payout do gerente vive no `genesis-mining-worker` (Rust).
 */
export { ACCOUNT_MANAGER_FIRE_LOCK_DAYS, ACCOUNT_MANAGER_SHARE, ACCOUNT_MANAGER_STATUS } from './services/constants.js';
export type { AccountManagerStatus } from './services/constants.js';
export { isAccountManagerEnabled } from './services/feature.js';
export { AccountManagerError } from './services/errors.js';
export { accrueManagerMiningShare } from './services/accrual.js';
export type { MiningGainEntry } from './services/accrual.js';
export { payClosedManagerWeeks } from './services/payout.js';
export type { PayClosedManagerWeeksResult } from './services/payout.js';
export {
  acceptContract,
  applyAsManager,
  declineContract,
  enterManagedAccount,
  fireManager,
  getAccountManagerMe,
  hireManager,
  leaveManagedAccount,
  loadSessionManagerFlags,
  resignManager
} from './services/manager.js';
export type { SessionManagerFlags } from './services/manager.js';
export { createManagerModeGuard, isApiPath, isManagerAllowedRoute } from './services/guard.js';
export type { ParseCookiesFn } from './services/guard.js';
