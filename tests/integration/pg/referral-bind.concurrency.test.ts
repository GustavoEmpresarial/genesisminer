import { describe, expect, it } from 'vitest';
import {
  countReferrals,
  createUser,
  getClaimedReferrals,
  makeTag,
  registerPgIntegrationLifecycle,
  type PgFixtureCtx
} from './harness.js';

describe('PG integration — referral bind concurrency', () => {
  let ctx: PgFixtureCtx | null = null;
  registerPgIntegrationLifecycle(
    () => ctx,
    (c) => {
      ctx = c;
    }
  );

  it('dois bindReferralAndAccrueClaim concorrentes: 1 linha referrals + claimed_referrals=1', async () => {
    const c = ctx!;
    const tag = makeTag();
    const referredUsername = `${tag}_refd`;

    const referrerId = await createUser(c.pool, {
      username: `${tag}_ref`,
      email: `${tag}_ref@itest.local`,
      usdc: 0
    });
    c.userIds.push(referrerId);

    const { prisma } = await import('../../../server/core/database/prisma.js');
    const { bindReferralAndAccrueClaim } = await import('../../../server/modules/profile/services/referral-credit.js');

    const settled = await Promise.allSettled([
      prisma.$transaction((tx) => bindReferralAndAccrueClaim(tx, { referrerId, referredUsername })),
      prisma.$transaction((tx) => bindReferralAndAccrueClaim(tx, { referrerId, referredUsername }))
    ]);

    const ok = settled.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(2);

    expect(await countReferrals(c.pool, referrerId, referredUsername)).toBe(1);
    expect(await getClaimedReferrals(c.pool, referrerId)).toBe(1);
    c.usernames.push(referredUsername);
  });
});
