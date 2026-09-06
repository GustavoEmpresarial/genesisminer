import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/referral services/report', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('buildReferralSummary', () => {
    it('monta o resumo a partir das 3 queries agregadas, sem propagar comissionPercent errado', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([{ commission_count: 3, base_total: 100, commission_total: 5 }])
        .mockResolvedValueOnce([{ unique_referrers: 2, total_links: 4, referred_distinct: 3 }])
        .mockResolvedValueOnce([{ referrer_user_id: 1, username: 'alice', email: 'a@x.com', invited_count: 2, commission_total: 5 }]);
      const { buildReferralSummary } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const out = await buildReferralSummary();
      expect(out.commissionPercent).toBe(5);
      expect(out.commissionRate).toBe(0.05);
      expect(out.stats).toMatchObject({ uniqueReferrers: 2, totalLinks: 4, commissionsCount: 3, totalCommissionPaidUsdc: 5 });
      expect(out.topReferrers[0]).toMatchObject({ id: 1, username: 'alice', invitedCount: 2 });
    });

    it('sem dados: stats zeradas, sem lançar', async () => {
      const { buildReferralSummary } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const out = await buildReferralSummary();
      expect(out.stats).toMatchObject({ uniqueReferrers: 0, totalLinks: 0, commissionsCount: 0 });
      expect(out.topReferrers).toEqual([]);
    });
  });

  describe('listReferralCommissions', () => {
    it('devolve total/rows mapeados', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          {
            id: '1',
            created_at: 1000,
            idempotency_key: 'deposit_tx:0xabc',
            source_type: 'deposit',
            base_amount_usdc: 100,
            commission_percent: 5,
            commission_usdc: 5,
            referrer_user_id: 1,
            referrer_username: 'alice',
            referrer_email: 'alice@x.com',
            referred_user_id: 2,
            referred_username: 'bob',
            referred_email: 'bob@x.com'
          }
        ]);
      const { listReferralCommissions } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const out = await listReferralCommissions({ page: 1, limit: 50, startMs: null, endMs: null, referrer: '', referred: '', minCommission: NaN, maxCommission: NaN, q: '' });
      expect(out.total).toBe(1);
      expect(out.rows[0]).toMatchObject({ id: '1', commissionRate: 0.05, status: 'paid', referrer: { id: 1, username: 'alice' } });
    });
  });

  describe('listReferralLinks', () => {
    it('devolve total/rows mapeados', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([
        {
          link_id: 10,
          referrer_user_id: 1,
          referrer_username: 'alice',
          referrer_email: 'alice@x.com',
          referred_username_raw: 'bob',
          referred_user_id: 2,
          referred_email: 'bob@x.com',
          first_commission_at: 1000,
          total_deposit_usdc: 100,
          total_commission_usdc: 5
        }
      ]);
      const { listReferralLinks } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const out = await listReferralLinks({ page: 1, limit: 50, q: '' });
      expect(out.rows[0]).toMatchObject({ linkId: 10, totalDepositedUsdc: 100, totalCommissionUsdc: 5 });
    });
  });

  describe('buildReferralCommissionsCsv', () => {
    it('gera cabeçalho + linhas, formatando valores usdc com 8 casas decimais', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([
        {
          id: '1',
          created_at: 1000,
          idempotency_key: 'deposit_tx:0xabc',
          source_type: 'deposit',
          base_amount_usdc: 100,
          commission_percent: 5,
          commission_usdc: 5,
          referrer_username: 'alice',
          referrer_email: 'alice@x.com',
          referred_username: 'bob',
          referred_email: 'bob@x.com'
        }
      ]);
      const { buildReferralCommissionsCsv } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const csv = await buildReferralCommissionsCsv({ startMs: null, endMs: null, referrer: '', referred: '', q: '' });
      expect(csv).toContain('id,created_at_iso');
      expect(csv).toContain('100.00000000');
      expect(csv).toContain('5.0000');
    });

    it('sem linhas: só o cabeçalho', async () => {
      const { buildReferralCommissionsCsv } = await import('../../../../../server/modules/admin/referral/services/report.js');
      const csv = await buildReferralCommissionsCsv({ startMs: null, endMs: null, referrer: '', referred: '', q: '' });
      expect(csv.split('\n')).toHaveLength(1);
    });
  });
});
