import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectRackComponents,
  recallAllPlayersItems
} from '../../../../../server/modules/admin/recall-all/services/recall-all.js';

type Rack = {
  id: string;
  user_id: number;
  item_id: string | null;
  wiring_id: string | null;
  battery_id: string | null;
};
type Slot = { rack_id: string; machine_item_id: string | null };
type Multi = { rack_id: string; multiplier_item_id: string | null };
type Stock = { user_id: number; item_id: string; qty: number };

type DbState = { racks: Rack[]; slots: Slot[]; multis: Multi[]; stock: Stock[] };

function cloneState(s: DbState): DbState {
  return {
    racks: s.racks.map((r) => ({ ...r })),
    slots: s.slots.map((r) => ({ ...r })),
    multis: s.multis.map((r) => ({ ...r })),
    stock: s.stock.map((r) => ({ ...r }))
  };
}

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

type FakeOpts = {
  failOnNthStockInsert?: number;
  failOnDelete?: 'slots' | 'multi' | 'racks';
  reappearAfterCommit?: Rack[];
};

function createFakePool(initial: DbState, opts: FakeOpts = {}) {
  let live = cloneState(initial);
  const queries: string[] = [];
  let snapshot: DbState | null = null;
  let stockInserts = 0;
  let lockHeld = false;
  const lockWaiters: Array<() => void> = [];

  async function acquireLock() {
    if (!lockHeld) {
      lockHeld = true;
      return;
    }
    await new Promise<void>((resolve) => lockWaiters.push(resolve));
  }

  function releaseLock() {
    const next = lockWaiters.shift();
    if (next) next();
    else lockHeld = false;
  }

  async function query(sql: string, params: unknown[] = []) {
    const n = compactSql(sql);
    queries.push(n);

    if (/pg_advisory_lock/i.test(n)) {
      await acquireLock();
      return { rows: [] };
    }
    if (/pg_advisory_unlock/i.test(n)) {
      releaseLock();
      return { rows: [] };
    }
    if (/^BEGIN$/i.test(n)) {
      snapshot = cloneState(live);
      return { rows: [] };
    }
    if (/^COMMIT$/i.test(n)) {
      snapshot = null;
      if (opts.reappearAfterCommit?.length) {
        live.racks.push(...opts.reappearAfterCommit.map((r) => ({ ...r })));
      }
      return { rows: [] };
    }
    if (/^ROLLBACK$/i.test(n)) {
      if (snapshot) live = cloneState(snapshot);
      snapshot = null;
      return { rows: [] };
    }
    if (/^SELECT id, user_id, item_id, wiring_id, battery_id FROM placed_racks$/i.test(n)) {
      return { rows: live.racks.map((r) => ({ ...r })) };
    }
    if (/FROM rack_slots WHERE rack_id = ANY/i.test(n)) {
      const ids = (params[0] as string[]) || [];
      return {
        rows: live.slots.filter((s) => ids.includes(s.rack_id)).map((s) => ({ rack_id: s.rack_id, item_id: s.machine_item_id }))
      };
    }
    if (/FROM rack_multiplier_slots WHERE rack_id = ANY/i.test(n)) {
      const ids = (params[0] as string[]) || [];
      return {
        rows: live.multis
          .filter((s) => ids.includes(s.rack_id))
          .map((s) => ({ rack_id: s.rack_id, item_id: s.multiplier_item_id }))
      };
    }
    if (/INSERT INTO stock/i.test(n)) {
      stockInserts++;
      if (opts.failOnNthStockInsert && stockInserts >= opts.failOnNthStockInsert) {
        throw new Error('stock insert failed');
      }
      const userId = params[0] as number;
      const itemId = String(params[1]);
      const row = live.stock.find((s) => s.user_id === userId && s.item_id === itemId);
      if (row) row.qty += 1;
      else live.stock.push({ user_id: userId, item_id: itemId, qty: 1 });
      return { rows: [] };
    }
    if (/^DELETE FROM rack_slots/i.test(n)) {
      if (opts.failOnDelete === 'slots') throw new Error('delete slots failed');
      const ids = new Set(live.racks.map((r) => r.id));
      live.slots = live.slots.filter((s) => !ids.has(s.rack_id));
      return { rows: [] };
    }
    if (/^DELETE FROM rack_multiplier_slots/i.test(n)) {
      if (opts.failOnDelete === 'multi') throw new Error('delete multi failed');
      const ids = new Set(live.racks.map((r) => r.id));
      live.multis = live.multis.filter((s) => !ids.has(s.rack_id));
      return { rows: [] };
    }
    if (/^DELETE FROM placed_racks/i.test(n)) {
      if (opts.failOnDelete === 'racks') throw new Error('delete racks failed');
      live.racks = [];
      return { rows: [] };
    }
    throw new Error('unexpected SQL: ' + n);
  }

  const pool = {
    connect: async () => ({
      query,
      release: () => {}
    }),
    state: () => live,
    queries
  };
  return pool;
}

