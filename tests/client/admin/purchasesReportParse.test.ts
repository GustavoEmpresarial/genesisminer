import { describe, expect, it } from 'vitest';
import { parseAdminPurchasesReportBody } from '../../../client/src/shared/api/admin-users';

describe('parseAdminPurchasesReportBody', () => {
  it('separa loja e P2P por item e origem', () => {
    const parsed = parseAdminPurchasesReportBody({
      sources: [
        {
          id: 'shop',
          label: 'Loja',
          hint: 'jogo',
          usdc: 1000,
          itemQty: 10,
          events: 5,
          buyers: 3
        },
        {
          id: 'p2p',
          label: 'P2P',
          hint: 'mercado',
          usdc: 50,
          itemQty: 2,
          events: 2,
          buyers: 1
        }
      ],
      byItem: [
        {
          id: 'nft_a',
          name: 'NFT A',
          source: 'shop',
          sourceLabel: 'Loja',
          qty: 8,
          events: 4,
          buyers: 2,
          usdc: 800,
          firstAt: 1,
          lastAt: 2
        }
      ],
      topBuyers: {
        shop: [
          {
            userId: 17,
            username: 'Zezin',
            email: 'a@b.c',
            usdc: 400,
            events: 2,
            itemQty: 4,
            source: 'shop',
            sourceLabel: 'Loja'
          }
        ],
        p2p: []
      },
      recentShop: [],
      shopTruncated: false,
      limit: 500
    });
    expect(parsed?.ok).toBe(true);
    expect(parsed?.sources).toHaveLength(2);
    expect(parsed?.byItem[0]?.source).toBe('shop');
    expect(parsed?.topBuyersShop[0]?.userId).toBe(17);
    expect(parsed?.topBuyersP2p).toEqual([]);
  });
});
