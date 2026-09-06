import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakePool(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) {
  return { connect: vi.fn(async () => client), query: client.query } as any;
}

const AUTH_WORKER = '../../../../server/modules/auth/services/auth-worker-client.js';

describe('gerente services/manager', () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let pool: any;
  let callAuthSessionLoad: ReturnType<typeof vi.fn>;
  let callAuthSessionUpdateFlags: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    client = { query: vi.fn(), release: vi.fn() };
    pool = fakePool(client);
    callAuthSessionLoad = vi.fn().mockResolvedValue({ ok: false, status: 401, error: 'session not found' });
    callAuthSessionUpdateFlags = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock(AUTH_WORKER, async () => {
      const actual = await vi.importActual<typeof import('../../../../server/modules/auth/services/auth-worker-client.js')>(
        AUTH_WORKER
      );
      return { ...actual, callAuthSessionLoad, callAuthSessionUpdateFlags };
    });
  });

  afterEach(() => {
    vi.doUnmock(AUTH_WORKER);
  });

  describe('hireManager', () => {
    it('dono não pode contratar a si próprio (SELF_HIRE)', async () => {
      client.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [{ id: 1, username: 'me', email: 'me@x.com' }] }); // findUserByEmailOrUsername (by email)
      const { hireManager, AccountManagerError } = await importManager();
      const err = await hireManager(pool, 1, 'me@x.com').catch((e) => e);
      expect(err).toBeInstanceOf(AccountManagerError);
      expect(err).toMatchObject({ code: 'SELF_HIRE' });
    });

    it('jogador-alvo não encontrado: USER_NOT_FOUND 404', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const { hireManager } = await importManager();
      await expect(hireManager(pool, 1, 'ninguem')).rejects.toMatchObject({ code: 'USER_NOT_FOUND', httpStatus: 404 });
    });

    it('sucesso: cria contrato pending e devolve mapeado', async () => {
      client.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [{ id: 2, username: 'manager1', email: 'm@x.com' }] }) // find by email
        .mockResolvedValueOnce({ rows: [] }) // existing pending/active check
        .mockResolvedValueOnce(undefined) // UPDATE end open applied
        .mockResolvedValueOnce({
          rows: [{ id: 10, owner_user_id: 1, manager_user_id: 2, status: 'pending', hired_at: null, ends_at: null, fire_locked_until: null, created_at: 1000, updated_at: 1000 }]
        }) // INSERT RETURNING
        .mockResolvedValueOnce(undefined); // COMMIT
      const { hireManager } = await importManager();
      const contract = await hireManager(pool, 1, 'manager1');
      expect(contract).toMatchObject({ id: 10, ownerUserId: 1, managerUserId: 2, status: 'pending', managerUsername: 'manager1' });
    });
  });

  describe('acceptContract — autorização por status', () => {
    it('status pending: só o gerente convidado pode aceitar (FORBIDDEN se não for)', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        rows: [{ id: 10, owner_user_id: 1, manager_user_id: 2, status: 'pending' }]
      });
      const { acceptContract } = await importManager();
      await expect(acceptContract(pool, 999, 10)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    });

    it('status applied: só o dono pode aprovar (FORBIDDEN se não for)', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        rows: [{ id: 10, owner_user_id: 1, manager_user_id: 2, status: 'applied' }]
      });
      const { acceptContract } = await importManager();
      await expect(acceptContract(pool, 999, 10)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    });

    it('contrato não encontrado: NOT_FOUND 404', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [] });
      const { acceptContract } = await importManager();
      await expect(acceptContract(pool, 1, 999)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('status já não pendente (ex.: ended): INVALID_STATUS', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        rows: [{ id: 10, owner_user_id: 1, manager_user_id: 2, status: 'ended' }]
      });
      const { acceptContract } = await importManager();
      await expect(acceptContract(pool, 2, 10)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });
  });

  describe('fireManager', () => {
    it('sem gerente ativo: NOT_FOUND', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [] });
      const { fireManager } = await importManager();
      await expect(fireManager(pool, 1)).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('dentro do fire-lock (primeira semana): FIRE_LOCKED 403', async () => {
      const future = Date.now() + 100000;
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [{ id: 10, fire_locked_until: future }] });
      const { fireManager } = await importManager();
      await expect(fireManager(pool, 1)).rejects.toMatchObject({ code: 'FIRE_LOCKED', httpStatus: 403 });
    });

    it('fora do lock: encerra contrato e força saída de sessões', async () => {
      const past = Date.now() - 100000;
      client.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // SET LOCAL lock_timeout
        .mockResolvedValueOnce({ rows: [{ id: 10, fire_locked_until: past }] }) // SELECT contract
        .mockResolvedValueOnce(undefined) // UPDATE contract ended
        .mockResolvedValueOnce(undefined); // COMMIT
      const { fireManager } = await importManager();
      await fireManager(pool, 1);
      expect(callAuthSessionUpdateFlags).toHaveBeenCalledWith({
        restoreUserIdFromOriginal: true,
        matchActingAsOwnerId: 1
      });
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('resignManager', () => {
    it('contrato não pertence ao gerente que está a resignar: FORBIDDEN', async () => {
      client.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce({
        rows: [{ id: 10, manager_user_id: 2, owner_user_id: 1, status: 'active' }]
      });
      const { resignManager } = await importManager();
      await expect(resignManager(pool, 999)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    });
  });

  describe('loadSessionManagerFlags', () => {
    it('sem sessionId: devolve flags vazias sem consultar o worker', async () => {
      const { loadSessionManagerFlags } = await importManager();
      const flags = await loadSessionManagerFlags(pool, null);
      expect(flags).toEqual({ managerMode: false, managerUserId: null, actingAsOwnerId: null, isManagingAccount: false });
      expect(callAuthSessionLoad).not.toHaveBeenCalled();
    });

    it('sessão fora de manager_mode: flags vazias', async () => {
      callAuthSessionLoad.mockResolvedValue({
        ok: true,
        userId: 1,
        sessionId: 'sid1',
        createdAtMs: 1,
        expiresAtMs: 2,
        managerMode: 0,
        originalUserId: null,
        actingAsOwnerId: null,
        user: { id: 1, username: 'u', email: 'u@x.com' }
      });
      const { loadSessionManagerFlags } = await importManager();
      const flags = await loadSessionManagerFlags(pool, 'sid1');
      expect(flags.managerMode).toBe(false);
    });

    it('sessão em manager_mode: devolve managerUserId (original_user_id) e actingAsOwnerId', async () => {
      callAuthSessionLoad.mockResolvedValue({
        ok: true,
        userId: 1,
        sessionId: 'sid1',
        createdAtMs: 1,
        expiresAtMs: 2,
        managerMode: 1,
        originalUserId: 2,
        actingAsOwnerId: 1,
        user: { id: 1, username: 'u', email: 'u@x.com' }
      });
      const { loadSessionManagerFlags } = await importManager();
      const flags = await loadSessionManagerFlags(pool, 'sid1');
      expect(flags).toEqual({ managerMode: true, managerUserId: 2, actingAsOwnerId: 1, isManagingAccount: true });
    });

    it('worker unset/5xx: throw (fail-closed)', async () => {
      callAuthSessionLoad.mockRejectedValue(new Error('GENESIS_AUTH_URL unset'));
      const { loadSessionManagerFlags } = await importManager();
      await expect(loadSessionManagerFlags(pool, 'sid1')).rejects.toThrow('GENESIS_AUTH_URL unset');
    });
  });
});

async function importManager() {
  return import('../../../../server/modules/gerente/services/manager.js').then(async (m) => ({
    ...m,
    AccountManagerError: (await import('../../../../server/modules/gerente/services/errors.js')).AccountManagerError
  }));
}
