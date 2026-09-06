import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortAllActiveJobs,
  createJobRunner,
  getActiveJobCount,
  isAppReady,
  isShuttingDown,
  markAppReady,
  markAppShuttingDown,
  markAppStarting,
  normalizeRequestId,
  resetLifecycleForTests,
  requestGracefulShutdown,
  type JobContext
} from '../../../server/core/ops/index.js';

describe('core/ops lifecycle + job-runner + request-id', () => {
  afterEach(() => {
    resetLifecycleForTests();
    vi.restoreAllMocks();
  });

  it('readiness phase: starting → ready → shutting_down', () => {
    markAppStarting();
    expect(isAppReady()).toBe(false);
    expect(isShuttingDown()).toBe(false);
    markAppReady();
    expect(isAppReady()).toBe(true);
    markAppShuttingDown();
    expect(isAppReady()).toBe(false);
    expect(isShuttingDown()).toBe(true);
  });

  it('normalizeRequestId aceita válido e rejeita curto/inválido', () => {
    expect(normalizeRequestId('abcdefgh')).toBe('abcdefgh');
    expect(normalizeRequestId('bad id')).toBeNull();
    expect(normalizeRequestId('short')).toBeNull();
    expect(normalizeRequestId(null)).toBeNull();
  });

  it('job não inicia durante shutdown', async () => {
    markAppShuttingDown();
    const run = vi.fn().mockResolvedValue(undefined);
    const runner = createJobRunner({ name: 't_shutdown', timeoutMs: 1000, run });
    const out = await runner.tick();
    expect(out).toBe('skipped_shutdown');
    expect(run).not.toHaveBeenCalled();
  });

  it('job recebe AbortSignal no contexto', async () => {
    markAppReady();
    let seen: JobContext | null = null;
    const runner = createJobRunner({
      name: 't_ctx',
      timeoutMs: 1000,
      run: async (ctx) => {
        seen = ctx;
      }
    });
    expect(await runner.tick()).toBe('completed');
    expect(seen).not.toBeNull();
    expect(seen!.jobName).toBe('t_ctx');
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect(seen!.startedAt).toBeInstanceOf(Date);
  });

  it('timeout chama abort no signal', async () => {
    markAppReady();
    let signal: AbortSignal | null = null;
    const runner = createJobRunner({
      name: 't_timeout_abort',
      timeoutMs: 30,
      run: async (ctx) => {
        signal = ctx.signal;
        await new Promise<void>((r) => setTimeout(r, 200));
      }
    });
    expect(await runner.tick()).toBe('timeout');
    expect(signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(runner.isRunning()).toBe(false);
  });

  it('job cooperativo para após abort', async () => {
    markAppReady();
    let loops = 0;
    const runner = createJobRunner({
      name: 't_coop',
      timeoutMs: 40,
      run: async (ctx) => {
        while (!ctx.signal.aborted) {
          loops += 1;
          await new Promise<void>((r) => setTimeout(r, 10));
        }
      }
    });
    expect(await runner.tick()).toBe('timeout');
    await new Promise((r) => setTimeout(r, 80));
    expect(runner.isRunning()).toBe(false);
    expect(loops).toBeGreaterThan(0);
    expect(loops).toBeLessThan(20);
  });

  it('job não corre duas vezes localmente (overlap)', async () => {
    markAppReady();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = vi.fn().mockImplementation((_ctx: JobContext) => gate);
    const runner = createJobRunner({ name: 't_overlap', timeoutMs: 5_000, run });
    const p1 = runner.tick();
    await Promise.resolve();
    expect(runner.isRunning()).toBe(true);
    const p2 = runner.tick();
    expect(await p2).toBe('skipped_overlap');
    release();
    expect(await p1).toBe('completed');
    expect(getActiveJobCount()).toBe(0);
  });

  it('job timeout é registado e não deixa overlap solto', async () => {
    markAppReady();
    const run = vi.fn().mockImplementation(
      (_ctx: JobContext) => new Promise<void>((r) => setTimeout(r, 200))
    );
    const runner = createJobRunner({ name: 't_timeout', timeoutMs: 30, run });
    const out = await runner.tick();
    expect(out).toBe('timeout');
    expect(runner.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(runner.isRunning()).toBe(false);
  });

  it('shutdown solicita abort aos jobs ativos', async () => {
    markAppReady();
    let signal: AbortSignal | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = createJobRunner({
      name: 't_shutdown_abort',
      timeoutMs: 30_000,
      run: async (ctx) => {
        signal = ctx.signal;
        await gate;
      }
    });
    const tickP = runner.tick();
    await Promise.resolve();
    expect(runner.isRunning()).toBe(true);

    const aborted = abortAllActiveJobs('shutdown');
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect(signal!.aborted).toBe(true);

    release();
    expect(await tickP).toBe('aborted');
  });

  it('graceful shutdown é idempotente (mesma Promise) e aborta jobs', async () => {
    markAppReady();
    let signal: AbortSignal | null = null;
    let releaseJob!: () => void;
    const jobGate = new Promise<void>((r) => {
      releaseJob = r;
    });
    const runner = createJobRunner({
      name: 't_sd_job',
      timeoutMs: 60_000,
      run: async (ctx) => {
        signal = ctx.signal;
        await jobGate;
      }
    });
    const tickP = runner.tick();
    await Promise.resolve();

    const close = vi.fn((cb?: (err?: Error) => void) => {
      cb?.();
    });
    const stopSchedulers = vi.fn();
    const httpServer = { close } as any;

    const p1 = requestGracefulShutdown(
      {
        httpServer,
        stopSchedulers,
        skipProcessExit: true,
        disconnectRedisFn: async () => undefined,
        disconnectPostgresFn: async () => undefined,
        closeSocketIoFn: async () => undefined
      },
      'SIGTERM'
    );
    const p2 = requestGracefulShutdown(
      {
        httpServer,
        stopSchedulers,
        skipProcessExit: true,
        disconnectRedisFn: async () => undefined,
        disconnectPostgresFn: async () => undefined,
        closeSocketIoFn: async () => undefined
      },
      'SIGINT'
    );
    expect(p1).toBe(p2);
    await Promise.resolve();
    expect(signal!.aborted).toBe(true);
    releaseJob();
    await tickP;
    await p1;
    expect(stopSchedulers).toHaveBeenCalledTimes(1);
    expect(isShuttingDown()).toBe(true);
  });
});
