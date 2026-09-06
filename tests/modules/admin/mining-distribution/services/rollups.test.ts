import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin/mining-distribution services/rollups', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    client = { query: vi.fn().mockResolvedValue({ rowCount: 3 }), release: vi.fn() };
    poolMock = { default: { connect: vi.fn(async () => client) } };
    vi.doMock('../../../../../server/core/database/pool.js', () => poolMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/pool.js');
  });

  describe('rebuildMiningDistributionRollups', () => {
    it('faz o upsert e devolve daysProcessed/rowsUpserted', async () => {
      const { rebuildMiningDistributionRollups } = await import('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
      const out = await rebuildMiningDistributionRollups('2026-01-01', '2026-01-03');
      expect(out).toEqual({ daysProcessed: 3, rowsUpserted: 3 });
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mining_distribution_daily'), ['2026-01-01', '2026-01-03']);
      expect(client.release).toHaveBeenCalled();
    });

    it('tabela mining_block_history ausente (42P01): degrada pra 0/0 sem lançar', async () => {
      const err: any = new Error('relation "mining_block_history" does not exist');
      err.code = '42P01';
      client.query.mockRejectedValue(err);
      const { rebuildMiningDistributionRollups } = await import('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
      const out = await rebuildMiningDistributionRollups('2026-01-01', '2026-01-03');
      expect(out).toEqual({ daysProcessed: 0, rowsUpserted: 0 });
      expect(client.release).toHaveBeenCalled();
    });

    it('outro erro de BD: propaga', async () => {
      client.query.mockRejectedValue(new Error('conexão perdida'));
      const { rebuildMiningDistributionRollups } = await import('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
      await expect(rebuildMiningDistributionRollups('2026-01-01', '2026-01-03')).rejects.toThrow('conexão perdida');
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('rebuildMiningDistributionRollupsRecent', () => {
    it('usa a janela de daysBack a partir de hoje', async () => {
      const { rebuildMiningDistributionRollupsRecent } = await import('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
      const out = await rebuildMiningDistributionRollupsRecent(10);
      expect(out.rowsUpserted).toBe(3);
      expect(client.query).toHaveBeenCalled();
    });

    it('default de 45 dias quando daysBack não é informado', async () => {
      const { rebuildMiningDistributionRollupsRecent } = await import('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
      await rebuildMiningDistributionRollupsRecent();
      const [, params] = client.query.mock.calls[0];
      expect(params).toHaveLength(2);
    });
  });
});
