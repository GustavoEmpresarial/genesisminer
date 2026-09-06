import { describe, expect, it, vi } from 'vitest';
import { fetchWheelPrizesForApiConfig, pickWeightedPrize, queryWheelPrizeByItemIdJoined, queryWheelPrizesEligibleForRoll } from '../../../../server/modules/wheel/services/prizes.js';

describe('wheel services/prizes', () => {
  describe('pickWeightedPrize', () => {
    it('lança 500 quando o total de pesos é <= 0', () => {
      try {
        pickWeightedPrize([{ id: '1', label: 'a', weight: 0, color: null, item_id: 'i1', image: null }]);
        expect.unreachable();
      } catch (e: any) {
        expect(e.statusCode).toBe(500);
      }
    });

    it('escolhe determinística quando só há um prémio', () => {
      const prizes = [{ id: '1', label: 'a', weight: 10, color: null, item_id: 'i1', image: null }];
      expect(pickWeightedPrize(prizes)).toBe(prizes[0]);
    });

    it('sempre devolve um prémio da lista mesmo com pesos negativos/NaN misturados', () => {
      const prizes = [
        { id: '1', label: 'a', weight: -5, color: null, item_id: 'i1', image: null },
        { id: '2', label: 'b', weight: 10, color: null, item_id: 'i2', image: null }
      ];
      for (let i = 0; i < 20; i++) {
        expect(prizes).toContainEqual(pickWeightedPrize(prizes));
      }
    });
  });

  describe('queryWheelPrizesEligibleForRoll / queryWheelPrizeByItemIdJoined', () => {
    it('mapeia label do upgrade quando presente, senão usa stored_label', async () => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([
          { id: '1', stored_label: 'Antigo', weight: 5, color: '#fff', item_id: 'i1', upgrade_name: 'Novo Nome', upgrade_image: 'img.png' },
          { id: '2', stored_label: 'Só stored', weight: 5, color: null, item_id: 'i2', upgrade_name: null, upgrade_image: null }
        ])
      };
      const rows = await queryWheelPrizesEligibleForRoll(tx as any);
      expect(rows[0]).toMatchObject({ id: '1', label: 'Novo Nome', image: 'img.png' });
      expect(rows[1]).toMatchObject({ id: '2', label: 'Só stored', image: null });
    });

    it('queryWheelPrizeByItemIdJoined devolve null quando não encontra', async () => {
      const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
      const out = await queryWheelPrizeByItemIdJoined(tx as any, 'nope');
      expect(out).toBeNull();
    });
  });

  describe('fetchWheelPrizesForApiConfig', () => {
    it('força weight uniforme = 1 na resposta pública', async () => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: '1', stored_label: 'a', weight: 999, color: null, item_id: 'i1', upgrade_name: null, upgrade_image: null }])
      };
      const rows = await fetchWheelPrizesForApiConfig(tx as any);
      expect(rows[0]!.weight).toBe(1);
    });
  });
});
