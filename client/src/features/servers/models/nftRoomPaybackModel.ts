import {
  filterNftRoomExclusiveMiningCoins,
  formatAsicRemainingUntil,
  isNftRoomCatalogMachine,
  normalizeMiningCoinSymbolKey,
  normalizePlacedRackRoomId,
  NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS,
  resolveAsicValidityLabel,
  resolveNftRoomCoinUsdRate,
  type AsicLeaseDetail,
  type MiningCoin,
  type PlacedRack,
  type Upgrade
} from '../types';
import { orphanCatalogUpgrade } from './orphanCatalogItem';

export type NftRoomAsicRow = {
  upgradeId: string;
  name: string;
  costUsd: number;
  coinId: string | null;
  coinLabel: string;
  effectiveHash: number;
  isMining: boolean;
  validityLabel: string;
  remainingLabel: string;
  expiresAt: number | null;
};

export type NftRoomCoinHashRow = {
  coinId: string;
  label: string;
  hash: number;
  asicCount: number;
};

export type NftRoomPaybackStats = {
  asicCount: number;
  totalInvestedUsd: number;
  recoveredUsd: number;
  remainingUsd: number;
  progressPercent: number;
  estimatedUsdPerDay: number;
  asics: NftRoomAsicRow[];
  /** H/s por moeda exclusiva NFT (USDT, cbBTC, DAI, GHO, GEMT) — rigs ligadas. */
  hashByExclusiveCoin: NftRoomCoinHashRow[];
};

function rackMultiplier(_slots: (string | null)[], multiplierSlots: (string | null)[], upgrades: Upgrade[]): number {
  let mult = 1;
  for (const sid of multiplierSlots) {
    if (!sid) continue;
    const up = upgrades.find((u) => u.id === sid);
    if (up?.multiplier != null && Number.isFinite(up.multiplier)) mult += Number(up.multiplier);
  }
  return mult;
}

function resolveCoinLabel(coinId: string | null, miningCoins: MiningCoin[]): string {
  if (!coinId) return '—';
  const coin = miningCoins.find((c) => c.id === coinId);
  if (coin) {
    const label = (coin.symbol || coin.name || '').trim();
    return label || 'Unknown coin';
  }
  return 'Unknown coin';
}

function buildExclusiveCoinHashRows(asics: NftRoomAsicRow[], miningCoins: MiningCoin[]): NftRoomCoinHashRow[] {
  const exclusiveCoins = filterNftRoomExclusiveMiningCoins(miningCoins);
  const coinIdSet = new Set<string>();
  for (const c of exclusiveCoins) coinIdSet.add(c.id);
  for (const sym of NFT_ROOM_EXCLUSIVE_MINING_COIN_SYMBOLS) {
    const match = miningCoins.find(
      (c) =>
        normalizeMiningCoinSymbolKey(c.symbol) === sym || normalizeMiningCoinSymbolKey(c.id) === sym
    );
    if (match) coinIdSet.add(match.id);
  }
  for (const a of asics) {
    if (a.coinId) coinIdSet.add(a.coinId);
  }

  const order = new Map(exclusiveCoins.map((c, i) => [c.id, i]));
  const rows: NftRoomCoinHashRow[] = [...coinIdSet].map((coinId) => {
    const matched = asics.filter((a) => a.coinId === coinId);
    return {
      coinId,
      label: resolveCoinLabel(coinId, miningCoins),
      hash: matched.filter((a) => a.isMining).reduce((s, a) => s + a.effectiveHash, 0),
      asicCount: matched.length
    };
  });

  rows.sort((a, b) => {
    const oa = order.has(a.coinId) ? order.get(a.coinId)! : 1000;
    const ob = order.has(b.coinId) ? order.get(b.coinId)! : 1000;
    if (oa !== ob) return oa - ob;
    return a.label.localeCompare(b.label);
  });
  return rows;
}

/**
 * Payback da Sala NFT: investimento = soma dos `baseCost` dos ASICs instalados;
 * recuperado = total USD creditado pelo servidor (`nftAsicMinedUsdTotal`).
 */
