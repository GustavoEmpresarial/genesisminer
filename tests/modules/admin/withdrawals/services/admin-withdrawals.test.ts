import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('listAdminWithdrawals', () => {
  it('mapeia JOIN users + mining_coins com o shape legado', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'wd-1',
            user_id: 7,
            username: 'alice',
            email: 'a@a.a',
            coin_id: 'btc',
            coin_symbol: 'BTC',
            amount_crypto: 1,
            amount_usdc: 50,
            fee_amount: 0.1,
            net_amount: 0.9,
            wallet_address: '0xabc',
            status: 'pending',
            tx_hash: null,
            created_at: 1000,
            processed_at: null
          }
        ]
      })
    };
    const { listAdminWithdrawals } = await import(
      '../../../../../server/modules/admin/withdrawals/services/admin-withdrawals.js'
    );
    const rows = await listAdminWithdrawals(pool as never);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('JOIN users u ON w.user_id = u.id'));
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('JOIN mining_coins c ON w.coin_id = c.id'));
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY w.created_at DESC'));
    expect(rows).toEqual([
      {
        id: 'wd-1',
        userId: 7,
        username: 'alice',
        email: 'a@a.a',
        coinId: 'btc',
        coinSymbol: 'BTC',
        amountCrypto: 1,
        amountUsdc: 50,
        feeAmount: 0.1,
        netAmount: 0.9,
        walletAddress: '0xabc',
        status: 'pending',
        txHash: null,
        createdAt: 1000,
        processedAt: null
      }
    ]);
  });

  it('GET não escreve (só SELECT)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const { listAdminWithdrawals } = await import(
      '../../../../../server/modules/admin/withdrawals/services/admin-withdrawals.js'
    );
    await listAdminWithdrawals(pool as never);
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});

describe('runAdminWithdrawalStatusUpdate', () => {
  let callWalletAdminWithdrawalStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    callWalletAdminWithdrawalStatus = vi.fn().mockResolvedValue({
      ok: true,
      message: 'Solicitação marcada como concluída.'
    });
    vi.doMock('../../../../../server/modules/wallet/services/wallet-worker-client.js', () => ({
      callWalletAdminWithdrawalStatus,
      isWalletWorkerError: (e: unknown) =>
        Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'WalletWorkerError')
    }));
  });

  async function load() {
    return import('../../../../../server/modules/admin/withdrawals/services/admin-withdrawals.js');
  }

  it('payload inválido: 400 e não chama worker', async () => {
    const { runAdminWithdrawalStatusUpdate } = await load();
    await expect(runAdminWithdrawalStatusUpdate({ requestId: '', status: 'completed' })).rejects.toMatchObject({
      statusCode: 400,
      jsonBody: { error: 'Dados inválidos' }
    });
    await expect(runAdminWithdrawalStatusUpdate({ requestId: 'wd-1', status: 'pending' })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(runAdminWithdrawalStatusUpdate({ requestId: 'wd-1', status: 'cancelled' })).rejects.toMatchObject({
      statusCode: 400
    });
    expect(callWalletAdminWithdrawalStatus).not.toHaveBeenCalled();
  });

  it('completed: delega ao wallet worker', async () => {
    const { runAdminWithdrawalStatusUpdate } = await load();
    const out = await runAdminWithdrawalStatusUpdate({
      requestId: 'wd-1',
      status: 'completed',
      txHash: '0xabc',
      nowMs: 1_700_000_000_000
    });
    expect(out).toEqual({ ok: true, message: 'Solicitação marcada como concluída.' });
    expect(callWalletAdminWithdrawalStatus).toHaveBeenCalledWith({
      requestId: 'wd-1',
      status: 'completed',
      txHash: '0xabc',
      serverNowMs: 1_700_000_000_000
    });
  });

  it('rejected: delega com status rejected', async () => {
    callWalletAdminWithdrawalStatus.mockResolvedValue({
      ok: true,
      message: 'Solicitação rejeitada e estornada.'
    });
    const { runAdminWithdrawalStatusUpdate } = await load();
    const out = await runAdminWithdrawalStatusUpdate({
      requestId: 'wd-1',
      status: 'rejected',
      nowMs: 9
    });
    expect(out).toEqual({ ok: true, message: 'Solicitação rejeitada e estornada.' });
    expect(callWalletAdminWithdrawalStatus).toHaveBeenCalledWith({
      requestId: 'wd-1',
      status: 'rejected',
      txHash: null,
      serverNowMs: 9
    });
  });

  it('WalletWorkerError 404: mapeia para HttpControlledError', async () => {
    const err = Object.assign(new Error('Solicitação não encontrada'), {
      name: 'WalletWorkerError',
      statusCode: 404,
      jsonBody: { ok: false, error: 'Solicitação não encontrada', code: 'NOT_FOUND' }
    });
    callWalletAdminWithdrawalStatus.mockRejectedValue(err);
    const { runAdminWithdrawalStatusUpdate } = await load();
    await expect(runAdminWithdrawalStatusUpdate({ requestId: 'missing', status: 'completed' })).rejects.toMatchObject({
      statusCode: 404,
      jsonBody: expect.objectContaining({ error: 'Solicitação não encontrada' })
    });
  });

  it('GENESIS_WALLET_URL unset: propaga throw', async () => {
    callWalletAdminWithdrawalStatus.mockRejectedValue(new Error('GENESIS_WALLET_URL unset'));
    const { runAdminWithdrawalStatusUpdate } = await load();
    await expect(runAdminWithdrawalStatusUpdate({ requestId: 'wd-1', status: 'completed' })).rejects.toThrow(
      'GENESIS_WALLET_URL unset'
    );
  });
});
