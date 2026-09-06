import { describe, expect, it } from 'vitest';
import { isAsicMachineForMerge, isForbiddenMergeRootId, isMergeCatalogId, isMergeForbiddenCatalog, isMergeableSourceRarity, normalizeMergeRarity, parseCostPctJson, parseRackHsBonusPctJson } from '../../../../server/modules/merge/services/constants.js';

describe('normalizeMergeRarity', () => {
  it('reconhece raridades válidas (case-insensitive), cai em common senão', () => {
    expect(normalizeMergeRarity('EPIC')).toBe('epic');
    expect(normalizeMergeRarity('nao-existe')).toBe('common');
    expect(normalizeMergeRarity(undefined)).toBe('common');
  });
});

describe('isMergeableSourceRarity', () => {
  it('supreme não é mergeável como origem, resto sim', () => {
    expect(isMergeableSourceRarity('legendary')).toBe(true);
    expect(isMergeableSourceRarity('supreme')).toBe(false);
  });
});

describe('isAsicMachineForMerge', () => {
  it('reconhece por prefixo do id ou categoria contendo "asic"', () => {
    expect(isAsicMachineForMerge('asic_x1', 'machine', 'machine')).toBe(true);
    expect(isAsicMachineForMerge('gpu_x1', 'ASIC Line', 'machine')).toBe(true);
    expect(isAsicMachineForMerge('gpu_x1', 'gpu', 'machine')).toBe(false);
  });

  it('só se aplica a type=machine', () => {
    expect(isAsicMachineForMerge('asic_x1', 'asic', 'multiplier')).toBe(false);
  });
});

describe('isMergeCatalogId', () => {
  it('reconhece prefixo merge_', () => {
    expect(isMergeCatalogId('merge_gpu_epic_abc')).toBe(true);
    expect(isMergeCatalogId('gpu_normal')).toBe(false);
    expect(isMergeCatalogId('')).toBe(false);
  });
});

describe('isForbiddenMergeRootId / isMergeForbiddenCatalog', () => {
  it('bloqueia os roots proibidos directos', () => {
    expect(isForbiddenMergeRootId('armario_1')).toBe(true);
    expect(isForbiddenMergeRootId('battery_nebula')).toBe(true);
    expect(isForbiddenMergeRootId('gpu_normal')).toBe(false);
  });

  it('bloqueia linhagem merge_<root>_ e merge_merge_<root>_ (cascata)', () => {
    expect(isForbiddenMergeRootId('merge_armario_1_epic_abc')).toBe(true);
    expect(isForbiddenMergeRootId('merge_merge_armario_1_epic_abc')).toBe(true);
  });

  it('isMergeForbiddenCatalog bloqueia NFT, root proibido, ou ASIC', () => {
    expect(isMergeForbiddenCatalog({ id: 'x', is_nft: 1 })).toBe(true);
    expect(isMergeForbiddenCatalog({ id: 'armario_1' })).toBe(true);
    expect(isMergeForbiddenCatalog({ id: 'asic_x', category: 'gpu', type: 'machine' })).toBe(true);
    expect(isMergeForbiddenCatalog({ id: 'gpu_normal', category: 'gpu', type: 'machine' })).toBe(false);
  });
});

describe('parseCostPctJson / parseRackHsBonusPctJson', () => {
  it('parseCostPctJson usa defaults quando JSON inválido/ausente', () => {
    expect(parseCostPctJson(null)).toEqual({ common: 10, uncommon: 15, rare: 20, epic: 25, legendary: 30 });
    expect(parseCostPctJson('{not json')).toEqual({ common: 10, uncommon: 15, rare: 20, epic: 25, legendary: 30 });
  });

  it('parseCostPctJson sobrescreve só valores válidos (0-100)', () => {
    const out = parseCostPctJson(JSON.stringify({ common: 50, rare: 999, epic: -5 }));
    expect(out.common).toBe(50);
    expect(out.rare).toBe(20); // fora do intervalo, mantém default
    expect(out.epic).toBe(25); // negativo, mantém default
  });

  it('parseRackHsBonusPctJson usa defaults (tudo 0) quando ausente', () => {
    expect(parseRackHsBonusPctJson(undefined)).toEqual({ common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, supreme: 0 });
  });

  it('parseRackHsBonusPctJson aceita até 500', () => {
    const out = parseRackHsBonusPctJson(JSON.stringify({ supreme: 500, legendary: 501 }));
    expect(out.supreme).toBe(500);
    expect(out.legendary).toBe(0);
  });
});