const fullRack: Rack = { id: 'r1', user_id: 1, item_id: 'chassis-a', wiring_id: 'wire-a', battery_id: 'bat-a' };

describe('collectRackComponents (contagem POST, não scan)', () => {
  it('chassis só entra se item_id for truthy — diferente do COUNT(placed_racks) do scan', () => {
    expect(collectRackComponents({ item_id: null, wiring_id: null, battery_id: null }, [], [])).toEqual([]);
    expect(collectRackComponents({ item_id: '', wiring_id: 'w', battery_id: null }, [], [])).toEqual(['w']);
    expect(collectRackComponents({ item_id: 'c', wiring_id: 'w', battery_id: 'b' }, ['m1', null, 'm2'], ['x'])).toEqual([
      'c',
      'w',
      'b',
      'm1',
      'm2',
      'x'
    ]);
  });
});

describe('recallAllPlayersItems', () => {
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
  });

  it('nenhum placed_racks → success, zero moved, sem BEGIN', async () => {
    const pool = createFakePool({ racks: [], slots: [], multis: [], stock: [] });
    const out = await recallAllPlayersItems(pool as any);
    expect(out).toEqual({
      ok: true,
      report: {
        steps: [
          'Iniciando tentativa 1...',
          'Tudo limpo: Nenhum item instalado detectado.',
          'Finalizado com sucesso total e verificado.'
        ],
        finalStatus: 'success',
        totalItemsMoved: 0,
        racksProcessed: 0,
        retries: 0
      }
    });
    expect(pool.queries.some((q) => q === 'BEGIN')).toBe(false);
    expect(pool.queries.some((q) => q === 'COMMIT')).toBe(false);
  });
});

describe('recallAllPlayersItems GENESIS_HARDWARE_URL', () => {
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../../server/modules/hardware/services/hardware-client.js');
    vi.resetModules();
  });

  it('recolhe via callHardwareRecallAll — sem credit/INSERT/DELETE Node', async () => {
    const pool = createFakePool({
      racks: [{ id: 'r1', user_id: 7, item_id: 'rack-item', wiring_id: null, battery_id: null }],
      slots: [],
      multis: [],
      stock: []
    });
    const callHardwareRecallAll = vi.fn().mockImplementation(async () => {
      const s = pool.state();
      s.racks = [];
      s.slots = [];
      s.multis = [];
      return { ok: true, itemsMoved: 1, racksProcessed: 1 };
    });
    const callHardwareCredit = vi.fn();
    vi.doMock('../../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwareRecallAll,
      callHardwareCredit
    }));
    const { recallAllPlayersItems: recallWithHw } = await import(
      '../../../../../server/modules/admin/recall-all/services/recall-all.js'
    );
    const out = await recallWithHw(pool as never);
    expect(out.ok).toBe(true);
    expect(out.report.totalItemsMoved).toBe(1);
    expect(out.report.racksProcessed).toBe(1);
    expect(callHardwareRecallAll).toHaveBeenCalledTimes(1);
    expect(callHardwareCredit).not.toHaveBeenCalled();
    expect(pool.queries.some((q) => /INSERT INTO stock/i.test(q))).toBe(false);
    expect(pool.queries.some((q) => /^DELETE FROM placed_racks/i.test(q))).toBe(false);
  });

  it('recall-all HTTP falha → sem DELETE racks (fail-closed)', async () => {
    const callHardwareRecallAll = vi.fn().mockRejectedValue(new Error('hardware recall-all failed'));
    const callHardwareCredit = vi.fn();
    vi.doMock('../../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwareRecallAll,
      callHardwareCredit
    }));
    const { recallAllPlayersItems: recallWithHw } = await import(
      '../../../../../server/modules/admin/recall-all/services/recall-all.js'
    );
    const initial: DbState = {
      racks: [fullRack],
      slots: [{ rack_id: 'r1', machine_item_id: 'm1' }],
      multis: [],
      stock: [{ user_id: 1, item_id: 'pre', qty: 1 }]
    };
    const pool = createFakePool(initial);
    await expect(recallWithHw(pool as never)).rejects.toThrow('hardware recall-all failed');
    expect(callHardwareRecallAll).toHaveBeenCalled();
    expect(callHardwareCredit).not.toHaveBeenCalled();
    expect(pool.queries.some((q) => /^DELETE FROM placed_racks/i.test(q))).toBe(false);
    expect(pool.queries.some((q) => /INSERT INTO stock/i.test(q))).toBe(false);
    expect(pool.state()).toEqual(initial);
  });
});
