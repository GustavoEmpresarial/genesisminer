/**
 * Identidade canônica do catálogo hardware (AdminEditor).
 *
 * IDs já presentes em `persistedIds` nunca são remapeados.
 * Só itens NOVOS (ainda não persistidos) podem receber slug seguro.
 */
import {
  mergeCatalogRootId,
  normalizeCompatibleRackIdsToRoots
} from '../../servers/lib/upgradeRackCompat';
import { normalizeRackRoomAffinity } from '../../servers/types';

export const SHOP_PRODUCT_ID_RE = /^[a-zA-Z0-9_.-]{1,160}$/;

const INFRASTRUCTURE_TYPE = 'infrastructure';
const MACHINE_TYPE = 'machine';

/** Campos partilhados root → merge_* (máquinas). Não inclui name/rarity/stats nem sell flags. */
const MACHINE_SHARED_FIELDS = [
  'category',
  'description',
  'icon',
  'image',
  'powerConsumption',
  'isActive',
  'mergeEnabled',
  'nftMiningCoinId',
  'isNft',
  'nftContract',
  'nftTokenId'
] as const;

/** Só propagam se a chave existir no row do root (ASIC timed). */
const MACHINE_SHARED_FIELDS_IF_PRESENT = ['asicDurationAmount', 'asicDurationUnit'] as const;

type MachineSharedUpgrade = {
  id: string;
  type?: unknown;
  compatibleRacks?: unknown;
  category?: unknown;
  description?: unknown;
  icon?: unknown;
  image?: unknown;
  powerConsumption?: unknown;
  isActive?: unknown;
  mergeEnabled?: unknown;
  nftMiningCoinId?: unknown;
  isNft?: unknown;
  nftContract?: unknown;
  nftTokenId?: unknown;
  asicDurationAmount?: unknown;
  asicDurationUnit?: unknown;
};

function pickMachineSharedFieldsFromRoot<T extends MachineSharedUpgrade>(root: T): Partial<T> {
  const patch: Record<string, unknown> = {
    compatibleRacks: normalizeCompatibleRackIdsToRoots(
      ((root.compatibleRacks as unknown[]) || []).map((rid) => String(rid ?? ''))
    )
  };
  const rootRec = root as Record<string, unknown>;
  for (const key of MACHINE_SHARED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(root, key)) {
      patch[key] = rootRec[key];
    }
  }
  for (const key of MACHINE_SHARED_FIELDS_IF_PRESENT) {
    if (Object.prototype.hasOwnProperty.call(root, key)) {
      patch[key] = rootRec[key];
    }
  }
  return patch as Partial<T>;
}

/**
 * Lookup root→shared: exact peel, senão root remapeado (`cpu_v3` → `gpu_cpu_v3`)
 * via sufixo `_${peeled}` (remap de catálogo só alterou roots, não merge_*).
 */
function resolveMachineSharedFromRootMap<T>(
  peeledRoot: string,
  sharedByRootId: Map<string, Partial<T>>
): Partial<T> | undefined {
  const exact = sharedByRootId.get(peeledRoot);
  if (exact != null) return exact;
  if (!peeledRoot) return undefined;
  const suffix = `_${peeledRoot}`;
  let best: Partial<T> | undefined;
  let bestLen = 0;
  for (const [rootId, shared] of sharedByRootId) {
    if (!rootId.endsWith(suffix)) continue;
    if (rootId.length > bestLen) {
      best = shared;
      bestLen = rootId.length;
    }
  }
  return best;
}

/** Campos partilhados root → merge_* (chassis). Não inclui name/rarity/baseCost/description/icon nem sell flags. */
const INFRASTRUCTURE_SHARED_FIELDS = [
  'slotsCapacity',
  'aiSlotsCapacity',
  'image',
  'category',
  'isActive',
  'isNft',
  'powerCapacity',
  'layout',
  'rackRoomAffinity'
] as const;

type InfrastructureSharedUpgrade = {
  id: string;
  type?: unknown;
  slotsCapacity?: unknown;
  aiSlotsCapacity?: unknown;
  image?: unknown;
  category?: unknown;
  isActive?: unknown;
  isNft?: unknown;
  powerCapacity?: unknown;
  layout?: unknown;
  rackRoomAffinity?: unknown;
};

