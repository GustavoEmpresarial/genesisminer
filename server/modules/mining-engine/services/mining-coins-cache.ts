/**
 * Mapa id → is_active de `mining_coins`, com Redis + Prisma (menos pressão no pool `pg`
 * no hot path de mineração).
 *
 * Migrado de legacy/backend/lib/stack/miningCoinsPrismaCache.ts (verbatim).
 */
import { prisma } from '../../../core/database/prisma.js';
import { redisDel, redisJsonGet, redisJsonSet } from '../../../core/redis/json-cache.js';

const CACHE_KEY = 'cache:mining_coins:active_map_v1';
const TTL_SEC = 45;

export type MiningCoinActiveRow = { id: string; is_active: boolean };

export async function getMiningCoinsActiveMap(): Promise<Map<string, { isActive: boolean }>> {
  const cached = await redisJsonGet<Record<string, { isActive: boolean }>>(CACHE_KEY);
  if (cached) {
    return new Map(Object.entries(cached));
  }

  const rows = await prisma.mining_coins.findMany({ select: { id: true, is_active: true } });

  const obj: Record<string, { isActive: boolean }> = {};
  for (const r of rows) {
    obj[String(r.id)] = { isActive: !!r.is_active };
  }
  await redisJsonSet(CACHE_KEY, obj, TTL_SEC);
  return new Map(Object.entries(obj));
}

export async function invalidateMiningCoinsCache(): Promise<void> {
  await redisDel(CACHE_KEY);
}
