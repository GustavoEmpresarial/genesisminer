import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('parseAdminWalletHistoryUserId', () => {
  it('aceita inteiro positivo em string', async () => {
    const { parseAdminWalletHistoryUserId } = await import(
      '../../../../../server/modules/admin/users/services/wallet-history.js'
    );
    expect(parseAdminWalletHistoryUserId('42')).toBe(42);
    expect(parseAdminWalletHistoryUserId(42)).toBe(42);
  });

  it('rejeita ausente, 0, negativo, decimal e lixo', async () => {
    const { parseAdminWalletHistoryUserId } = await import(
      '../../../../../server/modules/admin/users/services/wallet-history.js'
    );
    expect(parseAdminWalletHistoryUserId(undefined)).toBeNull();
    expect(parseAdminWalletHistoryUserId('')).toBeNull();
    expect(parseAdminWalletHistoryUserId('abc')).toBeNull();
    expect(parseAdminWalletHistoryUserId('0')).toBeNull();
    expect(parseAdminWalletHistoryUserId('-1')).toBeNull();
    expect(parseAdminWalletHistoryUserId('1.5')).toBeNull();
  });
});

describe('loadAdminUserWalletHistory', () => {
  let prismaMock: Record<string, any>;
  let profileWalletHistory: Record<string, any>;

  const historyRow = {
    id: 'h1',
    action: 'admin_changed',
    network: 'polygon',
    walletAddress: '0xabc',
    previousWalletAddress: '0xold',
    newWalletAddress: '0xabc',
    ipAddress: '1.2.3.4',
    userAgent: 'ua',
    actorType: 'admin',
    actorUserId: 7,
    source: 'admin',
    notes: 'ok',
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { k: 1 }
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        users: { findUnique: vi.fn().mockResolvedValue({ id: 10 }) }
      }
    };
    profileWalletHistory = {
      getProfileWalletWithHistory: vi.fn().mockResolvedValue({
        ok: true,
        wallet: { address: '0xabc', network: 'polygon', connectedAt: '2026-01-01T00:00:00.000Z' },
        history: [historyRow]
      })
    };
    vi.doMock('../../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../../server/modules/profile/services/wallet-history.js', () => profileWalletHistory);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../../server/modules/profile/services/wallet-history.js');
  });

  async function load() {
    return import('../../../../../server/modules/admin/users/services/wallet-history.js');
  }

  it('ID inválido: 400 e não consulta utilizador nem histórico', async () => {
    const { loadAdminUserWalletHistory } = await load();
    await expect(loadAdminUserWalletHistory('1.5')).rejects.toMatchObject({ statusCode: 400 });
    await expect(loadAdminUserWalletHistory('abc')).rejects.toMatchObject({ statusCode: 400 });
    await expect(loadAdminUserWalletHistory('0')).rejects.toMatchObject({ statusCode: 400 });
    await expect(loadAdminUserWalletHistory('-1')).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.prisma.users.findUnique).not.toHaveBeenCalled();
    expect(profileWalletHistory.getProfileWalletWithHistory).not.toHaveBeenCalled();
  });

  it('utilizador inexistente: 404', async () => {
    prismaMock.prisma.users.findUnique.mockResolvedValue(null);
    const { loadAdminUserWalletHistory } = await load();
    await expect(loadAdminUserWalletHistory('99')).rejects.toMatchObject({ statusCode: 404 });
    expect(profileWalletHistory.getProfileWalletWithHistory).not.toHaveBeenCalled();
  });

  it('alvo é o userId do path, não outro id de sessão', async () => {
    const { loadAdminUserWalletHistory } = await load();
    await loadAdminUserWalletHistory('10');
    expect(prismaMock.prisma.users.findUnique).toHaveBeenCalledWith({ where: { id: 10 }, select: { id: true } });
    expect(profileWalletHistory.getProfileWalletWithHistory).toHaveBeenCalledWith({ userId: 10 });
  });

  it('mapeia wallet → currentWallet com status connected e history camelCase', async () => {
    const { loadAdminUserWalletHistory } = await load();
    const out = await loadAdminUserWalletHistory('10');
    expect(out).toEqual({
      currentWallet: {
        address: '0xabc',
        network: 'polygon',
        connectedAt: '2026-01-01T00:00:00.000Z',
        status: 'connected'
      },
      history: [historyRow]
    });
    expect(JSON.stringify(out)).not.toMatch(/signature_message/);
    expect(JSON.stringify(out)).not.toMatch(/signature_address/);
    expect(out).not.toHaveProperty('ok');
    expect(out).not.toHaveProperty('wallet');
  });

  it('wallet null → currentWallet null; history vazio → []', async () => {
    profileWalletHistory.getProfileWalletWithHistory.mockResolvedValue({ ok: true, wallet: null, history: [] });
    const { loadAdminUserWalletHistory } = await load();
    const out = await loadAdminUserWalletHistory('10');
    expect(out).toEqual({ currentWallet: null, history: [] });
  });

  it('inclui ação admin_changed no history', async () => {
    const { loadAdminUserWalletHistory } = await load();
    const out = await loadAdminUserWalletHistory('10');
    expect(out.history.some((r) => r.action === 'admin_changed')).toBe(true);
  });
});
