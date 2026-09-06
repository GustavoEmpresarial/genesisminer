/**
 * Paga semanas UTC fechadas e ainda não liquidadas da share do gerente.
 *
 * Money TX em `genesis-mining-worker` (`POST /v1/gerente/payout`, fail-closed).
 * Accrual já vive no worker; payout idempotente via `am_payout:{contract}:{coin}:{week}`.
 *
 * Catch-up: processa **todas** as linhas com `week_start < openWeekStart` e
 * `paid_at IS NULL`. Feature off: no-op sem HTTP.
 */
import { opsConfig } from '../../../core/ops/config.js';
import { isAccountManagerEnabled } from './feature.js';
import { callMiningWorkerGerentePayout } from '../../mining-engine/services/mining-worker-client.js';

export type PayClosedManagerWeeksResult = {
  paid: number;
  skipped: number;
};

/**
 * Liquida accruals fechados via mining-worker (fail-closed).
 * `shouldStop` true antes do HTTP → early return; abort durante o pedido via `signal`.
 */
export async function payClosedManagerWeeks(
  nowMs: number,
  shouldStop?: () => boolean,
  signal?: AbortSignal
): Promise<PayClosedManagerWeeksResult> {
  if (!isAccountManagerEnabled()) {
    return { paid: 0, skipped: 0 };
  }
  if (shouldStop?.()) {
    return { paid: 0, skipped: 0 };
  }

  const out = await callMiningWorkerGerentePayout({
    serverNowMs: nowMs,
    signal,
    timeoutMs: opsConfig.jobTimeouts.gerentePayout
  });
  if (!out.ok) {
    throw new Error(out.error ?? 'GENESIS_MINING_WORKER_URL unset');
  }
  return { paid: out.paid, skipped: out.skipped };
}
