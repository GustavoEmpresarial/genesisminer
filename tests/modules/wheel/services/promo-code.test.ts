import { describe, expect, it, vi } from 'vitest';
import { promoCodeRowEligibleForRoletaFlow, promoTypeLiteralIsRoleta, throwIfPromoCodeExpired } from '../../../../server/modules/wheel/services/promo-code.js';

describe('wheel services/promo-code', () => {
  describe('throwIfPromoCodeExpired', () => {
    it('não lança quando expires_at é null/0/ausente', () => {
      expect(() => throwIfPromoCodeExpired({}, Date.now())).not.toThrow();
      expect(() => throwIfPromoCodeExpired({ expires_at: 0 }, Date.now())).not.toThrow();
    });

    it('lança 400 quando serverNowMs > expires_at', () => {
      try {
        throwIfPromoCodeExpired({ expires_at: 100 }, 200);
        expect.unreachable();
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
      }
    });

    it('não lança quando ainda não expirou', () => {
      expect(() => throwIfPromoCodeExpired({ expires_at: 9999999999999 }, Date.now())).not.toThrow();
    });
  });

  describe('promoTypeLiteralIsRoleta', () => {
    it('true para tipos que começam com roleta_', () => {
      expect(promoTypeLiteralIsRoleta('roleta_global_1x')).toBe(true);
    });

    it('false para outros tipos', () => {
      expect(promoTypeLiteralIsRoleta('global_once')).toBe(false);
      expect(promoTypeLiteralIsRoleta(null)).toBe(false);
    });
  });

  describe('promoCodeRowEligibleForRoletaFlow', () => {
    it('true direto quando type começa com roleta_ (sem consultar BD)', async () => {
      const tx = { loot_boxes: { findFirst: vi.fn() } };
      const out = await promoCodeRowEligibleForRoletaFlow(tx as any, { type: 'roleta_player_1x', loot_box_id: null });
      expect(out).toBe(true);
      expect(tx.loot_boxes.findFirst).not.toHaveBeenCalled();
    });

    it('false quando não tem loot_box_id', async () => {
      const tx = { loot_boxes: { findFirst: vi.fn() } };
      const out = await promoCodeRowEligibleForRoletaFlow(tx as any, { type: 'shop', loot_box_id: null });
      expect(out).toBe(false);
    });

    it('consulta trigger da caixa quando type não é roleta_ mas tem loot_box_id', async () => {
      const tx = { loot_boxes: { findFirst: vi.fn().mockResolvedValue({ trigger: 'roleta_code' }) } };
      const out = await promoCodeRowEligibleForRoletaFlow(tx as any, { type: 'shop', loot_box_id: 'box_1' });
      expect(out).toBe(true);
      expect(tx.loot_boxes.findFirst).toHaveBeenCalledWith({ where: { id: 'box_1' }, select: { trigger: true } });
    });

    it('false quando trigger da caixa não é roleta_code', async () => {
      const tx = { loot_boxes: { findFirst: vi.fn().mockResolvedValue({ trigger: 'shop' }) } };
      const out = await promoCodeRowEligibleForRoletaFlow(tx as any, { type: 'shop', loot_box_id: 'box_1' });
      expect(out).toBe(false);
    });
  });
});
