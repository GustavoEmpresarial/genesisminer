/**
 * Migrado de legacy/backend/modules/merge/merge.settings.ts (verbatim, usando
 * o pool singleton `core/database/pool.js` em vez de `Pool` injetado por deps).
 */
import db from '../../../core/database/pool.js';
import { MS_PER_SECOND } from '../../../shared/utils/time.js';
import {
  DEFAULT_MERGE_COST_PCT,
  DEFAULT_MERGE_GAIN_PERCENT,
  DEFAULT_RACK_HS_BONUS_PCT,
  MERGEABLE_SOURCE_RARITIES,
  MERGE_RARITIES,
  parseCostPctJson,
  parseRackHsBonusPctJson,
  type MergeableSourceRarity,
  type MergeAllowedType,
  type MergeRarity
} from './constants.js';

export type MergeRuntimeSettings = {
  enabled: boolean;
  enabledMachine: boolean;
  enabledMultiplier: boolean;
  enabledInfrastructure: boolean;
  gainPercent: number;
  costPctByRarity: Record<MergeableSourceRarity, number>;
  /** Bónus H/s % da rig (resultado) por raridade — ex. 10 = +10%. */
  rackHsBonusPctByRarity: Record<MergeRarity, number>;
};

const DEFAULTS: MergeRuntimeSettings = {
  enabled: true,
  enabledMachine: true,
  enabledMultiplier: true,
  enabledInfrastructure: true,
  gainPercent: DEFAULT_MERGE_GAIN_PERCENT,
  costPctByRarity: { ...DEFAULT_MERGE_COST_PCT },
  rackHsBonusPctByRarity: { ...DEFAULT_RACK_HS_BONUS_PCT }
};

let cache: { at: number; value: MergeRuntimeSettings } | null = null;
const CACHE_SECONDS = 5;
const CACHE_MS = CACHE_SECONDS * MS_PER_SECOND;

export function invalidateMergeSettingsCache(): void {
  cache = null;
}

function cloneDefaults(): MergeRuntimeSettings {
  return {
    ...DEFAULTS,
    costPctByRarity: { ...DEFAULT_MERGE_COST_PCT },
    rackHsBonusPctByRarity: { ...DEFAULT_RACK_HS_BONUS_PCT }
  };
}

function flagOn(v: number | null | undefined): boolean {
  return v == null ? true : Number(v) !== 0;
}

export function isMergeTypeEnabled(settings: MergeRuntimeSettings, type: MergeAllowedType): boolean {
  if (type === 'machine') return settings.enabledMachine;
  if (type === 'multiplier') return settings.enabledMultiplier;
  return settings.enabledInfrastructure;
}

export function anyMergeTypeEnabled(settings: MergeRuntimeSettings): boolean {
  return settings.enabledMachine || settings.enabledMultiplier || settings.enabledInfrastructure;
}

const GAIN_PERCENT_MAX = 100;

export async function loadMergeSettings(): Promise<MergeRuntimeSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await db.query<{
      gain_percent: number;
      cost_pct_json: string;
      rack_hs_bonus_pct_json: string | null;
      enabled: number | null;
      enabled_machine: number | null;
      enabled_multiplier: number | null;
      enabled_infrastructure: number | null;
    }>(
      `SELECT gain_percent, cost_pct_json, enabled,
              COALESCE(rack_hs_bonus_pct_json, '{}') AS rack_hs_bonus_pct_json,
              enabled_machine, enabled_multiplier, enabled_infrastructure
         FROM merge_settings WHERE id = 1`
    );
    const row = res.rows[0];
    if (!row) {
      cache = { at: Date.now(), value: cloneDefaults() };
      return cache.value;
    }
    const gain = Number(row.gain_percent);
    const value: MergeRuntimeSettings = {
      enabled: flagOn(row.enabled),
      enabledMachine: flagOn(row.enabled_machine),
      enabledMultiplier: flagOn(row.enabled_multiplier),
      enabledInfrastructure: flagOn(row.enabled_infrastructure),
      gainPercent: Number.isFinite(gain) && gain >= 0 && gain <= GAIN_PERCENT_MAX ? gain : DEFAULT_MERGE_GAIN_PERCENT,
      costPctByRarity: parseCostPctJson(row.cost_pct_json),
      rackHsBonusPctByRarity: parseRackHsBonusPctJson(row.rack_hs_bonus_pct_json)
    };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cloneDefaults();
  }
}

