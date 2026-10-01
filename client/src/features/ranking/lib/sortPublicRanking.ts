/**
 * Pure sort/filter helpers for the public mining ranking (POWER view).
 * POWER uses `generalCoins` (excludes NFT/ASIC room power); yield/`coins` is unchanged.
 */
import type { PublicRankingPayload, PublicRankingUser } from '../../../shared/api/ranking';
import { isNftRoomExclusiveMiningCoin } from '../../servers/types';

export type RankedUser = PublicRankingUser & { power: number };

export function sumGeneralPower(u: PublicRankingUser, data: PublicRankingPayload): number {
  // generalCoins presente (mesmo {}) = fonte de verdade — não fallback para coins (ASIC-only → 0).
  if (u.generalCoins != null && typeof u.generalCoins === 'object') {
    return Object.values(u.generalCoins).reduce((acc, curr) => acc + (Number(curr) || 0), 0);
  }
  if (typeof u.generalPower === 'number' && Number.isFinite(u.generalPower)) {
    return u.generalPower;
  }
  return Object.entries(u.coins).reduce((acc, [coinId, curr]) => {
    const meta = data.coins.find((c) => c.id === coinId);
    if (meta && isNftRoomExclusiveMiningCoin(meta)) return acc;
    if (isNftRoomExclusiveMiningCoin(coinId)) return acc;
    return acc + curr;
  }, 0);
}

export function getSortedRanking(
  data: PublicRankingPayload,
  selectedCoin: string
): { list: RankedUser[]; activeCoin: string } {
  const activeCoin = selectedCoin;

  if (activeCoin === 'ALL') {
    const filtered = data.ranking
      .map((u) => ({ ...u, power: sumGeneralPower(u, data) }))
      .filter((u) => u.power > 0)
      .sort((a, b) => b.power - a.power);

    return { list: filtered, activeCoin: 'ALL' };
  }

  // Moeda específica — POWER usa generalCoins (exclui ASIC/NFT); `coins` fica para yield.
  const result = data.ranking
    .map((u) => ({
      ...u,
      power: u.generalCoins?.[activeCoin] ?? 0
    }))
    .filter((u) => u.power > 0)
    .sort((a, b) => b.power - a.power);

  return { list: result, activeCoin };
}
