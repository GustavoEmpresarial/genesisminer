import { genesisRustEnabled, loadGenesisNative } from '../../../shared/rust/genesis-native.js';
import type { MergeRuntimeSettings } from './settings.js';
import type { MergeResultStats, MergeSourceCatalog } from './stats.js';
import {
  computeMergeResultStats as computeMergeResultStatsTs,
  mergeSourceCatalogsEquivalent as mergeTs,
  statsMatchExisting
} from './stats.js';

export { statsMatchExisting };
export type { MergeResultStats, MergeSourceCatalog };

function toRustSource(source: MergeSourceCatalog) {
  return {
    id: source.id,
    name: source.name,
    category: source.category,
    type: source.type,
    rarity: source.rarity,
    base_cost: source.base_cost,
    base_production: source.base_production,
    power_consumption: source.power_consumption,
    multiplier: source.multiplier,
    slots_capacity: source.slots_capacity,
    ai_slots_capacity: source.ai_slots_capacity
  };
}

function toRustSettings(settings: MergeRuntimeSettings) {
  return {
    gainPercent: settings.gainPercent,
    costPctByRarity: settings.costPctByRarity,
    rackHsBonusPctByRarity: settings.rackHsBonusPctByRarity
  };
}

export function computeMergeResultStats(source: MergeSourceCatalog, settings: MergeRuntimeSettings): MergeResultStats | null {
  if (!genesisRustEnabled()) return computeMergeResultStatsTs(source, settings);
  const native = loadGenesisNative();
  const fn = native?.mergeComputeResultStatsJson;
  if (!fn) return computeMergeResultStatsTs(source, settings);
  try {
    const raw = fn(JSON.stringify(toRustSource(source)), JSON.stringify(toRustSettings(settings)));
    if (raw == null) return null;
    return JSON.parse(raw) as MergeResultStats;
  } catch (e) {
    console.warn('[merge/rust] computeMergeResultStats fallback to TS', e instanceof Error ? e.message : e);
    return computeMergeResultStatsTs(source, settings);
  }
}

export function mergeSourceCatalogsEquivalent(a: MergeSourceCatalog, b: MergeSourceCatalog): boolean {
  if (!genesisRustEnabled()) return mergeTs(a, b);
  const native = loadGenesisNative();
  const fn = native?.mergeSourceCatalogsEquivalentJson;
  if (!fn) return mergeTs(a, b);
  try {
    return fn(JSON.stringify(toRustSource(a)), JSON.stringify(toRustSource(b)));
  } catch (e) {
    console.warn('[merge/rust] mergeSourceCatalogsEquivalent fallback to TS', e instanceof Error ? e.message : e);
    return mergeTs(a, b);
  }
}
