/**
 * Picker / affinity de chassis vs salas.
 *
 * `rack_army` (BD: affinity `asic`) = só Sala ASICs.
 * Chassis sem campo = `standard` (Prisma default; só sala normal, NÃO Sala ASICs).
 * `'asic+standard'` explícito = salas normais + Sala ASICs.
 * `'standard'` explícito = só sala normal.
 */
import { describe, expect, it } from 'vitest';
import { listItemsForSelection } from '../../../client/src/features/servers/models/serverRoomModel.js';
import {
  ASIC_ROOM_ID,
  NFT_AUTO_ALLOWED_CHASSIS_ID,
  NFT_AUTO_ROOM_ID,
  isChassisAllowedForRoomAffinity,
  resolveChassisRackRoomAffinity,
  resolveClientRoomKind,
  type Upgrade
} from '../../../client/src/features/servers/types.js';

const ASIC_ROOM = {
  type: 'rack' as const,
  rackId: null,
  slotIndex: 0,
  roomId: ASIC_ROOM_ID,
  roomName: 'SALA DAS ASICS'
};

const STANDARD_ROOM = {
  type: 'rack' as const,
  rackId: null,
  slotIndex: 0,
  roomId: 'room_initial',
  roomName: 'Sala inicial'
};

const NFT_ROOM = {
  type: 'rack' as const,
  rackId: null,
  slotIndex: 0,
  roomId: NFT_AUTO_ROOM_ID,
  roomName: 'SALA NFTs'
};

function chassis(id: string, affinity?: Upgrade['rackRoomAffinity']): Upgrade {
  return {
    id,
    name: id,
    category: 'infrastructure',
    type: 'infrastructure',
    baseCost: 0,
    baseProduction: 0,
    description: '',
    icon: '',
    status: 'limited',
    slotsCapacity: 6,
    aiSlotsCapacity: 1,
    ...(affinity ? { rackRoomAffinity: affinity } : {})
  };
}

describe('resolveClientRoomKind', () => {
  it('Sala ASICs canónica → asic (sem roomKind da API)', () => {
    expect(resolveClientRoomKind({ roomId: ASIC_ROOM_ID, roomName: 'SALA DAS ASICS' })).toBe('asic');
  });

  it('id ASIC bate roomKind API standard (servidor só envia standard|nft)', () => {
    expect(resolveClientRoomKind({ roomId: ASIC_ROOM_ID, roomKind: 'standard' })).toBe('asic');
  });
});

describe('Rack Army só na Sala ASICs', () => {
  it('fallback por id (API sem affinity) → asic only', () => {
    const affinity = resolveChassisRackRoomAffinity('rack_army', undefined);
    expect(affinity).toBe('asic');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(true);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'nft')).toBe(false);
  });

  it('affinity asic da BD → só Sala ASICs', () => {
    const affinity = resolveChassisRackRoomAffinity('rack_army', 'asic');
    expect(affinity).toBe('asic');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(true);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'nft')).toBe(false);
  });

  it('picker: rack_army em stock só na Sala ASICs', () => {
    const upgrades = [chassis('rack_army', 'asic')];
    const stock = { rack_army: 1 };
    const asicIds = listItemsForSelection(ASIC_ROOM, [], upgrades, stock).map((u) => u.id);
    const stdIds = listItemsForSelection(STANDARD_ROOM, [], upgrades, stock).map((u) => u.id);
    const nftIds = listItemsForSelection(NFT_ROOM, [], upgrades, stock).map((u) => u.id);
    expect(asicIds).toEqual(['rack_army']);
    expect(stdIds).toEqual([]);
    expect(nftIds).toEqual([]);
  });

  it('picker: standard explícito só na sala normal', () => {
    const upgrades = [chassis('rack04', 'standard')];
    const stock = { rack04: 1 };
    const asicIds = listItemsForSelection(ASIC_ROOM, [], upgrades, stock).map((u) => u.id);
    const stdIds = listItemsForSelection(STANDARD_ROOM, [], upgrades, stock).map((u) => u.id);
    expect(asicIds).toEqual([]);
    expect(stdIds).toEqual(['rack04']);
  });

  it('picker: asic+standard entra na Sala ASICs e na sala normal', () => {
    const upgrades = [chassis('rack04', 'asic+standard')];
    const stock = { rack04: 1 };
    const asicIds = listItemsForSelection(ASIC_ROOM, [], upgrades, stock).map((u) => u.id);
    const stdIds = listItemsForSelection(STANDARD_ROOM, [], upgrades, stock).map((u) => u.id);
    expect(asicIds).toEqual(['rack04']);
    expect(stdIds).toEqual(['rack04']);
  });

  it('chassis sem campo (fallback) é standard only — NÃO entra na Sala ASICs', () => {
    const affinity = resolveChassisRackRoomAffinity('rack04', undefined);
    expect(affinity).toBe('standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it("'standard' explícito não entra na Sala ASICs", () => {
    const affinity = resolveChassisRackRoomAffinity('rack04', 'standard');
    expect(affinity).toBe('standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it("'asic+standard' entra na Sala ASICs e na sala normal", () => {
    const affinity = resolveChassisRackRoomAffinity('rack04', 'asic+standard');
    expect(affinity).toBe('asic+standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(true);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it('chassis NFT exclusivo não entra na Sala ASICs sem affinity asic+nft', () => {
    const affinity = resolveChassisRackRoomAffinity(NFT_AUTO_ALLOWED_CHASSIS_ID, undefined);
    expect(affinity).toBe('nft');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'nft')).toBe(true);
  });
});

