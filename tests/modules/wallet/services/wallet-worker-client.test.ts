import { afterEach, describe, expect, it, vi } from 'vitest';

describe('wallet-worker-client fail-closed', () => {
  const prev = process.env.GENESIS_WALLET_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.GENESIS_WALLET_URL;
    else process.env.GENESIS_WALLET_URL = prev;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('deposit resolve-receipt HTTP budget matches Blockscout + explorer + polygon RPC chain', async () => {
    const {
      DEPOSIT_RPC_RECEIPT_TIMEOUT_MS,
      DEPOSIT_EXPLORER_FETCH_TIMEOUT_MS,
      DEPOSIT_POLYGON_RPC_CANDIDATE_MAX,
      WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS
    } = await import('../../../../server/modules/wallet/services/wallet-worker-client.js');
    expect(WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS).toBe(
      DEPOSIT_RPC_RECEIPT_TIMEOUT_MS +
        DEPOSIT_EXPLORER_FETCH_TIMEOUT_MS +
        DEPOSIT_POLYGON_RPC_CANDIDATE_MAX * DEPOSIT_RPC_RECEIPT_TIMEOUT_MS
    );
  });

  it('deposit resolve-receipt uses WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS', async () => {
    process.env.GENESIS_WALLET_URL = 'http://wallet.test';
    vi.resetModules();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, pending: true })
      }))
    );
    const { callWalletDepositResolveReceipt, WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    const out = await callWalletDepositResolveReceipt({
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      network: 'polygon',
      settings: {}
    });
    expect(out).toEqual({ ok: true, pending: true });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), WALLET_DEPOSIT_RESOLVE_TIMEOUT_MS);
  });

  it('unset URL → GENESIS_WALLET_URL unset', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletExchangeLiquidate } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(
      callWalletExchangeLiquidate({
        userId: 1,
        coinId: 'btc',
        fraction: 0.5,
        fractionMode: 'desk_shortcuts',
        minUsdc: 0.1,
        feePercent: 0,
        idempotencyKey: 'k'.repeat(10),
        idempotencyScope: 'wallet_exchange_liquidate',
        serverNowMs: Date.now()
      })
    ).rejects.toThrow('GENESIS_WALLET_URL unset');
  });

  it('HTTP 422 domain → WalletWorkerError', async () => {
    process.env.GENESIS_WALLET_URL = 'http://wallet.test';
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ ok: false, error: 'Insufficient balance.' })
      }))
    );
    const { callWalletExchangeLiquidate, isWalletWorkerError } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    try {
      await callWalletExchangeLiquidate({
        userId: 1,
        coinId: 'btc',
        fraction: 1,
        fractionMode: 'desk_shortcuts',
        minUsdc: 0.1,
        feePercent: 0,
        idempotencyKey: null,
        idempotencyScope: 'wallet_exchange_liquidate',
        serverNowMs: Date.now()
      });
      expect.fail('should throw');
    } catch (e) {
      expect(isWalletWorkerError(e)).toBe(true);
      expect((e as { statusCode: number }).statusCode).toBe(422);
    }
  });

  it('quest claim unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletQuestClaim } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(callWalletQuestClaim({ userId: 1, questId: 'daily_checkin', serverNowMs: Date.now() })).rejects.toThrow(
      'GENESIS_WALLET_URL unset'
    );
  });

  it('referral credit unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletReferralCreditOnEmailVerified } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(callWalletReferralCreditOnEmailVerified({ verifiedUserId: 1 })).rejects.toThrow('GENESIS_WALLET_URL unset');
  });

  it('zerads credit unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletZeradsCredit } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(callWalletZeradsCredit({ userId: 1, amountZer: 1, clicks: 0 })).rejects.toThrow('GENESIS_WALLET_URL unset');
  });

  it('admin withdrawal status unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletAdminWithdrawalStatus } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(
      callWalletAdminWithdrawalStatus({ requestId: 'wd-1', status: 'completed' })
    ).rejects.toThrow('GENESIS_WALLET_URL unset');
  });

  it('admin set coin balance unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletAdminSetCoinBalance } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(
      callWalletAdminSetCoinBalance({ userId: 1, coinId: 'btc', amount: 1 })
    ).rejects.toThrow('GENESIS_WALLET_URL unset');
  });

  it('admin save-game balances unset URL', async () => {
    delete process.env.GENESIS_WALLET_URL;
    vi.resetModules();
    const { callWalletAdminSaveGameBalances } = await import(
      '../../../../server/modules/wallet/services/wallet-worker-client.js'
    );
    await expect(callWalletAdminSaveGameBalances({ userId: 1, usdc: 1 })).rejects.toThrow(
      'GENESIS_WALLET_URL unset'
    );
  });

});
