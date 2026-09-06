/**
 * Cache JSON genérico sobre Redis (get/set com TTL, delete) — degrada para no-op
 * sem lançar quando Redis está indisponível (mesmo padrão de `core/redis/lock.ts`).
 *
 * Migrado de legacy/backend/lib/stack/redisCache.ts (`getGenesisRedis` → `getRedis`,
 * cliente único já consolidado em `core/redis/client.ts`).
 */
import { getRedis } from './client.js';

/** Lê e faz `JSON.parse` de `key`. `null` se Redis indisponível, chave
 *  ausente, ou valor não for JSON válido (nunca lança). */
export async function redisJsonGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  const s = await r.get(key);
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Piso de TTL — nunca grava sem expiração, mesmo se `ttlSec` vier 0/negativo. */
const MIN_TTL_SECONDS = 1;

/** Serializa `value` como JSON e grava com expiração `ttlSec` (segundos).
 *  No-op silencioso se Redis indisponível. */
export async function redisJsonSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(key, JSON.stringify(value), 'EX', Math.max(MIN_TTL_SECONDS, Math.floor(ttlSec)));
}

/** Remove `key`. No-op silencioso se Redis indisponível ou chave ausente. */
export async function redisDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(key);
}