function pickInfrastructureSharedFieldsFromRoot<T extends InfrastructureSharedUpgrade>(
  root: T
): Partial<T> {
  const patch: Record<string, unknown> = {};
  const rootRec = root as Record<string, unknown>;
  for (const key of INFRASTRUCTURE_SHARED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(root, key)) continue;
    if (key === 'rackRoomAffinity') {
      patch[key] = normalizeRackRoomAffinity(root.rackRoomAffinity);
    } else {
      patch[key] = rootRec[key];
    }
  }
  return patch as Partial<T>;
}

/**
 * Merges `merge_*` de chassis herdam campos de família da placa base no array local.
 * Espelha `applyInfrastructureSharedFieldsFromMergeRoots` do servidor.
 */
export function applyInfrastructureSharedFieldsFromMergeRoots<T extends InfrastructureSharedUpgrade>(
  upgrades: T[]
): T[] {
  const sharedByRootId = new Map<string, Partial<T>>();
  for (const u of upgrades) {
    if (String(u.type ?? '') !== INFRASTRUCTURE_TYPE) continue;
    const id = String(u.id || '').trim();
    if (!id) continue;
    if (mergeCatalogRootId(id) !== id) continue;
    sharedByRootId.set(id, pickInfrastructureSharedFieldsFromRoot(u));
  }
  return upgrades.map((u) => {
    if (String(u.type ?? '') !== INFRASTRUCTURE_TYPE) return u;
    const id = String(u.id || '').trim();
    if (!id) return u;
    const rootId = mergeCatalogRootId(id);
    if (rootId === id) {
      const own = sharedByRootId.get(id);
      return own ? { ...u, ...own } : u;
    }
    const fromRoot = sharedByRootId.get(rootId);
    if (fromRoot == null) return u;
    return { ...u, ...fromRoot };
  });
}

/**
 * Merges `merge_*` de máquinas herdam campos partilhados da base no array local.
 * Espelha `applyMachineSharedFieldsFromMergeRoots` do servidor.
 */
export function applyMachineSharedFieldsFromMergeRoots<T extends MachineSharedUpgrade>(
  upgrades: T[]
): T[] {
  const sharedByRootId = new Map<string, Partial<T>>();
  for (const u of upgrades) {
    if (String(u.type ?? '') !== MACHINE_TYPE) continue;
    const id = String(u.id || '').trim();
    if (!id) continue;
    if (mergeCatalogRootId(id) !== id) continue;
    sharedByRootId.set(id, pickMachineSharedFieldsFromRoot(u));
  }
  return upgrades.map((u) => {
    if (String(u.type ?? '') !== MACHINE_TYPE) return u;
    const id = String(u.id || '').trim();
    if (!id) return u;
    const rootId = mergeCatalogRootId(id);
    if (rootId === id) {
      const own = sharedByRootId.get(id);
      return own ? { ...u, ...own } : u;
    }
    const fromRoot = resolveMachineSharedFromRootMap(rootId, sharedByRootId);
    if (fromRoot == null) return u;
    return { ...u, ...fromRoot };
  });
}
export function makeSafeShopProductId(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .toLowerCase()
    .slice(0, 160);
}

export function makeUniqueShopProductId(baseValue: string, used: Set<string>): string {
  const base = makeSafeShopProductId(baseValue) || 'item';
  let candidate = base;
  let seq = 2;
  while (used.has(candidate)) {
    const suffix = `-${seq}`;
    const trimmedBase = base.slice(0, Math.max(1, 160 - suffix.length));
    candidate = `${trimmedBase}${suffix}`;
    seq += 1;
  }
  used.add(candidate);
  return candidate;
}

export type UpgradeIdFix = { name: string; from: string; to: string };

/**
 * Normaliza IDs do catálogo antes do POST.
 * - ID em `persistedIds` → preserva exactamente (mesmo inválido para regex).
 * - ID novo inválido → gera slug único (CREATE only).
 * - Nunca produz previousId / rename.
 */
