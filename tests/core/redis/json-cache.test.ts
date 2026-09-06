import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('core/redis/json-cache', () => {
  let clientMock: Record<string, any>;
  let redisClient: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } | null;

  beforeEach(() => {
    vi.resetModules();
    redisClient = { get: vi.fn(), set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) };
    clientMock = { getRedis: () => redisClient };
    vi.doMock('../../../server/core/redis/client.js', () => clientMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../server/core/redis/client.js');
  });

  describe('sem Redis conectado', () => {
    beforeEach(() => {
      redisClient = null;
    });

    it('redisJsonGet devolve null sem lançar', async () => {
      const { redisJsonGet } = await import('../../../server/core/redis/json-cache.js');
      expect(await redisJsonGet('k')).toBeNull();
    });

    it('redisJsonSet/redisDel são no-op sem lançar', async () => {
      const { redisJsonSet, redisDel } = await import('../../../server/core/redis/json-cache.js');
      await expect(redisJsonSet('k', { a: 1 }, 60)).resolves.toBeUndefined();
      await expect(redisDel('k')).resolves.toBeUndefined();
    });
  });

  describe('com Redis conectado', () => {
    it('redisJsonGet devolve null quando a chave não existe', async () => {
      redisClient!.get.mockResolvedValue(null);
      const { redisJsonGet } = await import('../../../server/core/redis/json-cache.js');
      expect(await redisJsonGet('k')).toBeNull();
    });

    it('redisJsonGet faz parse do JSON armazenado', async () => {
      redisClient!.get.mockResolvedValue(JSON.stringify({ a: 1 }));
      const { redisJsonGet } = await import('../../../server/core/redis/json-cache.js');
      expect(await redisJsonGet('k')).toEqual({ a: 1 });
    });

    it('redisJsonGet devolve null se o valor armazenado não for JSON válido', async () => {
      redisClient!.get.mockResolvedValue('{not json');
      const { redisJsonGet } = await import('../../../server/core/redis/json-cache.js');
      expect(await redisJsonGet('k')).toBeNull();
    });

    it('redisJsonSet serializa o valor e aplica o TTL em segundos', async () => {
      const { redisJsonSet } = await import('../../../server/core/redis/json-cache.js');
      await redisJsonSet('k', { a: 1 }, 30);
      expect(redisClient!.set).toHaveBeenCalledWith('k', JSON.stringify({ a: 1 }), 'EX', 30);
    });

    it('redisJsonSet aplica o piso mínimo de TTL (1s) mesmo se pedirem 0 ou negativo', async () => {
      const { redisJsonSet } = await import('../../../server/core/redis/json-cache.js');
      await redisJsonSet('k', 1, 0);
      expect(redisClient!.set).toHaveBeenCalledWith('k', '1', 'EX', 1);
      await redisJsonSet('k', 1, -10);
      expect(redisClient!.set).toHaveBeenCalledWith('k', '1', 'EX', 1);
    });

    it('redisDel chama del com a chave', async () => {
      const { redisDel } = await import('../../../server/core/redis/json-cache.js');
      await redisDel('k');
      expect(redisClient!.del).toHaveBeenCalledWith('k');
    });
  });
});
