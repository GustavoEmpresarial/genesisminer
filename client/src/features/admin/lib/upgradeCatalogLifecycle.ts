/**
 * Lifecycle admin do catálogo editável (T5): retired / reactivar / filtros.
 * Derivado do `status` canónico do backend — sem estado paralelo.
 * Protegidos (temp_legacy_* / legacy-temp) ficam fora da UX.
 */
import {
  applyAdminCatalogItemSave,
  type CatalogItemLike,
  type UpgradeIdFix
} from './upgradeCatalogIds';

/** Espelha `UPGRADE_STATUS_RETIRED` do backend (sem importar server). */
export const UPGRADE_STATUS_RETIRED = 'retired';

export type CatalogLifecycleFilter = 'all' | 'active' | 'retired';

export type CatalogLifecycleItem = CatalogItemLike & {
  status?: string;
  category?: string;
  type?: string;
  isActive?: boolean;
  sellInHardwareMarket?: boolean;
  sellInBlackMarket?: boolean;
};

/** Alinhado a `isProtectedUpgradeRow` no backend. */
export function isAdminCatalogProtectedUpgrade(u: {
  id?: string;
  category?: string | null;
  type?: string | null;
}): boolean {
  const id = String(u.id || '');
  if (id.startsWith('temp_legacy_')) return true;
  if (u.category === 'legacy-temp' || u.type === 'legacy-temp') return true;
  return false;
}

/** Estado canónico de soft-retire (`upgrades.status = 'retired'`). */
export function isUpgradeRetired(u: { status?: string | null }): boolean {
  return String(u.status ?? '')
    .trim()
    .toLowerCase() === UPGRADE_STATUS_RETIRED;
}

export function filterAdminEditableUpgrades<T extends CatalogLifecycleItem>(upgrades: T[]): T[] {
  return upgrades.filter((u) => !isAdminCatalogProtectedUpgrade(u));
}

export function filterUpgradesByLifecycle<T extends CatalogLifecycleItem>(
  upgrades: T[],
  lifecycle: CatalogLifecycleFilter
): T[] {
  const editable = filterAdminEditableUpgrades(upgrades);
  if (lifecycle === 'all') return editable;
  if (lifecycle === 'retired') return editable.filter((u) => isUpgradeRetired(u));
  return editable.filter((u) => !isUpgradeRetired(u));
}

/**
 * Soft-retire via UPSERT (mesmos campos que o backend força na omissão).
 * Não remove o ID do array — o item permanece visível em «Retirados».
 */
export function applyUpgradeRetireState<T extends CatalogLifecycleItem>(item: T): T {
  return {
    ...item,
    status: UPGRADE_STATUS_RETIRED,
    isActive: false,
    sellInHardwareMarket: false,
    sellInBlackMarket: false
  };
}

/**
 * Reativação = modelo de item activo novo no AdminEditor:
 * status normal + activo + mercados on. Preserva o mesmo `id`.
 * (O soft-retire do BE sobrescreve o status anterior; não há histórico para restaurar.)
 */
export function applyUpgradeReactivateState<T extends CatalogLifecycleItem>(item: T): T {
  return {
    ...item,
    status: 'normal',
    isActive: true,
    sellInHardwareMarket: true,
    sellInBlackMarket: true
  };
}

export function applyAdminCatalogLifecycleSave<T extends CatalogLifecycleItem>(args: {
  gameUpgrades: T[];
  targetId: string;
  mode: 'retire' | 'reactivate';
}): { upgrades: T[]; fixes: UpgradeIdFix[]; lockedId: string } {
  const targetId = String(args.targetId || '').trim();
  const existing = args.gameUpgrades.find((u) => u.id === targetId);
  if (!existing) {
    throw new Error(`Item não encontrado: ${targetId}`);
  }
  if (isAdminCatalogProtectedUpgrade(existing)) {
    throw new Error('Item protegido não é editável no catálogo admin.');
  }
  const nextForm =
    args.mode === 'retire' ? applyUpgradeRetireState(existing) : applyUpgradeReactivateState(existing);
  const out = applyAdminCatalogItemSave({
    gameUpgrades: args.gameUpgrades,
    editingSourceId: targetId,
    itemForm: nextForm
  });
  if (out.lockedId !== targetId) {
    throw new Error('Identidade canónica imutável.');
  }
  const saved = out.upgrades.find((u) => u.id === targetId);
  if (!saved) {
    throw new Error(`Identidade canónica perdida: ${targetId}`);
  }
  if (args.mode === 'retire' && !isUpgradeRetired(saved)) {
    throw new Error('Retire não aplicou status retired.');
  }
  if (args.mode === 'reactivate' && isUpgradeRetired(saved)) {
    throw new Error('Reativação manteve status retired.');
  }
  return out;
}
