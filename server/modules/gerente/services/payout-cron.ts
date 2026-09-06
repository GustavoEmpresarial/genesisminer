/**
 * Cron horário de payout da share do gerente (semanas UTC fechadas).
 *
 * **No-op:** o loop vive em `genesis-mining-worker` (`run_gerente_payout_loop`,
 * Redis lock `genesis:lock:job:gerente-payout`, intervalo `MS_PER_HOUR`).
 * Money TX continua em `POST /v1/gerente/payout` (fail-closed).
 *
 * Mantido como export de bootstrap para não partir `startBackgroundSchedulers`.
 */
import { log } from '../../../core/ops/logger.js';

export function startGerentePayoutCron(): () => void {
  log.info('gerente payout cron not scheduled', {
    module: 'gerente_payout',
    event: 'disabled',
    reason: 'Rust mining-worker owns gerente payout tick'
  });
  return () => undefined;
}