export function normalizeUpgradeCatalogIds<
  T extends { id: string; name?: string; compatibleRacks?: string[] }
>(
  upgrades: T[],
  persistedIds: ReadonlySet<string> = new Set()
): { upgrades: T[]; fixes: UpgradeIdFix[] } {
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  const fixes: UpgradeIdFix[] = [];

  for (const upgrade of upgrades) {
    const currentId = String(upgrade.id || '').trim();

    if (persistedIds.has(currentId)) {
      used.add(currentId);
      idMap.set(currentId, currentId);
      continue;
    }

    if (SHOP_PRODUCT_ID_RE.test(currentId) && !used.has(currentId)) {
      used.add(currentId);
      idMap.set(currentId, currentId);
      continue;
    }

    const nextId = makeUniqueShopProductId(currentId || upgrade.name || 'item', used);
    idMap.set(currentId, nextId);
    fixes.push({
      name: String(upgrade.name || nextId),
      from: currentId,
      to: nextId
    });
  }

  return {
    upgrades: upgrades.map((upgrade) => {
      const raw = String(upgrade.id || '').trim();
      const nextId = idMap.get(raw) || (persistedIds.has(raw) ? raw : makeUniqueShopProductId(upgrade.name || 'item', used));
      return {
        ...upgrade,
        id: nextId,
        compatibleRacks: (upgrade.compatibleRacks || []).map(
          (rackId) => idMap.get(String(rackId || '').trim()) || rackId
        )
      };
    }),
    fixes
  };
}

export type CatalogItemLike = {
  id: string;
  name: string;
  compatibleRacks?: string[];
  [key: string]: unknown;
};

/**
 * Aplica CREATE/UPDATE no array local sem rename.
 * Se `editingSourceId` está definido, o id do payload é forçado a esse valor.
 * Não emite `previousId`.
 */
export function applyAdminCatalogItemSave<T extends CatalogItemLike>(args: {
  gameUpgrades: T[];
  editingSourceId: string | null;
  itemForm: Partial<T> & { id?: string; name?: string };
}): { upgrades: T[]; fixes: UpgradeIdFix[]; lockedId: string; isCreate: boolean } {
  const isEdit = !!args.editingSourceId;
  const lockedId = isEdit
    ? String(args.editingSourceId)
    : String(args.itemForm.id || '').trim();

  if (!lockedId) {
    throw new Error('ID obrigatório.');
  }

  if (!isEdit && !SHOP_PRODUCT_ID_RE.test(lockedId)) {
    throw new Error('ID inválido. Use apenas letras, números, ".", "_" ou "-".');
  }

  const formCompat = args.itemForm.compatibleRacks;
  const newItem = {
    ...(args.itemForm as T),
    id: lockedId,
    ...(Array.isArray(formCompat)
      ? { compatibleRacks: normalizeCompatibleRackIdsToRoots(formCompat.map(String)) }
      : {})
  } as T;

  const existingIndex = args.gameUpgrades.findIndex((u) =>
    isEdit ? u.id === args.editingSourceId : u.id === lockedId
  );

  let nextUpgrades: T[];
  if (existingIndex >= 0) {
    const updated = [...args.gameUpgrades];
    updated[existingIndex] = newItem;
    nextUpgrades = updated;
  } else {
    nextUpgrades = [...args.gameUpgrades, newItem];
  }

  const persistedIds = new Set(args.gameUpgrades.map((u) => String(u.id || '').trim()).filter(Boolean));
  const { upgrades: normalized, fixes } = normalizeUpgradeCatalogIds(nextUpgrades, persistedIds);
  const upgrades = applyMachineSharedFieldsFromMergeRoots(
    applyInfrastructureSharedFieldsFromMergeRoots(normalized)
  );

  // Garantia final: item editado mantém o id canónico.
  if (isEdit && !upgrades.some((u) => u.id === lockedId)) {
    throw new Error(`Identidade canónica perdida no save: ${lockedId}`);
  }

  return { upgrades, fixes, lockedId, isCreate: !isEdit };
}
