/**
 * Chave de idempotência enviada pelo cliente em mutações sensíveis (compra na
 * loja, resgate, giro pago, criação de tickets, intents de servidor/rack...).
 *
 * O problema que resolve: o cliente pode reenviar a mesma requisição (timeout,
 * duplo clique, retry de rede) e, sem controle, isso repetiria o efeito
 * colateral (debitar saldo duas vezes, criar item duplicado, etc.). Para
 * evitar isso, o cliente gera uma chave única por tentativa de ação e a manda
 * junto do pedido; o servidor grava essa chave numa tabela `*_idempotency`
 * (ex.: `shop_checkout_idempotency`, `game_servers_intent_idempotency`) e, se
 * a mesma chave chegar de novo, devolve o resultado já processado em vez de
 * repetir o efeito.
 *
 * Este módulo cuida só da VALIDAÇÃO DE FORMATO da chave antes de ela ser
 * usada como parte de uma chave de idempotência em BD — não persiste nada e
 * não decide o que fazer em caso de replay (isso é responsabilidade de cada
 * módulo consumidor, ex. `modules/shop/services/checkout.ts`).
 *
 * Consumidores atuais: `modules/shop`, `modules/upgrades`, `modules/batteries`,
 * `modules/wheel`, `modules/support`, `modules/wallet`, `modules/servers`.
 *
 * Migrado de `legacy/backend/validation/roletaValidation.ts` (só a função
 * `parseIdempotencyKey` — o resto do arquivo era validação específica de
 * roleta/lucky-box, não genérica; por isso a extração para `shared/`).
 */

/** Comprimento mínimo aceite para a chave (após `trim`). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** Comprimento máximo aceite para a chave (após `trim`). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Alfabeto aceite: alfanumérico + `. _ : -` (sem espaços nem outros símbolos). */
const IDEMPOTENCY_KEY_RE = new RegExp(
  `^[a-zA-Z0-9_.:-]{${IDEMPOTENCY_KEY_MIN_LENGTH},${IDEMPOTENCY_KEY_MAX_LENGTH}}$`
);

/**
 * Valida e normaliza uma chave de idempotência recebida do cliente.
 *
 * @param raw - Valor bruto vindo do body/header da requisição (tipo ainda
 *   não confiável nesse ponto — por isso `unknown`).
 * @returns A chave normalizada (com espaços das pontas removidos) quando
 *   válida, ou `null` quando `raw` não é string ou não bate o formato
 *   esperado (fora dos limites de tamanho ou com caractere não permitido).
 */
export function parseIdempotencyKey(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return IDEMPOTENCY_KEY_RE.test(trimmed) ? trimmed : null;
}
