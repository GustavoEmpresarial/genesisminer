/**
 * Migrado de legacy/backend/modules/merge/merge.constants.ts (verbatim).
 */
export const DEFAULT_MERGE_GAIN_PERCENT = 5;

/** Prefixo de SKUs resultado de merge no catálogo (`merge_<root>_…`). */
export const MERGE_CATALOG_ID_PREFIX = 'merge_';

export function isMergeCatalogId(id: string): boolean {
  return String(id || '').startsWith(MERGE_CATALOG_ID_PREFIX);
}

export const MERGE_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'supreme'] as const;
export type MergeRarity = (typeof MERGE_RARITIES)[number];

export const MERGEABLE_SOURCE_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type MergeableSourceRarity = (typeof MERGEABLE_SOURCE_RARITIES)[number];

export const MERGE_RESULT_RARITY: Record<MergeableSourceRarity, MergeRarity> = {
  common: 'uncommon',
  uncommon: 'rare',
  rare: 'epic',
  epic: 'legendary',
  legendary: 'supreme'
};

export const DEFAULT_MERGE_COST_PCT: Record<MergeableSourceRarity, number> = {
  common: 10,
  uncommon: 15,
  rare: 20,
  epic: 25,
  legendary: 30
};

export const MERGE_ALLOWED_TYPES = ['machine', 'multiplier', 'infrastructure'] as const;
export type MergeAllowedType = (typeof MERGE_ALLOWED_TYPES)[number];

/** Defaults: bónus H/s % da rig merged por raridade do resultado (admin). */
export const DEFAULT_RACK_HS_BONUS_PCT: Record<MergeRarity, number> = {
  common: 0,
  uncommon: 0,
  rare: 0,
  epic: 0,
  legendary: 0,
  supreme: 0
};

const RACK_HS_BONUS_PCT_MAX = 500;
const PERCENT_ROUND_FACTOR = 100;

export function parseRackHsBonusPctJson(raw: unknown): Record<MergeRarity, number> {
  const out = { ...DEFAULT_RACK_HS_BONUS_PCT };
  if (typeof raw !== 'string' || !raw.trim()) return out;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    for (const k of MERGE_RARITIES) {
      const n = Number(j[k]);
      if (Number.isFinite(n) && n >= 0 && n <= RACK_HS_BONUS_PCT_MAX) out[k] = Math.round(n * PERCENT_ROUND_FACTOR) / PERCENT_ROUND_FACTOR;
    }
  } catch {
    /* keep defaults */
  }
  return out;
}

/** Máximo de merges num único pedido (lote). */
export const MERGE_MAX_COUNT = 50;

export const MERGE_RARITY_LABELS: Record<MergeRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
  supreme: 'Supreme'
};

export function normalizeMergeRarity(raw: unknown): MergeRarity {
  const s = String(raw ?? '').trim().toLowerCase();
  if ((MERGE_RARITIES as readonly string[]).includes(s)) return s as MergeRarity;
  return 'common';
}

export function isMergeableSourceRarity(r: string): r is MergeableSourceRarity {
  return (MERGEABLE_SOURCE_RARITIES as readonly string[]).includes(r);
}

export function isAsicMachineForMerge(id: string, category: string, type: string): boolean {
  if (type !== 'machine') return false;
  const iid = String(id || '').trim().toLowerCase();
  if (iid.startsWith('asic_')) return true;
  return String(category || '').trim().toLowerCase().includes('asic');
}

/**
 * Itens que nunca devem entrar no Merge:
 * - todos com is_nft=1
 * - Dólar F2P / Dólar Gênesis / Rack Dólar NFT / Fiação sem garantia / Bateria Nébula
 * - qualquer resultado de merge derivado desses roots
 */
export const MERGE_FORBIDDEN_ROOT_IDS = ['dolar_f2p', 'dolar_f2p2', 'armario_1', 'battery_nebula', 'cic'] as const;

export function isForbiddenMergeRootId(itemId: string): boolean {
  const id = String(itemId || '').trim();
  if (!id) return false;
  if ((MERGE_FORBIDDEN_ROOT_IDS as readonly string[]).includes(id)) return true;
  if (!isMergeCatalogId(id)) return false;
  // linhagem: merge_<root>_… e merge_merge_<root>_… (cascata)
  for (const root of MERGE_FORBIDDEN_ROOT_IDS) {
    if (id.startsWith(`merge_${root}_`) || id.startsWith(`merge_merge_${root}_`)) return true;
    if (id.includes(`_${root}_`)) return true;
  }
  return false;
}

export function isMergeForbiddenCatalog(item: { id: string; is_nft?: number | boolean | null; category?: string | null; type?: string | null }): boolean {
  const IS_NFT_FLAG = 1;
  if (item.is_nft === true || Number(item.is_nft) === IS_NFT_FLAG) return true;
  if (isForbiddenMergeRootId(item.id)) return true;
  if (isAsicMachineForMerge(item.id, String(item.category || ''), String(item.type || ''))) return true;
  return false;
}

const MERGE_COST_PCT_MAX = 100;

export function parseCostPctJson(raw: unknown): Record<MergeableSourceRarity, number> {
  const out = { ...DEFAULT_MERGE_COST_PCT };
  if (typeof raw !== 'string' || !raw.trim()) return out;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    for (const k of MERGEABLE_SOURCE_RARITIES) {
      const n = Number(j[k]);
      if (Number.isFinite(n) && n >= 0 && n <= MERGE_COST_PCT_MAX) out[k] = Math.round(n * PERCENT_ROUND_FACTOR) / PERCENT_ROUND_FACTOR;
    }
  } catch {
    /* keep defaults */
  }
  return out;
}
