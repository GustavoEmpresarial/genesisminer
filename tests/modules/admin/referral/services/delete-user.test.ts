import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('modules/admin/referral/services/delete-user', () => {
  let poolClientMock: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: { default: { connect: ReturnType<typeof vi.fn> } };
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    vi.doMock('../../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwareWipeUser: vi.fn().mockResolvedValue({ ok: true })
    }));
    vi.doMock('../../../../../server/modules/auth/services/auth-worker-client.js', () => ({
      callAuthSessionDeleteByUser: vi.fn().mockResolvedValue({ ok: true, deletedCount: 0 })
    }));
    vi.resetModules();
    poolClientMock = { query: vi.fn(), release: vi.fn() };
    poolMock = { default: { connect: vi.fn().mockResolvedValue(poolClientMock) } };
    vi.doMock('../../../../../server/core/database/pool.js', () => poolMock);
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../../server/core/database/pool.js');
    vi.doUnmock('../../../../../server/modules/hardware/services/hardware-client.js');
    vi.doUnmock('../../../../../server/modules/auth/services/auth-worker-client.js');
  });

  async function loadModule() {
    return import('../../../../../server/modules/admin/referral/services/delete-user.js');
  }

  it('email vazio: devolve erro sem abrir transação', async () => {
    const { deleteUserByEmail } = await loadModule();
    const result = await deleteUserByEmail('   ', null);
    expect(result).toEqual({ ok: false, error: 'Email inválido.' });
  });

  it('utilizador não encontrado: ROLLBACK e erro, quando dono da transação', async () => {
    poolClientMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve(undefined);
    });
    const { deleteUserByEmail } = await loadModule();
    const result = await deleteUserByEmail('nao-existe@x.com', null);
    expect(result).toEqual({ ok: false, error: 'Utilizador não encontrado.' });
    expect(poolClientMock.query).toHaveBeenCalledWith('BEGIN');
    expect(poolClientMock.query).toHaveBeenCalledWith('ROLLBACK');
    expect(poolClientMock.release).toHaveBeenCalled();
  });

  it('GENESIS_HARDWARE_URL: wipe via callHardwareWipeUser — sem DELETE stock/racks/batteries', async () => {
    const prevUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    const callHardwareWipeUser = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwareWipeUser
    }));
    poolClientMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT id, username')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 7, username: 'bob', polygon_wallet: null, email: 'bob@x.com' }] });
      }
      return Promise.resolve(undefined);
    });
    try {
      const { deleteUserByEmail } = await loadModule();
      const result = await deleteUserByEmail('bob@x.com', null);
      expect(result).toEqual({ ok: true });
      expect(callHardwareWipeUser).toHaveBeenCalledTimes(1);
      expect(callHardwareWipeUser).toHaveBeenCalledWith({ userId: 7 });
      const sqls = poolClientMock.query.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((q) => /DELETE FROM stock/i.test(q))).toBe(false);
      expect(sqls.some((q) => /DELETE FROM item_instances/i.test(q))).toBe(false);
      expect(sqls.some((q) => /DELETE FROM placed_racks/i.test(q))).toBe(false);
      expect(sqls.some((q) => /DELETE FROM stored_batteries/i.test(q))).toBe(false);
      expect(poolClientMock.query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', [7]);
      expect(sqls.some((q) => /DELETE FROM sessions/i.test(q))).toBe(false);
      expect(sqls.some((q) => /UPDATE sessions/i.test(q))).toBe(false);
      expect(poolClientMock.query).toHaveBeenCalledWith('COMMIT');
    } finally {
      if (prevUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
      else process.env.GENESIS_HARDWARE_URL = prevUrl;
      vi.doUnmock('../../../../../server/modules/hardware/services/hardware-client.js');
    }
  });

  it('GENESIS_HARDWARE_URL: wipe throw aborta sem DELETE users (fail-closed)', async () => {
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    const callHardwareWipeUser = vi.fn().mockRejectedValue(new Error('hardware wipe-user failed'));
    vi.doMock('../../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwareWipeUser
    }));
    poolClientMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT id, username')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 7, username: 'bob', polygon_wallet: null, email: 'bob@x.com' }] });
      }
      return Promise.resolve(undefined);
    });
    const { deleteUserByEmail } = await loadModule();
    await expect(deleteUserByEmail('bob@x.com', null)).rejects.toThrow('hardware wipe-user failed');
    expect(callHardwareWipeUser).toHaveBeenCalledWith({ userId: 7 });
    expect(poolClientMock.query).not.toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', [7]);
    expect(poolClientMock.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('recebendo um client externo (transação partilhada): não faz BEGIN/COMMIT/ROLLBACK/release próprios', async () => {
    const externalClient = { query: vi.fn() };
    externalClient.query.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT id, username')) return Promise.resolve({ rowCount: 1, rows: [{ id: 3, username: null, polygon_wallet: null, email: 'x@x.com' }] });
      return Promise.resolve(undefined);
    });
    const { deleteUserByEmail } = await loadModule();
    const result = await deleteUserByEmail('x@x.com', externalClient as any);
    expect(result).toEqual({ ok: true });
    expect(externalClient.query).not.toHaveBeenCalledWith('BEGIN');
    expect(externalClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(poolMock.default.connect).not.toHaveBeenCalled();
  });

  it('múltiplas contas com o mesmo e-mail (case-insensitive) sem correspondência exacta: lança erro', async () => {
    poolClientMock.query.mockImplementation((sql: string) => {
      if (sql.includes('AND email = $2')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.startsWith('SELECT id, username')) return Promise.resolve({ rowCount: 2, rows: [] });
      return Promise.resolve(undefined);
    });
    const { deleteUserByEmail } = await loadModule();
    await expect(deleteUserByEmail('Bob@X.com', null)).rejects.toThrow('várias contas com o mesmo e-mail');
  });
});
