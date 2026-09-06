/**
 * Lock distribuído (Redis `SET NX EX`). Uma única implementação com duas formas de uso:
 *   - `tryAcquireDistributedLock`/`releaseDistributedLock` — handle explícito (para locks
 *     que atravessam múltiplas chamadas, ex.: tick de mineração).
 *   - `withRedisLock(key, ttl, fn)` — açúcar de callback (adquire, roda `fn`, liberta sempre).
 *
 * Sem Redis conectado (`../redis/client.ts` sem `REDIS_URL`), ambos degradam para
 * "sem lock": `tryAcquireDistributedLock` devolve sempre um handle válido, `withRedisLock`
 * roda `fn` direto. `GENESIS_REDIS_LOCKS_ENABLED=0` força esse modo mesmo com Redis disponível.
 *
 * Migrado de legacy/backend/lib/redisDistributedLock.ts + legacy/backend/lib/stack/redisLock.ts
 * — eram duas implementações independentes (com duas conexões ioredis próprias) para o
 * mesmo propósito; consolidadas aqui sobre o cliente único de `./client.ts`.
 */
import { getRedis } from './client.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../shared/utils/time.js';

const LOCKS_ENABLED = String(process.env.GENESIS_REDIS_LOCKS_ENABLED ?? '1').trim() !== '0';

/** Margem de TTL vs timeout do job (espelho mining-yield: 3 min). */
const GERENTE_PAYOUT_LOCK_TTL_MINUTES = 3;

export type LockHandle = { key: string; token: string };

/** Base-36 pra token curto e legível (dígitos+letras); tamanho arbitrário mas fixo pro handle. */
const TOKEN_RADIX = 36;
const RANDOM_TOKEN_SLICE_START = 2;
const RANDOM_TOKEN_SLICE_END = 10;
const LOCK_TTL_SECONDS_MIN = 1;
/** Teto de TTL de lock — 30min, cobre dump SQL longo; jobs curtos usam TTL menor. */
const LOCK_TTL_SECONDS_MAX = 1800;

function clampLockTtlSeconds(ttlSeconds: number): number {
  return Math.max(LOCK_TTL_SECONDS_MIN, Math.min(Math.floor(ttlSeconds), LOCK_TTL_SECONDS_MAX));
}

/** Compare-and-delete atômico (só apaga se o dono ainda for quem pediu) — evita apagar o lock de outro dono numa corrida entre checar e apagar. */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

async function releaseLockAtomic(r: NonNullable<ReturnType<typeof getRedis>>, key: string, token: string): Promise<void> {
  try {
    await r.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.warn('[RedisLock] release falhou:', key, m);
  }
}

export async function tryAcquireDistributedLock(
  key: string,
  ttlSeconds: number,
  token?: string
): Promise<LockHandle | null> {
  const r = LOCKS_ENABLED ? getRedis() : null;
  if (!r) {
    return { key, token: token || 'no-redis' };
  }
  const t =
    token ||
    `${process.pid}:${Date.now()}:${Math.random()
      .toString(TOKEN_RADIX)
      .slice(RANDOM_TOKEN_SLICE_START, RANDOM_TOKEN_SLICE_END)}`;
  const ok = await r.set(key, t, 'EX', clampLockTtlSeconds(ttlSeconds), 'NX');
  if (ok !== 'OK') return null;
  return { key, token: t };
}

export async function releaseDistributedLock(handle: LockHandle | null): Promise<void> {
  if (!handle) return;
  const r = LOCKS_ENABLED ? getRedis() : null;
  if (!r) return;
  await releaseLockAtomic(r, handle.key, handle.token);
}

const WITH_LOCK_PREFIX = 'lock:';

/** Adquire, roda `fn`, liberta sempre. Devolve `null` se não conseguiu adquirir o lock. */
export async function withRedisLock<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T | null> {
  const r = LOCKS_ENABLED ? getRedis() : null;
  if (!r) {
    return fn();
  }
  const lockKey = `${WITH_LOCK_PREFIX}${key}`;
  const token = `${Date.now()}_${Math.random().toString(TOKEN_RADIX).slice(RANDOM_TOKEN_SLICE_START)}`;
  const ok = await r.set(lockKey, token, 'EX', clampLockTtlSeconds(ttlSec), 'NX');
  if (ok !== 'OK') {
    return null;
  }
  try {
    return await fn();
  } finally {
    // Compare-and-delete atômico (mesmo script de `releaseDistributedLock`) — GET+DEL em
    // duas chamadas separadas permitia apagar o lock de outro dono se o TTL expirasse
    // entre as duas.
    await releaseLockAtomic(r, lockKey, token);
  }
}

export const REDIS_LOCK_KEYS = {
  miningYieldTick: 'genesis:lock:mining_yield_tick',
  miningProgressUser: (userId: number) => `genesis:lock:mining_progress:user:${userId}`,
  /** Jobs de fundo do processo único `app` (coordenação se houver >1 réplica). */
  jobBackupSql: 'genesis:lock:job:backup-sql',
  jobChatTtl: 'genesis:lock:job:chat-ttl',
  jobPublicRanking: 'genesis:lock:job:public-ranking',
  jobIdempotencyPurge: 'genesis:lock:job:idempotency-purge',
  jobGerentePayout: 'genesis:lock:job:gerente-payout'
} as const;

/** TTLs (segundos) por job — devem cobrir a duração esperada sem serem absurdos. */
export const REDIS_LOCK_TTL_SECONDS = {
  miningYieldTick: 180,
  backupSql: 1800,
  chatTtl: 120,
  publicRanking: 300,
  idempotencyPurge: 600,
  /** Cobre `opsConfig.jobTimeouts.gerentePayout` (default 2 min) — espelho mining-yield. */
  gerentePayout: GERENTE_PAYOUT_LOCK_TTL_MINUTES * (MS_PER_MINUTE / MS_PER_SECOND)
} as const;
