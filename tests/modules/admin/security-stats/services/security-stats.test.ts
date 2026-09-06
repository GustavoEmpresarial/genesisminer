import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('loadSecurityStats / blacklist persist', () => {
  let prismaMock: Record<string, any>;
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let pool: { connect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn()
    };
    pool = { connect: vi.fn(async () => client) };
    prismaMock = {
      prisma: {
        ip_blacklist: {
          findMany: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 })
        },
        admin_access_logs: { findMany: vi.fn().mockResolvedValue([]) }
      }
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
  });

  it('section desconhecida: arrays vazios e só connect/release', async () => {
    const { loadSecurityStats } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    const dto = await loadSecurityStats(pool as any, 'nope');
    expect(dto.multiAccounts).toEqual([]);
    expect(dto.blacklist).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('multiAccounts filtra IP privado e devolve o público', async () => {
    client.query.mockResolvedValue({
      rows: [
        { registration_ip: '10.0.0.1', account_count: '2', usernames: ['a'], emails: ['a@a'], ids: [1] },
        { registration_ip: '8.8.8.8', account_count: '3', usernames: ['b'], emails: ['b@b'], ids: [2] }
      ]
    });
    const { loadSecurityStats } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    const dto = await loadSecurityStats(pool as any, 'multiAccounts');
    expect(dto.multiAccounts).toHaveLength(1);
    expect((dto.multiAccounts[0] as any).registration_ip).toBe('8.8.8.8');
    expect(dto.historyMultiAccounts).toEqual([]);
  });

  it('accessLogs mapeia created_at BigInt', async () => {
    prismaMock.prisma.admin_access_logs.findMany.mockResolvedValue([
      { id: 1, ip: '1.1.1.1', attempted_url: '/x', user_agent: null, details: 'd', created_at: 1700000000000n }
    ]);
    const { loadSecurityStats } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    const dto = await loadSecurityStats(pool as any, 'accessLogs');
    expect(dto.accessLogs[0]).toMatchObject({ id: 1, attempted_url: '/x', created_at: 1700000000000 });
  });

  it('addIpToBlacklist: valida antes do upsert; reason default', async () => {
    const { addIpToBlacklist } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    await expect(addIpToBlacklist({ ip: '' })).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.prisma.ip_blacklist.upsert).not.toHaveBeenCalled();
    await expect(addIpToBlacklist({ ip: '203.0.113.5' })).resolves.toEqual({ ok: true });
    expect(prismaMock.prisma.ip_blacklist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ip: '203.0.113.5' },
        create: expect.objectContaining({ ip: '203.0.113.5', reason: 'Banned by Admin' })
      })
    );
  });

  it('removeIpFromBlacklist chama deleteMany', async () => {
    const { removeIpFromBlacklist } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    await expect(removeIpFromBlacklist('203.0.113.5')).resolves.toEqual({ ok: true });
    expect(prismaMock.prisma.ip_blacklist.deleteMany).toHaveBeenCalledWith({ where: { ip: '203.0.113.5' } });
  });

  it('upsert falha: propaga', async () => {
    prismaMock.prisma.ip_blacklist.upsert.mockRejectedValue(new Error('db down'));
    const { addIpToBlacklist } = await import(
      '../../../../../server/modules/admin/security-stats/services/security-stats.js'
    );
    await expect(addIpToBlacklist({ ip: '203.0.113.5' })).rejects.toThrow('db down');
  });
});
