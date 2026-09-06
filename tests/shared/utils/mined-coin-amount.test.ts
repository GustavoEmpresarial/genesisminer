import { describe, expect, it } from 'vitest';
import { MINED_COIN_AMOUNT_DECIMALS, roundMinedCoinAmount } from '../../../server/shared/utils/mined-coin-amount.js';

describe('shared/utils/mined-coin-amount', () => {
  it('arredonda para 8 casas decimais', () => {
    expect(MINED_COIN_AMOUNT_DECIMALS).toBe(8);
    expect(roundMinedCoinAmount(0.1234567890123)).toBe(0.12345679);
    expect(roundMinedCoinAmount('0.00001234567890123')).toBe(0.00001235);
  });

  it('valores inválidos → 0', () => {
    expect(roundMinedCoinAmount(NaN)).toBe(0);
    expect(roundMinedCoinAmount('nope')).toBe(0);
    expect(roundMinedCoinAmount(null)).toBe(0);
  });
});
