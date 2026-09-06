import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('admin device-fingerprint services/logs', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        device_fingerprint_logs: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        users: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('sem filtros: where vazio, devolve linhas mapeadas com utilizador associado', async () => {
    prismaMock.prisma.device_fingerprint_logs.count.mockResolvedValue(1);
    prismaMock.prisma.device_fingerprint_logs.findMany.mockResolvedValue([
      { id: 1n, user_id: 7, event_type: 'login', fingerprint_hash: 'abc', payload_json: '{}', ip: '1.2.3.4', user_agent: 'UA', created_at: 1000n }
    ]);
    prismaMock.prisma.users.findMany.mockResolvedValue([{ id: 7, email: 'a@b.com', username: 'joe' }]);
    const { listDeviceFingerprintLogs } = await import('../../../../../server/modules/admin/device-fingerprint/services/logs.js');
    const out = await listDeviceFingerprintLogs({ limit: 50, offset: 0 });
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ id: '1', userId: 7, email: 'a@b.com', username: 'joe', eventType: 'login', createdAt: 1000 });
    expect(prismaMock.prisma.device_fingerprint_logs.count).toHaveBeenCalledWith({ where: {} });
  });

  it('filtra por eventType e userId', async () => {
    const { listDeviceFingerprintLogs } = await import('../../../../../server/modules/admin/device-fingerprint/services/logs.js');
    await listDeviceFingerprintLogs({ limit: 50, offset: 0, eventType: 'register', userId: 5 });
    expect(prismaMock.prisma.device_fingerprint_logs.count).toHaveBeenCalledWith({
      where: { AND: [{ event_type: 'register' }, { user_id: 5 }] }
    });
  });

  it('busca por texto (q): resolve utilizadores primeiro e inclui os ids no OR', async () => {
    prismaMock.prisma.users.findMany.mockResolvedValueOnce([{ id: 9 }]);
    const { listDeviceFingerprintLogs } = await import('../../../../../server/modules/admin/device-fingerprint/services/logs.js');
    await listDeviceFingerprintLogs({ limit: 50, offset: 0, q: 'joe' });
    const whereArg = prismaMock.prisma.device_fingerprint_logs.count.mock.calls[0][0].where;
    expect(whereArg.AND[0].OR).toEqual(
      expect.arrayContaining([{ fingerprint_hash: { contains: 'joe', mode: 'insensitive' } }, { user_id: { in: [9] } }])
    );
  });

  it('limit é limitado a 200 e offset nunca negativo', async () => {
    const { listDeviceFingerprintLogs } = await import('../../../../../server/modules/admin/device-fingerprint/services/logs.js');
    await listDeviceFingerprintLogs({ limit: 9999, offset: -5 });
    expect(prismaMock.prisma.device_fingerprint_logs.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200, skip: 0 }));
  });
});
