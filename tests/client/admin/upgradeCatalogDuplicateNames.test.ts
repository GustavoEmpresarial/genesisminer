import { describe, expect, it } from 'vitest';
import {
  collectDuplicateNonMergeNameIds,
  isMergeCatalogId,
  normalizeCatalogDisplayName
} from '../../../client/src/features/admin/lib/upgradeCatalogDuplicateNames';

describe('upgradeCatalogDuplicateNames', () => {
  it('identifica merge_* por prefixo', () => {
    expect(isMergeCatalogId('merge_gpu_v1_uncommon_abc')).toBe(true);
    expect(isMergeCatalogId('gpu_v1')).toBe(false);
  });

  it('normaliza trim + lower', () => {
    expect(normalizeCatalogDisplayName('  Merged GPU  ')).toBe('merged gpu');
  });

  it('não marca merges que partilham «Merged X»', () => {
    const dup = collectDuplicateNonMergeNameIds([
      { id: 'gpu_v1', name: 'GPU Base' },
      { id: 'merge_gpu_v1_uncommon_a', name: 'Merged GPU Base' },
      { id: 'merge_gpu_v1_rare_b', name: 'Merged GPU Base' },
      { id: 'merge_gpu_v1_epic_c', name: 'Merged GPU Base' }
    ]);
    expect(dup.size).toBe(0);
  });

  it('não marca merge que partilha nome com a base', () => {
    const dup = collectDuplicateNonMergeNameIds([
      { id: 'gpu_v1', name: 'Merged GPU Base' },
      { id: 'merge_gpu_v1_uncommon_a', name: 'Merged GPU Base' }
    ]);
    expect(dup.size).toBe(0);
  });

  it('marca só não-merge com nome igual', () => {
    const dup = collectDuplicateNonMergeNameIds([
      { id: 'gpu_v1', name: 'Same Name' },
      { id: 'gpu_v2', name: 'Same Name' },
      { id: 'merge_gpu_v1_x', name: 'Same Name' },
      { id: 'cpu_v1', name: 'Other' }
    ]);
    expect([...dup].sort()).toEqual(['gpu_v1', 'gpu_v2']);
  });

  it('ignora nomes vazios', () => {
    const dup = collectDuplicateNonMergeNameIds([
      { id: 'a', name: '   ' },
      { id: 'b', name: '' },
      { id: 'c', name: 'Ok' }
    ]);
    expect(dup.size).toBe(0);
  });
});
