/**
 * Executor leve de jobs: shutdown gate, overlap local, lock Redis opcional,
 * timeout com AbortSignal cooperativo, logs estruturados.
 *
 * AbortSignal é cooperativo: o job deve consultar `signal.aborted` (ou
 * escutar `abort`). O runner NÃO cancela Promise magicamente.
 */
import {
  releaseDistributedLock,
  tryAcquireDistributedLock,
  type LockHandle
} from '../redis/lock.js';
import {
  beginJob,
  endJob,
  isShuttingDown,
  registerJobAbortController,
  unregisterJobAbortController
} from './lifecycle.js';
import { log } from './logger.js';

export type JobRunOutcome =
  | 'completed'
  | 'skipped_lock'
  | 'skipped_shutdown'
  | 'skipped_overlap'
  | 'timeout'
  | 'aborted'
  | 'failed';

export type JobContext = {
  signal: AbortSignal;
  jobName: string;
  startedAt: Date;
};

export type JobRunnerOptions = {
  name: string;
  /** Se definido, tenta `tryAcquireDistributedLock` antes de correr. */
  lockKey?: string;
  lockTtlSeconds?: number;
  timeoutMs: number;
  run: (ctx: JobContext) => Promise<void>;
};

export type JobRunner = {
  /** Um tick (intervalo / timeout). Seguro chamar concorrentemente. */
  tick: () => Promise<JobRunOutcome>;
  isRunning: () => boolean;
};

export class JobTimeoutError extends Error {
  constructor(job: string, timeoutMs: number) {
    super(`Job ${job} exceeded timeout ${timeoutMs}ms`);
    this.name = 'JobTimeoutError';
  }
}

export class JobAbortError extends Error {
  constructor(message = 'Job aborted') {
    super(message);
    this.name = 'JobAbortError';
  }
}

export function isJobAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'AbortError' || name === 'JobAbortError';
}

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms).unref?.();
  });
}

export function createJobRunner(opts: JobRunnerOptions): JobRunner {
  let running = false;

  const tick = async (): Promise<JobRunOutcome> => {
    if (isShuttingDown()) {
      log.info('job skipped', { module: 'job-runner', job: opts.name, event: 'skipped_shutdown' });
      return 'skipped_shutdown';
    }
    if (running) {
      log.info('job skipped', { module: 'job-runner', job: opts.name, event: 'skipped_overlap' });
      return 'skipped_overlap';
    }

    running = true;
    beginJob();
    let lock: LockHandle | null = null;
    const startedAt = new Date();
    const started = startedAt.getTime();
    const controller = new AbortController();
    registerJobAbortController(controller);

    const releaseAll = async (): Promise<void> => {
      unregisterJobAbortController(controller);
      try {
        await releaseDistributedLock(lock);
      } catch {
        /* ignore */
      }
      lock = null;
      running = false;
      endJob();
    };

    const ctx: JobContext = {
      signal: controller.signal,
      jobName: opts.name,
      startedAt
    };

    try {
      if (opts.lockKey) {
        lock = await tryAcquireDistributedLock(opts.lockKey, opts.lockTtlSeconds ?? 60);
        if (!lock) {
          log.info('job skipped', { module: 'job-runner', job: opts.name, event: 'skipped_lock' });
          await releaseAll();
          return 'skipped_lock';
        }
      }

      if (isShuttingDown() || controller.signal.aborted) {
        if (!controller.signal.aborted) controller.abort('shutdown');
        log.info('job skipped', { module: 'job-runner', job: opts.name, event: 'skipped_shutdown' });
        await releaseAll();
        return 'skipped_shutdown';
      }

      log.info('job started', { module: 'job-runner', job: opts.name, event: 'started' });

      const work = opts.run(ctx);
      const raced = await Promise.race([work.then(() => 'ok' as const), sleep(opts.timeoutMs)]);

      if (raced === 'timeout') {
        if (!controller.signal.aborted) {
          controller.abort('timeout');
        }
        log.error('job timeout', {
          module: 'job-runner',
          job: opts.name,
          event: 'timeout',
          durationMs: Date.now() - started,
          err: new JobTimeoutError(opts.name, opts.timeoutMs)
        });
        // Mantém `running` até a Promise original terminar — evita overlap local.
        // Lock Redis só é libertado no finally real (não artificialmente no timeout).
        void work
          .then(() => {
            log.info('job settled after timeout', {
              module: 'job-runner',
              job: opts.name,
              event: controller.signal.aborted ? 'aborted_late' : 'completed_late',
              durationMs: Date.now() - started
            });
          })
          .catch((err) => {
            log.error('job failed after timeout', {
              module: 'job-runner',
              job: opts.name,
              event: isJobAbortError(err) ? 'aborted_late' : 'failed',
              durationMs: Date.now() - started,
              err
            });
          })
          .finally(() => {
            void releaseAll();
          });
        return 'timeout';
      }

      if (controller.signal.aborted) {
        log.info('job aborted', {
          module: 'job-runner',
          job: opts.name,
          event: 'aborted',
          durationMs: Date.now() - started,
          reason: String(controller.signal.reason ?? 'aborted')
        });
        await releaseAll();
        return 'aborted';
      }

      log.info('job completed', {
        module: 'job-runner',
        job: opts.name,
        event: 'completed',
        durationMs: Date.now() - started
      });
      await releaseAll();
      return 'completed';
    } catch (err) {
      if (isJobAbortError(err) || controller.signal.aborted) {
        log.info('job aborted', {
          module: 'job-runner',
          job: opts.name,
          event: 'aborted',
          durationMs: Date.now() - started,
          err
        });
        await releaseAll();
        return 'aborted';
      }
      log.error('job failed', {
        module: 'job-runner',
        job: opts.name,
        event: 'failed',
        durationMs: Date.now() - started,
        err
      });
      await releaseAll();
      return 'failed';
    }
  };

  return {
    tick,
    isRunning: () => running
  };
}

/** Atalho one-shot (útil em testes / chamadas manuais). */
export async function runJobOnce(opts: JobRunnerOptions): Promise<JobRunOutcome> {
  return createJobRunner(opts).tick();
}
