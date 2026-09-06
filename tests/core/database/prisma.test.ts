import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('core/database/prisma', () => {
  let connectMock: ReturnType<typeof vi.fn>;
  let disconnectMock: ReturnType<typeof vi.fn>;
  let PrismaClientMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    connectMock = vi.fn().mockResolvedValue(undefined);
    disconnectMock = vi.fn().mockResolvedValue(undefined);
    PrismaClientMock = vi.fn().mockImplementation(() => ({ $connect: connectMock, $disconnect: disconnectMock }));
    vi.doMock('@prisma/client', () => ({ PrismaClient: PrismaClientMock }));
    delete (globalThis as { prisma?: unknown }).prisma;
  });

  afterEach(() => {
    vi.doUnmock('@prisma/client');
    vi.unstubAllEnvs();
    delete (globalThis as { prisma?: unknown }).prisma;
  });

  it('cria o PrismaClient com log de erro em produção (sem warn)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await import('../../../server/core/database/prisma.js');
    expect(PrismaClientMock).toHaveBeenCalledWith({ log: ['error'] });
  });

  it('cria o PrismaClient com log warn+error fora de produção', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await import('../../../server/core/database/prisma.js');
    expect(PrismaClientMock).toHaveBeenCalledWith({ log: ['warn', 'error'] });
  });

  it('fora de produção, guarda a instância em globalThis.prisma (hot-reload)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { prisma } = await import('../../../server/core/database/prisma.js');
    expect((globalThis as { prisma?: unknown }).prisma).toBe(prisma);
  });

  it('em produção, não guarda em globalThis.prisma', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await import('../../../server/core/database/prisma.js');
    expect((globalThis as { prisma?: unknown }).prisma).toBeUndefined();
  });

  it('reaproveita a instância já existente em globalThis.prisma em vez de criar outra', async () => {
    const existing = { $connect: vi.fn(), $disconnect: vi.fn() };
    (globalThis as { prisma?: unknown }).prisma = existing;
    const { prisma } = await import('../../../server/core/database/prisma.js');
    expect(prisma).toBe(existing);
    expect(PrismaClientMock).not.toHaveBeenCalled();
  });

  it('connectPrisma/disconnectPrisma chamam $connect/$disconnect da instância', async () => {
    const { connectPrisma, disconnectPrisma } = await import('../../../server/core/database/prisma.js');
    await connectPrisma();
    await disconnectPrisma();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});
