/**
 * Agenda todos os jobs de fundo no mesmo processo HTTP (`app`).
 *
 * Coordenação entre réplicas: cada job usa Redis lock (`core/redis/lock.ts`).
 * Kill-switch de emergência: `SCHEDULER_ENABLED=0`.
 */
import { startScheduledSqlBackups } from '../modules/admin/backup/index.js';
import { startIdempotencyPurgeCron } from '../modules/admin/maintenance/index.js';
import { startChatTtlCron } from '../modules/chat/index.js';
import { startGerentePayoutCron } from '../modules/gerente/index.js';
import { startMiningYieldCron } from '../modules/mining-engine/index.js';
import { startPublicMiningRankingRefreshLoop } from '../modules/ranking/index.js';
import { log } from '../core/ops/logger.js';

export type StartSchedulersDeps = {
  uploadsDir: string;
};

export type StopSchedulers = () => void;

function schedulersEnabled(): boolean {
  return String(process.env.SCHEDULER_ENABLED ?? '1').trim() !== '0';
}

/**
 * Liga os crons e devolve `stop()` para shutdown (limpa timers; não cancela
 * ticks já em curso — cada job libera o próprio lock Redis no `finally`).
 */
export function startBackgroundSchedulers(deps: StartSchedulersDeps): StopSchedulers {
  if (!schedulersEnabled()) {
    log.info('schedulers disabled', { module: 'schedulers', event: 'disabled' });
    return () => undefined;
  }

  const stopYield = startMiningYieldCron();
  const stopBackup = startScheduledSqlBackups();
  const stopChat = startChatTtlCron({ uploadsDir: deps.uploadsDir });
  const stopRanking = startPublicMiningRankingRefreshLoop();
  const stopIdemPurge = startIdempotencyPurgeCron();
  const stopGerentePayout = startGerentePayoutCron();

  log.info('schedulers started', { module: 'schedulers', event: 'started' });

  return () => {
    stopYield();
    stopBackup();
    stopChat();
    stopRanking();
    stopIdemPurge();
    stopGerentePayout();
    log.info('schedulers stopped', { module: 'schedulers', event: 'stopped' });
  };
}
