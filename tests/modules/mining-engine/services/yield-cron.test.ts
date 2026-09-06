import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../../../../server/core/ops/job-runner.js';
import { TEN_MIN_MS, utcMidnightMs } from '../../../../server/modules/mining-engine/services/wall-clock-grid.js';
import { MS_PER_MINUTE } from '../../../../server/shared/utils/time.js';

function yieldTickCtx(): JobContext {
  return { signal: new AbortController().signal, jobName: 'mining_yield', startedAt: new Date() };
}

describe('mining-engine services/yield-cron', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: { default: { connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } };
  let lockMock: Record<string, any>;
  let socketMock: Record<string, any>;

  beforeEach(async () => {
    vi.resetModules();
    const life = await import('../../../../server/core/ops/lifecycle.js');
    life.resetLifecycleForTests();
    life.markAppReady();

    vi.stubEnv('SCHEDULER_ENABLED', '1');
    vi.stubEnv('MINING_YIELD_CRON_ENABLED', '1');
    vi.stubEnv('MINING_WALL_CLOCK_TEN_MIN_GRID', '0');

    client = {
      query: vi.fn(async (sql: string) => {
        const s = String(sql);
        if (s.includes('FROM mining_yield_history WHERE effective_at')) return { rows: [{ m: null }] };
        if (s.includes('FROM rig_rooms')) return { rows: [] };
        if (s.includes('FROM mining_coins WHERE is_active')) return { rows: [] };
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('INSERT INTO app_cache')) return { rows: [] };
        if (s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
        if (s.includes('INSERT INTO mining_yield_history')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    poolMock = {
      default: {
        connect: vi.fn().mockResolvedValue(client),
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          if (s.includes('FROM placed_racks pr')) return { rows: [] };
          if (s.includes('FROM upgrades')) return { rows: [] };
          if (s.includes('FROM mining_coins WHERE is_active')) return { rows: [] };
          return { rows: [] };
        })
      }
    };
    lockMock = {
      REDIS_LOCK_KEYS: { miningYieldTick: 'genesis:lock:mining_yield_tick' },
      REDIS_LOCK_TTL_SECONDS: { miningYieldTick: 180 },
      tryAcquireDistributedLock: vi.fn().mockResolvedValue({ key: 'x', token: 'y' }),
      releaseDistributedLock: vi.fn().mockResolvedValue(undefined)
    };
    socketMock = { getSocketIo: vi.fn().mockReturnValue(null) };

    vi.doMock('../../../../server/core/database/pool.js', () => poolMock);
    vi.doMock('../../../../server/core/redis/lock.js', () => lockMock);
    vi.doMock('../../../../server/core/socket/client.js', () => socketMock);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/core/redis/lock.js');
    vi.doUnmock('../../../../server/core/socket/client.js');
    const life = await import('../../../../server/core/ops/lifecycle.js');
    life.resetLifecycleForTests();
  });

  it('updateMiningYields é sempre no-op (não adquire lock nem corre o tick)', async () => {
    const { updateMiningYields } = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    await updateMiningYields();
    expect(lockMock.tryAcquireDistributedLock).not.toHaveBeenCalled();
    expect(poolMock.default.connect).not.toHaveBeenCalled();
  });

  it('caminho feliz: executeMiningYieldTick corre o job e liberta o client', async () => {
    const { executeMiningYieldTick } = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    await executeMiningYieldTick(yieldTickCtx());
    expect(poolMock.default.connect).toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('com moedas ativas (grelha off): INSERT em batch via UNNEST + ON CONFLICT DO NOTHING', async () => {
    poolMock.default.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM placed_racks pr')) return { rows: [] };
      if (s.includes('FROM upgrades')) return { rows: [] };
      if (s.includes('FROM mining_coins WHERE is_active')) {
        return {
          rows: [{ id: 'btc', block_reward: 1, block_time: 60, network_hashrate: 100 }]
        };
      }
      return { rows: [] };
    });
    const { executeMiningYieldTick, MINING_YIELD_HISTORY_INSERT_SQL } = await import(
      '../../../../server/modules/mining-engine/services/yield-cron.js'
    );
    expect(MINING_YIELD_HISTORY_INSERT_SQL).toContain('ON CONFLICT (coin_id, effective_at) DO NOTHING');
    await executeMiningYieldTick(yieldTickCtx());
    const inserts = client.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('INSERT INTO mining_yield_history'));
    expect(inserts.length).toBe(1);
    expect(String(inserts[0]![0])).toContain('UNNEST');
    expect(String(inserts[0]![0])).toContain('ON CONFLICT (coin_id, effective_at) DO NOTHING');
  });

  it('erro durante o tick: faz rollback e ainda liberta o client', async () => {
    poolMock.default.query.mockRejectedValueOnce(new Error('db down'));
    const { executeMiningYieldTick } = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    await expect(executeMiningYieldTick(yieldTickCtx())).rejects.toThrow('db down');
    expect(client.release).toHaveBeenCalled();
  });

  it('startMiningYieldCron é no-op (não agenda timers)', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const { startMiningYieldCron } = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    const stop = startMiningYieldCron({ startupDelayMs: MS_PER_MINUTE, intervalMs: MS_PER_MINUTE * 2 });
    expect(typeof stop).toBe('function');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
    expect(lockMock.tryAcquireDistributedLock).not.toHaveBeenCalled();
    expect(poolMock.default.connect).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });
});

