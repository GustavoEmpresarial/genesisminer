/**
 * Eventos que afectam o strip da navbar (USDC / moedas / H/s).
 * Invalida cache local já; publica Kafka para outras réplicas quando enabled.
 */
import { invalidatePlayerGameHeaderCache } from '../../modules/mining-engine/services/player-game-header-cache.js';
import type { PlayerHeaderEvent, PlayerHeaderEventReason } from './header-events.js';
import { publishJson } from './producer.js';
import { KAFKA_TOPIC_ECONOMY_LEDGER, KAFKA_TOPIC_MINING_PROGRESS } from './topics.js';

export function notifyMiningProgressHeader(
  userId: number,
  extra?: { totalHash?: number }
): void {
  invalidatePlayerGameHeaderCache(userId);
  const ev: PlayerHeaderEvent = {
    userId,
    reason: 'mining_progress',
    at: Date.now(),
    ...(extra?.totalHash != null ? { totalHash: extra.totalHash } : {})
  };
  void publishJson(KAFKA_TOPIC_MINING_PROGRESS, String(userId), ev);
}

export function notifyEconomyLedgerHeader(
  userId: number,
  reason: Extract<PlayerHeaderEventReason, 'exchange_liquidate' | 'deposit_credited'>,
  extra?: { usdc?: number }
): void {
  invalidatePlayerGameHeaderCache(userId);
  const ev: PlayerHeaderEvent = {
    userId,
    reason,
    at: Date.now(),
    ...(extra?.usdc != null ? { usdc: extra.usdc } : {})
  };
  void publishJson(KAFKA_TOPIC_ECONOMY_LEDGER, String(userId), ev);
}
