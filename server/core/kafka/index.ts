import { kafkaEnabled } from './config.js';
import { disconnectKafkaProducer, getKafkaProducer } from './client.js';
import { startHeaderInvalidateConsumer, stopHeaderInvalidateConsumer } from './consumer-header-invalidate.js';
import {
  startRankingSnapshotConsumer,
  stopRankingSnapshotConsumer
} from './consumer-ranking-snapshot.js';

/** Liga producer + consumers de invalidate (no-op se disabled). */
export async function startKafkaIfEnabled(): Promise<void> {
  if (!kafkaEnabled()) {
    console.info('[kafka] disabled (KAFKA_ENABLED≠1 or empty brokers)');
    return;
  }
  await getKafkaProducer();
  await startHeaderInvalidateConsumer();
  await startRankingSnapshotConsumer();
}

export async function stopKafka(): Promise<void> {
  await stopRankingSnapshotConsumer();
  await stopHeaderInvalidateConsumer();
  await disconnectKafkaProducer();
}

export { kafkaEnabled, kafkaBrokers, kafkaClientId } from './config.js';
export { publishJson } from './producer.js';
export { notifyMiningProgressHeader, notifyEconomyLedgerHeader } from './header-notify.js';
export {
  KAFKA_TOPIC_MINING_PROGRESS,
  KAFKA_TOPIC_ECONOMY_LEDGER,
  KAFKA_TOPIC_RANKING_SNAPSHOT,
  KAFKA_TOPIC_PARTNER_GAMES_SESSION,
  KAFKA_TOPIC_MARKET_EVENTS,
  KAFKA_TOPIC_LUCKY_BOX_OPEN,
  KAFKA_HEADER_INVALIDATE_TOPICS
} from './topics.js';
export { applyHeaderInvalidateFromMessageValue } from './consumer-header-invalidate.js';
export { applyRankingSnapshotFromMessageValue } from './consumer-ranking-snapshot.js';
export { parsePlayerHeaderEvent, type PlayerHeaderEvent } from './header-events.js';
