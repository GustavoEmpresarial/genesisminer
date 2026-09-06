import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('merge services/settings', () => {
  let dbMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    dbMock = { default: { query: vi.fn() } };
    vi.doMock('../../../../server/core/database/pool.js', () => dbMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/pool.js');
  });

  describe('loadMergeSettings', () => {
    it('sem linha em merge_settings: devolve defaults', async () => {
      dbMock.default.query.mockResolvedValue({ rows: [] });
      const { loadMergeSettings } = await import('../../../../server/modules/merge/services/settings.js');
      const settings = await loadMergeSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.gainPercent).toBe(5);
    });

    it('lê e normaliza a linha existente', async () => {
      dbMock.default.query.mockResolvedValue({
        rows: [
          {
            gain_percent: 15,
            cost_pct_json: JSON.stringify({ common: 50 }),
            rack_hs_bonus_pct_json: JSON.stringify({ supreme: 100 }),
            enabled: 0,
            enabled_machine: 1,
            enabled_multiplier: 0,
            enabled_infrastructure: 1
          }
        ]
      });
      const { loadMergeSettings } = await import('../../../../server/modules/merge/services/settings.js');
      const settings = await loadMergeSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.gainPercent).toBe(15);
      expect(settings.costPctByRarity.common).toBe(50);
      expect(settings.rackHsBonusPctByRarity.supreme).toBe(100);
      expect(settings.enabledMultiplier).toBe(false);
    });

    it('cacheia por 5s — 2ª chamada não repete a query', async () => {
      dbMock.default.query.mockResolvedValue({ rows: [] });
      const { loadMergeSettings } = await import('../../../../server/modules/merge/services/settings.js');
      await loadMergeSettings();
      await loadMergeSettings();
      expect(dbMock.default.query).toHaveBeenCalledTimes(1);
    });

    it('erro na query cai em defaults', async () => {
      dbMock.default.query.mockRejectedValue(new Error('boom'));
      const { loadMergeSettings } = await import('../../../../server/modules/merge/services/settings.js');
      const settings = await loadMergeSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.gainPercent).toBe(5);
    });
  });

  describe('saveMergeSettings', () => {
    it('grava, invalida o cache e devolve o valor normalizado', async () => {
      dbMock.default.query.mockResolvedValue({ rows: [] });
      const { saveMergeSettings, loadMergeSettings } = await import('../../../../server/modules/merge/services/settings.js');
      const saved = await saveMergeSettings({
        enabled: true,
        enabledMachine: true,
        enabledMultiplier: false,
        enabledInfrastructure: true,
        gainPercent: 999, // clampa
        costPctByRarity: { common: 999, uncommon: 15, rare: 20, epic: 25, legendary: 30 },
        rackHsBonusPctByRarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, supreme: 999 }
      });
      expect(saved.gainPercent).toBe(100); // gainPercent é clampado a [0,100]
      expect(saved.costPctByRarity.common).toBe(10); // fora de [0,100]: mantém o default, não clampa
      expect(saved.rackHsBonusPctByRarity.supreme).toBe(0); // fora de [0,500]: mantém o default

      // 2ª leitura reaproveita o cache recém-gravado (sem nova query)
      const before = dbMock.default.query.mock.calls.length;
      const reloaded = await loadMergeSettings();
      expect(dbMock.default.query.mock.calls.length).toBe(before);
      expect(reloaded).toEqual(saved);
    });
  });
});
