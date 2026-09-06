import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET_CLIENT_PATH = '../../../../../server/modules/wallet/services/wallet-worker-client.js';

describe('setAdminCoinBalance', () => {
  let callWalletAdminSetCoinBalance: ReturnType<typeof vi.fn>;
  let prevWalletUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevWalletUrl = process.env.GENESIS_WALLET_URL;
    process.env.GENESIS_WALLET_URL = 'http://wallet.test';
    callWalletAdminSetCoinBalance = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock(WALLET_CLIENT_PATH, () => ({
      callWalletAdminSetCoinBalance,
      isWalletWorkerError: (e: unknown) =>
        e instanceof Error && (e as { name?: string }).name === 'WalletWorkerError'
    }));
  });

  afterEach(() => {
    if (prevWalletUrl === undefined) delete process.env.GENESIS_WALLET_URL;
    else process.env.GENESIS_WALLET_URL = prevWalletUrl;
    vi.doUnmock(WALLET_CLIENT_PATH);
  });

  it('delega SET absoluto ao wallet worker; não escreve SQL local', async () => {
    const { setAdminCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    const pool = { query: vi.fn() };
    const out = await setAdminCoinBalance(pool as never, { userId: 7, coinId: 'btc', amount: 3.5 });
    expect(out).toEqual({ ok: true });
    expect(callWalletAdminSetCoinBalance).toHaveBeenCalledWith({
      userId: 7,
      coinId: 'btc',
      amount: 3.5
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('permite SET negativo (legado não faz GREATEST no individual)', async () => {
    const { setAdminCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    await setAdminCoinBalance({ query: vi.fn() } as never, { userId: 7, coinId: 'btc', amount: -2 });
    expect(callWalletAdminSetCoinBalance).toHaveBeenCalledWith({
      userId: 7,
      coinId: 'btc',
      amount: -2
    });
  });

  it('user/coin inexistentes: ainda chama worker (sem FK / sem 404 no Node)', async () => {
    const { setAdminCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    await expect(
      setAdminCoinBalance({ query: vi.fn() } as never, {
        userId: 999999,
        coinId: 'no-such-coin',
        amount: 1
      })
    ).resolves.toEqual({ ok: true });
    expect(callWalletAdminSetCoinBalance).toHaveBeenCalledTimes(1);
  });

  it('payload inválido: 400 e não chama worker', async () => {
    const { setAdminCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    const pool = { query: vi.fn() };
    await expect(setAdminCoinBalance(pool as never, { userId: undefined, coinId: 'btc', amount: 1 })).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: { error: 'Missing fields: userId, coinId, amount' }
    });
    await expect(setAdminCoinBalance(pool as never, { userId: 7, coinId: '', amount: 1 })).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: { error: 'Missing fields: userId, coinId, amount' }
    });
    await expect(setAdminCoinBalance(pool as never, { userId: 7, coinId: 'btc', amount: Number.NaN })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(setAdminCoinBalance(pool as never, { userId: 7, coinId: 'btc', amount: Infinity })).rejects.toMatchObject({
      statusCode: 400
    });
    expect(callWalletAdminSetCoinBalance).not.toHaveBeenCalled();
  });

  it('GENESIS_WALLET_URL unset: propaga throw', async () => {
    callWalletAdminSetCoinBalance.mockRejectedValue(new Error('GENESIS_WALLET_URL unset'));
    const { setAdminCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    await expect(
      setAdminCoinBalance({ query: vi.fn() } as never, { userId: 7, coinId: 'btc', amount: 1 })
    ).rejects.toThrow('GENESIS_WALLET_URL unset');
  });
});

describe('runAdminBulkUpdateCoinBalance', () => {
  let client: { query: ReturnType<typeof vi.fn> };
  let selectedIds: number[];
  let balances: Map<string, number>;
  let beginCalled: boolean;
  let commitCalled: boolean;
  let rollbackCalled: boolean;
  let upsertParams: unknown[] | null;

  beforeEach(() => {
    selectedIds = [7, 8];
    balances = new Map([
      ['7:btc', 10],
      ['8:btc', 1],
      ['9:btc', 50],
      ['7:eth', 100]
    ]);
    beginCalled = false;
    commitCalled = false;
    rollbackCalled = false;
    upsertParams = null;
    client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = String(sql);
        if (s.includes('BEGIN')) {
          beginCalled = true;
          return { rows: [] };
        }
        if (s.includes('COMMIT')) {
          commitCalled = true;
          return { rows: [] };
        }
        if (s.includes('ROLLBACK')) {
          rollbackCalled = true;
          return { rows: [] };
        }
        if (s.includes('FROM placed_racks')) {
          return { rows: selectedIds.map((user_id) => ({ user_id })) };
        }
        if (s.includes('unnest')) {
          upsertParams = params ?? null;
          const [userIds, coinId, amount] = params as [number[], string, number];
          for (const uid of userIds) {
            const key = `${uid}:${coinId}`;
            const prev = balances.get(key);
            if (prev == null) {
              balances.set(key, Math.max(0, amount));
            } else {
              balances.set(key, Math.max(0, prev + amount));
            }
          }
          return { rows: [], rowCount: userIds.length };
        }
        return { rows: [] };
      })
    };
  });

  it('incrementa (não SET) só os userIds seleccionados, floor 0, COMMIT', async () => {
    const { runAdminBulkUpdateCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    const out = await runAdminBulkUpdateCoinBalance(client as never, { coinId: 'btc', amount: -3 });
    expect(out).toEqual({ ok: true, count: 2 });
    expect(beginCalled).toBe(true);
    expect(commitCalled).toBe(true);
    expect(rollbackCalled).toBe(false);
    expect(balances.get('7:btc')).toBe(7);
    expect(balances.get('8:btc')).toBe(0);
    expect(balances.get('9:btc')).toBe(50);
    expect(balances.get('7:eth')).toBe(100);
    expect(String(client.query.mock.calls.find((c) => String(c[0]).includes('unnest'))?.[0])).toContain(
      'GREATEST(0, coin_balances.amount + $3'
    );
    expect(upsertParams?.[0]).toEqual([7, 8]);
    expect(upsertParams?.[1]).toBe('btc');
    expect(upsertParams?.[2]).toBe(-3);
  });

  it('lista vazia: COMMIT com count 0, sem UPSERT', async () => {
    const { runAdminBulkUpdateCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    selectedIds = [];
    const out = await runAdminBulkUpdateCoinBalance(client as never, { coinId: 'btc', amount: 5 });
    expect(out).toEqual({ ok: true, count: 0 });
    expect(commitCalled).toBe(true);
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('unnest'))).toBe(false);
    expect(balances.get('9:btc')).toBe(50);
  });

  it('falha a meio: ROLLBACK de todos, sem COMMIT', async () => {
    const { runAdminBulkUpdateCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    client.query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('BEGIN')) return { rows: [] };
      if (s.includes('ROLLBACK')) {
        rollbackCalled = true;
        return { rows: [] };
      }
      if (s.includes('COMMIT')) {
        commitCalled = true;
        return { rows: [] };
      }
      if (s.includes('FROM placed_racks')) return { rows: [{ user_id: 7 }, { user_id: 8 }] };
      if (s.includes('unnest')) throw new Error('disk full');
      return { rows: [] };
    });
    await expect(runAdminBulkUpdateCoinBalance(client as never, { coinId: 'btc', amount: 1 })).rejects.toThrow('disk full');
    expect(rollbackCalled).toBe(true);
    expect(commitCalled).toBe(false);
  });

  it('payload inválido: 400 sem transação', async () => {
    const { runAdminBulkUpdateCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    await expect(runAdminBulkUpdateCoinBalance(client as never, { coinId: '', amount: 1 })).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: { error: 'Campos ausentes: coinId, amount' }
    });
    await expect(runAdminBulkUpdateCoinBalance(client as never, { coinId: 'btc', amount: undefined })).rejects.toMatchObject({
      statusCode: 400
    });
    expect(beginCalled).toBe(false);
  });

  it('coin inexistente: mesmo fluxo (0 alvos) — sem 404', async () => {
    const { runAdminBulkUpdateCoinBalance } = await import(
      '../../../../../server/modules/admin/coin-balance/services/admin-coin-balance.js'
    );
    selectedIds = [];
    await expect(runAdminBulkUpdateCoinBalance(client as never, { coinId: 'ghost', amount: 1 })).resolves.toEqual({
      ok: true,
      count: 0
    });
  });
});