describe('Rack A3 só sala normal', () => {
  it('fallback por id → standard only', () => {
    const affinity = resolveChassisRackRoomAffinity('rack_a63', undefined);
    expect(affinity).toBe('standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'nft')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it("affinity 'asic+standard' na BD ainda força standard", () => {
    const affinity = resolveChassisRackRoomAffinity('rack_a63', 'asic+standard');
    expect(affinity).toBe('standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it('merge rack_a63 → standard', () => {
    const affinity = resolveChassisRackRoomAffinity('merge_rack_a63_uncommon_b038fa6415', undefined);
    expect(affinity).toBe('standard');
    expect(isChassisAllowedForRoomAffinity(affinity, 'asic')).toBe(false);
    expect(isChassisAllowedForRoomAffinity(affinity, 'standard')).toBe(true);
  });

  it('picker: rack_a63 só na sala inicial, não na Sala ASICs', () => {
    const upgrades = [chassis('rack_a63', 'asic+standard')];
    const stock = { rack_a63: 1 };
    const asicIds = listItemsForSelection(ASIC_ROOM, [], upgrades, stock).map((u) => u.id);
    const stdIds = listItemsForSelection(STANDARD_ROOM, [], upgrades, stock).map((u) => u.id);
    expect(asicIds).toEqual([]);
    expect(stdIds).toEqual(['rack_a63']);
  });

  it("rack_a634 / merge A4 não herdam override standard do A3", () => {
    expect(resolveChassisRackRoomAffinity('rack_a634', 'asic+standard')).toBe('asic+standard');
    expect(
      resolveChassisRackRoomAffinity('merge_rack_a634_uncommon_04a8b38ae4', 'asic+standard')
    ).toBe('asic+standard');
  });
});

describe('máquina ASIC só na Sala ASICs (picker)', () => {
  function machine(id: string, category: string): Upgrade {
    return {
      id,
      name: id,
      category,
      type: 'machine',
      baseCost: 0,
      baseProduction: 1,
      description: '',
      icon: '',
      status: 'normal',
      nftMiningCoinId: category.includes('nft') ? 'gemt' : category.includes('asic') ? 'usdc_interno' : null
    };
  }

  const MACHINE_SEL = {
    type: 'machine' as const,
    rackId: 'r1',
    slotIndex: 0
  };

  it('Sala ASICs: só asic_*; sala normal e NFT: sem asic_*', () => {
    const upgrades = [
      machine('asic_dolar_f2p', 'asic'),
      machine('gpu_x', 'gpu'),
      machine('nft_gemt_1', 'nft')
    ];
    const stock = { asic_dolar_f2p: 1, gpu_x: 1, nft_gemt_1: 1 };
    const rack = {
      id: 'r1',
      itemId: 'rack04',
      slots: [''],
      multiplierSlots: [],
      wiringId: null,
      batteryId: null,
      isOn: false,
      selectedCoinId: null,
      roomId: ASIC_ROOM_ID,
      slotIndex: 0
    };

    const asicIds = listItemsForSelection(
      { ...MACHINE_SEL, roomId: ASIC_ROOM_ID, roomName: 'SALA DAS ASICS' },
      [rack],
      upgrades,
      stock
    ).map((u) => u.id);
    const stdIds = listItemsForSelection(
      { ...MACHINE_SEL, roomId: 'room_initial', roomName: 'Sala' },
      [{ ...rack, roomId: 'room_initial' }],
      upgrades,
      stock
    ).map((u) => u.id);
    const nftIds = listItemsForSelection(
      { ...MACHINE_SEL, roomId: NFT_AUTO_ROOM_ID, roomName: 'SALA NFTs' },
      [{ ...rack, roomId: NFT_AUTO_ROOM_ID }],
      upgrades,
      stock
    ).map((u) => u.id);

    expect(asicIds).toEqual(['asic_dolar_f2p']);
    expect(stdIds).toEqual(['gpu_x']);
    expect(nftIds).toEqual(['nft_gemt_1']);
  });
});
