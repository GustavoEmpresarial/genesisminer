/**
 * Public mining ranking — GET `/api/ranking/public`
 * Routes: `current/server/modules/ranking/`
 */
import { apiFetch } from './http';

const base = '/api';

export type RankingCoin = {
  id: string;
  name: string;
  symbol: string;
};

export type PublicRankingUser = {
  user_id: number;
  username: string;
  /** Poder por moeda (inclui Sala NFT / ASIC). */
  coins: Record<string, number>;
  /** Poder por moeda só de rigs fora da Sala NFT (ranking geral / GPU). */
  generalCoins?: Record<string, number>;
  generalPower?: number;
};

export type PublicRankingPayload = {
  timestamp: number;
  ranking: PublicRankingUser[];
  coins: RankingCoin[];
};

export async function getPublicRanking(signal?: AbortSignal): Promise<PublicRankingPayload> {
  const res = await apiFetch(`${base}/ranking/public?t=${Date.now()}`, { signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j?.error === 'string' && j.error.trim()) msg = j.error.trim();
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as PublicRankingPayload;
}
