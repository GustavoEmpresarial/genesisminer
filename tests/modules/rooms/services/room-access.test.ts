import { describe, expect, it } from 'vitest';
import { isRoomAccessAllowedForUser, roomAccessGateFromRow } from '../../../../server/modules/rooms/services/room-access.js';

const NO_ACCESS = { planIds: [], passIds: [] };

describe('rooms services/room-access', () => {
  describe('roomAccessGateFromRow', () => {
    it('lê as colunas JSON legadas allowed_levels / allowed_season_pass_ids', () => {
      const gate = roomAccessGateFromRow({ allowed_levels: '["plan_a","plan_b"]', allowed_season_pass_ids: '["pass_1"]' });
      expect(gate).toEqual({ allowedPlanIds: ['plan_a', 'plan_b'], allowedSeasonPassIds: ['pass_1'] });
    });

    it('coluna NULL ou vazia vira lista vazia (sala sem restrição)', () => {
      expect(roomAccessGateFromRow({ allowed_levels: null, allowed_season_pass_ids: '' })).toEqual({ allowedPlanIds: [], allowedSeasonPassIds: [] });
      expect(roomAccessGateFromRow({})).toEqual({ allowedPlanIds: [], allowedSeasonPassIds: [] });
    });

    it('JSON inválido não rebenta — degrada para sem restrição', () => {
      expect(roomAccessGateFromRow({ allowed_levels: '{nao é json', allowed_season_pass_ids: '"string"' })).toEqual({
        allowedPlanIds: [],
        allowedSeasonPassIds: []
      });
    });

    it('normaliza entradas não-string para string', () => {
      expect(roomAccessGateFromRow({ allowed_levels: '[1,2]' }).allowedPlanIds).toEqual(['1', '2']);
    });
  });

  describe('isRoomAccessAllowedForUser', () => {
    it('sala sem restrição libera qualquer utilizador', () => {
      expect(isRoomAccessAllowedForUser({ allowedPlanIds: [], allowedSeasonPassIds: [] }, NO_ACCESS)).toBe(true);
    });

    it('sala restrita a plano: bloqueia quem não o tem', () => {
      expect(isRoomAccessAllowedForUser({ allowedPlanIds: ['vip'], allowedSeasonPassIds: [] }, NO_ACCESS)).toBe(false);
    });

    it('sala restrita a plano: libera quem o tem', () => {
      expect(isRoomAccessAllowedForUser({ allowedPlanIds: ['vip'], allowedSeasonPassIds: [] }, { planIds: ['vip'], passIds: [] })).toBe(true);
    });

    it('plano E passe são exigidos quando ambos estão definidos', () => {
      const gate = { allowedPlanIds: ['vip'], allowedSeasonPassIds: ['s1'] };
      expect(isRoomAccessAllowedForUser(gate, { planIds: ['vip'], passIds: [] })).toBe(false);
      expect(isRoomAccessAllowedForUser(gate, { planIds: [], passIds: ['s1'] })).toBe(false);
      expect(isRoomAccessAllowedForUser(gate, { planIds: ['vip'], passIds: ['s1'] })).toBe(true);
    });

    it('gate montado a partir da linha DB decide igual (integração das duas funções)', () => {
      const gate = roomAccessGateFromRow({ allowed_levels: '["vip"]', allowed_season_pass_ids: null });
      expect(isRoomAccessAllowedForUser(gate, NO_ACCESS)).toBe(false);
      expect(isRoomAccessAllowedForUser(gate, { planIds: ['vip'], passIds: [] })).toBe(true);
    });
  });
});
