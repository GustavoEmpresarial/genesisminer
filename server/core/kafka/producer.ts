import { kafkaEnabled } from './config.js';
import { getKafkaProducer } from './client.js';

/**
 * Publica JSON fire-and-forget. Nunca lança para o caller HTTP.
 * No-op se KAFKA_ENABLED≠1 ou brokers vazios / producer indisponível.
 */
export async function publishJson(
  topic: string,
  key: string | null,
  payload: unknown
): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!kafkaEnabled()) return { ok: true, skipped: true };
  try {
    const producer = await getKafkaProducer();
    if (!producer) return { ok: false, skipped: true };
    await producer.send({
      topic,
      messages: [
        {
          key: key ?? undefined,
          value: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' }
        }
      ]
    });
    return { ok: true };
  } catch (err) {
    console.warn(
      '[kafka] publish failed topic=%s key=%s err=%s',
      topic,
      key,
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false };
  }
}