describe('mining-engine yield-cron — catch-up canónico (grelha ON)', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: { default: { connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } };
  let lockMock: Record<string, any>;

  const day0 = utcMidnightMs(Date.UTC(2026, 7, 20, 12, 0, 0));
  const t2220 = day0 + 22 * 60 * 60 * 1000 + 20 * 60 * 1000;
  const t2230 = t2220 + TEN_MIN_MS;
  const t2240 = t2230 + TEN_MIN_MS;
  const t2250 = t2240 + TEN_MIN_MS;

  function effectivesFromInserts(): number[] {
    const inserts = client.query.mock.calls.filter((c: unknown[]) => String(c[0]).includes('INSERT INTO mining_yield_history'));
    return inserts.map((c) => {
      const params = c[1] as unknown[];
      const effectives = params[4] as number[];
      return effectives[0]!;
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    const life = await import('../../../../server/core/ops/lifecycle.js');
    life.resetLifecycleForTests();
    life.markAppReady();

    vi.stubEnv('SCHEDULER_ENABLED', '1');
    vi.stubEnv('MINING_YIELD_CRON_ENABLED', '1');
    vi.stubEnv('MINING_WALL_CLOCK_TEN_MIN_GRID', '1');

    client = {
      query: vi.fn(async (sql: string) => {
        const s = String(sql);
        if (s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        if (s.includes('INSERT INTO app_cache')) return { rows: [] };
        if (s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
        if (s.includes('INSERT INTO mining_yield_history')) return { rows: [] };
        if (s.includes('FROM rig_rooms')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn()
    };
    poolMock = {
      default: {
        connect: vi.fn().mockResolvedValue(client),
        query: vi.fn(async (sql: string) => {
          const s = String(sql);
          if (s.includes('FROM placed_racks pr')) return { rows: [] };
          if (s.includes('FROM upgrades')) return { rows: [] };
          if (s.includes('FROM mining_coins WHERE is_active')) {
            return { rows: [{ id: 'pol', block_reward: 1, block_time: 600, network_hashrate: 1000 }] };
          }
          return { rows: [] };
        })
      }
    };
    lockMock = {
      REDIS_LOCK_KEYS: { miningYieldTick: 'genesis:lock:mining_yield_tick' },
      REDIS_LOCK_TTL_SECONDS: { miningYieldTick: 180 },
      tryAcquireDistributedLock: vi.fn().mockResolvedValue({ key: 'x', token: 'y' }),
      releaseDistributedLock: vi.fn().mockResolvedValue(undefined)
    };

    vi.doMock('../../../../server/core/database/pool.js', () => poolMock);
    vi.doMock('../../../../server/core/redis/lock.js', () => lockMock);
    vi.doMock('../../../../server/core/socket/client.js', () => ({ getSocketIo: () => null }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock('../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../server/core/redis/lock.js');
    vi.doUnmock('../../../../server/core/socket/client.js');
    const life = await import('../../../../server/core/ops/lifecycle.js');
    life.resetLifecycleForTests();
  });

  it('TESTE 1 — normal: checkpoint 22:20, agora 22:31 → só 22:30', async () => {
    vi.useFakeTimers({ now: t2230 + 60_000 });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2230]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2230);
  });

  it('TESTE 2+3 — catch-up: 22:20 → 22:53 grava 22:30,22:40,22:50 (não só 22:50)', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await mod.executeMiningYieldTick(yieldTickCtx());
    const eff = effectivesFromInserts();
    expect(eff).toEqual([t2230, t2240, t2250]);
    expect(eff).not.toEqual([t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE 4 — reexecução com checkpoint 22:50 → nenhum insert', async () => {
    vi.useFakeTimers({ now: t2250 + 2 * 60_000 });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2250);
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([]);
  });

  it('TESTE 5 — falha no meio: 22:30 ok, 22:40 falha; 22:50 não corre; retoma em 22:40', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    let insertCount = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) {
        insertCount += 1;
        if (insertCount === 2) throw new Error('fail-2240');
        return { rows: [] };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });

    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);

    await expect(mod.executeMiningYieldTick(yieldTickCtx())).rejects.toThrow('fail-2240');
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2230);
    // 22:40 foi tentado (INSERT) mas falhou antes do COMMIT → checkpoint não avançou; 22:50 não correu
    expect(effectivesFromInserts()).toEqual([t2230, t2240]);
    expect(effectivesFromInserts()).not.toContain(t2250);

    // retry: should resume at 22:40 then 22:50
    insertCount = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) return { rows: [] };
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });
    client.query.mockClear();
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2240, t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE 6 — restart: hidrata MAX=22:30; agora 22:53 → 22:40,22:50 (não repete 22:30)', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('MAX(effective_at)')) return { rows: [{ m: t2230 }] };
      if (s.includes('INSERT INTO mining_yield_history')) return { rows: [] };
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms')) return { rows: [] };
      return { rows: [] };
    });

    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2240, t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE 8 — primeiro boot (MAX null): só grava cap actual', async () => {
    vi.useFakeTimers({ now: t2250 + 60_000 });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2250]);
  });

  it('TESTE B — segundo writer no mesmo boundary: não lança; checkpoint correcto', async () => {
    vi.useFakeTimers({ now: t2230 + 60_000 });
    let inserts = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) {
        inserts += 1;
        // 1ª execução: insert; 2ª: ON CONFLICT DO NOTHING (rowCount 0, sem throw)
        return { rows: [], rowCount: inserts === 1 ? 1 : 0 };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2230);

    client.query.mockClear();
    inserts = 0;
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([]); // nada pendente
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2230);
  });

  it('TESTE C — 22:30 já existe (conflito/skip); continua 22:40 e 22:50', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    let insertN = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) {
        insertN += 1;
        // 22:30: DO NOTHING; 22:40/50: insert
        return { rows: [], rowCount: insertN === 1 ? 0 : 1 };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2230, t2240, t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE C2 — 23505 residual em 22:30: tratado como persistido; catch-up segue', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    let insertN = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) {
        insertN += 1;
        if (insertN === 1) {
          const err = Object.assign(new Error('duplicate key'), { code: '23505' });
          throw err;
        }
        return { rows: [], rowCount: 1 };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE D+E — erro real em 22:40 para; retoma sem duplicar lógica de ordem', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    let insertCount = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) {
        insertCount += 1;
        if (insertCount === 2) throw new Error('db-real-fail');
        return { rows: [] };
      }
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });

    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    mod.setMiningYieldHistoryBoundaryMsForTests(t2220);
    await expect(mod.executeMiningYieldTick(yieldTickCtx())).rejects.toThrow('db-real-fail');
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2230);

    insertCount = 0;
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('INSERT INTO mining_yield_history')) return { rows: [], rowCount: 1 };
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms') || s.includes('MAX(effective_at)')) return { rows: [{ m: null }] };
      return { rows: [] };
    });
    client.query.mockClear();
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2240, t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });

  it('TESTE F — restart hidrata MAX; checkpoint consistente', async () => {
    vi.useFakeTimers({ now: t2250 + 3 * 60_000 });
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('MAX(effective_at)')) return { rows: [{ m: t2240 }] };
      if (s.includes('INSERT INTO mining_yield_history')) return { rows: [] };
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('INSERT INTO app_cache') || s.includes('DELETE FROM mining_yield_history')) return { rows: [] };
      if (s.includes('FROM rig_rooms')) return { rows: [] };
      return { rows: [] };
    });
    const mod = await import('../../../../server/modules/mining-engine/services/yield-cron.js');
    mod.resetMiningYieldCronStateForTests();
    await mod.executeMiningYieldTick(yieldTickCtx());
    expect(effectivesFromInserts()).toEqual([t2250]);
    expect(mod.getMiningYieldHistoryBoundaryMsForTests()).toBe(t2250);
  });
});
