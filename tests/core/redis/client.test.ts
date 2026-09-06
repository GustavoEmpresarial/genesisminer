import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('core/redis/client', () => {
  let RedisMock: ReturnType<typeof vi.fn>;
  let pingMock: ReturnType<typeof vi.fn>;
  let quitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    pingMock = vi.fn().mockResolvedValue('PONG');
    quitMock = vi.fn().mockResolvedValue(undefined);
    RedisMock = vi.fn().mockImplementation(() => ({ ping: pingMock, quit: quitMock }));
    vi.doMock('ioredis', () => ({ Redis: RedisMock }));
  });

  afterEach(() => {
    vi.doUnmock('ioredis');
    vi.unstubAllEnvs();
  });

  it('getRedis devolve null antes de connectRedis', async () => {
    const { getRedis } = await import('../../../server/core/redis/client.js');
    expect(getRedis()).toBeNull();
  });

  it('connectRedis sem REDIS_URL: não cria cliente, getRedis continua null', async () => {
    vi.stubEnv('REDIS_URL', '');
    const { connectRedis, getRedis } = await import('../../../server/core/redis/client.js');
    await connectRedis();
    expect(RedisMock).not.toHaveBeenCalled();
    expect(getRedis()).toBeNull();
  });

  it('connectRedis com REDIS_URL: cria cliente, faz ping e fica disponível via getRedis', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    const { connectRedis, getRedis } = await import('../../../server/core/redis/client.js');
    await connectRedis();
    expect(RedisMock).toHaveBeenCalledWith('redis://localhost:6379', { maxRetriesPerRequest: null });
    expect(pingMock).toHaveBeenCalled();
    expect(getRedis()).not.toBeNull();
  });

  it('connectRedis com ping falhando: degrada para null sem lançar', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    pingMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { connectRedis, getRedis } = await import('../../../server/core/redis/client.js');
    await expect(connectRedis()).resolves.toBeUndefined();
    expect(getRedis()).toBeNull();
  });

  it('disconnectRedis sem cliente conectado: no-op', async () => {
    const { disconnectRedis } = await import('../../../server/core/redis/client.js');
    await expect(disconnectRedis()).resolves.toBeUndefined();
    expect(quitMock).not.toHaveBeenCalled();
  });

  it('disconnectRedis com cliente conectado: chama quit e limpa o singleton', async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    const { connectRedis, disconnectRedis, getRedis } = await import('../../../server/core/redis/client.js');
    await connectRedis();
    expect(getRedis()).not.toBeNull();
    await disconnectRedis();
    expect(quitMock).toHaveBeenCalledTimes(1);
    expect(getRedis()).toBeNull();
  });
});
