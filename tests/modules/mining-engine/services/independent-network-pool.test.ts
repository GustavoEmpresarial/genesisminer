import { describe, expect, it } from 'vitest';
import { isIndependentNetworkPoolMiningCoinRef } from '../../../../server/modules/mining-engine/services/nft-room-mining.js';

describe('isIndependentNetworkPoolMiningCoinRef', () => {
  it('usdc_interno é pool independente (mesmo não sendo exclusive NFT room)', () => {
    expect(isIndependentNetworkPoolMiningCoinRef('usdc_interno')).toBe(true);
    expect(isIndependentNetworkPoolMiningCoinRef({ id: 'usdc_interno', nft_room_only: 0 })).toBe(true);
  });

  it('GHO_nft / flag nft_room_only é independente', () => {
    expect(
      isIndependentNetworkPoolMiningCoinRef({
        id: '6529d347-d3dd-4dc8-b15f-3a4d318a301f',
        symbol: 'GHO_nft',
        nft_room_only: 1
      })
    ).toBe(true);
    expect(isIndependentNetworkPoolMiningCoinRef('gho_nft')).toBe(true);
  });

  it('moedas GPU clássicas não são independentes', () => {
    expect(isIndependentNetworkPoolMiningCoinRef('pol')).toBe(false);
    expect(isIndependentNetworkPoolMiningCoinRef({ id: 'eth', symbol: 'ETH', nft_room_only: 0 })).toBe(false);
  });
});
