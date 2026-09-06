import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cobre especificamente a correção do gap documentado em DECISIONS.md: quando o
 * caller omite `stock`, a recuperação automática de componentes "evaporados" só
 * detectava rigs INTEIRAMENTE removidas. Reduzir os slots de uma rig que continua
 * a existir (sem enviar `stock`) fazia o item sumir — nem voltava ao stock, nem
 * ficava na rig — porque o DELETE+INSERT de `rack_slots`/`rack_multiplier_slots`
 * substituía o conjunto antigo pelo novo sem comparar item a item.
 */
describe('modules/hardware/services/persistence — recuperação de stock em rig mantida', () => {
  let client: { query: ReturnType<typeof vi.fn> };
  let asicLeaseMock: Record<string, any>;
  let semanticSyncMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();

    asicLeaseMock = {
      reconcileTimedAsicStockLeases: vi.fn().mockResolvedValue(undefined),
      releaseAllEquippedLeasesOnRack: vi.fn().mockResolvedValue(undefined),
      // Nenhum item do cenário de teste é ASIC com validade — nunca é "timed".
      loadAsicDurationConfig: vi.fn().mockResolvedValue({ amount: 0, unit: null }),
      isTimedAsicDuration: vi.fn().mockReturnValue(false)
    };
    semanticSyncMock = { syncStoredBatterySemanticsForUser: vi.fn().mockResolvedValue(undefined) };

    vi.doMock('../../../../server/modules/mining-engine/services/asic-lease.js', () => asicLeaseMock);
    vi.doMock('../../../../server/modules/hardware/services/semantic-sync.js', () => semanticSyncMock);

    client = {
      query: vi.fn(async (sqlRaw: string, _params?: unknown[]) => {
        const sql = String(sqlRaw);

        // --- recuperação (applyDismantledRacksStockRecoveryWhenStockOmitted) ---
        if (sql.includes('SELECT id, item_id, wiring_id, battery_id FROM placed_racks WHERE user_id = $1')) {
          return {
            rows: [{ id: 'rack1', item_id: 'chassis1', wiring_id: 'wire1', battery_id: null }]
          };
        }
        if (sql.includes('FROM rack_slots WHERE rack_id = $1 AND machine_item_id IS NOT NULL')) {
          // BD tinha 2× gpu_a montado nos slots de máquina desta rig.
          return { rows: [{ machine_item_id: 'gpu_a' }, { machine_item_id: 'gpu_a' }] };
        }
        if (sql.includes('FROM rack_multiplier_slots WHERE rack_id = $1 AND multiplier_item_id IS NOT NULL')) {
          return { rows: [{ multiplier_item_id: 'mult_x' }] };
        }
        if (sql.includes('SELECT item_id, qty FROM stock WHERE user_id = $1 AND item_id = ANY($2::text[])')) {
          // Sem stock prévio destes itens — base 0 para todos.
          return { rows: [] };
        }

        // --- releaseLeasesForRemovedPlacedRacks: mesmo user, só coluna id ---
        if (sql.trim().startsWith('SELECT id FROM placed_racks WHERE user_id = $1')) {
          return { rows: [{ id: 'rack1' }] };
        }

        // --- resto do corpo de persistStockStoredBatteriesPlacedRacks: valores
        // genéricos vazios bastam, não são o alvo desta asserção. ---
        return { rows: [], rowCount: 0 };
      })
    };
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/mining-engine/services/asic-lease.js');
    vi.doUnmock('../../../../server/modules/hardware/services/semantic-sync.js');
  });

  it('rig mantida com 1 GPU a menos, fiação removida e multiplicador removido: tudo volta ao stock', async () => {
    const { persistStockStoredBatteriesPlacedRacks } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    const changes: { placedRacks: unknown[]; stock?: Record<string, number> } = {
      placedRacks: [
        {
          id: 'rack1',
          itemId: 'chassis1',
          slots: ['gpu_a'], // era 2× gpu_a, agora só 1×
          multiplierSlots: [], // era 1× mult_x, agora nenhum
          wiringId: null, // era 'wire1', agora nenhuma fiação
          batteryId: null,
          isOn: true,
          selectedCoinId: null,
          roomId: 'room_initial',
          slotIndex: 0
        }
      ]
      // `stock` omitido de propósito — aciona o caminho de recuperação automática.
    };

    await persistStockStoredBatteriesPlacedRacks(client as any, 1, changes as any, []);

    // O item retirado do meio da rig (1× gpu_a a mais que o novo estado), a fiação
    // removida e o multiplicador removido devem ter voltado ao stock — nenhum se perde.
    expect(changes.stock).toEqual({ gpu_a: 1, wire1: 1, mult_x: 1 });
  });

  it('rig mantida sem nenhuma mudança de slots/fiação: não inventa recuperação nenhuma', async () => {
    const { persistStockStoredBatteriesPlacedRacks } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    const changes: { placedRacks: unknown[]; stock?: Record<string, number> } = {
      placedRacks: [
        {
          id: 'rack1',
          itemId: 'chassis1',
          slots: ['gpu_a', 'gpu_a'], // mesma contagem que a BD tinha
          multiplierSlots: ['mult_x'], // idem
          wiringId: 'wire1', // idem
          batteryId: null,
          isOn: true,
          selectedCoinId: null,
          roomId: 'room_initial',
          slotIndex: 0
        }
      ]
    };

    await persistStockStoredBatteriesPlacedRacks(client as any, 1, changes as any, []);

    // `applyDismantledRacksStockRecoveryWhenStockOmitted` só define `changes.stock`
    // se houver algo a recuperar; sem diferença nenhuma, não mexe no campo (fica
    // `undefined`, como veio).
    expect(changes.stock).toBeUndefined();
  });
});

