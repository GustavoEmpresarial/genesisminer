import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('redis/lock — sem cliente Redis conectado (padrão em testes)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('tryAcquireDistributedLock devolve handle "no-redis" e release não rebenta', async () => {
    const { tryAcquireDistributedLock, releaseDistributedLock, REDIS_LOCK_KEYS } = await import('../../../server/core/redis/lock.js');
    const h = await tryAcquireDistributedLock(REDIS_LOCK_KEYS.miningYieldTick, 60);
    expect(h).not.toBeNull();
    expect(h!.key).toContain('mining_yield');
    expect(h!.token).toBe('no-redis');
    await expect(releaseDistributedLock(h)).resolves.toBeUndefined();
  });

  it('REDIS_LOCK_KEYS.miningProgressUser gera chave por userId', async () => {
    const { REDIS_LOCK_KEYS } = await import('../../../server/core/redis/lock.js');
    expect(REDIS_LOCK_KEYS.miningProgressUser(42)).toContain('42');
  });

  it('withRedisLock roda fn direto (sem lock real) e devolve o resultado', async () => {
    const { withRedisLock } = await import('../../../server/core/redis/lock.js');
    const result = await withRedisLock('some-key', 30, async () => 'done');
    expect(result).toBe('done');
  });
});

describe('redis/lock — com cliente Redis mockado', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../../server/core/redis/client.js');
  });

  it('GENESIS_REDIS_LOCKS_ENABLED=0 ignora o cliente Redis mesmo se conectado', async () => {
    vi.stubEnv('GENESIS_REDIS_LOCKS_ENABLED', '0');
    const fakeSet = vi.fn();
    vi.doMock('../../../server/core/redis/client.js', () => ({
      getRedis: () => ({ set: fakeSet })
    }));
    const { tryAcquireDistributedLock, REDIS_LOCK_KEYS } = await import('../../../server/core/redis/lock.js');
    const h = await tryAcquireDistributedLock(REDIS_LOCK_KEYS.miningYieldTick, 60);
    expect(h!.token).toBe('no-redis');
    expect(fakeSet).not.toHaveBeenCalled();
  });

  it('tryAcquireDistributedLock adquire via SET NX EX e devolve handle com token', async () => {
    const fakeSet = vi.fn().mockResolvedValue('OK');
    vi.doMock('../../../server/core/redis/client.js', () => ({
      getRedis: () => ({ set: fakeSet })
    }));
    const { tryAcquireDistributedLock } = await import('../../../server/core/redis/lock.js');
    const h = await tryAcquireDistributedLock('lock:test', 60, 'fixed-token');
    expect(h).toEqual({ key: 'lock:test', token: 'fixed-token' });
    expect(fakeSet).toHaveBeenCalledWith('lock:test', 'fixed-token', 'EX', 60, 'NX');
  });

  it('REDIS_LOCK_KEYS inclui chaves dos jobs de fundo do app', async () => {
    const { REDIS_LOCK_KEYS, REDIS_LOCK_TTL_SECONDS } = await import('../../../server/core/redis/lock.js');
    expect(REDIS_LOCK_KEYS.jobBackupSql).toBe('genesis:lock:job:backup-sql');
    expect(REDIS_LOCK_KEYS.jobChatTtl).toBe('genesis:lock:job:chat-ttl');
    expect(REDIS_LOCK_KEYS.jobPublicRanking).toBe('genesis:lock:job:public-ranking');
    expect(REDIS_LOCK_KEYS.jobGerentePayout).toBe('genesis:lock:job:gerente-payout');
    expect(REDIS_LOCK_TTL_SECONDS.backupSql).toBe(1800);
    expect(REDIS_LOCK_TTL_SECONDS.chatTtl).toBe(120);
    expect(REDIS_LOCK_TTL_SECONDS.publicRanking).toBe(300);
    expect(REDIS_LOCK_TTL_SECONDS.gerentePayout).toBe(180);
  });

  it('tryAcquireDistributedLock clampa TTL acima do máximo (30min)', async () => {
    const fakeSet = vi.fn().mockResolvedValue('OK');
    vi.doMock('../../../server/core/redis/client.js', () => ({
      getRedis: () => ({ set: fakeSet })
    }));
    const { tryAcquireDistributedLock } = await import('../../../server/core/redis/lock.js');
    await tryAcquireDistributedLock('lock:long', 99999, 't');
    expect(fakeSet).toHaveBeenCalledWith('lock:long', 't', 'EX', 1800, 'NX');
  });

  it('withRedisLock adquire, roda fn e liberta o lock no fim (compare-and-delete via EVAL)', async () => {
    const store = new Map<string, string>();
    const fakeClient = {
      set: vi.fn(async (key: string, token: string) => {
        if (store.has(key)) return null;
        store.set(key, token);
        return 'OK';
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
        if (store.get(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      })
    };
    vi.doMock('../../../server/core/redis/client.js', () => ({ getRedis: () => fakeClient }));
    const { withRedisLock } = await import('../../../server/core/redis/lock.js');

    const result = await withRedisLock('checkout', 30, async () => 'ok');
    expect(result).toBe('ok');
    expect(fakeClient.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:checkout', expect.any(String));
    expect(store.size).toBe(0);
  });

  it('withRedisLock não apaga o lock se outro dono já o assumiu entre a expiração do TTL e o release (compare-and-delete)', async () => {
    const store = new Map<string, string>();
    let releasedToken = '';
    const fakeClient = {
      set: vi.fn(async (key: string, token: string) => {
        releasedToken = token;
        store.set(key, token);
        return 'OK';
      }),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
        if (store.get(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      })
    };
    vi.doMock('../../../server/core/redis/client.js', () => ({ getRedis: () => fakeClient }));
    const { withRedisLock } = await import('../../../server/core/redis/lock.js');

    await withRedisLock('checkout', 30, async () => {
      // Simula outro processo a assumir o lock (TTL expirou) antes do release rodar.
      store.set('lock:checkout', 'outro-dono');
      return 'ok';
    });
    expect(releasedToken).not.toBe('outro-dono');
    expect(store.get('lock:checkout')).toBe('outro-dono');
  });

  it('releaseDistributedLock chama EVAL (compare-and-delete) com key e token do handle', async () => {
    const fakeEval = vi.fn().mockResolvedValue(1);
    vi.doMock('../../../server/core/redis/client.js', () => ({ getRedis: () => ({ eval: fakeEval }) }));
    const { releaseDistributedLock } = await import('../../../server/core/redis/lock.js');
    await releaseDistributedLock({ key: 'lock:x', token: 'tok-1' });
    expect(fakeEval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:x', 'tok-1');
  });

  it('releaseDistributedLock não lança se o EVAL falhar (best-effort)', async () => {
    const fakeEval = vi.fn().mockRejectedValue(new Error('redis down'));
    vi.doMock('../../../server/core/redis/client.js', () => ({ getRedis: () => ({ eval: fakeEval }) }));
    const { releaseDistributedLock } = await import('../../../server/core/redis/lock.js');
    await expect(releaseDistributedLock({ key: 'lock:x', token: 'tok-1' })).resolves.toBeUndefined();
  });

  it('withRedisLock devolve null se não conseguir adquirir (lock já em uso)', async () => {
    const fakeClient = {
      set: vi.fn().mockResolvedValue(null),
      get: vi.fn(),
      del: vi.fn()
    };
    vi.doMock('../../../server/core/redis/client.js', () => ({ getRedis: () => fakeClient }));
    const { withRedisLock } = await import('../../../server/core/redis/lock.js');
    const result = await withRedisLock('busy-key', 30, async () => 'unreachable');
    expect(result).toBeNull();
  });
});
