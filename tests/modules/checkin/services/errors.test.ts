import { describe, expect, it } from 'vitest';
import { CHECKIN_PREMIUM_COOLDOWN_CODE, CheckinPremiumCooldownError } from '../../../../server/modules/checkin/services/errors.js';

describe('CheckinPremiumCooldownError', () => {
  it('expõe code/nextCheckinAllowedMs/intervalDays', () => {
    const e = new CheckinPremiumCooldownError(123456, 7);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(CHECKIN_PREMIUM_COOLDOWN_CODE);
    expect(e.nextCheckinAllowedMs).toBe(123456);
    expect(e.intervalDays).toBe(7);
    expect(e.message).toContain('every 7 days');
  });
});
