/**
 * Módulo `merge`: Merge Station — funde 2 unidades iguais (GPU/Chip IA/Rig)
 * numa de raridade superior, cobra taxa USDC, cria o item resultado no
 * catálogo sob demanda, credita progresso em `modules/quests` ('merge').
 */
export { registerMergeModuleRoutes } from './controllers/merge.controller.js';
export type { MergeModuleDeps } from './controllers/merge.controller.js';

export {
  DEFAULT_MERGE_COST_PCT,
  DEFAULT_MERGE_GAIN_PERCENT,
  DEFAULT_RACK_HS_BONUS_PCT,
  MERGEABLE_SOURCE_RARITIES,
  MERGE_ALLOWED_TYPES,
  MERGE_CATALOG_ID_PREFIX,
  MERGE_FORBIDDEN_ROOT_IDS,
  MERGE_MAX_COUNT,
  MERGE_RARITIES,
  MERGE_RARITY_LABELS,
  MERGE_RESULT_RARITY,
  isAsicMachineForMerge,
  isForbiddenMergeRootId,
  isMergeCatalogId,
  isMergeForbiddenCatalog,
  isMergeableSourceRarity,
  normalizeMergeRarity,
  parseCostPctJson,
  parseRackHsBonusPctJson
} from './services/constants.js';
export type { MergeAllowedType, MergeRarity, MergeableSourceRarity } from './services/constants.js';

export { anyMergeTypeEnabled, invalidateMergeSettingsCache, isMergeTypeEnabled, loadMergeSettings, saveMergeSettings } from './services/settings.js';
export type { MergeRuntimeSettings, MergeSettingsUpdate } from './services/settings.js';

export { computeMergeResultStats, mergeResultDisplayName, statsMatchExisting } from './services/stats.js';
export type { MergeResultStats, MergeSourceCatalog } from './services/stats.js';

export { MergeError, executeMerge, getMergePublicConfig, listMergeHistory, listMergeInventory } from './services/merge.js';
export type { MergeExecuteResult, MergeHistoryEntry, MergeHistorySummaryRow, MergeInventoryItem } from './services/merge.js';
