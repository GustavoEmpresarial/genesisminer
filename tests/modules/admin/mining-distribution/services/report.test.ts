import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/mining-distribution services/report', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = { prisma: { $queryRaw: vi.fn().mockResolvedValue([]) } };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  describe('getDistributionOverview', () => {
    it('monta today/last7Days/last30Days zerados quando não há dados', async () => {
      const { getDistributionOverview } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionOverview();
      expect(out.periods.today).toMatchObject({ label: 'today', totalCoins: 0, totalUsd: 0 });
      expect(out.periods.custom).toBeNull();
    });

    it('inclui período custom quando customFrom/customTo válidos', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ total_coins: 10, total_usd: 5, credit_rows: 2, unique_users: 1 }]);
      const { getDistributionOverview } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionOverview(1000, 2000);
      expect(out.periods.custom).toMatchObject({ label: 'custom', fromMs: 1000, toMs: 2000, totalCoins: 10 });
    });

    it('tabela ausente (P2021): degrada pra tudo zerado, sem lançar', async () => {
      const { Prisma } = await import('@prisma/client');
      prismaMock.prisma.$queryRaw.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('relation does not exist', { code: 'P2021', clientVersion: 'test' }));
      const { getDistributionOverview } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionOverview();
      expect(out.periods.today).toMatchObject({ totalCoins: 0, totalUsd: 0, creditRows: 0, uniqueUsers: 0 });
    });

    it('erro Prisma que não é P2021: propaga', async () => {
      const { Prisma } = await import('@prisma/client');
      prismaMock.prisma.$queryRaw.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2002', clientVersion: 'test' }));
      const { getDistributionOverview } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      await expect(getDistributionOverview()).rejects.toThrow();
    });
  });

  describe('getDistributionByCoin', () => {
    it('calcula pctOfTotalUsd e emissão teórica quando block_reward/block_time estão presentes', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([
        { coin_id: 'btc', symbol: 'BTC', name: 'Bitcoin', block_reward: 6.25, block_time: 600, total_coins: 100, total_usd: 80, credit_rows: 10, unique_users: 3 },
        { coin_id: 'eth', symbol: 'ETH', name: 'Ethereum', block_reward: 0, block_time: 0, total_coins: 50, total_usd: 20, credit_rows: 5, unique_users: 2 }
      ]);
      const { getDistributionByCoin } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionByCoin(0, 86_400_000);
      expect(out.rows[0].pctOfTotalUsd).toBeCloseTo(80, 5);
      expect(out.rows[0].theoreticalEmissionCoins).toBeGreaterThan(0);
      expect(out.rows[1].theoreticalEmissionCoins).toBeNull();
      expect(out.totals.totalUsd).toBe(100);
    });

    it('sem linhas: devolve totals zerados', async () => {
      const { getDistributionByCoin } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionByCoin(0, 1000);
      expect(out.rows).toEqual([]);
      expect(out.totals).toEqual({ totalCoins: 0, totalUsd: 0, creditRows: 0, uniqueUsers: 0 });
    });
  });

  describe('getDistributionTimeline', () => {
    it('mapeia bucket_start pra bucketStartMs/bucketLabel', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([{ bucket_start: new Date('2026-01-01T00:00:00.000Z'), total_coins: 1, total_usd: 2, credit_rows: 3, unique_users: 1 }]);
      const { getDistributionTimeline } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getDistributionTimeline(0, 1000, 'day');
      expect(out.rows[0]).toMatchObject({ bucketLabel: '2026-01-01', totalCoins: 1 });
    });
  });

  describe('validateCreditsRange', () => {
    it('rejeita from/to inválidos ou to < from', async () => {
      const { validateCreditsRange } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      expect(validateCreditsRange(NaN, 100, false)).toBeTruthy();
      expect(validateCreditsRange(200, 100, false)).toBeTruthy();
    });

    it('rejeita intervalo maior que 93 dias', async () => {
      const { validateCreditsRange } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const from = 0;
      const to = 94 * 86_400_000;
      expect(validateCreditsRange(from, to, false)).toContain('93 dias');
    });

    it('intervalo válido devolve null', async () => {
      const { validateCreditsRange } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      expect(validateCreditsRange(0, 86_400_000, false)).toBeNull();
    });
  });

  describe('getMiningCreditsLedger', () => {
    it('intervalo inválido lança HttpControlledError 400', async () => {
      const { getMiningCreditsLedger } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      await expect(getMiningCreditsLedger({ fromMs: 200, toMs: 100, page: 1, limit: 50 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('devolve total e rows mapeados', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([{ total: 1 }])
        .mockResolvedValueOnce([
          { id: 1, user_id: 7, username: 'joe', email: 'joe@x.com', coin_id: 'btc', coin_symbol: 'BTC', room_id: 'r1', window_start_ms: 0, window_end_ms: 600000, credit_blocks: 1, amount_coins: 1, amount_usd: 2, user_hash_hps: 100, network_hashrate: 1000, block_reward: 6.25, block_time: 600, created_at: 123 }
        ]);
      const { getMiningCreditsLedger } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getMiningCreditsLedger({ fromMs: 0, toMs: 1000, page: 1, limit: 50 });
      expect(out.total).toBe(1);
      expect(out.rows[0]).toMatchObject({ id: '1', userId: 7, username: 'joe', coinId: 'btc' });
    });

    it('tabela ausente: devolve página vazia sem lançar', async () => {
      const { Prisma } = await import('@prisma/client');
      prismaMock.prisma.$queryRaw.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('nope', { code: 'P2021', clientVersion: 'test' }));
      const { getMiningCreditsLedger } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getMiningCreditsLedger({ fromMs: 0, toMs: 1000, page: 1, limit: 50 });
      expect(out).toEqual({ total: 0, page: 1, limit: 50, rows: [] });
    });
  });

  describe('streamMiningCreditsCsv', () => {
    it('escreve o cabeçalho + linhas CSV, escapando campos com vírgula/aspas', async () => {
      prismaMock.prisma.$queryRaw.mockResolvedValue([
        { id: 1, user_id: 7, username: 'a,b"c', email: 'x@y.com', coin_id: 'btc', coin_symbol: 'BTC', room_id: null, window_start_ms: 0, window_end_ms: 1000, credit_blocks: 1, amount_coins: 1, amount_usd: 2, user_hash_hps: 1, network_hashrate: 1, created_at: 0 }
      ]);
      const { streamMiningCreditsCsv } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const chunks: string[] = [];
      const out = await streamMiningCreditsCsv({ fromMs: 0, toMs: 1000, page: 1, limit: 50 }, (c) => chunks.push(c));
      expect(out).toEqual({ rowsWritten: 1, truncated: false });
      const csv = chunks.join('');
      expect(csv).toContain('id,user_id,username,email');
      expect(csv).toContain('"a,b""c"');
    });

    it('intervalo maior que 93 dias (exportação): lança HttpControlledError 400', async () => {
      const { streamMiningCreditsCsv } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      await expect(streamMiningCreditsCsv({ fromMs: 0, toMs: 94 * 86_400_000, page: 1, limit: 50 }, () => undefined)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('getUserMiningDistributionSummary', () => {
    it('devolve byCoin com pctOfTotalUsd e totals do utilizador', async () => {
      prismaMock.prisma.$queryRaw
        .mockResolvedValueOnce([{ coin_id: 'btc', symbol: 'BTC', name: 'Bitcoin', total_coins: 10, total_usd: 50, credit_rows: 4 }])
        .mockResolvedValueOnce([{ total_coins: 10, total_usd: 50, credit_rows: 4, unique_users: 1 }]);
      const { getUserMiningDistributionSummary } = await import('../../../../../server/modules/admin/mining-distribution/services/report.js');
      const out = await getUserMiningDistributionSummary(7, 0, 1000);
      expect(out.byCoin[0]).toMatchObject({ coinId: 'btc', pctOfTotalUsd: 100 });
      expect(out.totals).toMatchObject({ totalUsd: 50, uniqueUsers: 1 });
    });
  });
});
