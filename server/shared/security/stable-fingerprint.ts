/**
 * Fingerprint estável (SHA-256, truncado) de um objeto — usado pra comparar
 * "mesma chave de idempotência, mesmo pedido" vs. replay com corpo diferente.
 * Se o cliente reenvia a mesma `idempotencyKey` mas com payload diferente do
 * pedido original (bug de cliente, ou tentativa de abuso), o fingerprint não
 * bate e o módulo consumidor pode recusar com `409 IDEMPOTENCY_PAYLOAD_MISMATCH`
 * em vez de silenciosamente devolver a resposta cacheada do pedido antigo.
 *
 * Ordena as chaves do objeto antes de serializar — sem isso, `JSON.stringify`
 * de dois objetos com as mesmas chaves em ordens diferentes ({a,b} vs {b,a})
 * produziria fingerprints diferentes para o "mesmo" pedido lógico.
 *
 * Migrado de legacy/backend/lib/gameIntentIdempotencyPrisma.ts (só
 * `stableIntentFingerprint` — o resto do arquivo é a tabela
 * `game_servers_intent_idempotency`, específica do fluxo de servers/racks
 * ainda não migrado por completo). Também reaproveitado por
 * `modules/lucky-boxes/services/idempotency.ts`.
 */
import crypto from 'node:crypto';

/** Tamanho do fingerprint final (hex). Truncar o SHA-256 (que tem 64 chars
 *  hex) é aceitável aqui porque o objetivo é detectar mudança de payload
 *  entre duas chamadas com a mesma chave de idempotência, não resistir a
 *  ataque de colisão deliberada — 32 chars hex (128 bits) já é folga enorme
 *  pra esse caso de uso. */
const FINGERPRINT_LENGTH = 32;

/**
 * Calcula o fingerprint de `parts` (as "partes" que definem unicamente o
 * pedido — ex. `{ op: 'lucky_box_open', boxId }`).
 *
 * Determinístico independente da ordem das chaves em `parts`.
 */
export function stableIntentFingerprint(parts: Record<string, unknown>): string {
  const sortedKeys = Object.keys(parts).sort();
  const orderedParts: Record<string, unknown> = {};
  for (const key of sortedKeys) orderedParts[key] = parts[key];
  return crypto.createHash('sha256').update(JSON.stringify(orderedParts)).digest('hex').slice(0, FINGERPRINT_LENGTH);
}
