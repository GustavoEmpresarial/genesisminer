import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('shared/settings/settings-repository', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        settings: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
          upsert: vi.fn().mockResolvedValue(undefined)
        },
        $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops))
      }
    };
    vi.doMock('../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../server/core/database/prisma.js');
  });

  describe('getSettingValue', () => {
    it('devolve o value quando a chave existe', async () => {
      prismaMock.prisma.settings.findUnique.mockResolvedValue({ value: 'abc' });
      const { getSettingValue } = await import('../../../server/shared/settings/settings-repository.js');
      expect(await getSettingValue('foo')).toBe('abc');
      expect(prismaMock.prisma.settings.findUnique).toHaveBeenCalledWith({ where: { key: 'foo' }, select: { value: true } });
    });

    it('devolve null quando a chave não existe', async () => {
      prismaMock.prisma.settings.findUnique.mockResolvedValue(null);
      const { getSettingValue } = await import('../../../server/shared/settings/settings-repository.js');
      expect(await getSettingValue('nope')).toBeNull();
    });
  });

  describe('getSettingsRecord', () => {
    it('lista vazia devolve {} sem tocar na BD', async () => {
      const { getSettingsRecord } = await import('../../../server/shared/settings/settings-repository.js');
      expect(await getSettingsRecord([])).toEqual({});
      expect(prismaMock.prisma.settings.findMany).not.toHaveBeenCalled();
    });

    it('deduplica e filtra chaves inválidas antes de consultar', async () => {
      prismaMock.prisma.settings.findMany.mockResolvedValue([]);
      const { getSettingsRecord } = await import('../../../server/shared/settings/settings-repository.js');
      await getSettingsRecord(['a', 'a', '', 'b']);
      expect(prismaMock.prisma.settings.findMany).toHaveBeenCalledWith({ where: { key: { in: ['a', 'b'] } }, select: { key: true, value: true } });
    });

    it('só chaves inválidas: devolve {} sem consultar', async () => {
      const { getSettingsRecord } = await import('../../../server/shared/settings/settings-repository.js');
      expect(await getSettingsRecord(['', ''])).toEqual({});
      expect(prismaMock.prisma.settings.findMany).not.toHaveBeenCalled();
    });

    it('monta o Record a partir das rows devolvidas (chaves ausentes ficam de fora)', async () => {
      prismaMock.prisma.settings.findMany.mockResolvedValue([{ key: 'a', value: '1' }]);
      const { getSettingsRecord } = await import('../../../server/shared/settings/settings-repository.js');
      const out = await getSettingsRecord(['a', 'b']);
      expect(out).toEqual({ a: '1' });
    });
  });

  describe('upsertSettingsEntries', () => {
    it('lista vazia: não abre transação', async () => {
      const { upsertSettingsEntries } = await import('../../../server/shared/settings/settings-repository.js');
      await upsertSettingsEntries([]);
      expect(prismaMock.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('faz upsert de todas as entradas numa única transação', async () => {
      const { upsertSettingsEntries } = await import('../../../server/shared/settings/settings-repository.js');
      await upsertSettingsEntries([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
      expect(prismaMock.prisma.settings.upsert).toHaveBeenCalledTimes(2);
      expect(prismaMock.prisma.settings.upsert).toHaveBeenCalledWith({ where: { key: 'a' }, create: { key: 'a', value: '1' }, update: { value: '1' } });
      expect(prismaMock.prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
