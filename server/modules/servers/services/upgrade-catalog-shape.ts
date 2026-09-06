/**
 * Formato API do catálogo de upgrades (`GET /api/upgrades`, bootstrap).
 *
 * Migrado de legacy/backend/lib/upgradeCatalogShape.ts, verbatim.
 */
import type { upgrades } from '@prisma/client';
import { normalizePublicAssetUrl } from '../../../core/http/public-asset-url.js';

const RARITY_DEFAULT = 'common';

/** UPSERT admin: preserva validade na BD se o payload não enviar os campos. */
export function resolveAsicDurationUpsertFields(
  payload: { asicDurationAmount?: unknown; asicDurationUnit?: unknown },
  existing?: { asic_duration_amount?: unknown; asic_duration_unit?: string | null } | null
): { amount: number; unit: string | null } {
  const hasExplicit =
    Object.prototype.hasOwnProperty.call(payload, 'asicDurationAmount') ||
    Object.prototype.hasOwnProperty.call(payload, 'asicDurationUnit');
  if (hasExplicit) {
    const amt = Math.floor(Number(payload.asicDurationAmount) || 0);
    const unit =
      typeof payload.asicDurationUnit === 'string' && payload.asicDurationUnit.trim()
        ? payload.asicDurationUnit.trim()
        : null;
    return amt > 0 && unit ? { amount: amt, unit } : { amount: 0, unit: null };
  }
  const amt = Math.max(0, Math.floor(Number(existing?.asic_duration_amount) || 0));
  const unit =
    existing?.asic_duration_unit != null && String(existing.asic_duration_unit).trim()
      ? String(existing.asic_duration_unit).trim()
      : null;
  return amt > 0 && unit ? { amount: amt, unit } : { amount: 0, unit: null };
}

export function mapUpgradeRowToApi(r: upgrades, compatibleRacks: string[] = []) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    type: r.type,
    baseCost: r.base_cost,
    baseProduction: r.base_production,
    powerConsumption: r.power_consumption ?? undefined,
    powerCapacity: r.power_capacity ?? undefined,
    multiplier: r.multiplier ?? undefined,
    slotsCapacity: r.slots_capacity ?? undefined,
    aiSlotsCapacity: r.ai_slots_capacity ?? undefined,
    description: r.description,
    icon: r.icon,
    status: r.status,
    isNft: !!r.is_nft,
    nftContract: r.nft_contract ?? undefined,
    nftTokenId: r.nft_token_id ?? undefined,
    maxGlobalStock: r.max_global_stock ?? undefined,
    totalSold: Number((r as { total_sold?: unknown }).total_sold) || 0,
    image: normalizePublicAssetUrl(r.image != null ? String(r.image) : undefined) ?? undefined,
    layout: r.layout
      ? (() => {
          try {
            return JSON.parse(r.layout) as unknown;
          } catch {
            return undefined;
          }
        })()
      : undefined,
    compatibleRacks,
    rewardWh: r.reward_wh ?? 0,
    sellInHardwareMarket: r.sell_in_hardware_market !== 0,
    sellInBlackMarket: r.sell_in_black_market !== 0,
    isActive: r.is_active !== 0,
    nftMiningCoinId: r.nft_mining_coin_id != null && String(r.nft_mining_coin_id).trim() ? String(r.nft_mining_coin_id).trim() : undefined,
    asicDurationKind: r.asic_duration_kind != null && String(r.asic_duration_kind).trim() ? String(r.asic_duration_kind).trim() : 'none',
    asicDurationAmount: Math.max(0, Math.floor(Number(r.asic_duration_amount) || 0)),
    asicDurationUnit: r.asic_duration_unit != null && String(r.asic_duration_unit).trim() ? String(r.asic_duration_unit).trim() : undefined,
    rarity: (r as { rarity?: string | null }).rarity != null && String((r as { rarity?: string | null }).rarity).trim() ? String((r as { rarity?: string | null }).rarity).trim().toLowerCase() : RARITY_DEFAULT,
    rackRoomAffinity:
      (r as { rack_room_affinity?: string | null }).rack_room_affinity != null &&
      String((r as { rack_room_affinity?: string | null }).rack_room_affinity).trim()
        ? String((r as { rack_room_affinity?: string | null }).rack_room_affinity).trim()
        : undefined
  };
}
