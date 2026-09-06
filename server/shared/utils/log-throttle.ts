/**
 * Evita spam de `console.warn`/`console.log` sob carga (ex.: um aviso de
 * divergência de estado que dispararia uma vez por bateria × N jogadores,
 * inundando o log em vez de sinalizar o problema).
 *
 * Estado em memória de processo (`Map`), não distribuído — cada réplica tem
 * seu próprio throttle. Isso é intencional: o objetivo é proteger o próprio
 * processo de flood de I/O de log, não coordenar uma taxa global entre
 * réplicas (pra isso seria preciso Redis, overhead que não compensa aqui).
 *
 * Migrado de legacy/backend/lib/logThrottle.ts (sem mudança de comportamento).
 */

/** Timestamp (ms) da última emissão aceita, por chave. */
const lastEmittedAtByKey = new Map<string, number>();

/** Teto de chaves distintas em memória antes de forçar limpeza — evita leak
 *  de memória sob alta cardinalidade de chaves (ex.: chave incluindo userId). */
const MAX_TRACKED_KEYS = 8000;

/** Piso de TTL: nunca deixa throttlar mais rápido que 1x por segundo, mesmo
 *  se o chamador pedir um `ttlMs` menor (ou 0/negativo/NaN) por engano. */
const MIN_TTL_MS = 1000;

/** Janela mínima usada como corte na limpeza por idade, mesmo que o TTL
 *  pedido pela chamada mais recente seja bem curto — evita que uma chamada
 *  com TTL de 1s apague entradas de outra chave que pediu TTL de 5min. */
const CLEANUP_CUTOFF_FLOOR_MS = 60_000;

/**
 * Decide se um log associado a `key` deve ser emitido agora, ou se está
 * dentro da janela de throttle e deve ser descartado.
 *
 * Efeito colateral: em caso de emissão aceita, registra `now` como o novo
 * "último emitido" para essa chave. Quando o número de chaves rastreadas
 * ultrapassa `MAX_TRACKED_KEYS`, faz uma limpeza por idade (remove entradas
 * mais velhas que `max(ttl, CLEANUP_CUTOFF_FLOOR_MS)`); se mesmo assim ainda
 * estiver acima do teto (alta cardinalidade sustentada), zera tudo — prefere
 * permitir alguns logs extras a manter um `Map` crescendo sem limite.
 *
 * @param key - Identifica o "tipo" de mensagem a throttlar (ex.:
 *   `battery_state_divergence:${userId}`). Chaves diferentes têm janelas
 *   independentes.
 * @param ttlMs - Janela mínima entre duas emissões aceitas para a mesma
 *   chave. Valores abaixo de `MIN_TTL_MS` (ou inválidos) são elevados a ele.
 * @param now - Timestamp atual em ms; parametrizável para teste determinístico.
 * @returns `true` se o chamador deve emitir o log agora; `false` se deve
 *   descartar (ainda dentro da janela de throttle da chave).
 */
export function shouldEmitThrottled(key: string, ttlMs: number, now = Date.now()): boolean {
  const ttl = Math.max(MIN_TTL_MS, Math.floor(ttlMs || 0));
  const lastEmittedAt = lastEmittedAtByKey.get(key) || 0;
  if (lastEmittedAt > 0 && now - lastEmittedAt < ttl) return false;

  lastEmittedAtByKey.set(key, now);
  if (lastEmittedAtByKey.size > MAX_TRACKED_KEYS) {
    const cutoff = now - Math.max(ttl, CLEANUP_CUTOFF_FLOOR_MS);
    for (const [trackedKey, trackedAt] of lastEmittedAtByKey) {
      if (trackedAt < cutoff) lastEmittedAtByKey.delete(trackedKey);
    }
    if (lastEmittedAtByKey.size > MAX_TRACKED_KEYS) lastEmittedAtByKey.clear();
  }
  return true;
}