export type MergeSettingsUpdate = {
  enabled: boolean;
  enabledMachine: boolean;
  enabledMultiplier: boolean;
  enabledInfrastructure: boolean;
  gainPercent: number;
  costPctByRarity: Record<MergeableSourceRarity, number>;
  rackHsBonusPctByRarity: Record<MergeRarity, number>;
};

export async function saveMergeSettings(input: MergeSettingsUpdate): Promise<MergeRuntimeSettings> {
  const enabled = !!input.enabled;
  const enabledMachine = !!input.enabledMachine;
  const enabledMultiplier = !!input.enabledMultiplier;
  const enabledInfrastructure = !!input.enabledInfrastructure;
  const gain = Math.max(0, Math.min(GAIN_PERCENT_MAX, Number(input.gainPercent) || 0));
  const PERCENT_ROUND_FACTOR = 100;
  const MERGE_COST_PCT_MAX = 100;
  const RACK_HS_BONUS_PCT_MAX = 500;
  const cost: Record<MergeableSourceRarity, number> = { ...DEFAULT_MERGE_COST_PCT };
  for (const k of MERGEABLE_SOURCE_RARITIES) {
    const n = Number(input.costPctByRarity?.[k]);
    if (Number.isFinite(n) && n >= 0 && n <= MERGE_COST_PCT_MAX) cost[k] = Math.round(n * PERCENT_ROUND_FACTOR) / PERCENT_ROUND_FACTOR;
  }
  const rackBonus: Record<MergeRarity, number> = { ...DEFAULT_RACK_HS_BONUS_PCT };
  for (const k of MERGE_RARITIES) {
    const n = Number(input.rackHsBonusPctByRarity?.[k]);
    if (Number.isFinite(n) && n >= 0 && n <= RACK_HS_BONUS_PCT_MAX) rackBonus[k] = Math.round(n * PERCENT_ROUND_FACTOR) / PERCENT_ROUND_FACTOR;
  }
  const costJson = JSON.stringify(cost);
  const rackJson = JSON.stringify(rackBonus);
  const now = Date.now();
  await db.query(
    `INSERT INTO merge_settings (
       id, gain_percent, cost_pct_json, rack_hs_bonus_pct_json,
       enabled, enabled_machine, enabled_multiplier, enabled_infrastructure, updated_at
     )
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       gain_percent = EXCLUDED.gain_percent,
       cost_pct_json = EXCLUDED.cost_pct_json,
       rack_hs_bonus_pct_json = EXCLUDED.rack_hs_bonus_pct_json,
       enabled = EXCLUDED.enabled,
       enabled_machine = EXCLUDED.enabled_machine,
       enabled_multiplier = EXCLUDED.enabled_multiplier,
       enabled_infrastructure = EXCLUDED.enabled_infrastructure,
       updated_at = EXCLUDED.updated_at`,
    [gain, costJson, rackJson, enabled ? 1 : 0, enabledMachine ? 1 : 0, enabledMultiplier ? 1 : 0, enabledInfrastructure ? 1 : 0, now]
  );
  invalidateMergeSettingsCache();
  const value: MergeRuntimeSettings = {
    enabled,
    enabledMachine,
    enabledMultiplier,
    enabledInfrastructure,
    gainPercent: gain,
    costPctByRarity: cost,
    rackHsBonusPctByRarity: rackBonus
  };
  cache = { at: Date.now(), value };
  return value;
}
