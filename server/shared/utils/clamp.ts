/**
 * `clamp(n, lo, hi)` — restringe um número inteiro a um intervalo `[lo, hi]`,
 * com fallback para `lo` quando `n` não é um número finito (`NaN`, `Infinity`,
 * `undefined` convertido, etc.). Usado nos módulos admin para normalizar
 * `page`/`limit`/`userId` vindos de query string antes de montar SQL.
 *
 * Existiam cópias idênticas desta função em vários módulos admin (cada um
 * reinventando o mesmo corpo de 3 linhas) — esta é a versão compartilhada,
 * pensada pro mesmo padrão de `shared/utils/time.ts` (fonte única em vez de
 * duplicar). `modules/admin/user-audit`, `modules/admin/referral/services/format.ts`
 * (que reexporta `clamp` para não quebrar consumidores existentes) foram
 * migrados para importar daqui — as cópias locais equivalentes foram removidas.
 */

/**
 * Restringe `n` ao intervalo fechado `[lo, hi]`, arredondando para baixo
 * (`Math.floor`) — pensado para paginação/limites onde o valor final precisa
 * ser um inteiro.
 *
 * @param n - Valor candidato. Pode vir de `parseInt`/`Number` sobre input
 *   não confiável (query string), por isso o cuidado com `NaN`/`Infinity`.
 * @param lo - Limite inferior (inclusive). Também é o valor de fallback
 *   quando `n` não é finito.
 * @param hi - Limite superior (inclusive).
 * @returns `n` arredondado para baixo e restrito a `[lo, hi]`; `lo` se `n`
 *   não for um número finito.
 */
export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
