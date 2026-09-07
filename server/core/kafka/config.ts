/**
 * Config Kafka (opt-in). Default off — sem brokers / KAFKA_ENABLED≠1 → no-op.
 * Espelha deploy/k8s ConfigMap + deploy/kafka/topics.md.
 */
export function kafkaEnabled(): boolean {
  const flag = String(process.env.KAFKA_ENABLED ?? '0').trim();
  if (flag !== '1' && flag.toLowerCase() !== 'true') return false;
  return kafkaBrokers().length > 0;
}

export function kafkaBrokers(): string[] {
  return String(process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function kafkaClientId(): string {
  const id = String(process.env.KAFKA_CLIENT_ID || 'genesis-app').trim();
  return id || 'genesis-app';
}


/** Consumer group para invalidação do fallback local do ranking. */
export const KAFKA_RANKING_CACHE_GROUP_ID = 'genesis-app-ranking-cache';
