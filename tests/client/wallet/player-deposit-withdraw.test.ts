import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendUsdcDeposit } from '../../../client/src/features/wallet/lib/sendUsdcDeposit.js';

const walletPagePath = join(dirname(fileURLToPath(import.meta.url)), '../../../client/src/features/wallet/ui/WalletPage.tsx');

describe('player wallet deposit/withdraw client wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('WalletPage já não usa stubs de migração pendente', () => {
    const src = readFileSync(walletPagePath, 'utf8');
    expect(src).not.toMatch(/ainda estão em migração/);
    expect(src).toContain('requestWithdrawal');
    expect(src).toContain('verifyDeposit');
    expect(src).toContain('sendUsdcDeposit');
    expect(src).toContain('onStartDeposit');
    expect(src).toContain('handleVerifyDepositByHash');
  });

  it('sendUsdcDeposit recusa carteira MetaMask diferente da do perfil', async () => {
    const ethereum = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'];
        return '0x1';
      })
    };
    const out = await sendUsdcDeposit({
      amount: 10,
      network: 'polygon',
      polygonWallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      settings: {
        depositWallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositTokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
      },
      ethereum,
      confirm: () => true
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/carteira conectada/);
  });

  it('sendUsdcDeposit não trata cancelamento como sucesso', async () => {
    const out = await sendUsdcDeposit({
      amount: 10,
      network: 'polygon',
      polygonWallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      settings: {
        depositWallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        depositTokenContract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
      },
      ethereum: {
        request: vi.fn(async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8'];
          if (method === 'eth_chainId') return '0x89';
          if (method === 'eth_call') return '0x6';
          throw new Error('user rejected');
        })
      },
      confirm: () => true
    });
    expect(out.ok).toBe(false);
    expect(out.cancelled).toBe(true);
  });

  it('requestWithdrawal e verifyDeposit usam rotas reais e não inventam ok', async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/withdraw')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'Saldo insuficiente.' })
        };
      }
      if (String(url).includes('/deposit/verify')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'Hash inválido.' })
        };
      }
      throw new Error('unexpected ' + url);
    });
    vi.doMock('../../../client/src/shared/api/http.js', () => ({ apiFetch: fetchMock }));
    const { requestWithdrawal, verifyDeposit } = await import('../../../client/src/shared/api/wallet.js');
    const w = await requestWithdrawal('btc', 1, '0xabc', 'abcdefgh');
    expect(w.ok).toBe(false);
    expect(w.error).toBe('Saldo insuficiente.');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/withdraw');
    const d = await verifyDeposit({
      txHash: '0x' + 'a'.repeat(64),
      network: 'polygon'
    });
    expect(d.ok).toBe(false);
    expect(d.error).toBe('Hash inválido.');
    vi.doUnmock('../../../client/src/shared/api/http.js');
  });
});
