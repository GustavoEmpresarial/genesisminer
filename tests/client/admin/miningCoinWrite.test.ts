import { describe, expect, it, vi } from 'vitest';
import {
  MINING_COINS_WRITE_PATH,
  inactivateMiningCoin
} from '../../../client/src/features/admin/lib/miningCoinWrite.js';

const btc = { id: 'btc', name: 'Bitcoin', symbol: 'BTC', isActive: true, priceUSD: 1 };

describe('miningCoinWrite', () => {
  it('path de escrita é POST /api/mining-coins', () => {
    expect(MINING_COINS_WRITE_PATH).toBe('/api/mining-coins');
  });

  it('inativar reenvia a moeda existente com isActive false no upsert', async () => {
    const saveCoin = vi.fn().mockResolvedValue({ ok: true, id: 'btc' });
    const res = await inactivateMiningCoin('btc', {
      loadCoins: async () => [btc, { id: 'eth', name: 'Ethereum', isActive: true }],
      saveCoin
    });
    expect(res.ok).toBe(true);
    expect(saveCoin).toHaveBeenCalledTimes(1);
    const payload = saveCoin.mock.calls[0][0] as typeof btc;
    expect(payload.id).toBe('btc');
    expect(payload.isActive).toBe(false);
    expect(payload.name).toBe('Bitcoin');
  });

  it('moeda inexistente não chama save', async () => {
    const saveCoin = vi.fn();
    const res = await inactivateMiningCoin('x', {
      loadCoins: async () => [btc],
      saveCoin
    });
    expect(res).toEqual({ ok: false, error: 'Moeda não encontrada.' });
    expect(saveCoin).not.toHaveBeenCalled();
  });

  it('propaga erro do save', async () => {
    const res = await inactivateMiningCoin('btc', {
      loadCoins: async () => [btc],
      saveCoin: async () => ({ ok: false, error: 'HTTP 403' })
    });
    expect(res).toEqual({ ok: false, error: 'HTTP 403' });
  });

  it('falha do GET não se apresenta como moeda inexistente', async () => {
    const saveCoin = vi.fn();
    const res = await inactivateMiningCoin('btc', {
      loadCoins: async () => {
        throw new Error('Erro de API (500)');
      },
      saveCoin
    });
    expect(res).toEqual({ ok: false, error: 'Erro de API (500)' });
    expect(saveCoin).not.toHaveBeenCalled();
  });
});
