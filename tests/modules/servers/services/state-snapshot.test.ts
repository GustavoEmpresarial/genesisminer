import { describe, expect, it } from 'vitest';
import { mapPrismaRacksToPlacedRackDtos } from '../../../../server/modules/servers/services/state-snapshot.js';

describe('mapPrismaRacksToPlacedRackDtos', () => {
  it('monta slots/multiplierSlots por rack a partir das listas separadas', () => {
    const rackRows = [
      {
        id: 'r1',
        item_id: 'rack04',
        wiring_id: 'wiring_x',
        battery_id: 'battery_estelar',
        is_on: 1,
        selected_coin_id: 'btc',
        room_id: null,
        slot_index: 2,
        battery_catalog_item_id: 'small_battery',
        battery_display_name: 'Bateria',
        battery_image_url: 'img.png'
      }
    ];
    const slotsList = [{ rack_id: 'r1', slot_index: 0, machine_item_id: 'gpu_x', machine_lease_id: 'lease-1' }];
    const multipliersList = [{ rack_id: 'r1', slot_index: 0, multiplier_item_id: 'chip_x' }];
    const out = mapPrismaRacksToPlacedRackDtos(rackRows, slotsList, multipliersList);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'r1',
      itemId: 'rack04',
      slots: ['gpu_x'],
      slotLeaseIds: ['lease-1'],
      multiplierSlots: ['chip_x'],
      roomId: 'room_initial',
      isOn: true,
      batteryCatalogItemId: 'battery_estelar' // small_battery normalizado
    });
  });

  it('rig sem slots/multiplicadores devolve arrays vazios', () => {
    const out = mapPrismaRacksToPlacedRackDtos(
      [{ id: 'r2', item_id: 'rack04', wiring_id: null, battery_id: null, is_on: 0, selected_coin_id: null, room_id: 'room_x', slot_index: 0 }],
      [],
      []
    );
    expect(out[0]?.slots).toEqual([]);
    expect(out[0]?.multiplierSlots).toEqual([]);
    expect(out[0]?.roomId).toBe('room_x');
  });
});
