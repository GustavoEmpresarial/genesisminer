/**
 * Migrado de legacy/backend/lib/checkinBonusHash.ts (verbatim).
 */
import { isNftMiningRoomId, isNftRoomExclusiveMiningCoinRef } from './nft-room-mining.js';
import { isAsicMiningRoomId } from './room-kind.js';

export type CheckinHashEntry = {
  coinId: string;
  roomId: string | null;
  baseHps: number;
  /** false = ASIC/NFT special — fora da base e da distribuição do bónus de check-in. */
  countsTowardGeneralPower?: boolean;
};

function entryEligibleForCheckinBonusBase(
  e: CheckinHashEntry,
  nftRoomIds: ReadonlySet<string>,
  asicRoomIds?: ReadonlySet<string> | null
): boolean {
  if (e.countsTowardGeneralPower === false) return false;
  if (isNftMiningRoomId(e.roomId, nftRoomIds)) return false;
  if (isAsicMiningRoomId(e.roomId, asicRoomIds)) return false;
  if (isNftRoomExclusiveMiningCoinRef(e.coinId)) return false;
  return true;
}

/** Soma H/s de rigs operacionais elegíveis ao bónus (fora Sala NFT / ASICs / créditos special). */
export function sumNonNftRoomRigHashHps(
  entries: Array<CheckinHashEntry>,
  nftRoomIds: ReadonlySet<string>,
  asicRoomIds?: ReadonlySet<string> | null
): number {
  let total = 0;
  for (const e of entries) {
    if (!entryEligibleForCheckinBonusBase(e, nftRoomIds, asicRoomIds)) continue;
    const h = Number(e.baseHps);
    if (Number.isFinite(h) && h > 0) total += h;
  }
  return total;
}

/** H/s efectivo para yield = base da rig + quota proporcional do bónus acumulado de check-in. */
export function effectiveHashWithCheckinBonus(
  baseHps: number,
  coinId: string,
  roomId: string | null,
  bonusHps: number,
  totalNonNftRigHash: number,
  nftRoomIds: ReadonlySet<string>,
  asicRoomIds?: ReadonlySet<string> | null,
  countsTowardGeneralPower?: boolean
): number {
  const base = Number(baseHps);
  if (!Number.isFinite(base) || base < 0) return 0;
  const bonus = Number(bonusHps);
  if (!Number.isFinite(bonus) || bonus <= 0 || totalNonNftRigHash <= 0) return base;
  if (countsTowardGeneralPower === false) return base;
  if (isNftMiningRoomId(roomId, nftRoomIds)) return base;
  if (isAsicMiningRoomId(roomId, asicRoomIds)) return base;
  if (isNftRoomExclusiveMiningCoinRef(coinId)) return base;
  return base + bonus * (base / totalNonNftRigHash);
}

/**
 * Agrega H/s por moeda com bónus de check-in (mesma regra que mineração/yield).
 * Rigs na Sala Dólar/NFTs, Sala ASICs e moedas exclusivas NFT ficam só com o H/s base.
 */
export function aggregateHashByCoinWithCheckinBonus(
  entries: CheckinHashEntry[],
  bonusHps: number,
  nftRoomIds: ReadonlySet<string>,
  asicRoomIds?: ReadonlySet<string> | null
): Record<string, number> {
  const totalNonNftRigHash = sumNonNftRoomRigHashHps(entries, nftRoomIds, asicRoomIds);
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const effective = effectiveHashWithCheckinBonus(
      entry.baseHps,
      entry.coinId,
      entry.roomId,
      bonusHps,
      totalNonNftRigHash,
      nftRoomIds,
      asicRoomIds,
      entry.countsTowardGeneralPower
    );
    if (!Number.isFinite(effective) || effective <= 0) continue;
    out[entry.coinId] = (out[entry.coinId] || 0) + effective;
  }
  return out;
}

/** @deprecated Preferir `aggregateHashByCoinWithCheckinBonus` (respeita sala + moeda). */
export function applyCheckinBonusToHashByCoin(hashByCoin: Record<string, number>, bonusHps: number): Record<string, number> {
  const out = { ...hashByCoin };
  const bonus = Number(bonusHps);
  if (!Number.isFinite(bonus) || bonus <= 0) return out;
  let total = 0;
  for (const [cid, v] of Object.entries(hashByCoin)) {
    if (isNftRoomExclusiveMiningCoinRef(cid)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  if (total <= 0) return out;
  for (const [cid, v] of Object.entries(hashByCoin)) {
    if (isNftRoomExclusiveMiningCoinRef(cid)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[cid] = n + bonus * (n / total);
  }
  return out;
}
