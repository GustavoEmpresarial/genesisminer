/**
 * Migrado de legacy/backend/modules/checkin/checkinErrors.ts.
 */
export const CHECKIN_PREMIUM_COOLDOWN_CODE = 'CHECKIN_PREMIUM_COOLDOWN';

export class CheckinPremiumCooldownError extends Error {
  readonly code = CHECKIN_PREMIUM_COOLDOWN_CODE;
  readonly nextCheckinAllowedMs: number;
  readonly intervalDays: number;

  constructor(nextCheckinAllowedMs: number, intervalDays: number) {
    super(`Premium pass buyers can only check in every ${intervalDays} days. Next available soon.`);
    this.name = 'CheckinPremiumCooldownError';
    this.nextCheckinAllowedMs = nextCheckinAllowedMs;
    this.intervalDays = intervalDays;
  }
}
