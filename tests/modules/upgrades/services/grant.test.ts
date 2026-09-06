import { beforeEach, describe, expect, it, vi } from 'vitest';

// Entrega de item de catálogo é HTTP no worker de hardware (`creditCatalogItemQtyInTx`);
// unit test corta nesse limite pra não depender de GENESIS_HARDWARE_URL.
const callHardwareCredit = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock('../../../../server/modules/hardware/services/hardware-client.js', () => ({ callHardwareCredit }));

import { expandAdminUpgradeBundleAsLootRewardsInTx, grantAdminUpgradeRewardsInTx, grantPassRewardsInTx, materializeUpgradePackageAsLootBoxInTx } from '../../../../server/modules/upgrades/services/grant.js';

beforeEach(() => {
  callHardwareCredit.mockClear();
});

function fakeTx(overrides: Record<string, any> = {}) {
  return {
    admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: 'pack_1', name: 'Pacote Founder', grant_usdc: 5 }) },
    loot_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
    admin_upgrade_items: { findMany: vi.fn().mockResolvedValue([{ item_id: 'gpu_1', qty: 2 }]) },
    admin_upgrade_coins: { findMany: vi.fn().mockResolvedValue([{ coin_id: 'btc', amount: 3 }]) },
    loot_box_items: { deleteMany: vi.fn().mockResolvedValue(undefined), createMany: vi.fn().mockResolvedValue(undefined) },
    unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
    ...overrides
  } as any;
}

describe('materializeUpgradePackageAsLootBoxInTx', () => {
  it('upgrade inexistente lança HttpControlledError 409 UPGRADE_NOT_FOUND', async () => {
    const tx = fakeTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(materializeUpgradePackageAsLootBoxInTx(tx, { userId: 1, upgradeId: 'nao_existe' })).rejects.toMatchObject({ statusCode: 409, jsonBody: expect.objectContaining({ code: 'UPGRADE_NOT_FOUND' }) });
  });

  it('cria a loot box com id derivado do upgrade e nome prefixado "Pacote "', async () => {
    const tx = fakeTx();
    const result = await materializeUpgradePackageAsLootBoxInTx(tx, { userId: 1, upgradeId: 'pack_1' });
    expect(result.boxId).toBe('upgrade_pkg_pack_1');
    expect(result.boxName).toBe('Pacote Pacote Founder');
    expect(tx.loot_boxes.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'upgrade_pkg_pack_1' }, create: expect.objectContaining({ is_active: 0, price: 0 }) })
    );
  });

  it('monta os drafts de loot_box_items: bundle + items + usdc + coins', async () => {
    const tx = fakeTx();
    await materializeUpgradePackageAsLootBoxInTx(tx, { userId: 1, upgradeId: 'pack_1' });
    const draftsArg = tx.loot_box_items.createMany.mock.calls[0][0].data;
    expect(draftsArg).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_type: 'bundle', item_id: 'pack_1' }),
        expect.objectContaining({ item_type: 'item', item_id: 'gpu_1', min_qty: 2, max_qty: 2 }),
        expect.objectContaining({ item_type: 'currency', item_id: 'usdc', min_qty: 5, max_qty: 5 }),
        expect.objectContaining({ item_type: 'coin', item_id: 'btc', min_qty: 3, max_qty: 3 })
      ])
    );
  });

  it('credita +1 em unopened_boxes pro utilizador (upsert com increment)', async () => {
    const tx = fakeTx();
    await materializeUpgradePackageAsLootBoxInTx(tx, { userId: 42, upgradeId: 'pack_1' });
    expect(tx.unopened_boxes.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id_box_id: { user_id: 42, box_id: 'upgrade_pkg_pack_1' } },
        update: { qty: { increment: 1 } }
      })
    );
  });

  it('sem grant_usdc/items/coins: só o draft bundle', async () => {
    const tx = fakeTx({
      admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: 'pack_2', name: '', grant_usdc: 0 }) },
      admin_upgrade_items: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_coins: { findMany: vi.fn().mockResolvedValue([]) }
    });
    const result = await materializeUpgradePackageAsLootBoxInTx(tx, { userId: 1, upgradeId: 'pack_2' });
    expect(result.boxName).toBe('Pacote pack_2');
    const draftsArg = tx.loot_box_items.createMany.mock.calls[0][0].data;
    expect(draftsArg).toHaveLength(1);
    expect(draftsArg[0]).toMatchObject({ item_type: 'bundle' });
  });
});