export function computeNftRoomPaybackStats(
  racks: PlacedRack[],
  roomId: string | null | undefined,
  upgrades: Upgrade[],
  miningCoins: MiningCoin[],
  minedUsdTotal: number,
  asicLeaseDetails: AsicLeaseDetail[] = [],
  nowMs: number = Date.now()
): NftRoomPaybackStats {
  const roomNorm = normalizePlacedRackRoomId(roomId);
  const asics: NftRoomAsicRow[] = [];
  const leaseById = new Map(asicLeaseDetails.map((l) => [l.leaseId, l]));
  const leaseByRackSlot = new Map<string, AsicLeaseDetail>();
  for (const l of asicLeaseDetails) {
    if (l.status === 'equipped' && l.rackId && l.slotIndex != null) {
      leaseByRackSlot.set(`${l.rackId}:${l.slotIndex}`, l);
    }
  }

  for (const rack of racks) {
    if (normalizePlacedRackRoomId(rack.roomId) !== roomNorm) continue;
    const operational = !!(rack.isOn && rack.wiringId && rack.batteryId);
    const mult = rackMultiplier(rack.slots, rack.multiplierSlots || [], upgrades);
    const slots = rack.slots || [];
    const leaseIds = rack.slotLeaseIds || [];

    for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
      const sid = slots[slotIdx];
      if (!sid) continue;
      const sidNorm = String(sid).trim().toLowerCase();
      let up = upgrades.find((u) => u.id === sid);
      if (!up && sidNorm.startsWith('asic_')) {
        up = orphanCatalogUpgrade(String(sid), 'machine');
      }
      if (!up || !isNftRoomCatalogMachine(up)) continue;
      const coinId = up.nftMiningCoinId?.trim() || null;
      const coin = coinId ? miningCoins.find((c) => c.id === coinId) : undefined;
      const bp = Number(up.baseProduction);
      const effectiveHash = Number.isFinite(bp) && bp > 0 ? bp * mult : 0;
      const validityLabel = resolveAsicValidityLabel(up);
      const leaseId =
        leaseIds[slotIdx] != null && String(leaseIds[slotIdx]).trim()
          ? String(leaseIds[slotIdx]).trim()
          : '';
      let lease = leaseId ? leaseById.get(leaseId) : undefined;
      if (!lease) {
        lease = leaseByRackSlot.get(`${rack.id}:${slotIdx}`);
      }
      const expiresAt = lease?.expiresAt != null ? Number(lease.expiresAt) : null;
      const remainingLabel =
        expiresAt != null && expiresAt > nowMs
          ? formatAsicRemainingUntil(expiresAt, nowMs)
          : validityLabel === 'Permanent'
            ? '—'
            : expiresAt != null
              ? 'Expired'
              : '—';
      asics.push({
        upgradeId: up.id,
        name: (up.name && up.name.trim()) || orphanCatalogUpgrade(up.id, up.type || 'machine').name,
        costUsd: Math.max(0, Number(up.baseCost) || 0),
        coinId,
        coinLabel: resolveCoinLabel(coinId, miningCoins),
        effectiveHash,
        isMining: operational && Boolean(coinId && coin?.isActive),
        validityLabel,
        remainingLabel,
        expiresAt
      });
    }
  }

  const totalInvestedUsd = asics.reduce((s, a) => s + a.costUsd, 0);
  const recoveredUsd = Math.max(0, Number(minedUsdTotal) || 0);
  const remainingUsd = Math.max(0, totalInvestedUsd - recoveredUsd);
  const progressPercent =
    totalInvestedUsd > 0 ? Math.min(100, (recoveredUsd / totalInvestedUsd) * 100) : recoveredUsd > 0 ? 100 : 0;

  let estimatedUsdPerDay = 0;
  for (const a of asics) {
    if (!a.isMining || a.effectiveHash <= 0 || !a.coinId) continue;
    const coin = miningCoins.find((c) => c.id === a.coinId);
    const yieldPerHash = Number(coin?.minProportion) || 0;
    const usdRate = resolveNftRoomCoinUsdRate(coin);
    if (yieldPerHash <= 0 || usdRate <= 0) continue;
    estimatedUsdPerDay += a.effectiveHash * yieldPerHash * usdRate * 86400;
  }

  return {
    asicCount: asics.length,
    totalInvestedUsd,
    recoveredUsd,
    remainingUsd,
    progressPercent,
    estimatedUsdPerDay,
    asics,
    hashByExclusiveCoin: buildExclusiveCoinHashRows(asics, miningCoins)
  };
}

export function formatUsdCompact(val: number, investedUsd?: number): string {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (n >= 10_000) return `$${(n / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
  if (n < 0.01) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
  const inv = Number(investedUsd);
  if (Number.isFinite(inv) && inv > 0 && inv - n > 0 && inv - n < 1) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
