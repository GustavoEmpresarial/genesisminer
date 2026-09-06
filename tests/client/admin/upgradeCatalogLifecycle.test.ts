/**
 * UX retired no AdminEditor (Tarefa 5) — filtros, badge, retire/reativar, identidade.
 */
import { describe, expect, it } from 'vitest';
import { applyAdminCatalogItemSave } from '../../../client/src/features/admin/lib/upgradeCatalogIds.js';
import {
  UPGRADE_STATUS_RETIRED,
  applyAdminCatalogLifecycleSave,
  applyUpgradeReactivateState,
  applyUpgradeRetireState,
  filterAdminEditableUpgrades,
  filterUpgradesByLifecycle,
  isAdminCatalogProtectedUpgrade,
  isUpgradeRetired
} from '../../../client/src/features/admin/lib/upgradeCatalogLifecycle.js';

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  category: 'gpu',
  type: 'machine',
  baseCost: 1,
  baseProduction: 1,
  description: 'd',
  status: 'normal' as const,
  isActive: true,
  sellInHardwareMarket: true,
  sellInBlackMarket: true,
  ...extra
});

describe('upgradeCatalogLifecycle — UX retired (T5)', () => {
  const catalog = [
    base('gpu_v1'),
    base('merge_gpu_v1_uncommon_abc'),
    base('old_chip', { status: UPGRADE_STATUS_RETIRED, isActive: false, sellInHardwareMarket: false, sellInBlackMarket: false }),
    base('temp_legacy_1_rally', { category: 'legacy-temp', type: 'legacy-temp' }),
    base('ghost', { category: 'legacy-temp', type: 'legacy-temp' })
  ];

  it('1) ativo aparece em Ativos', () => {
    const active = filterUpgradesByLifecycle(catalog, 'active');
    expect(active.map((u) => u.id)).toContain('gpu_v1');
    expect(active.map((u) => u.id)).toContain('merge_gpu_v1_uncommon_abc');
    expect(active.every((u) => !isUpgradeRetired(u))).toBe(true);
  });

  it('2) retired aparece em Retirados', () => {
    const retired = filterUpgradesByLifecycle(catalog, 'retired');
    expect(retired.map((u) => u.id)).toEqual(['old_chip']);
  });

  it('3) filtro Todos não mostra protegidos', () => {
    const all = filterUpgradesByLifecycle(catalog, 'all');
    expect(all.every((u) => !isAdminCatalogProtectedUpgrade(u))).toBe(true);
    expect(all.map((u) => u.id)).not.toContain('temp_legacy_1_rally');
    expect(all.map((u) => u.id)).not.toContain('ghost');
    expect(filterAdminEditableUpgrades(catalog).map((u) => u.id)).toEqual([
      'gpu_v1',
      'merge_gpu_v1_uncommon_abc',
      'old_chip'
    ]);
  });

  it('4) retired é detectável para badge (status canónico)', () => {
    expect(isUpgradeRetired(catalog.find((u) => u.id === 'old_chip')!)).toBe(true);
    expect(isUpgradeRetired(base('gpu_v1'))).toBe(false);
  });

  it('5) abrir retired preserva id (editingSourceId / apply save)', () => {
    const retired = catalog.find((u) => u.id === 'old_chip')!;
    const { upgrades, lockedId } = applyAdminCatalogItemSave({
      gameUpgrades: filterAdminEditableUpgrades(catalog),
      editingSourceId: retired.id,
      itemForm: { ...retired, name: 'Renamed display', id: 'SHOULD_NOT_APPLY' }
    });
    expect(lockedId).toBe('old_chip');
    expect(upgrades.filter((u) => u.id === 'old_chip')).toHaveLength(1);
    expect(upgrades.find((u) => u.id === 'old_chip')?.name).toBe('Renamed display');
  });

  it('6) alterar id no formulário não muda payload (lock)', () => {
    const { upgrades, lockedId } = applyAdminCatalogItemSave({
      gameUpgrades: [base('gpu_v1')],
      editingSourceId: 'gpu_v1',
      itemForm: { ...base('gpu_v1'), id: 'gpu_v1_HACKED', name: 'X' }
    });
    expect(lockedId).toBe('gpu_v1');
    expect(upgrades.map((u) => u.id)).toEqual(['gpu_v1']);
    expect(upgrades.some((u) => u.id === 'gpu_v1_HACKED')).toBe(false);
  });

  it('7) reativação preserva exactamente o mesmo id', () => {
    const { upgrades, lockedId } = applyAdminCatalogLifecycleSave({
      gameUpgrades: filterAdminEditableUpgrades(catalog),
      targetId: 'old_chip',
      mode: 'reactivate'
    });
    expect(lockedId).toBe('old_chip');
    const row = upgrades.find((u) => u.id === 'old_chip')!;
    expect(row.status).toBe('normal');
    expect(row.isActive).toBe(true);
    expect(row.sellInHardwareMarket).toBe(true);
    expect(row.sellInBlackMarket).toBe(true);
  });

  it('8) reativação não cria segundo item', () => {
    const editable = filterAdminEditableUpgrades(catalog);
    const before = editable.length;
    const { upgrades } = applyAdminCatalogLifecycleSave({
      gameUpgrades: editable,
      targetId: 'old_chip',
      mode: 'reactivate'
    });
    expect(upgrades.length).toBe(before);
    expect(upgrades.filter((u) => u.id === 'old_chip')).toHaveLength(1);
  });

  it('9) retire não cria novo id', () => {
    const editable = filterAdminEditableUpgrades(catalog);
    const beforeIds = editable.map((u) => u.id).sort();
    const { upgrades, lockedId } = applyAdminCatalogLifecycleSave({
      gameUpgrades: editable,
      targetId: 'gpu_v1',
      mode: 'retire'
    });
    expect(lockedId).toBe('gpu_v1');
    expect(upgrades.map((u) => u.id).sort()).toEqual(beforeIds);
    expect(isUpgradeRetired(upgrades.find((u) => u.id === 'gpu_v1')!)).toBe(true);
  });

  it('10) retire/reativar usam o mesmo save path (sem previousId)', () => {
    const { upgrades } = applyAdminCatalogLifecycleSave({
      gameUpgrades: filterAdminEditableUpgrades(catalog),
      targetId: 'gpu_v1',
      mode: 'retire'
    });
    for (const u of upgrades) {
      expect(Object.prototype.hasOwnProperty.call(u, 'previousId')).toBe(false);
    }
  });

  it('11) OCC permanece no fluxo AdminPanel (setUpgrades + expectedCatalogRevision) — lifecycle só muta array local', () => {
    // Contrato: lifecycle devolve upgrades; persistGameUpgrades(upgrades) envia revision (T4).
    const { upgrades } = applyAdminCatalogLifecycleSave({
      gameUpgrades: [base('gpu_v1')],
      targetId: 'gpu_v1',
      mode: 'retire'
    });
    expect(Array.isArray(upgrades)).toBe(true);
    expect(upgrades[0].id).toBe('gpu_v1');
  });

  it('12) merge_* continua editável / reactivável', () => {
    const editable = filterAdminEditableUpgrades(catalog);
    expect(editable.some((u) => u.id.startsWith('merge_'))).toBe(true);
    const retiredMerge = applyUpgradeRetireState(editable.find((u) => u.id.startsWith('merge_'))!);
    const { upgrades, lockedId } = applyAdminCatalogLifecycleSave({
      gameUpgrades: editable.map((u) => (u.id === retiredMerge.id ? retiredMerge : u)),
      targetId: retiredMerge.id,
      mode: 'reactivate'
    });
    expect(lockedId).toBe(retiredMerge.id);
    expect(isUpgradeRetired(upgrades.find((u) => u.id === retiredMerge.id)!)).toBe(false);
  });

  it('13) temp_legacy_* / legacy-temp não aparecem como editáveis', () => {
    expect(isAdminCatalogProtectedUpgrade(base('temp_legacy_9_x'))).toBe(true);
    expect(isAdminCatalogProtectedUpgrade(base('x', { category: 'legacy-temp', type: 'legacy-temp' }))).toBe(
      true
    );
    expect(() =>
      applyAdminCatalogLifecycleSave({
        gameUpgrades: catalog,
        targetId: 'temp_legacy_1_rally',
        mode: 'retire'
      })
    ).toThrow(/protegido/i);
  });

  it('helpers retire/reactivate espelham campos do soft-retire BE', () => {
    const retired = applyUpgradeRetireState(base('gpu_v1', { status: 'limited' }));
    expect(retired).toMatchObject({
      id: 'gpu_v1',
      status: 'retired',
      isActive: false,
      sellInHardwareMarket: false,
      sellInBlackMarket: false
    });
    const back = applyUpgradeReactivateState(retired);
    expect(back).toMatchObject({
      id: 'gpu_v1',
      status: 'normal',
      isActive: true,
      sellInHardwareMarket: true,
      sellInBlackMarket: true
    });
  });
});
