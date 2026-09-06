import { describe, expect, it } from 'vitest';
import {
  CANONICAL_1000WH_BATTERY_ID,
  isKnownInfiniteBatteryCatalogId,
  normalizeKnown1000WhBatteryCatalogId,
  normalizeStockCatalogItemId,
  remapPurgedStockItemId,
  resolvePlacedRackBatteryCatalogId,
  buildStableLegacyTempUpgradeId
} from '../../../../server/modules/hardware/services/catalog.js';

describe('normalizeKnown1000WhBatteryCatalogId', () => {
  it('mapeia ids legados para o canónico', () => {
    expect(normalizeKnown1000WhBatteryCatalogId('small_battery')).toBe(CANONICAL_1000WH_BATTERY_ID);
    expect(normalizeKnown1000WhBatteryCatalogId('battery_stellar')).toBe(CANONICAL_1000WH_BATTERY_ID);
  });

  it('mantém ids não legados intactos', () => {
    expect(normalizeKnown1000WhBatteryCatalogId('battery_nebula')).toBe('battery_nebula');
  });

  it('vazio/nulo devolve string vazia', () => {
    expect(normalizeKnown1000WhBatteryCatalogId(null)).toBe('');
    expect(normalizeKnown1000WhBatteryCatalogId('  ')).toBe('');
  });
});

describe('remapPurgedStockItemId / normalizeStockCatalogItemId', () => {
  it('funde bateria expurgada não-carregador em Estelar', () => {
    expect(remapPurgedStockItemId('battery_aa')).toBe(CANONICAL_1000WH_BATTERY_ID);
  });

  it('carregador expurgado vira string vazia (removido)', () => {
    expect(remapPurgedStockItemId('charger_a1')).toBe('');
  });

  it('item normal não é afetado', () => {
    expect(remapPurgedStockItemId('gpu_rx6600')).toBe('gpu_rx6600');
  });

  it('normalizeStockCatalogItemId combina legado + expurgo', () => {
    expect(normalizeStockCatalogItemId('small_battery')).toBe(CANONICAL_1000WH_BATTERY_ID);
    expect(normalizeStockCatalogItemId('charger_a2')).toBe('');
  });
});

describe('resolvePlacedRackBatteryCatalogId', () => {
  it('snapshot explícito ganha prioridade', () => {
    const map = new Map([['uuid-1', 'battery_nebula']]);
    expect(resolvePlacedRackBatteryCatalogId('uuid-1', map, 'small_battery')).toBe(CANONICAL_1000WH_BATTERY_ID);
  });

  it('sem snapshot, resolve pelo mapa de instância', () => {
    const map = new Map([['uuid-1', 'battery_nebula']]);
    expect(resolvePlacedRackBatteryCatalogId('uuid-1', map)).toBe('battery_nebula');
  });

  it('sem mapa nem snapshot, devolve o id cru', () => {
    expect(resolvePlacedRackBatteryCatalogId('battery_x', new Map())).toBe('battery_x');
  });

  it('id vazio devolve vazio', () => {
    expect(resolvePlacedRackBatteryCatalogId('', new Map())).toBe('');
  });
});

describe('isKnownInfiniteBatteryCatalogId', () => {
  it('qualquer id não vazio é considerado infinito (sistema atual)', () => {
    expect(isKnownInfiniteBatteryCatalogId('battery_nebula')).toBe(true);
    expect(isKnownInfiniteBatteryCatalogId('')).toBe(false);
  });
});

describe('buildStableLegacyTempUpgradeId', () => {
  it('gera id determinístico por userId + slug', () => {
    const a = buildStableLegacyTempUpgradeId(7, 'Old Item!!');
    const b = buildStableLegacyTempUpgradeId(7, 'Old Item!!');
    expect(a).toBe(b);
    expect(a).toMatch(/^temp_legacy_7_/);
  });

  it('nunca excede 200 caracteres', () => {
    const long = buildStableLegacyTempUpgradeId(1, 'x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(200);
  });
});
