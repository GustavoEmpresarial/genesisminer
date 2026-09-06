/**
 * Módulo `wheel`: roleta (giro pago atómico + giro/reivindicação por código
 * promocional) + editor admin (`/api/admin/wheel/*`).
 */
export { registerWheelModuleRoutes } from './controllers/wheel.controller.js';
export type { WheelModuleDeps } from './controllers/wheel.controller.js';

export {
  addAdminWheelPlayer,
  fetchWheelPrizesForAdminWheelEditor,
  getAdminWheelRuntimeConfig,
  listAdminWheelPlayers,
  replaceWheelPrizesCatalog,
  upsertAdminWheelRuntimeConfig
} from './services/admin.js';
export type { AdminWheelPlayerRow, AdminWheelPrizeInput, AdminWheelPrizeRow, AdminWheelRuntimeConfigDto, AdminWheelRuntimeConfigInput } from './services/admin.js';

export { fetchWheelPrizesForApiConfig, pickWeightedPrize, queryWheelPrizeByItemIdJoined, queryWheelPrizesByItemIdsJoined, queryWheelPrizesEligibleForRoll } from './services/prizes.js';
export type { WheelPrizeRow } from './services/prizes.js';

export { runPromoCodeRedeemInTransaction } from './services/promo-redeem.js';
export type { PromoRedeemTransactionResult } from './services/promo-redeem.js';

export {
  WHEEL_ABSOLUTE_MIN_SPIN_PRICE_USDC,
  WHEEL_DEFAULT_SPIN_PRICE_USDC,
  fetchWheelRuntimeConfig,
  getWheelPaidSpinPriceDecimal,
  grantWheelPrizeUnopenedBox,
  paidWheelSpinAtomic,
  resolveEffectivePaidSpinPrice,
  roletaClaimInTransaction,
  wheelRollInTransaction
} from './services/spin.js';
export type { PaidWheelAtomicSpinResult, RoletaClaimResult, WheelRollResult, WheelRuntimeConfigDto } from './services/spin.js';

export { normalizePromoCode, parseIdempotencyKey, parseWonItemId, sanitizeDisplayName } from './services/validation.js';
