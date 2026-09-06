/**
 * Migrado de legacy/backend/modules/merge/merge.stats.ts (verbatim).
 */
import { MERGE_RESULT_RARITY, type MergeAllowedType, type MergeRarity, type MergeableSourceRarity, isMergeableSourceRarity, normalizeMergeRarity } from './constants.js';
import type { MergeRuntimeSettings } from './settings.js';

export type MergeSourceCatalog = {
  id: string;
  name: string;
  category: string;
  type: string;
  rarity: string;
  base_cost: number;
  base_production: number;
  power_consumption: number | null;
  multiplier: number | null;
  slots_capacity: number | null;
  ai_slots_capacity: number | null;
  description: string;
  icon: string;
  image: string | null;
  status: string;
};

export type MergeResultStats = {
  resultRarity: MergeRarity;
  name: string;
  baseCost: number;
  baseProduction: number;
  powerConsumption: number | null;
  multiplier: number | null;
  slotsCapacity: number | null;
  aiSlotsCapacity: number | null;
  feeUsdc: number;
  costPct: number;
  gainPercent: number;
};

const DEFAULT_ROUND_DIGITS = 8;
const DECIMAL_BASE = 10;

function roundStat(n: number, digits: number = DEFAULT_ROUND_DIGITS): number {
  const f = DECIMAL_BASE ** digits;
  return Math.round(n * f) / f;
}

export function mergeResultDisplayName(sourceName: string): string {
  const base = String(sourceName || '').replace(/^(Merged\s+)+/i, '').trim() || String(sourceName || 'Item');
  return `Merged ${base}`;
}

const PERCENT_BASE = 100;
const FEE_ROUND_DIGITS = 2;
const COST_ROUND_DIGITS = 6;
const POWER_EFFICIENCY_FACTOR = 0.95;

export function computeMergeResultStats(source: MergeSourceCatalog, settings: MergeRuntimeSettings): MergeResultStats | null {
  const rarity = normalizeMergeRarity(source.rarity);
  if (!isMergeableSourceRarity(rarity)) return null;
  const resultRarity = MERGE_RESULT_RARITY[rarity];
  const costPct = settings.costPctByRarity[rarity as MergeableSourceRarity];
  const gainFactor = 1 + settings.gainPercent / PERCENT_BASE;
  const c1 = Math.max(0, Number(source.base_cost) || 0);
  const feeUsdc = roundStat((c1 + c1) * (costPct / PERCENT_BASE), FEE_ROUND_DIGITS);
  const baseCost = roundStat((c1 + c1) * gainFactor, COST_ROUND_DIGITS);
  const type = String(source.type || '') as MergeAllowedType;

  let baseProduction = 0;
  let powerConsumption: number | null = null;
  let multiplier: number | null = null;
  let slotsCapacity: number | null = null;
  let aiSlotsCapacity: number | null = null;

  if (type === 'machine') {
    const p = Math.max(0, Number(source.base_production) || 0);
    baseProduction = roundStat((p + p) * gainFactor);
    const w = Math.max(0, Number(source.power_consumption) || 0);
    powerConsumption = roundStat((w + w) * POWER_EFFICIENCY_FACTOR, COST_ROUND_DIGITS);
  } else if (type === 'multiplier') {
    const m = Math.max(0, Number(source.multiplier) || 0);
    multiplier = roundStat((m + m) * gainFactor);
  } else if (type === 'infrastructure') {
    const bonusPct = Math.max(0, Number(settings.rackHsBonusPctByRarity?.[resultRarity]) || 0);
    multiplier = roundStat(bonusPct / PERCENT_BASE);
    const sc = source.slots_capacity == null ? null : Math.floor(Number(source.slots_capacity));
    const ai = source.ai_slots_capacity == null ? null : Math.floor(Number(source.ai_slots_capacity));
    slotsCapacity = sc != null && Number.isFinite(sc) && sc >= 0 ? sc : null;
    aiSlotsCapacity = ai != null && Number.isFinite(ai) && ai >= 0 ? ai : null;
  } else {
    return null;
  }

  return {
    resultRarity,
    name: mergeResultDisplayName(source.name),
    baseCost,
    baseProduction,
    powerConsumption,
    multiplier,
    slotsCapacity,
    aiSlotsCapacity,
    feeUsdc,
    costPct,
    gainPercent: settings.gainPercent
  };
}