describe('grantPassRewardsInTx', () => {
  function fakePassTx(overrides: Record<string, any> = {}) {
    return {
      season_pass_rewards: { findMany: vi.fn().mockResolvedValue([]) },
      game_states: { updateMany: vi.fn().mockResolvedValue(undefined) },
      coin_balances: { upsert: vi.fn().mockResolvedValue(undefined) },
      stock: { upsert: vi.fn().mockResolvedValue(undefined) },
      loot_boxes: { findMany: vi.fn().mockResolvedValue([]) },
      unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
      upgrades: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'gpu_1',
          type: 'item',
          power_capacity: 0,
          name: 'GPU',
          image: null
        })
      },
      ...overrides
    } as any;
  }

  it('credita USDC, moedas e itens do pass, e caixas cujo trigger bate com pass_id ou season:<id>', async () => {
    const tx = fakePassTx({
      season_pass_rewards: {
        findMany: vi.fn().mockResolvedValue([
          { type: 'currency', coin_id: 'usdc', qty: 10, item_id: null },
          { type: 'currency', coin_id: 'btc', qty: 2, item_id: null },
          { type: 'item', coin_id: null, item_id: 'gpu_1', qty: 3 }
        ])
      },
      loot_boxes: { findMany: vi.fn().mockResolvedValue([{ id: 'box_pass_1' }]) }
    });
    await grantPassRewardsInTx(tx, 1, 'pass_1', 'season_2026');
    expect(tx.game_states.updateMany).toHaveBeenCalledWith({ where: { user_id: 1 }, data: { usdc: { increment: 10 } } });
    expect(tx.coin_balances.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id_coin_id: { user_id: 1, coin_id: 'btc' } } }));
    expect(callHardwareCredit).toHaveBeenCalledWith({ userId: 1, itemId: 'gpu_1', qty: 3 });
    expect(tx.unopened_boxes.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { user_id_box_id: { user_id: 1, box_id: 'box_pass_1' } } }));
  });

  it('sem recompensas configuradas: não escreve nada', async () => {
    const tx = fakePassTx();
    await grantPassRewardsInTx(tx, 1, 'pass_1', 'season_1');
    expect(tx.game_states.updateMany).not.toHaveBeenCalled();
    expect(tx.unopened_boxes.upsert).not.toHaveBeenCalled();
  });
});

describe('expandAdminUpgradeBundleAsLootRewardsInTx', () => {
  function fakeExpandTx(overrides: Record<string, any> = {}) {
    return {
      admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ grant_usdc: 5, grant_access_level_id: null }) },
      admin_upgrade_items: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_coins: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_boxes: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_passes: { findMany: vi.fn().mockResolvedValue([]) },
      ...overrides
    } as any;
  }

  it('multiplier 0: devolve lista vazia sem consultar a BD', async () => {
    const tx = fakeExpandTx();
    const out = await expandAdminUpgradeBundleAsLootRewardsInTx(tx, 'pack_1', 0);
    expect(out).toEqual([]);
    expect(tx.admin_upgrades.findUnique).not.toHaveBeenCalled();
  });

  it('upgrade inexistente: devolve lista vazia (não lança)', async () => {
    const tx = fakeExpandTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue(null) } });
    const out = await expandAdminUpgradeBundleAsLootRewardsInTx(tx, 'nope', 1);
    expect(out).toEqual([]);
  });

  it('multiplica qty por multiplier em cada tipo de recompensa', async () => {
    const tx = fakeExpandTx({
      admin_upgrade_items: { findMany: vi.fn().mockResolvedValue([{ item_id: 'gpu_1', qty: 2 }]) },
      admin_upgrade_coins: { findMany: vi.fn().mockResolvedValue([{ coin_id: 'btc', amount: 1 }]) },
      admin_upgrade_boxes: { findMany: vi.fn().mockResolvedValue([{ box_id: 'box_1', qty: 1 }]) },
      admin_upgrade_passes: { findMany: vi.fn().mockResolvedValue([{ pass_id: 'pass_1' }]) }
    });
    const out = await expandAdminUpgradeBundleAsLootRewardsInTx(tx, 'pack_1', 3);
    expect(out).toEqual(
      expect.arrayContaining([
        { type: 'currency', id: 'usdc', qty: 15 },
        { type: 'item', id: 'gpu_1', qty: 6 },
        { type: 'coin', id: 'btc', qty: 3 },
        { type: 'box', id: 'box_1', qty: 3 },
        { type: 'pass', id: 'pass_1', qty: 3 }
      ])
    );
  });

  it('inclui access_level como marcador qty=1 sempre (não multiplicado)', async () => {
    const tx = fakeExpandTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ grant_usdc: 0, grant_access_level_id: 'founder' }) } });
    const out = await expandAdminUpgradeBundleAsLootRewardsInTx(tx, 'pack_1', 5);
    expect(out).toContainEqual({ type: 'access_level', id: 'founder', qty: 1 });
  });
});

