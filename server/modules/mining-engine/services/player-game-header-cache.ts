/**
 * Cache por user do snapshot do header do jogo (Tokens / USDC / Hash).
 *
 * O GET `/api/player-game/header` passou para genesis-api (Rust); em Node só
 * resta a invalidação, chamada pelos hooks Kafka (`core/kafka/header-notify.ts`
 * e `core/kafka/consumer-header-invalidate.ts`) quando o saldo/hash muda.
 */
const headerCacheByUser = new Map<number, unknown>();

export function invalidatePlayerGameHeaderCache(userId?: number): void {
  if (userId == null) {
    headerCacheByUser.clear();
    return;
  }
  headerCacheByUser.delete(userId);
}
