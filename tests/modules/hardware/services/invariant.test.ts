import { describe, expect, it } from 'vitest';
import { shouldExposeBatteryInInventoryWarehouse } from '../../../../server/modules/hardware/services/invariant.js';

describe('batteries services/invariant', () => {
  it('id vazio: skip', () => {
    const out = shouldExposeBatteryInInventoryWarehouse({ id: '', status: 'INVENTORY', location: 'WAREHOUSE' }, new Set());
    expect(out).toMatchObject({ ok: false, event: 'inventory_battery_skip' });
  });

  it('listada num rack montado: divergência', () => {
    const out = shouldExposeBatteryInInventoryWarehouse({ id: 'bat-1', status: 'INVENTORY', location: 'WAREHOUSE' }, new Set(['bat-1']));
    expect(out).toMatchObject({ ok: false, event: 'inventory_state_battery_divergence', reason: 'listed_on_placed_rack' });
  });

  it('status EQUIPPED: divergência', () => {
    const out = shouldExposeBatteryInInventoryWarehouse({ id: 'bat-1', status: 'EQUIPPED', location: null }, new Set());
    expect(out).toMatchObject({ ok: false, event: 'inventory_state_battery_divergence' });
  });

  it('status CONSUMED/LOCKED/BROKEN: bloqueada', () => {
    for (const st of ['CONSUMED', 'LOCKED', 'BROKEN']) {
      const out = shouldExposeBatteryInInventoryWarehouse({ id: 'bat-1', status: st, location: null }, new Set());
      expect(out).toMatchObject({ ok: false, event: 'inventory_state_battery_blocked' });
    }
  });

  it('rack_id/slot_id/room_id definidos em status INVENTORY: divergência', () => {
    expect(shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'INVENTORY', location: 'WAREHOUSE', rack_id: 'r1' }, new Set())).toMatchObject({ ok: false, reason: 'rack_id_on_inventory_semantics' });
    expect(shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'INVENTORY', location: 'WAREHOUSE', slot_id: 2 }, new Set())).toMatchObject({ ok: false, reason: 'slot_id_set' });
    expect(shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'INVENTORY', location: 'WAREHOUSE', room_id: 'room_1' }, new Set())).toMatchObject({ ok: false, reason: 'room_id_set' });
  });

  it('location fora de WAREHOUSE/INVENTORY: divergência', () => {
    const out = shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'INVENTORY', location: 'RACK' }, new Set());
    expect(out).toMatchObject({ ok: false, reason: 'location_not_warehouse' });
  });

  it('caminho feliz: status INVENTORY/vazio, sem rack, na WAREHOUSE', () => {
    expect(shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'INVENTORY', location: 'WAREHOUSE' }, new Set())).toEqual({ ok: true });
    expect(shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: '', location: '' }, new Set())).toEqual({ ok: true });
  });

  it('status desconhecido: divergência', () => {
    const out = shouldExposeBatteryInInventoryWarehouse({ id: 'b1', status: 'WEIRD', location: null }, new Set());
    expect(out).toMatchObject({ ok: false, reason: 'unknown_status_WEIRD' });
  });
});
