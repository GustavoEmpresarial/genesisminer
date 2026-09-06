/**
 * GET /api/admin/economy-stats — leitura para AdminEconomy.
 *
 * Migrado de `legacy/backend/server.ts` (SELECT coins + racks activos + slots).
 * Sem query params. Sem período/timezone. Hashrate = base_production × (1 + Σ multiplier).
 *
 * Não usa `listSlotMiningCredits` / NFT rooms (isso é o tick de yield). O painel
 * mostra estes números como «rede real (racks / BD)» em paralelo ao runtime.
 */
import { prisma } from '../../../../core/database/prisma.js';

export type EconomyUpgradeRow = {
  id: string;
  base_production: number | null;
  multiplier: number | null;
  power_capacity: number | null;
};

export type EconomyActiveRackRow = {
  id: string;
  user_id: number;
  selected_coin_id: string | null;
};

export type EconomySlotRow = {
  rack_id: string;
  machine_item_id: string | null;
};

export type EconomyMultiRow = {
  rack_id: string;
  multiplier_item_id: string | null;
};

export type EconomyCoinRow = {
  id: string;
  name: string;
  symbol: string;
  description: string;
  network_hashrate: number;
  block_reward: number;
  block_time: number;
  price_usd: number;
  algorithm: string;
  difficulty: number;
  multiplier: number;
  color: string;
  min_proportion: number;
  usdc_rate: number;
  is_active: number;
  target_daily_usd: number | null;
  show_in_exchange: number | null;
  nft_room_only: number;
};

export type EconomyCoinStatDto = EconomyCoinRow & {
  realActiveMiners: number;
  realTotalHashrate: number;
};

export function rackEffectiveHashrate(
  machineIds: Array<string | null | undefined>,
  multiplierIds: Array<string | null | undefined>,
  upsMap: Map<string, EconomyUpgradeRow>
): number | null {
  let base = 0;
  for (const mid of machineIds) {
    const u = mid ? upsMap.get(mid) : undefined;
    if (u) base += u.base_production || 0;
  }
  if (base === 0) return null;

  let mult = 1;
  for (const mid of multiplierIds) {
    const u = mid ? upsMap.get(mid) : undefined;
    if (u) mult += u.multiplier || 0;
  }
  return base * mult;
}

export function aggregateEconomyStats(
  coins: EconomyCoinRow[],
  racks: EconomyActiveRackRow[],
  slots: EconomySlotRow[],
  multis: EconomyMultiRow[],
  upgrades: EconomyUpgradeRow[]
): EconomyCoinStatDto[] {
  const coinsMap = new Map<string, EconomyCoinStatDto>();
  for (const c of coins) {
    coinsMap.set(c.id, { ...c, realActiveMiners: 0, realTotalHashrate: 0 });
  }

  const upsMap = new Map<string, EconomyUpgradeRow>();
  for (const u of upgrades) upsMap.set(u.id, u);

  const slotsMap: Record<string, Array<string | null>> = {};
  for (const s of slots) {
    if (!slotsMap[s.rack_id]) slotsMap[s.rack_id] = [];
    slotsMap[s.rack_id]!.push(s.machine_item_id);
  }

  const multiMap: Record<string, Array<string | null>> = {};
  for (const m of multis) {
    if (!multiMap[m.rack_id]) multiMap[m.rack_id] = [];
    multiMap[m.rack_id]!.push(m.multiplier_item_id);
  }

  const activeMinersSets: Record<string, Set<number>> = {};

  for (const rack of racks) {
    if (!rack.selected_coin_id) continue;
    const cid = rack.selected_coin_id;
    if (!coinsMap.has(cid)) continue;

    const power = rackEffectiveHashrate(slotsMap[rack.id] || [], multiMap[rack.id] || [], upsMap);
    if (power == null) continue;

    const cStats = coinsMap.get(cid)!;
    cStats.realTotalHashrate += power;

    if (!activeMinersSets[cid]) activeMinersSets[cid] = new Set();
    activeMinersSets[cid]!.add(rack.user_id);
  }

  return Array.from(coinsMap.values()).map((c) => ({
    ...c,
    realActiveMiners: activeMinersSets[c.id] ? activeMinersSets[c.id]!.size : 0
  }));
}

export async function listEconomyStats(): Promise<EconomyCoinStatDto[]> {
  const [coins, upgrades, racks, slots, multis] = await Promise.all([
    prisma.mining_coins.findMany(),
    prisma.upgrades.findMany({
      select: { id: true, base_production: true, multiplier: true, power_capacity: true }
    }),
    prisma.$queryRaw<EconomyActiveRackRow[]>`
      SELECT pr.id, pr.user_id, pr.selected_coin_id
      FROM placed_racks pr
      INNER JOIN users u ON u.id = pr.user_id
      WHERE pr.is_on = 1
        AND pr.wiring_id IS NOT NULL
        AND pr.battery_id IS NOT NULL
        AND u.is_blocked = 0
    `,
    prisma.rack_slots.findMany({ select: { rack_id: true, machine_item_id: true } }),
    prisma.rack_multiplier_slots.findMany({ select: { rack_id: true, multiplier_item_id: true } })
  ]);

  return aggregateEconomyStats(coins, racks, slots, multis, upgrades);
}
