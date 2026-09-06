/**
 * Config operacional mínima (shutdown / jobs / readiness).
 * Defaults seguros; env opcional.
 */
import { MS_PER_MINUTE, MS_PER_SECOND } from '../../shared/utils/time.js';

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* eslint-disable no-magic-numbers -- este ficheiro É a declaração dos defaults
   operacionais: cada número está nomeado e comentado abaixo, e os multiplicadores
   (25 * MS_PER_SECOND) são a forma legível de os escrever. Mesmo critério já usado
   em `shared/utils/time.ts`. */

/** Limites genéricos de qualquer timeout configurável por env. */
const MS_MIN = MS_PER_SECOND;
const MS_MAX = 10 * MS_PER_MINUTE;

/** Shutdown: o total tem de caber nos limites do orquestrador. */
const SHUTDOWN_TOTAL_DEFAULT_MS = 25 * MS_PER_SECOND;
const SHUTDOWN_JOBS_DEFAULT_MS = 15 * MS_PER_SECOND;
const SHUTDOWN_HTTP_DEFAULT_MS = 10 * MS_PER_SECOND;

/** Readiness: probe tem de ser curto — é chamado pelo healthcheck. */
const READINESS_DEFAULT_MS = 2 * MS_PER_SECOND;
const READINESS_MIN_MS = 200;
const READINESS_MAX_MS = 15 * MS_PER_SECOND;

/** Limiar de "pedido lento" no log HTTP. */
const SLOW_HTTP_DEFAULT_MS = 1_500;
const SLOW_HTTP_MIN_MS = 200;
const SLOW_HTTP_MAX_MS = 2 * MS_PER_MINUTE;

/** Timeout por job: cada um cobre o pior caso esperado do próprio trabalho. */
const JOB_MINING_YIELD_DEFAULT_MS = 2 * MS_PER_MINUTE;
const JOB_BACKUP_SQL_DEFAULT_MS = 1_100_000;
const JOB_BACKUP_SQL_MAX_MS = 30 * MS_PER_MINUTE;
const JOB_CHAT_TTL_DEFAULT_MS = 90 * MS_PER_SECOND;
const JOB_PUBLIC_RANKING_DEFAULT_MS = 4 * MS_PER_MINUTE;
const JOB_IDEMPOTENCY_PURGE_DEFAULT_MS = 5 * MS_PER_MINUTE;
const JOB_GERENTE_PAYOUT_DEFAULT_MS = 2 * MS_PER_MINUTE;

export const opsConfig = {
  /** Tempo total máximo de graceful shutdown (HTTP drain + jobs + DB). */
  shutdownTimeoutMs: parsePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TOTAL_DEFAULT_MS, MS_MIN, MS_MAX),
  /** Tempo máximo a esperar jobs em curso no shutdown. */
  shutdownJobsTimeoutMs: parsePositiveInt(process.env.SHUTDOWN_JOBS_TIMEOUT_MS, SHUTDOWN_JOBS_DEFAULT_MS, MS_MIN, MS_MAX),
  /** Tempo máximo a esperar HTTP in-flight no shutdown. */
  shutdownHttpTimeoutMs: parsePositiveInt(process.env.SHUTDOWN_HTTP_TIMEOUT_MS, SHUTDOWN_HTTP_DEFAULT_MS, MS_MIN, MS_MAX),
  /** Timeout curto para probes de readiness (Postgres/Redis). */
  readinessCheckTimeoutMs: parsePositiveInt(process.env.READINESS_TIMEOUT_MS, READINESS_DEFAULT_MS, READINESS_MIN_MS, READINESS_MAX_MS),
  /** Loga HTTP requests com duração ≥ este limiar (ms). */
  slowHttpMs: parsePositiveInt(process.env.SLOW_HTTP_MS, SLOW_HTTP_DEFAULT_MS, SLOW_HTTP_MIN_MS, SLOW_HTTP_MAX_MS),
  jobTimeouts: {
    miningYield: parsePositiveInt(process.env.JOB_TIMEOUT_MINING_YIELD_MS, JOB_MINING_YIELD_DEFAULT_MS, MS_MIN, MS_MAX),
    backupSql: parsePositiveInt(process.env.JOB_TIMEOUT_BACKUP_SQL_MS, JOB_BACKUP_SQL_DEFAULT_MS, MS_MIN, JOB_BACKUP_SQL_MAX_MS),
    chatTtl: parsePositiveInt(process.env.JOB_TIMEOUT_CHAT_TTL_MS, JOB_CHAT_TTL_DEFAULT_MS, MS_MIN, MS_MAX),
    publicRanking: parsePositiveInt(process.env.JOB_TIMEOUT_PUBLIC_RANKING_MS, JOB_PUBLIC_RANKING_DEFAULT_MS, MS_MIN, MS_MAX),
    idempotencyPurge: parsePositiveInt(process.env.JOB_TIMEOUT_IDEMPOTENCY_PURGE_MS, JOB_IDEMPOTENCY_PURGE_DEFAULT_MS, MS_MIN, MS_MAX),
    gerentePayout: parsePositiveInt(process.env.JOB_TIMEOUT_GERENTE_PAYOUT_MS, JOB_GERENTE_PAYOUT_DEFAULT_MS, MS_MIN, MS_MAX)
  }
} as const;
/* eslint-enable no-magic-numbers */
