/**
 * Contrato do event log de elegibilidade de mineração (4C / cutover).
 *
 * Fonte histórica válida apenas para eventos com at_ms >= cutover.
 * Sem backfill fictício do passado.
 */

export const MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT = Date.UTC(2026, 7, 21, 12, 0, 0, 0);

export function miningEligibilityHistoryCutoverMs(): number {
  const raw = process.env.MINING_ELIGIBILITY_HISTORY_CUTOVER_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return MINING_ELIGIBILITY_HISTORY_CUTOVER_MS_DEFAULT;
}

/**
 * Ordenação canónica para qualquer reconstrução / replay pós-cutover.
 *
 * ```sql
 * ORDER BY at_ms ASC, id ASC
 * ```
 *
 * - `at_ms` — instante económico da transição; o novo estado vale `[at_ms, …)`.
 * - `id` (BIGSERIAL) — desempate determinístico quando vários eventos partilham `at_ms`.
 */
export const MINING_ELIGIBILITY_EVENTS_REPLAY_ORDER_SQL = 'ORDER BY at_ms ASC, id ASC' as const;

/**
 * Semântica de timestamps para `ASIC_EXPIRED`:
 *
 * - `lease.expires_at` / `payload.expires_at` = fim económico contratual (T1).
 * - `ASIC_EXPIRED.at_ms` = instante em que o sistema materializou a transição
 *   stock|equipped → expired (T2 ≥ T1 se o expire correr atrasado).
 *
 * O replay de elegibilidade da lease deve terminar em `expires_at` (domínio),
 * não em `ASIC_EXPIRED.at_ms`, para não creditar o atraso operacional T2−T1.
 */
export const ASIC_EXPIRED_TIMESTAMP_CONTRACT = {
  contractualEndField: 'expires_at',
  operationalMaterializationField: 'at_ms'
} as const;

/** Regras de escrita do event log (resumo). */
export const MINING_ELIGIBILITY_EVENT_LOG_CONTRACT = {
  appendOnly: true,
  replayOrderSql: MINING_ELIGIBILITY_EVENTS_REPLAY_ORDER_SQL,
  mutationAndEventSameTransaction: true,
  captureIdentityBeforeClear: true,
  noFictionalBackfill: true,
  cutoverMs: miningEligibilityHistoryCutoverMs,
  asicExpiredTimestamps: ASIC_EXPIRED_TIMESTAMP_CONTRACT
} as const;
