import type { Consumer, EachMessagePayload } from 'kafkajs';

import { invalidateRankingCachesFromKafka } from '../../modules/ranking/services/mining-ranking.js';
import { getKafka } from './client.js';
import { kafkaEnabled, KAFKA_RANKING_CACHE_GROUP_ID } from './config.js';
import { KAFKA_TOPIC_RANKING_SNAPSHOT } from './topics.js';

let consumer: Consumer | null = null;

/** Aplica invalidate a partir do valor (também testes sem broker). */
export function applyRankingSnapshotFromMessageValue(value: Buffer | string | null | undefined): boolean {
  if (value == null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : value.toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const o = parsed as Record<string, unknown>;
  if (o.reason != null && String(o.reason) !== 'ranking_snapshot') return false;
  invalidateRankingCachesFromKafka();
  return true;
}

async function onEachMessage({ message }: EachMessagePayload): Promise<void> {
  applyRankingSnapshotFromMessageValue(message.value);
}

export async function startRankingSnapshotConsumer(): Promise<void> {
  if (!kafkaEnabled()) return;
  if (consumer) return;
  const k = getKafka();
  if (!k) return;
  const c = k.consumer({ groupId: KAFKA_RANKING_CACHE_GROUP_ID });
  try {
    await c.connect();
    await c.subscribe({ topics: [KAFKA_TOPIC_RANKING_SNAPSHOT], fromBeginning: false });
    await c.run({ eachMessage: onEachMessage });
    consumer = c;
    console.info('[kafka] ranking-snapshot consumer started group=%s', KAFKA_RANKING_CACHE_GROUP_ID);
  } catch (err) {
    console.warn('[kafka] ranking-snapshot consumer failed', err instanceof Error ? err.message : err);
    try {
      await c.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export async function stopRankingSnapshotConsumer(): Promise<void> {
  const c = consumer;
  consumer = null;
  if (!c) return;
  try {
    await c.disconnect();
  } catch (err) {
    console.warn('[kafka] ranking consumer disconnect failed', err instanceof Error ? err.message : String(err));
  }
}
