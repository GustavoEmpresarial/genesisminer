/**
 * Cron do expurgo de idempotência.
 *
 * **No-op:** o loop vive em `genesis-mining-worker` (`run_idempotency_purge_loop`,
 * Redis lock `genesis:lock:job:idempotency-purge`, intervalo `MS_PER_HOUR`,
 * retenção 30d). Mantido como export de bootstrap para não partir
 * `startBackgroundSchedulers`.
 */
import { log } from '../../../../core/ops/logger.js';

export function startIdempotencyPurgeCron(): () => void {
  log.info('idempotency purge cron not scheduled', {
    module: 'idempotency_purge',
    event: 'disabled',
    reason: 'Rust mining-worker owns idempotency purge tick'
  });
  return () => undefined;
}