const NEAR_EPSILON = 1e-6;

/** Mesmo modelo mergeável (nome/tipo/raridade + stats efectivos) — SKUs distintos no catálogo. */
export function mergeSourceCatalogsEquivalent(a: MergeSourceCatalog, b: MergeSourceCatalog): boolean {
  if (String(a.type || '') !== String(b.type || '')) return false;
  if (normalizeMergeRarity(a.rarity) !== normalizeMergeRarity(b.rarity)) return false;
  if (String(a.name || '').trim() !== String(b.name || '').trim()) return false;
  return statsMatchExisting(
    {
      base_cost: Number(a.base_cost) || 0,
      base_production: Number(a.base_production) || 0,
      power_consumption: a.power_consumption == null ? null : Number(a.power_consumption),
      multiplier: a.multiplier == null ? null : Number(a.multiplier),
      slots_capacity: a.slots_capacity == null ? null : Number(a.slots_capacity),
      ai_slots_capacity: a.ai_slots_capacity == null ? null : Number(a.ai_slots_capacity)
    },
    {
      resultRarity: normalizeMergeRarity(a.rarity),
      name: a.name,
      baseCost: Number(b.base_cost) || 0,
      baseProduction: Number(b.base_production) || 0,
      powerConsumption: b.power_consumption == null ? null : Number(b.power_consumption),
      multiplier: b.multiplier == null ? null : Number(b.multiplier),
      slotsCapacity: b.slots_capacity == null ? null : Math.floor(Number(b.slots_capacity)),
      aiSlotsCapacity: b.ai_slots_capacity == null ? null : Math.floor(Number(b.ai_slots_capacity)),
      feeUsdc: 0,
      costPct: 0,
      gainPercent: 0
    },
    String(a.type || '')
  );
}

export function statsMatchExisting(
  row: { base_cost: number; base_production: number; power_consumption: number | null; multiplier: number | null; slots_capacity?: number | null; ai_slots_capacity?: number | null },
  stats: MergeResultStats,
  type: string
): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < NEAR_EPSILON;
  if (!near(Number(row.base_cost) || 0, stats.baseCost)) return false;
  if (type === 'machine') {
    if (!near(Number(row.base_production) || 0, stats.baseProduction)) return false;
    const rw = row.power_consumption == null ? null : Number(row.power_consumption);
    const sw = stats.powerConsumption;
    if (rw == null && sw == null) return true;
    if (rw == null || sw == null) return false;
    return near(rw, sw);
  }
  if (type === 'multiplier') {
    const rm = row.multiplier == null ? null : Number(row.multiplier);
    const sm = stats.multiplier;
    if (rm == null && sm == null) return true;
    if (rm == null || sm == null) return false;
    return near(rm, sm);
  }
  if (type === 'infrastructure') {
    const rm = row.multiplier == null ? null : Number(row.multiplier);
    const sm = stats.multiplier;
    if (rm == null && sm == null) {
      /* ok */
    } else if (rm == null || sm == null || !near(rm, sm)) {
      return false;
    }
    const rs = row.slots_capacity == null ? null : Math.floor(Number(row.slots_capacity));
    const as = row.ai_slots_capacity == null ? null : Math.floor(Number(row.ai_slots_capacity));
    if (rs !== stats.slotsCapacity) return false;
    if (as !== stats.aiSlotsCapacity) return false;
    return true;
  }
  return false;
}
