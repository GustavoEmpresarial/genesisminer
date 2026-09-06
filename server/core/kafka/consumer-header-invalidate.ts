import type { Consumer, EachMessagePayload } from 'kafkajs';
import { invalidatePlayerGameHeaderCache } from '../../modules/mining-engine/services/player-game-header-cache.js';
import { getKafka } from './client.js';
import { kafkaEnabled, KAFKA_HEADER_CACHE_GROUP_ID } from './config.js';
import { parsePlayerHeaderEvent } from './header-events.js';
import { KAFKA_HEADER_INVALIDATE_TOPICS } from './topics.js';

let consumer: Consumer | null = null;

/** Aplica invalidate a partir de valor de mensagem (também usado em testes sem broker). */
export function applyHeaderInvalidateFromMessageValue(value: Buffer | string | null | undefined): boolean {
  if (value == null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === 'string' ? value : value.toString('utf8'));
  } catch {
    return false;
  }
  const ev = parsePlayerHeaderEvent(parsed);
  if (!ev) return false;
  invalidatePlayerGameHeaderCache(ev.userId);
  return true;
}

async function onEachMessage({ message }: EachMessagePayload): Promise<void> {
  applyHeaderInvalidateFromMessageValue(message.value);
}

export async function startHeaderInvalidateConsumer(): Promise<void> {
  if (!kafkaEnabled()) return;
  if (consumer) return;
  const k = getKafka();
  if (!k) return;
  const c = k.consumer({ groupId: KAFKA_HEADER_CACHE_GROUP_ID });
  try {
    await c.connect();
    await c.subscribe({ topics: [...KAFKA_HEADER_INVALIDATE_TOPICS], fromBeginning: false });
    await c.run({ eachMessage: onEachMessage });
    consumer = c;
    console.info('[kafka] header-invalidate consumer started group=%s', KAFKA_HEADER_CACHE_GROUP_ID);
  } catch (err) {
    console.warn('[kafka] header-invalidate consumer failed', err instanceof Error ? err.message : err);
    try {
      await c.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export async function stopHeaderInvalidateConsumer(): Promise<void> {
  const c = consumer;
  consumer = null;
  if (!c) return;
  try {
    await c.disconnect();
  } catch (err) {
    console.warn('[kafka] consumer disconnect failed', err instanceof Error ? err.message : err);
  }
}
