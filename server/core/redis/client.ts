/**
 * Cliente Redis singleton — usado por `./lock.ts` (lock distribuído),
 * `./json-cache.ts` (cache) e `../socket/attach.ts` (adapter pub/sub do
 * Socket.IO, via `.duplicate()`). Opcional: sem `REDIS_URL`, `getRedis()`
 * devolve `null` e quem chama deve degradar graciosamente (ex.: locks viram
 * no-op, cache é ignorado).
 *
 * ⚠️ Não há fila BullMQ no projeto atual (`bullmq` não é dependência —
 * decisão registrada em DECISIONS.md #40; o único worker BullMQ do legado,
 * `legacy/backend/workers/bullGenesisWorker.ts`, não foi portado porque o job
 * que ele processava já roda in-process via cron no `app`
 * (`modules/mining-engine/services/yield-cron.ts`, lock Redis). Se isso mudar no
 * futuro, um novo consumidor de fila reaproveitaria este cliente único, não
 * abriria conexão própria.
 *
 * Migrado de legacy/backend/lib/genesisStack/init.ts (metade Redis) — consolida
 * também a segunda conexão que existia solta em legacy/backend/lib/redisDistributedLock.ts
 * (duas instâncias de ioredis para o mesmo Redis; agora é uma só).
 */
import { Redis } from 'ioredis';

let redis: Redis | null = null;

/** `null` se nunca conectado ou se a conexão falhou/não foi configurada. */
export function getRedis(): Redis | null {
  return redis;
}

/**
 * Conecta ao Redis se `REDIS_URL` estiver definida; nunca lança — falha de
 * conexão é logada e {@link getRedis} passa a devolver `null` (Redis é
 * opcional; locks/cache degradam para no-op sem ele).
 */
export async function connectRedis(): Promise<void> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    console.log('[Redis] REDIS_URL não definido — Redis ignorado');
    return;
  }
  try {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: null });
    await client.ping();
    redis = client;
    console.log('[Redis] conectado');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[Redis] indisponível:', msg);
    redis = null;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (!redis) return;
  await redis.quit();
  redis = null;
}
