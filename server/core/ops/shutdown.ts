/**
 * Graceful shutdown idempotente (SIGTERM/SIGINT / fatal errors).
 */
import type { Server } from 'node:http';
import pool from '../database/pool.js';
import { disconnectPrisma } from '../database/prisma.js';
import { disconnectRedis } from '../redis/client.js';
import { closeSocketIo } from '../socket/client.js';
import { opsConfig } from './config.js';
import {
  abortAllActiveJobs,
  getActiveHttpRequestCount,
  getActiveJobCount,
  getOrCreateShutdownPromise,
  isShuttingDown,
  markAppShuttingDown
} from './lifecycle.js';
import { log } from './logger.js';

export type GracefulShutdownDeps = {
  httpServer: Server;
  stopSchedulers: () => void;
  /** Opcional: desliga producer/consumer Kafka. */
  stopKafkaFn?: () => Promise<void>;
  /** Opcional: force exit code (default 0; 1 for fatal). */
  exitCode?: number;
  /** Testes: não chama process.exit. */
  skipProcessExit?: boolean;
  disconnectRedisFn?: () => Promise<void>;
  disconnectPostgresFn?: () => Promise<void>;
  closeSocketIoFn?: () => Promise<void>;
};

function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, pollMs).unref?.();
    };
    tick();
  });
}

async function closeHttp(server: Server, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close((err) => {
      if (err) log.warn('http close error', { module: 'shutdown', err });
      done();
    });
    setTimeout(done, timeoutMs).unref?.();
  });
}

/**
 * Executa shutdown uma única vez. Chamadas subsequentes reutilizam a mesma Promise.
 */
async function runShutdownSteps(deps: GracefulShutdownDeps, signal: string, t0: number): Promise<void> {
  try {
    deps.stopSchedulers();
    log.info('schedulers stopped', { module: 'shutdown', event: 'schedulers_stopped' });
  } catch (err) {
    log.error('stopSchedulers failed', { module: 'shutdown', err });
  }

  if (deps.stopKafkaFn) {
    try {
      await deps.stopKafkaFn();
      log.info('kafka stopped', { module: 'shutdown', event: 'kafka_stopped' });
    } catch (err) {
      log.warn('stopKafka failed', { module: 'shutdown', err });
    }
  }

  const aborted = abortAllActiveJobs('shutdown');
  log.info('active jobs abort requested', {
    module: 'shutdown',
    event: 'jobs_abort_requested',
    abortedControllers: aborted,
    activeJobs: getActiveJobCount()
  });

  const jobsOk = await waitUntil(() => getActiveJobCount() === 0, opsConfig.shutdownJobsTimeoutMs);
  if (!jobsOk) {
    log.warn('shutdown: jobs still running after timeout', {
      module: 'shutdown',
      event: 'jobs_timeout',
      activeJobs: getActiveJobCount()
    });
  }

  try {
    await (deps.closeSocketIoFn ?? closeSocketIo)(opsConfig.shutdownHttpTimeoutMs);
    log.info('socket.io closed', { module: 'shutdown', event: 'socketio_closed' });
  } catch (err) {
    log.warn('socket.io close failed', { module: 'shutdown', err });
  }

  await closeHttp(deps.httpServer, opsConfig.shutdownHttpTimeoutMs);

  const httpOk = await waitUntil(() => getActiveHttpRequestCount() === 0, opsConfig.shutdownHttpTimeoutMs);
  if (!httpOk) {
    log.warn('shutdown: HTTP still in-flight after timeout', {
      module: 'shutdown',
      event: 'http_timeout',
      activeHttp: getActiveHttpRequestCount()
    });
  }

  try {
    await (deps.disconnectRedisFn ?? disconnectRedis)();
    log.info('redis disconnected', { module: 'shutdown', event: 'redis_closed' });
  } catch (err) {
    log.warn('redis disconnect failed', { module: 'shutdown', err });
  }

  try {
    if (deps.disconnectPostgresFn) {
      await deps.disconnectPostgresFn();
    } else {
      await disconnectPrisma();
      await pool.end();
    }
    log.info('postgres disconnected', { module: 'shutdown', event: 'postgres_closed' });
  } catch (err) {
    log.warn('postgres disconnect failed', { module: 'shutdown', err });
  }

  log.info('graceful shutdown complete', {
    module: 'shutdown',
    event: 'completed',
    durationMs: Date.now() - t0,
    signal
  });
}

export function requestGracefulShutdown(deps: GracefulShutdownDeps, signal: string): Promise<void> {
  return getOrCreateShutdownPromise(async () => {
    const exitCode = deps.exitCode ?? 0;
    const t0 = Date.now();
    markAppShuttingDown();
    log.info('graceful shutdown started', { module: 'shutdown', event: 'started', signal });

    const overall = new Promise<'overall_timeout'>((resolve) => {
      setTimeout(() => resolve('overall_timeout'), opsConfig.shutdownTimeoutMs).unref?.();
    });

    const raced = await Promise.race([
      runShutdownSteps(deps, signal, t0).then(() => 'ok' as const),
      overall
    ]);

    if (raced === 'overall_timeout') {
      log.error('graceful shutdown overall timeout', {
        module: 'shutdown',
        event: 'overall_timeout',
        durationMs: Date.now() - t0,
        shutdownTimeoutMs: opsConfig.shutdownTimeoutMs
      });
    }

    if (deps.skipProcessExit) return;

    const hard = setTimeout(() => {
      process.exit(exitCode);
    }, 500);
    hard.unref?.();
    process.exit(exitCode);
  });
}

export function installSignalHandlers(deps: GracefulShutdownDeps): void {
  const onSignal = (signal: string): void => {
    if (isShuttingDown()) {
      log.info('shutdown signal ignored (already shutting down)', { module: 'shutdown', signal });
      return;
    }
    void requestGracefulShutdown(deps, signal);
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}
