import { Kafka, type Producer } from 'kafkajs';
import { kafkaBrokers, kafkaClientId, kafkaEnabled } from './config.js';

let kafkaSingleton: Kafka | null = null;
let producerSingleton: Producer | null = null;
let producerConnecting: Promise<Producer | null> | null = null;

export function getKafka(): Kafka | null {
  if (!kafkaEnabled()) return null;
  if (kafkaSingleton) return kafkaSingleton;
  kafkaSingleton = new Kafka({
    clientId: kafkaClientId(),
    brokers: kafkaBrokers()
  });
  return kafkaSingleton;
}

/** Producer partilhado; null se Kafka desligado. */
export async function getKafkaProducer(): Promise<Producer | null> {
  if (!kafkaEnabled()) return null;
  if (producerSingleton) return producerSingleton;
  if (producerConnecting) return producerConnecting;
  producerConnecting = (async () => {
    const k = getKafka();
    if (!k) return null;
    const p = k.producer();
    await p.connect();
    producerSingleton = p;
    return p;
  })()
    .catch((err) => {
      console.warn('[kafka] producer connect failed', err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => {
      producerConnecting = null;
    });
  return producerConnecting;
}

export async function disconnectKafkaProducer(): Promise<void> {
  const p = producerSingleton;
  producerSingleton = null;
  if (!p) return;
  try {
    await p.disconnect();
  } catch (err) {
    console.warn('[kafka] producer disconnect failed', err instanceof Error ? err.message : err);
  }
}

/** Só testes — limpa singletons. */
export function resetKafkaClientForTests(): void {
  kafkaSingleton = null;
  producerSingleton = null;
  producerConnecting = null;
}
