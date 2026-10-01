/**
 * Wallet mined balance iconUrl parse (trim / empty → null).
 */
import { describe, expect, it } from 'vitest';
import { parseWalletIconUrl } from '../../../../client/src/shared/api/wallet.js';

describe('parseWalletIconUrl', () => {
  it('trims and keeps non-empty paths', () => {
    expect(parseWalletIconUrl('  /img/coin-logos/bnb.png  ')).toBe('/img/coin-logos/bnb.png');
  });

  it('maps empty / whitespace / non-string to null', () => {
    expect(parseWalletIconUrl('')).toBeNull();
    expect(parseWalletIconUrl('   ')).toBeNull();
    expect(parseWalletIconUrl(null)).toBeNull();
    expect(parseWalletIconUrl(undefined)).toBeNull();
    expect(parseWalletIconUrl(1)).toBeNull();
  });
});
