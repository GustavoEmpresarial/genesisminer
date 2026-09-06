/**
 * Módulo `checkin`: ciclo diário UTC 00:00, grace 48h (mineração),
 * check-in premium, streak e recompensas.
 */
export { registerCheckinModuleRoutes } from './controllers/checkin.controller.js';
export type { CheckinModuleDeps } from './controllers/checkin.controller.js';

export {
  CHECKIN_CYCLE_HOUR_BRT,
  CHECKIN_CYCLE_HOUR_UTC,
  CHECKIN_EARLY_WINDOW_MS,
  CHECKIN_GRACE_MS,
  CHECKIN_PREMIUM_COOLDOWN_CODE,
  CHECKIN_REWARD_EVERY_DAYS,
  CHECKIN_TIMEZONE,
  CHECKIN_WINDOW_MS,
  CheckinPremiumCooldownError,
  brtCheckinPeriodStartMs,
  brtDayFromMs,
  brtYmdAtWallTimeMs,
  canEarlyCheckinForNextPeriod,
  getCheckinStatus,
  hasCheckedInCurrentPeriod,
  isCheckinFrozenAtMs,
  isCheckinFrozenForUser,
  isEarlyCheckinTimestamp,
  isUserFrozenForToday,
  isWithinActiveCheckinWindow,
  nextBrtDay,
  nextCheckinPeriodEndMs,
  nextCheckinPeriodStartMs,
  nextUtcDay,
  performCheckin,
  previousBrtDay,
  previousUtcDay,
  utcCheckinPeriodStartMs,
  utcDayFromMs,
  utcDayStartMs
} from './services/checkin.js';
export type { CheckinResult, CheckinStatus } from './services/checkin.js';

export {
  canPerformPremiumCheckinNow,
  loadCheckinPremiumPolicy,
  nextPremiumCheckinAllowedMs,
  premiumIntervalMs,
  resolveUserCheckinPremiumContext,
  saveCheckinPremiumPolicy,
  userHasPremiumUpgradePurchase
} from './services/premium-policy.js';
export type { CheckinPremiumPolicy, UserCheckinPremiumContext } from './services/premium-policy.js';

export {
  checkinRewardUnitLabel,
  loadCheckinRewardPolicy,
  saveCheckinRewardPolicy,
  streakRewardDurationConfig
} from './services/reward-policy.js';
export type { CheckinRewardPolicy, CheckinRewardType } from './services/reward-policy.js';

export {
  computeNextDailyCheckinStreak,
  computeNextPremiumCheckinStreak,
  grantCheckinReward,
  grantCheckinStreakTemporaryItem,
  shouldGrantCheckinReward,
  shouldGrantStreakMilestoneReward
} from './services/reward.js';
export type { CheckinGrantResult, CheckinStreakGrantResult } from './services/reward.js';