describe('modules/hardware/services/persistence — ensureMountedStoredBatteriesForUser', () => {
  it('INSERT ... SELECT materializa UUID montado sem row em stored_batteries', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const { ensureMountedStoredBatteriesForUser } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    await ensureMountedStoredBatteriesForUser({ query } as any, 42);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toMatch(/INSERT INTO stored_batteries/i);
    expect(String(sql)).toMatch(/ON CONFLICT \(id\) DO NOTHING/i);
    expect(String(sql)).toMatch(/'EQUIPPED'/);
    expect(String(sql)).toMatch(/'RACK'/);
    expect(String(sql)).toMatch(/NOT EXISTS \(SELECT 1 FROM stored_batteries/i);
    expect(String(sql)).toMatch(/btrim\(pr\.battery_catalog_item_id\) <> ''/);
    expect(params).toEqual([42, expect.any(String)]);
  });

  it('uid inválido: no-op sem query', async () => {
    const query = vi.fn();
    const { ensureMountedStoredBatteriesForUser } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    await ensureMountedStoredBatteriesForUser({ query } as any, 0);
    await ensureMountedStoredBatteriesForUser({ query } as any, -1);
    expect(query).not.toHaveBeenCalled();
  });

  it('persist com placedRacks chama ensure antes do semantic sync', async () => {
    vi.resetModules();
    const asicLeaseMock = {
      reconcileTimedAsicStockLeases: vi.fn().mockResolvedValue(undefined),
      releaseAllEquippedLeasesOnRack: vi.fn().mockResolvedValue(undefined),
      loadAsicDurationConfig: vi.fn().mockResolvedValue({ amount: 0, unit: null }),
      isTimedAsicDuration: vi.fn().mockReturnValue(false)
    };
    const semanticSyncMock = { syncStoredBatterySemanticsForUser: vi.fn().mockResolvedValue(undefined) };
    vi.doMock('../../../../server/modules/mining-engine/services/asic-lease.js', () => asicLeaseMock);
    vi.doMock('../../../../server/modules/hardware/services/semantic-sync.js', () => semanticSyncMock);

    const callOrder: string[] = [];
    const client = {
      query: vi.fn(async (sqlRaw: string) => {
        const sql = String(sqlRaw);
        if (sql.includes('INSERT INTO stored_batteries') && sql.includes('EQUIPPED') && sql.includes('FROM placed_racks pr')) {
          callOrder.push('ensure');
        }
        if (sql.includes('SELECT id, item_id, wiring_id, battery_id, is_on')) {
          return { rows: [] };
        }
        if (sql.trim().startsWith('SELECT id FROM placed_racks WHERE user_id = $1')) {
          return { rows: [] };
        }
        if (sql.includes('FROM rack_slots') || sql.includes('FROM rack_multiplier_slots')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO placed_racks')) {
          callOrder.push('upsert_racks');
        }
        return { rows: [], rowCount: 0 };
      })
    };

    const { persistStockStoredBatteriesPlacedRacks } = await import(
      '../../../../server/modules/hardware/services/persistence.js'
    );

    const batUuid = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    await persistStockStoredBatteriesPlacedRacks(
      client as any,
      7,
      {
        stock: {},
        stockMode: 'snapshot',
        storedBatteries: [],
        placedRacks: [
          {
            id: 'rack-orphan',
            itemId: 'chassis1',
            slots: [],
            multiplierSlots: [],
            wiringId: null,
            batteryId: batUuid,
            batteryCatalogItemId: 'battery_estelar',
            batteryDisplayName: 'Estelar',
            batteryImageUrl: null,
            isOn: true,
            selectedCoinId: null,
            roomId: 'room_initial',
            slotIndex: 0
          }
        ]
      } as any,
      []
    );

    expect(callOrder).toContain('upsert_racks');
    expect(callOrder).toContain('ensure');
    expect(callOrder.indexOf('ensure')).toBeGreaterThan(callOrder.indexOf('upsert_racks'));
    expect(semanticSyncMock.syncStoredBatterySemanticsForUser).toHaveBeenCalledWith(client, 7);

    vi.doUnmock('../../../../server/modules/mining-engine/services/asic-lease.js');
    vi.doUnmock('../../../../server/modules/hardware/services/semantic-sync.js');
  });
});
