import { describe, expect, it } from 'vitest';
import {
  buildItemDisposition,
  mergeAdminUserActivityLogs,
  mergeTimelineEvents,
  type AccountTraceEvent
} from '../../../../../server/modules/admin/user-audit/services/account-trace.js';
import type { GameActivityLogRow } from '../../../../../server/modules/admin/user-audit/services/account-trace.js';

describe('modules/admin/user-audit/services/account-trace', () => {
  describe('buildItemDisposition', () => {
    it('calcula unaccounted quando adquirido excede stock+rigs+listagens', () => {
      const rows = buildItemDisposition({
        itemNames: new Map([['gpu', 'GPU X']]),
        stock: new Map([['gpu', 1]]),
        onRigs: new Map(),
        listedP2p: new Map(),
        acquired: new Map([['gpu', 5]]),
        soldP2p: new Map()
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].unaccounted).toBe(4);
      expect(rows[0].hint).toContain('Sem localização');
    });

    it('não conta unaccounted quando localizado cobre o adquirido', () => {
      const rows = buildItemDisposition({
        itemNames: new Map(),
        stock: new Map([['gpu', 3]]),
        onRigs: new Map([['gpu', [{ rackId: 'r1', slotIndex: 0, roomId: null }]]]),
        listedP2p: new Map(),
        acquired: new Map([['gpu', 4]]),
        soldP2p: new Map()
      });
      expect(rows[0].unaccounted).toBe(0);
      expect(rows[0].hint).toContain('Montado na rig');
    });

    it('ordena por unaccounted desc, depois por acquired desc', () => {
      const rows = buildItemDisposition({
        itemNames: new Map(),
        stock: new Map(),
        onRigs: new Map(),
        listedP2p: new Map(),
        acquired: new Map([
          ['a', 10],
          ['b', 3]
        ]),
        soldP2p: new Map()
      });
      expect(rows.map((r) => r.itemId)).toEqual(['a', 'b']);
    });
  });

  describe('mergeTimelineEvents', () => {
    function ev(id: string, atMs: number, source: AccountTraceEvent['source'], overrides?: Partial<AccountTraceEvent>): AccountTraceEvent {
      return {
        id,
        atMs,
        source,
        kind: 'x',
        action: 'x',
        title: 't',
        summary: 's',
        severity: 'info',
        category: 'other',
        ...overrides
      };
    }

    it('mescla mongo+postgres ordenado por atMs desc e respeita o limit', () => {
      const mongo = [ev('m1', 100, 'mongo_game')];
      const pg = [ev('p1', 200, 'postgres')];
      const { events, hasMore } = mergeTimelineEvents(mongo, pg, { limit: 5 });
      expect(events.map((e) => e.id)).toEqual(['p1', 'm1']);
      expect(hasMore).toBe(false);
    });

    it('descarta duplicata mongo p2p_listing_buy perto de um trade postgres equivalente', () => {
      const mongo = [ev('m1', 1000, 'mongo_game', { action: 'p2p_listing_buy', kind: 'p2p_listing_buy' })];
      const pg = [ev('p1', 1000, 'postgres', { kind: 'p2p_buy' })];
      const { events } = mergeTimelineEvents(mongo, pg, { limit: 10 });
      expect(events.map((e) => e.id)).toEqual(['p1']);
    });

    it('aplica beforeMs e calcula hasMore/nextCursor', () => {
      const mongo = [ev('m1', 300, 'mongo_game'), ev('m2', 200, 'mongo_game'), ev('m3', 100, 'mongo_game')];
      const { events, hasMore, nextCursor } = mergeTimelineEvents(mongo, [], { limit: 1 });
      expect(events.map((e) => e.id)).toEqual(['m1']);
      expect(hasMore).toBe(true);
      expect(nextCursor).toBe(300);
    });
  });

  describe('mergeAdminUserActivityLogs', () => {
    function row(id: string, action: string, createdAt: number): GameActivityLogRow {
      return { id, action, createdAt, meta: {} };
    }

    it('remove p2p_listing_buy do mongo quando há trade postgres na mesma janela de tempo', () => {
      const mongo = [row('m1', 'p2p_listing_buy', 1000)];
      const pg = [row('p1', 'p2p_trade_buy', 1000)];
      const { rows } = mergeAdminUserActivityLogs(mongo, pg, { limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['p1']);
    });

    it('mantém mongo quando não há trade postgres próximo', () => {
      const mongo = [row('m1', 'p2p_listing_buy', 1000)];
      const { rows } = mergeAdminUserActivityLogs(mongo, [], { limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['m1']);
    });

    it('deduplica por id, ordena desc e aplica beforeMs', () => {
      const mongo = [row('a', 'login_success', 300), row('b', 'login_success', 100)];
      const pg = [row('a', 'login_success', 300)];
      const { rows, hasMore } = mergeAdminUserActivityLogs(mongo, pg, { beforeMs: 300, limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['b']);
      expect(hasMore).toBe(false);
    });
  });
});
