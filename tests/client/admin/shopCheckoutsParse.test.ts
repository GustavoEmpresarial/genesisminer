import { describe, expect, it } from 'vitest';
import { parseAdminShopCheckoutsBody } from '../../../client/src/shared/api/admin-users';

describe('parseAdminShopCheckoutsBody', () => {
  it('separa itens e mantém o checkout com data', () => {
    const parsed = parseAdminShopCheckoutsBody({
      rows: [
        {
          id: 'idem-1',
          userId: 7,
          username: 'fabio',
          email: 'fabio@example.com',
          totalCost: 200,
          newUsdc: 50,
          createdAt: 1_700_000_000_000,
          lines: [
            { id: 'nft_a', name: 'NFT A', qty: 2 },
            { id: '', name: 'drop', qty: 1 }
          ]
        }
      ],
      byItem: [
        {
          id: 'nft_a',
          name: 'NFT A',
          qty: 20,
          checkouts: 4,
          firstAt: 1_600_000_000_000,
          lastAt: 1_700_000_000_000
        }
      ],
      totalCost: 2000,
      itemQty: 20,
      checkoutCount: 4,
      truncated: false,
      limit: 500
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toHaveLength(1);
    expect(parsed?.rows[0]?.lines).toEqual([{ id: 'nft_a', name: 'NFT A', qty: 2 }]);
    expect(parsed?.byItem).toEqual([
      {
        id: 'nft_a',
        name: 'NFT A',
        qty: 20,
        checkouts: 4,
        firstAt: 1_600_000_000_000,
        lastAt: 1_700_000_000_000
      }
    ]);
    expect(parsed?.totalCost).toBe(2000);
    expect(parsed?.checkoutCount).toBe(4);
  });

  it('rejeita corpo que não é objeto', () => {
    expect(parseAdminShopCheckoutsBody(null)).toBeNull();
    expect(parseAdminShopCheckoutsBody([])).toBeNull();
  });
});
