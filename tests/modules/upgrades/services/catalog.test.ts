import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { computeDiscountPercent, parseUpgradePackageId, usdcDecimalFromRow } from '../../../../server/modules/upgrades/services/catalog.js';

describe('parseUpgradePackageId', () => {
  it('aceita ids válidos, rejeita formato inválido/vazio/não-string', () => {
    expect(parseUpgradePackageId('pack_1')).toBe('pack_1');
    expect(parseUpgradePackageId('  pack_1  ')).toBe('pack_1');
    expect(parseUpgradePackageId('pack com espaço')).toBeNull();
    expect(parseUpgradePackageId('')).toBeNull();
    expect(parseUpgradePackageId(123)).toBeNull();
    expect(parseUpgradePackageId(null)).toBeNull();
  });
});

describe('usdcDecimalFromRow', () => {
  it('converte number/string/null/Decimal-like num Decimal', () => {
    expect(usdcDecimalFromRow(10.5).toNumber()).toBe(10.5);
    expect(usdcDecimalFromRow('7.25').toNumber()).toBe(7.25);
    expect(usdcDecimalFromRow(null).toNumber()).toBe(0);
    expect(usdcDecimalFromRow('lixo').toNumber()).toBe(0);
  });
});

describe('computeDiscountPercent', () => {
  it('calcula percentual quando original > final', () => {
    const pct = computeDiscountPercent(new Prisma.Decimal(100), new Prisma.Decimal(75));
    expect(pct).toBe(25);
  });

  it('devolve null quando não há desconto real (original <= final, ou original <= 0)', () => {
    expect(computeDiscountPercent(new Prisma.Decimal(0), new Prisma.Decimal(0))).toBeNull();
    expect(computeDiscountPercent(new Prisma.Decimal(50), new Prisma.Decimal(50))).toBeNull();
    expect(computeDiscountPercent(new Prisma.Decimal(50), new Prisma.Decimal(60))).toBeNull();
  });
});
