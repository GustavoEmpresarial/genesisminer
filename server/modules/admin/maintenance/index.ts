/**
 * Manutenção de base de dados: rotinas que impedem tabelas técnicas de crescer
 * sem limite. Ver `services/idempotency-purge.ts`.
 */
export { startIdempotencyPurgeCron } from './services/idempotency-purge-cron.js';
export {
  IDEMPOTENCY_RETENTION_DAYS,
  IDEMPOTENCY_TABLES,
  purgeIdempotencyBatch,
  runIdempotencyPurge,
  type IdempotencyTable,
  type PurgeQueryable,
  type PurgeSummary
} from './services/idempotency-purge.js';
