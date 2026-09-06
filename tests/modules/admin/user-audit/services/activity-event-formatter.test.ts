import { describe, expect, it } from 'vitest';
import { formatActivityEvent, matchesActivityFilter } from '../../../../../server/modules/admin/user-audit/services/activity-event-formatter.js';

describe('modules/admin/user-audit/services/activity-event-formatter', () => {
  describe('formatActivityEvent', () => {
    it('formata stock_delta com perda como warning', () => {
      const d = formatActivityEvent('stock_delta', { itemId: 'gpu-1', itemName: 'GPU X', before: 5, after: 2 });
      expect(d.category).toBe('inventory');
      expect(d.severity).toBe('warning');
      expect(d.summary).toContain('GPU X');
      expect(d.summary).toContain('Δ -3');
    });

    it('formata inventory_loss_alert sempre como danger, mesmo com delta positivo', () => {
      const d = formatActivityEvent('inventory_loss_alert', { itemId: 'gpu-1', before: 1, after: 5 });
      expect(d.severity).toBe('danger');
      expect(d.category).toBe('inventory');
    });

    it('formata p2p_listing_buy com item e total', () => {
      const d = formatActivityEvent('p2p_listing_buy', { itemName: 'ASIC S19', qty: 2, totalUsdc: 100 });
      expect(d.category).toBe('p2p');
      expect(d.severity).toBe('success');
      expect(d.summary).toContain('ASIC S19');
      expect(d.summary).toContain('100.00');
    });

    it('formata login_blocked com retryAfterSeconds', () => {
      const d = formatActivityEvent('login_blocked', { retryAfterSeconds: 30 });
      expect(d.category).toBe('auth');
      expect(d.severity).toBe('danger');
      expect(d.summary).toContain('30s');
    });

    it('formata admin_ranking_exclusion', () => {
      const d = formatActivityEvent('admin_ranking_exclusion', { excluded: true, adminUserId: 3 });
      expect(d.category).toBe('other');
      expect(d.severity).toBe('warning');
      expect(d.title).toBe('Excluído do ranking');
      expect(d.lines?.[0]).toContain('3');
    });

    it('cai no default para ações desconhecidas, listando as chaves do meta', () => {
      const d = formatActivityEvent('acao_nunca_vista', { foo: 1, bar: 'x' });
      expect(d.category).toBe('other');
      expect(d.title).toBe('acao nunca vista');
      expect(d.summary).toContain('foo=');
    });

    it('trata meta nulo/array como objeto vazio sem lançar', () => {
      expect(() => formatActivityEvent('login_success', null)).not.toThrow();
      expect(() => formatActivityEvent('login_success', [1, 2, 3])).not.toThrow();
    });
  });

  describe('matchesActivityFilter', () => {
    it('filterId "all" aceita qualquer evento', () => {
      const d = formatActivityEvent('rack_place', {});
      expect(matchesActivityFilter(d, 'rack_place', 'all')).toBe(true);
    });

    it('filterId "losses" só aceita inventory warning/danger', () => {
      const loss = formatActivityEvent('stock_delta', { before: 5, after: 1 });
      const gain = formatActivityEvent('stock_delta', { before: 1, after: 5 });
      expect(matchesActivityFilter(loss, 'stock_delta', 'losses')).toBe(true);
      expect(matchesActivityFilter(gain, 'stock_delta', 'losses')).toBe(false);
    });

    it('filterId "p2p" só aceita categoria p2p', () => {
      const p2p = formatActivityEvent('p2p_trade_buy', { itemName: 'X', qty: 1 });
      const other = formatActivityEvent('login_success', {});
      expect(matchesActivityFilter(p2p, 'p2p_trade_buy', 'p2p')).toBe(true);
      expect(matchesActivityFilter(other, 'login_success', 'p2p')).toBe(false);
    });
  });
});
