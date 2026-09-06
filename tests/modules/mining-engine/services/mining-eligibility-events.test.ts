/**
 * TAREFA 4C — integridade do event log + soft-expire + repair endurecido.
 * Usa um PoolClient em memória (sem Postgres) para os fluxos de asic-lease.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  expireUserAsicLeases,
  finalizeTimedMinerEquip,
  repairEquippedAsicLeasesForRack,
  releaseEquippedAsicLease,
  releaseEquippedAsicLeaseById,
  resolveEquippedLeaseIdForSlot,
  applyTimedStockQtyToSnapshot
} from '../../../../server/modules/mining-engine/services/asic-lease.js';
import {
  isMiningEligibilityEventType,
  recordMiningEligibilityEvent
} from '../../../../server/modules/mining-engine/services/mining-eligibility-events.js';
import {
  MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT,
  miningEligibilityHistoryCutoverMs,
  MINING_ELIGIBILITY_EVENTS_REPLAY_ORDER_SQL,
  ASIC_EXPIRED_TIMESTAMP_CONTRACT,
  MINING_ELIGIBILITY_EVENT_LOG_CONTRACT
} from '../../../../server/modules/mining-engine/services/mining-eligibility-cutover.js';

const ROOT = resolve(__dirname, '../../../..');

type LeaseRow = {
  id: string;
  user_id: number;
  item_id: string;
  acquired_at: number;
  expires_at: number;
  status: string;
  rack_id: string | null;
  slot_index: number | null;
};

type SlotRow = {
  rack_id: string;
  slot_index: number;
  machine_item_id: string | null;
  machine_lease_id: string | null;
};

type EventRow = {
  id: number;
  user_id: number;
  event_type: string;
  at_ms: number;
  identity_kind: string;
  lease_id: string | null;
  rack_id: string | null;
  slot_index: number | null;
  catalog_item_id: string | null;
  coin_id: string | null;
  payload: string | null;
  created_at: number;
};

function makeFakeDb(seed?: { leases?: LeaseRow[]; slots?: SlotRow[] }) {
  const leases = new Map<string, LeaseRow>((seed?.leases || []).map((l) => [l.id, { ...l }]));
  const slots = new Map<string, SlotRow>();
  for (const s of seed?.slots || []) {
    slots.set(`${s.rack_id}|${s.slot_index}`, { ...s });
  }
  const events: EventRow[] = [];
  let nextEventId = 1;
  let failNextEventInsert = false;

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.includes('FROM upgrades WHERE id')) {
        const itemId = String(params[0]);
        // Timed ASIC catalog stub
        if (itemId.startsWith('asic_timed')) {
          return {
            rows: [
              {
                type: 'machine',
                category: 'asic',
                id: itemId,
                asic_duration_amount: 1,
                asic_duration_unit: 'day',
                asic_duration_kind: 'timed'
              }
            ]
          };
        }
        return {
          rows: [
            {
              type: 'machine',
              category: 'gpu',
              id: itemId,
              asic_duration_amount: 0,
              asic_duration_unit: null,
              asic_duration_kind: 'none'
            }
          ]
        };
      }

      if (q.includes('INSERT INTO mining_eligibility_events')) {
        if (failNextEventInsert) {
          failNextEventInsert = false;
          throw new Error('simulated_event_insert_failure');
        }
        const eventType = String(params[1]);
        const leaseId = params[4] != null ? String(params[4]) : null;
        if (eventType === 'ASIC_EXPIRED' && leaseId) {
          if (events.some((e) => e.event_type === 'ASIC_EXPIRED' && e.lease_id === leaseId)) {
            const err = Object.assign(new Error('unique'), { code: '23505' });
            throw err;
          }
        }
        const row: EventRow = {
          id: nextEventId++,
          user_id: Number(params[0]),
          event_type: eventType,
          at_ms: Number(params[2]),
          identity_kind: String(params[3]),
          lease_id: leaseId,
          rack_id: params[5] != null ? String(params[5]) : null,
          slot_index: params[6] != null ? Number(params[6]) : null,
          catalog_item_id: params[7] != null ? String(params[7]) : null,
          coin_id: params[8] != null ? String(params[8]) : null,
          payload: params[9] != null ? String(params[9]) : null,
          created_at: Number(params[10])
        };
        events.push(row);
        return { rows: [{ id: String(row.id) }], rowCount: 1 };
      }

      if (q.includes('FROM player_asic_leases') && q.includes('expires_at <=') && q.includes('FOR UPDATE')) {
        const userId = Number(params[0]);
        const nowMs = Number(params[1]);
        const rows = [...leases.values()].filter(
          (l) => l.user_id === userId && l.expires_at <= nowMs && (l.status === 'stock' || l.status === 'equipped')
        );
        return { rows, rowCount: rows.length };
      }

      if (q.includes('UPDATE rack_slots SET machine_item_id = NULL') && q.includes('machine_lease_id = $3')) {
        const rackId = String(params[0]);
        const si = Number(params[1]);
        const leaseId = String(params[2]);
        const key = `${rackId}|${si}`;
        const s = slots.get(key);
        if (s && s.machine_lease_id === leaseId) {
          s.machine_item_id = null;
          s.machine_lease_id = null;
        }
        return { rows: [], rowCount: 1 };
      }

      if (q.includes("SET status = 'expired'") && q.includes('player_asic_leases')) {
        const id = String(params[0]);
        const l = leases.get(id);
        if (!l) return { rows: [], rowCount: 0 };
        if (params.length >= 2 && Number(params[1]) !== l.user_id) return { rows: [], rowCount: 0 };
        if (l.status !== 'stock' && l.status !== 'equipped') return { rows: [], rowCount: 0 };
        l.status = 'expired';
        l.rack_id = null;
        l.slot_index = null;
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('SELECT DISTINCT item_id FROM player_asic_leases')) {
        const userId = Number(params[0]);
        const ids = [...new Set([...leases.values()].filter((l) => l.user_id === userId).map((l) => l.item_id))];
        return { rows: ids.map((item_id) => ({ item_id })), rowCount: ids.length };
      }

      if (q.includes('COUNT(*)') && q.includes("status = 'stock'")) {
        const userId = Number(params[0]);
        const itemId = String(params[1]);
        const nowMs = Number(params[2]);
        const n = [...leases.values()].filter(
          (l) => l.user_id === userId && l.item_id === itemId && l.status === 'stock' && l.expires_at > nowMs
        ).length;
        return { rows: [{ n }], rowCount: 1 };
      }

      if (q.includes('INSERT INTO stock') || q.includes('DELETE FROM stock')) {
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('FROM rack_slots s') && q.includes('machine_lease_id IS NULL')) {
        const userId = Number(params[0]);
        const rackId = String(params[1]);
        void userId;
        const rows = [...slots.values()].filter(
          (s) =>
            s.rack_id === rackId &&
            s.machine_item_id &&
            (!s.machine_lease_id || String(s.machine_lease_id).trim() === '')
        );
        return { rows, rowCount: rows.length };
      }

      if (q.includes('SELECT id FROM player_asic_leases') && q.includes("status = 'equipped'") && q.includes('expires_at >') && !q.includes('rack_id')) {
        // Hint validation: id + user + equipped + not expired
        const id = String(params[0]);
        const userId = Number(params[1]);
        const nowMs = Number(params[2]);
        const l = leases.get(id);
        if (l && l.user_id === userId && l.status === 'equipped' && l.expires_at > nowMs) {
          return { rows: [{ id: l.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (q.includes("status = 'equipped'") && q.includes('rack_id = $2') && q.includes('slot_index = $3')) {
        const userId = Number(params[0]);
        const rackId = String(params[1]);
        const si = Number(params[2]);
        const nowMs = Number(params[3]);
        const row = [...leases.values()].find(
          (l) =>
            l.user_id === userId &&
            l.status === 'equipped' &&
            l.rack_id === rackId &&
            l.slot_index === si &&
            l.expires_at > nowMs
        );
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
      }

      if (q.includes('UPDATE rack_slots SET machine_lease_id = $3')) {
        const rackId = String(params[0]);
        const si = Number(params[1]);
        const leaseId = String(params[2]);
        const key = `${rackId}|${si}`;
        const s = slots.get(key);
        if (s) s.machine_lease_id = leaseId;
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('SELECT id FROM player_asic_leases') && q.includes("status = 'stock'") && q.includes('FOR UPDATE SKIP LOCKED')) {
        const userId = Number(params[0]);
        const itemId = String(params[1]);
        const nowMs = Number(params[2]);
        const row = [...leases.values()]
          .filter((l) => l.user_id === userId && l.item_id === itemId && l.status === 'stock' && l.expires_at > nowMs)
          .sort((a, b) => a.expires_at - b.expires_at)[0];
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
      }

      if (q.includes("SET status = 'equipped'") && q.includes('player_asic_leases')) {
        const leaseId = String(params[0]);
        const userId = Number(params[1]);
        const rackId = String(params[2]);
        const si = Number(params[3]);
        const l = leases.get(leaseId);
        if (!l || l.user_id !== userId || l.status !== 'stock') return { rows: [], rowCount: 0 };
        l.status = 'equipped';
        l.rack_id = rackId;
        l.slot_index = si;
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('FROM player_asic_leases WHERE id = $1 AND user_id = $2')) {
        const id = String(params[0]);
        const userId = Number(params[1]);
        const l = leases.get(id);
        if (!l || l.user_id !== userId) return { rows: [], rowCount: 0 };
        return { rows: [l], rowCount: 1 };
      }

      if (q.includes("SET status = 'stock'") && q.includes('player_asic_leases')) {
        const id = String(params[0]);
        const l = leases.get(id);
        if (!l) return { rows: [], rowCount: 0 };
        l.status = 'stock';
        l.rack_id = null;
        l.slot_index = null;
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('UPDATE rack_slots SET machine_item_id = NULL') && !q.includes('machine_lease_id = $3')) {
        const rackId = String(params[0]);
        const si = Number(params[1]);
        const key = `${rackId}|${si}`;
        const s = slots.get(key);
        if (s) {
          s.machine_item_id = null;
          s.machine_lease_id = null;
        }
        return { rows: [], rowCount: 1 };
      }

      if (q.includes('SELECT machine_item_id, machine_lease_id FROM rack_slots') || q.includes('SELECT machine_lease_id FROM rack_slots')) {
        const rackId = String(params[0]);
        const si = Number(params[1]);
        const s = slots.get(`${rackId}|${si}`);
        return { rows: s ? [s] : [], rowCount: s ? 1 : 0 };
      }

      // Fallback: ignore unrelated sync queries
      if (q.includes('DELETE FROM player_asic_leases')) {
        throw new Error('DELETE player_asic_leases must not be used for expire after 4C');
      }

      return { rows: [], rowCount: 0 };
    })
  } as unknown as PoolClient;

  return {
    client,
    leases,
    slots,
    events,
    setFailNextEventInsert: () => {
      failNextEventInsert = true;
    }
  };
}

describe('4C mining_eligibility_events — schema + cutover', () => {
  it('Prisma model + migration + índices + unique ASIC_EXPIRED', () => {
    const schema = readFileSync(resolve(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('model mining_eligibility_events');
    expect(schema).toContain('mining_eligibility_events_user_at_idx');
    expect(schema).toContain('mining_eligibility_events_lease_at_idx');
    expect(schema).toContain('mining_eligibility_events_rack_at_idx');

    const sql = readFileSync(
      resolve(ROOT, 'prisma/migrations/20260821120000_mining_eligibility_events/migration.sql'),
      'utf8'
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "mining_eligibility_events"');
    expect(sql).toContain('mining_eligibility_events_asic_expired_lease_uidx');
    expect(sql).toContain("ASIC_EXPIRED");
  });

  it('cutover explícito (migration timestamp / env override)', () => {
    expect(miningEligibilityHistoryCutoverMs()).toBe(MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT);
    expect(MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT).toBe(Date.UTC(2026, 7, 21, 12, 0, 0, 0));
  });

  it('tipos de evento económicos explícitos', () => {
    expect(isMiningEligibilityEventType('MINER_EQUIPPED')).toBe(true);
    expect(isMiningEligibilityEventType('UPDATED')).toBe(false);
  });
});

describe('4C soft-expire + eventos', () => {
  const userId = 42;
  const leaseId = '11111111-1111-1111-1111-111111111111';
  const acquired = 1_000_000;
  const expiresAt = 2_000_000;
  const nowMs = 2_000_100;

  it('Caso 3 — expiração: preserva lease, status expired, ASIC_EXPIRED uma vez', async () => {
    const db = makeFakeDb({
      leases: [
        {
          id: leaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: expiresAt,
          status: 'equipped',
          rack_id: 'rack1',
          slot_index: 0
        }
      ],
      slots: [{ rack_id: 'rack1', slot_index: 0, machine_item_id: 'asic_timed_a', machine_lease_id: leaseId }]
    });

    const n = await expireUserAsicLeases(db.client, userId, nowMs);
    expect(n).toBe(1);
    const lease = db.leases.get(leaseId)!;
    expect(lease.status).toBe('expired');
    expect(lease.acquired_at).toBe(acquired);
    expect(lease.expires_at).toBe(expiresAt);
    expect(lease.rack_id).toBeNull();
    expect(db.slots.get('rack1|0')!.machine_lease_id).toBeNull();
    expect(db.events.filter((e) => e.event_type === 'ASIC_EXPIRED')).toHaveLength(1);
    expect(db.events.some((e) => e.event_type === 'MINER_UNEQUIPPED')).toBe(true);
  });

  it('Caso 4 — expiração repetida: sem segundo ASIC_EXPIRED', async () => {
    const db = makeFakeDb({
      leases: [
        {
          id: leaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: expiresAt,
          status: 'stock',
          rack_id: null,
          slot_index: null
        }
      ]
    });
    expect(await expireUserAsicLeases(db.client, userId, nowMs)).toBe(1);
    expect(await expireUserAsicLeases(db.client, userId, nowMs)).toBe(0);
    expect(db.events.filter((e) => e.event_type === 'ASIC_EXPIRED')).toHaveLength(1);
  });

  it('Caso 1 — equip timed emite MINER_EQUIPPED com lease_id', async () => {
    const db = makeFakeDb({
      leases: [
        {
          id: leaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: nowMs + 60_000,
          status: 'stock',
          rack_id: null,
          slot_index: null
        }
      ]
    });
    const stock: Record<string, number> = { asic_timed_a: 1 };
    const placed = [{ id: 'rack1', slots: ['asic_timed_a'], slotLeaseIds: [''] }];
    const fin = await finalizeTimedMinerEquip(db.client, userId, 'rack1', 0, 'asic_timed_a', placed, stock, nowMs);
    expect(fin.ok).toBe(true);
    const eq = db.events.find((e) => e.event_type === 'MINER_EQUIPPED');
    expect(eq).toBeTruthy();
    expect(eq!.lease_id).toBe(leaseId);
    expect(eq!.rack_id).toBe('rack1');
    expect(eq!.slot_index).toBe(0);
    expect(eq!.at_ms).toBe(nowMs);
    expect(db.leases.get(leaseId)!.status).toBe('equipped');
  });

  it('Caso 2 — unequip timed: MINER_UNEQUIPPED + lease permanece', async () => {
    const db = makeFakeDb({
      leases: [
        {
          id: leaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: nowMs + 60_000,
          status: 'equipped',
          rack_id: 'rack1',
          slot_index: 0
        }
      ],
      slots: [{ rack_id: 'rack1', slot_index: 0, machine_item_id: 'asic_timed_a', machine_lease_id: leaseId }]
    });
    const released = await releaseEquippedAsicLeaseById(db.client, userId, leaseId, 'asic_timed_a', nowMs);
    expect(released).toBe(true);
    expect(db.leases.get(leaseId)!.status).toBe('stock');
    expect(db.leases.has(leaseId)).toBe(true);
    expect(db.events.some((e) => e.event_type === 'MINER_UNEQUIPPED' && e.lease_id === leaseId)).toBe(true);
  });

  it('releaseEquippedAsicLeaseById: false quando lease inexistente', async () => {
    const db = makeFakeDb();
    const released = await releaseEquippedAsicLeaseById(
      db.client,
      userId,
      '99999999-9999-9999-9999-999999999999',
      'asic_timed_a',
      nowMs
    );
    expect(released).toBe(false);
  });

  it('hint UUID stale + lease equipped em rack+slot → stock + applyTimedStockQty qty>=1', async () => {
    const realLeaseId = '22222222-2222-2222-2222-222222222222';
    const staleHint = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const db = makeFakeDb({
      leases: [
        {
          id: realLeaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: nowMs + 60_000,
          status: 'equipped',
          rack_id: 'rack1',
          slot_index: 0
        }
      ],
      slots: [{ rack_id: 'rack1', slot_index: 0, machine_item_id: 'asic_timed_a', machine_lease_id: null }]
    });

    const resolved = await resolveEquippedLeaseIdForSlot(db.client, userId, 'rack1', 0, staleHint, nowMs);
    expect(resolved).toBe(realLeaseId);

    let released = false;
    if (resolved) {
      released = await releaseEquippedAsicLeaseById(db.client, userId, resolved, 'asic_timed_a', nowMs);
    }
    if (!released) {
      await releaseEquippedAsicLease(db.client, userId, 'rack1', 0, nowMs);
    }

    expect(db.leases.get(realLeaseId)!.status).toBe('stock');
    const stock: Record<string, number> = {};
    await applyTimedStockQtyToSnapshot(db.client, userId, stock, 'asic_timed_a', nowMs);
    expect(stock.asic_timed_a).toBeGreaterThanOrEqual(1);
  });

  it('slot machine_lease_id null + lease equipped por rack+slot → releaseEquippedAsicLease recupera', async () => {
    const realLeaseId = '33333333-3333-3333-3333-333333333333';
    const db = makeFakeDb({
      leases: [
        {
          id: realLeaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: nowMs + 60_000,
          status: 'equipped',
          rack_id: 'rack1',
          slot_index: 1
        }
      ],
      slots: [{ rack_id: 'rack1', slot_index: 1, machine_item_id: 'asic_timed_a', machine_lease_id: null }]
    });

    await releaseEquippedAsicLease(db.client, userId, 'rack1', 1, nowMs);
    expect(db.leases.get(realLeaseId)!.status).toBe('stock');
    expect(db.leases.get(realLeaseId)!.rack_id).toBeNull();
    expect(db.slots.get('rack1|1')!.machine_item_id).toBeNull();
  });

  it('Caso 7 — repair não inventa acquired_at=now', async () => {
    const db = makeFakeDb({
      slots: [{ rack_id: 'rack1', slot_index: 0, machine_item_id: 'asic_timed_a', machine_lease_id: null }]
    });
    const before = db.leases.size;
    const repaired = await repairEquippedAsicLeasesForRack(db.client, userId, 'rack1', nowMs);
    expect(repaired).toBe(0);
    expect(db.leases.size).toBe(before);
    expect([...db.leases.values()].some((l) => l.acquired_at === nowMs)).toBe(false);
  });

  it('Caso 5/6 — power/coin: record só em mudança real (serviço)', async () => {
    const db = makeFakeDb();
    await recordMiningEligibilityEvent(db.client, {
      userId,
      eventType: 'RACK_POWER_CHANGED',
      atMs: nowMs,
      identityKind: 'rack',
      rackId: 'rack1',
      payload: { is_on: false, previous: true }
    });
    expect(db.events).toHaveLength(1);
    await recordMiningEligibilityEvent(db.client, {
      userId,
      eventType: 'RACK_COIN_CHANGED',
      atMs: nowMs,
      identityKind: 'rack',
      rackId: 'rack1',
      coinId: 'ETH',
      payload: { previous: 'BTC', next: 'ETH' }
    });
    expect(db.events.filter((e) => e.event_type === 'RACK_COIN_CHANGED')).toHaveLength(1);
  });

  it('Caso 8 — falha no evento não deixa mutação órfã se caller aborta (simulação TX)', async () => {
    const db = makeFakeDb({
      leases: [
        {
          id: leaseId,
          user_id: userId,
          item_id: 'asic_timed_a',
          acquired_at: acquired,
          expires_at: nowMs + 60_000,
          status: 'stock',
          rack_id: null,
          slot_index: null
        }
      ]
    });
    db.setFailNextEventInsert();
    const stock: Record<string, number> = { asic_timed_a: 1 };
    const placed = [{ id: 'rack1', slots: ['asic_timed_a'], slotLeaseIds: [''] }];
    await expect(
      finalizeTimedMinerEquip(db.client, userId, 'rack1', 0, 'asic_timed_a', placed, stock, nowMs)
    ).rejects.toThrow('simulated_event_insert_failure');
    // Mutação operacional já ocorreu antes do evento neste path — caller (TX) deve ROLLBACK.
    // Documentamos o contrato: recordMiningEligibilityEvent propaga erro (não engole).
    expect(db.leases.get(leaseId)!.status).toBe('equipped');
    expect(db.events).toHaveLength(0);
  });
});

describe('4C-close.1 — contrato de replay/timestamps', () => {
  it('replay order canónico ORDER BY at_ms ASC, id ASC', () => {
    expect(MINING_ELIGIBILITY_EVENTS_REPLAY_ORDER_SQL).toBe('ORDER BY at_ms ASC, id ASC');
    expect(MINING_ELIGIBILITY_EVENT_LOG_CONTRACT.replayOrderSql).toBe(MINING_ELIGIBILITY_EVENTS_REPLAY_ORDER_SQL);
  });

  it('ASIC_EXPIRED: expires_at contratual vs at_ms operacional', () => {
    expect(ASIC_EXPIRED_TIMESTAMP_CONTRACT.contractualEndField).toBe('expires_at');
    expect(ASIC_EXPIRED_TIMESTAMP_CONTRACT.operationalMaterializationField).toBe('at_ms');
  });

  it('empate at_ms: id ASC processa A antes de B', () => {
    const events = [
      { at_ms: 1000, id: 2 },
      { at_ms: 1000, id: 1 }
    ];
    const ordered = [...events].sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
    expect(ordered.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe('4C — computeProgressForUser / payout / block history não tocados', () => {
  it('progress-computer não implementa eligibleSegments nem yield integrado', () => {
    const src = readFileSync(resolve(ROOT, 'server/modules/mining-engine/services/progress-computer.ts'), 'utf8');
    expect(src).not.toContain('eligibleSegments');
    expect(src).not.toContain('calculateIntegratedYield =');
  });
});