describe('grantAdminUpgradeRewardsInTx', () => {
  function fakeGrantTx(overrides: Record<string, any> = {}) {
    return {
      admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: 'pack_1', grant_usdc: 5, grant_access_level_id: null }) },
      game_states: { updateMany: vi.fn().mockResolvedValue(undefined) },
      admin_upgrade_coins: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_items: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_boxes: { findMany: vi.fn().mockResolvedValue([]) },
      admin_upgrade_passes: { findMany: vi.fn().mockResolvedValue([]) },
      coin_balances: { upsert: vi.fn().mockResolvedValue(undefined) },
      stock: { upsert: vi.fn().mockResolvedValue(undefined) },
      unopened_boxes: { upsert: vi.fn().mockResolvedValue(undefined) },
      season_passes: { findUnique: vi.fn().mockResolvedValue(null) },
      season_purchases: { createMany: vi.fn().mockResolvedValue(undefined) },
      season_pass_rewards: { findMany: vi.fn().mockResolvedValue([]) },
      users: { update: vi.fn().mockResolvedValue(undefined) },
      user_access_levels: { createMany: vi.fn().mockResolvedValue(undefined) },
      loot_boxes: { findMany: vi.fn().mockResolvedValue([]) },
      upgrades: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'gpu_1',
          type: 'item',
          power_capacity: 0,
          name: 'GPU',
          image: null
        })
      },
      user_rig_rooms: { createMany: vi.fn().mockResolvedValue(undefined) },
      rig_rooms: { findUnique: vi.fn().mockResolvedValue({ id: 'room_1765936323521' }) },
      ...overrides
    } as any;
  }

  it('upgrade inexistente lança HttpControlledError 409 UPGRADE_NOT_FOUND', async () => {
    const tx = fakeGrantTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(grantAdminUpgradeRewardsInTx(1, 'nope', tx)).rejects.toMatchObject({ statusCode: 409, jsonBody: expect.objectContaining({ code: 'UPGRADE_NOT_FOUND' }) });
  });

  it('credita USDC diretamente em game_states', async () => {
    const tx = fakeGrantTx();
    await grantAdminUpgradeRewardsInTx(1, 'pack_1', tx);
    expect(tx.game_states.updateMany).toHaveBeenCalledWith({ where: { user_id: 1 }, data: { usdc: { increment: 5 } } });
  });

  it('concede access_level: atualiza users e insere user_access_levels', async () => {
    const tx = fakeGrantTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: 'pack_1', grant_usdc: 0, grant_access_level_id: 'founder' }) } });
    await grantAdminUpgradeRewardsInTx(1, 'pack_1', tx);
    expect(tx.users.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { access_level_id: 'founder' } });
    expect(tx.user_access_levels.createMany).toHaveBeenCalled();
  });

  it('season pass: cria season_purchases e aplica grantPassRewardsInTx (via loot_boxes.findMany do pass)', async () => {
    const tx = fakeGrantTx({
      admin_upgrade_passes: { findMany: vi.fn().mockResolvedValue([{ pass_id: 'pass_1' }]) },
      season_passes: { findUnique: vi.fn().mockResolvedValue({ season_id: 'season_2026' }) }
    });
    await grantAdminUpgradeRewardsInTx(1, 'pack_1', tx);
    expect(tx.season_purchases.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ pass_id: 'pass_1', season_id: 'season_2026' })] }));
  });

  it('bundle Genesis: cria user_rig_rooms com a sala inicial', async () => {
    const GENESIS_ID = '53f0c699-0471-4e65-a147-17064e3aafe0';
    const tx = fakeGrantTx({ admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: GENESIS_ID, grant_usdc: 0, grant_access_level_id: null }) } });
    await grantAdminUpgradeRewardsInTx(1, GENESIS_ID, tx);
    expect(tx.user_rig_rooms.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ user_id: 1, room_id: 'room_1765936323521' })] }));
  });

  it('bundle não-Genesis: não mexe em user_rig_rooms', async () => {
    const tx = fakeGrantTx();
    await grantAdminUpgradeRewardsInTx(1, 'pack_1', tx);
    expect(tx.user_rig_rooms.createMany).not.toHaveBeenCalled();
  });

  it('bundle Genesis com sala inexistente na BD: loga aviso mas ainda cria o registo (não falha a concessão)', async () => {
    const GENESIS_ID = '53f0c699-0471-4e65-a147-17064e3aafe0';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tx = fakeGrantTx({
      admin_upgrades: { findUnique: vi.fn().mockResolvedValue({ id: GENESIS_ID, grant_usdc: 0, grant_access_level_id: null }) },
      rig_rooms: { findUnique: vi.fn().mockResolvedValue(null) }
    });
    await grantAdminUpgradeRewardsInTx(1, GENESIS_ID, tx);
    expect(tx.user_rig_rooms.createMany).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('genesis_bundle_room_missing'));
    errorSpy.mockRestore();
  });
});
