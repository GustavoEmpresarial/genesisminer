import { describe, expect, it } from 'vitest';
import { parseLedgerEntry } from '../../../../client/src/shared/api/wallet.js';

describe('parseLedgerEntry', () => {
  it('maps snake_case ledger row to ReinvestmentHistoryEntry', () => {
    const e = parseLedgerEntry({
      id: 'abc-1',
      coin_id: 'btc',
      sold_crypto: '0.5',
      gross_usdc: '100.25',
      fee_usdc: '2.5',
      net_usdc: '97.75',
      created_at: '2024-06-01T12:00:00.000Z',
      entry_type: 'exchange_liquidate'
    });
    expect(e).toEqual({
      id: 'abc-1',
      coinId: 'btc',
      coinSymbol: '',
      soldCrypto: 0.5,
      grossUsdc: 100.25,
      feeUsdc: 2.5,
      netUsdc: 97.75,
      createdAt: Date.parse('2024-06-01T12:00:00.000Z'),
      entryType: 'exchange_liquidate'
    });
  });

  it('maps coin_symbol / coinSymbol onto coinSymbol', () => {
    const fromSnake = parseLedgerEntry({
      id: 'sym-1',
      coin_id: 'btc',
      coin_symbol: 'BTC',
      sold_crypto: 1,
      gross_usdc: 10,
      fee_usdc: 0,
      net_usdc: 10,
      created_at: 1_717_233_600_000,
      entry_type: 'exchange_liquidate'
    });
    expect(fromSnake?.coinSymbol).toBe('BTC');

    const fromCamel = parseLedgerEntry({
      id: 'sym-2',
      coinId: 'eth',
      coinSymbol: 'ETH',
      soldCrypto: 1,
      grossUsdc: 10,
      feeUsdc: 0,
      netUsdc: 10,
      createdAt: 1_717_233_600_000,
      entryType: 'exchange_liquidate'
    });
    expect(fromCamel?.coinSymbol).toBe('ETH');
  });

  it('treats numeric created_at below ms threshold as unix seconds', () => {
    const unixSec = 1_717_233_600;
    const e = parseLedgerEntry({
      id: 'sec-1',
      coin_id: 'eth',
      sold_crypto: 1,
      gross_usdc: 10,
      fee_usdc: 0,
      net_usdc: 10,
      created_at: unixSec,
      entry_type: 'exchange_liquidate'
    });
    expect(e?.createdAt).toBe(unixSec * 1000);
  });

  it('treats numeric created_at above ms threshold as milliseconds', () => {
    const ms = 1_717_233_600_000;
    const e = parseLedgerEntry({
      id: 'ms-1',
      coin_id: 'eth',
      sold_crypto: 1,
      gross_usdc: 10,
      fee_usdc: 0,
      net_usdc: 10,
      created_at: ms,
      entry_type: 'exchange_liquidate'
    });
    expect(e?.createdAt).toBe(ms);
  });

  it('returns null without id or coin', () => {
    expect(parseLedgerEntry(null)).toBeNull();
    expect(parseLedgerEntry({ id: '', coin_id: 'x' })).toBeNull();
    expect(parseLedgerEntry({ id: '1', coin_id: '' })).toBeNull();
  });
});
