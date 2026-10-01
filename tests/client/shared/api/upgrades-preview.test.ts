import { describe, expect, it } from 'vitest';
import { parseUpgradesStatePackagePreview } from '../../../../client/src/shared/api/upgrades.js';

describe('parseUpgradesStatePackagePreview', () => {
  it('preserva imageUrl e baseProduction válidos', () => {
    expect(
      parseUpgradesStatePackagePreview({
        rewardType: 'STOCK_ITEM',
        catalogId: 'gpu_1',
        quantity: 2,
        label: 'GPU',
        imageUrl: '/img/miner/gpu.png',
        baseProduction: 120
      })
    ).toEqual({
      rewardType: 'STOCK_ITEM',
      catalogId: 'gpu_1',
      quantity: 2,
      label: 'GPU',
      imageUrl: '/img/miner/gpu.png',
      baseProduction: 120
    });
  });

  it('normaliza image vazia e baseProduction inválido', () => {
    expect(
      parseUpgradesStatePackagePreview({
        rewardType: 'LOOT_BOX',
        catalogId: 'box_1',
        quantity: 1,
        label: 'Lucky',
        imageUrl: '   ',
        baseProduction: 'nope'
      })
    ).toEqual({
      rewardType: 'LOOT_BOX',
      catalogId: 'box_1',
      quantity: 1,
      label: 'Lucky',
      imageUrl: null,
      baseProduction: 0
    });
  });
});
