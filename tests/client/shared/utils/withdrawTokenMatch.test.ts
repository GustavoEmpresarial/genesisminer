/**
 * Saque Web3: coinId ganha de um homónimo DAI desligado; "false" não desliga.
 */
import { describe, expect, it } from 'vitest';
import {
  findWithdrawTokenCfg,
  isWithdrawTokenDisabled,
  isWithdrawTokenUsable
} from '../../../../client/src/shared/utils/withdrawTokenMatch';

const DAI_CONTRACT = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';

describe('isWithdrawTokenDisabled', () => {
  it('only affirmative flags disable', () => {
    expect(isWithdrawTokenDisabled(true)).toBe(true);
    expect(isWithdrawTokenDisabled(1)).toBe(true);
    expect(isWithdrawTokenDisabled('true')).toBe(true);
    expect(isWithdrawTokenDisabled('1')).toBe(true);
    expect(isWithdrawTokenDisabled('yes')).toBe(true);
    expect(isWithdrawTokenDisabled('on')).toBe(true);
    expect(isWithdrawTokenDisabled(false)).toBe(false);
    expect(isWithdrawTokenDisabled('false')).toBe(false);
    expect(isWithdrawTokenDisabled('0')).toBe(false);
    expect(isWithdrawTokenDisabled('')).toBe(false);
    expect(isWithdrawTokenDisabled(undefined)).toBe(false);
    expect(isWithdrawTokenDisabled(null)).toBe(false);
  });
});

describe('findWithdrawTokenCfg', () => {
  it('coinId match wins over an earlier disabled DAI symbol row', () => {
    const hit = findWithdrawTokenCfg(
      [
        {
          name: 'DAI',
          symbol: 'DAI',
          coinId: 'old-dai',
          disabled: true,
          contract: DAI_CONTRACT
        },
        {
          name: 'DAI',
          symbol: 'DAI',
          coinId: 'dai',
          disabled: false,
          contract: DAI_CONTRACT
        }
      ],
      { id: 'dai', symbol: 'DAI', name: 'Dai' }
    );
    expect(hit?.coinId).toBe('dai');
    expect(isWithdrawTokenDisabled(hit?.disabled)).toBe(false);
    expect(isWithdrawTokenUsable(hit)).toBe(true);
  });

  it('string false on the matched row stays withdrawable', () => {
    const hit = findWithdrawTokenCfg(
      [{ coinId: 'dai', symbol: 'DAI', name: 'DAI', disabled: 'false', contract: DAI_CONTRACT }],
      { id: 'dai', symbol: 'DAI', name: 'DAI' }
    );
    expect(isWithdrawTokenDisabled(hit?.disabled)).toBe(false);
    expect(isWithdrawTokenUsable(hit)).toBe(true);
  });

  it('symbol fallback still matches when coinId is absent', () => {
    const hit = findWithdrawTokenCfg(
      [{ symbol: 'DAI', name: 'DAI', contract: DAI_CONTRACT }],
      { id: 'dai', symbol: 'DAI', name: 'DAI' }
    );
    expect(hit?.symbol).toBe('DAI');
    expect(isWithdrawTokenUsable(hit)).toBe(true);
  });

  it('does not use another coinId as a symbol fallback', () => {
    const hit = findWithdrawTokenCfg(
      [
        { coinId: 'dai-nft', symbol: 'DAI', name: 'DAI', disabled: true, contract: DAI_CONTRACT },
        { symbol: 'DAI', name: 'DAI', contract: DAI_CONTRACT }
      ],
      { id: 'dai', symbol: 'DAI', name: 'DAI' }
    );
    expect(hit?.coinId).toBeUndefined();
    expect(isWithdrawTokenUsable(hit)).toBe(true);
  });
});
