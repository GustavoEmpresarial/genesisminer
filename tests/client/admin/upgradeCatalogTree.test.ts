import { describe, expect, it } from 'vitest';
import {
  buildCatalogTree,
  catalogItemRarity,
  filterCatalogTree,
  UPGRADE_RARITY_ORDER
} from '../../../client/src/features/admin/lib/upgradeCatalogTree';

describe('upgradeCatalogTree', () => {
  it('UPGRADE_RARITY_ORDER matches AdminEditor select', () => {
    expect([...UPGRADE_RARITY_ORDER]).toEqual([
      'common',
      'uncommon',
      'rare',
      'epic',
      'legendary',
      'supreme'
    ]);
  });

  it('buildCatalogTree: root + 2 merges nested; órfão merge é topo', () => {
    const tree = buildCatalogTree([
      { id: 'gpu_v1', name: 'GPU Base', rarity: 'common' },
      { id: 'merge_gpu_v1_uncommon_aaaaaa', name: 'Merged Uncommon', rarity: 'uncommon' },
      { id: 'merge_gpu_v1_rare_bbbbbb', name: 'Merged Rare', rarity: 'rare' },
      { id: 'merge_missing_root_epic_cccccc', name: 'Orphan Merge', rarity: 'epic' }
    ]);
    expect(tree).toHaveLength(2);
    const root = tree.find((n) => n.item.id === 'gpu_v1');
    expect(root).toBeTruthy();
    expect(root!.children.map((c) => c.id)).toEqual([
      'merge_gpu_v1_uncommon_aaaaaa',
      'merge_gpu_v1_rare_bbbbbb'
    ]);
    const orphan = tree.find((n) => n.item.id === 'merge_missing_root_epic_cccccc');
    expect(orphan).toBeTruthy();
    expect(orphan!.children).toHaveLength(0);
  });

  it('search por nome do merge devolve o root com só esse child', () => {
    const tree = buildCatalogTree([
      { id: 'gpu_v1', name: 'GPU Base', category: 'gpu' },
      { id: 'merge_gpu_v1_uncommon_aaaaaa', name: 'Merged Alpha', category: 'gpu' },
      { id: 'merge_gpu_v1_rare_bbbbbb', name: 'Merged Beta', category: 'gpu' }
    ]);
    const filtered = filterCatalogTree(tree, { search: 'merged alpha', rarity: 'all' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].item.id).toBe('gpu_v1');
    expect(filtered[0].children.map((c) => c.id)).toEqual(['merge_gpu_v1_uncommon_aaaaaa']);
  });

  it('filtro uncommon esconde children common/rare', () => {
    const tree = buildCatalogTree([
      { id: 'gpu_v1', name: 'GPU Base', rarity: 'common' },
      { id: 'merge_gpu_v1_common_aaaaaa', name: 'M Common', rarity: 'common' },
      { id: 'merge_gpu_v1_uncommon_bbbbbb', name: 'M Uncommon', rarity: 'uncommon' },
      { id: 'merge_gpu_v1_rare_cccccc', name: 'M Rare', rarity: 'rare' }
    ]);
    const filtered = filterCatalogTree(tree, { search: '', rarity: 'uncommon' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].item.id).toBe('gpu_v1');
    expect(filtered[0].children.map((c) => c.id)).toEqual(['merge_gpu_v1_uncommon_bbbbbb']);
  });

  it('filtro common não promove merge a root', () => {
    const tree = buildCatalogTree([
      { id: 'gpu_v1', name: 'GPU Base', rarity: 'common' },
      { id: 'merge_gpu_v1_uncommon_aaaaaa', name: 'Merged', rarity: 'uncommon' },
      { id: 'other', name: 'Other', rarity: 'rare' }
    ]);
    const filtered = filterCatalogTree(tree, { search: '', rarity: 'common' });
    expect(filtered.map((n) => n.item.id)).toEqual(['gpu_v1']);
    expect(filtered[0].children.map((c) => c.id)).toEqual(['merge_gpu_v1_uncommon_aaaaaa']);
    expect(filtered.every((n) => !String(n.item.id).startsWith('merge_'))).toBe(true);
  });

  it('raridade lida do id se rarity em falta', () => {
    expect(
      catalogItemRarity({ id: 'merge_gpu_v1_legendary_abcdef', name: 'X' })
    ).toBe('legendary');
    expect(catalogItemRarity({ id: 'gpu_plain', name: 'Y' })).toBe('common');
    expect(catalogItemRarity({ id: 'gpu_plain', rarity: 'epic' })).toBe('epic');
  });
});
