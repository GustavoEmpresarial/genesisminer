import { describe, expect, it, vi } from 'vitest';
import { assertEmailMatchesSession, bodyLootBoxId, bodyOptionalDiscardQty, parseLootBoxId } from '../../../../server/modules/lucky-boxes/services/validation.js';

describe('lucky-boxes services/validation', () => {
  describe('parseLootBoxId / bodyLootBoxId', () => {
    it('aceita ids seguros', () => {
      expect(parseLootBoxId('box_abc-1.2')).toBe('box_abc-1.2');
    });

    it('rejeita vazio ou com caracteres inseguros', () => {
      expect(parseLootBoxId('')).toBeNull();
      expect(parseLootBoxId('has space')).toBeNull();
      expect(parseLootBoxId(42)).toBeNull();
    });

    it('bodyLootBoxId extrai do corpo', () => {
      expect(bodyLootBoxId({ boxId: 'box_1' })).toBe('box_1');
      expect(bodyLootBoxId(null)).toBeNull();
    });
  });

  describe('bodyOptionalDiscardQty', () => {
    it('ausente ou corpo vazio: "all"', () => {
      expect(bodyOptionalDiscardQty(null)).toBe('all');
      expect(bodyOptionalDiscardQty({})).toBe('all');
    });

    it('qty válida: devolve o número', () => {
      expect(bodyOptionalDiscardQty({ qty: 3 })).toBe(3);
    });

    it('qty inválida (0, negativa, fracionada ou acima do teto): null', () => {
      expect(bodyOptionalDiscardQty({ qty: 0 })).toBeNull();
      expect(bodyOptionalDiscardQty({ qty: -1 })).toBeNull();
      expect(bodyOptionalDiscardQty({ qty: 200_000 })).toBeNull();
    });
  });

  describe('assertEmailMatchesSession', () => {
    it('sem email no corpo: ok direto sem consultar BD', async () => {
      const db = { users: { findUnique: vi.fn() } };
      const out = await assertEmailMatchesSession(db as any, 1, undefined);
      expect(out).toEqual({ ok: true });
      expect(db.users.findUnique).not.toHaveBeenCalled();
    });

    it('email não-string: 400', async () => {
      const db = { users: { findUnique: vi.fn() } };
      const out = await assertEmailMatchesSession(db as any, 1, 123);
      expect(out).toMatchObject({ ok: false, status: 400 });
    });

    it('email não bate com a sessão: 403', async () => {
      const db = { users: { findUnique: vi.fn().mockResolvedValue({ email: 'real@x.com' }) } };
      const out = await assertEmailMatchesSession(db as any, 1, 'fake@x.com');
      expect(out).toMatchObject({ ok: false, status: 403 });
    });

    it('email bate (case-insensitive): ok', async () => {
      const db = { users: { findUnique: vi.fn().mockResolvedValue({ email: 'Real@X.com' }) } };
      const out = await assertEmailMatchesSession(db as any, 1, 'real@x.com');
      expect(out).toEqual({ ok: true });
    });
  });
});
