/**
 * Migrado de legacy/backend/modules/upgrades/upgrades.catalog.ts (verbatim).
 */
import { Prisma } from '@prisma/client';

/** ID de pacote admin (`admin_upgrades.id`). */
export const UPGRADE_PACKAGE_ID_RE = /^[a-zA-Z0-9_.-]{1,120}$/;

export function parseUpgradePackageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || !UPGRADE_PACKAGE_ID_RE.test(s)) return null;
  return s;
}

export function usdcDecimalFromRow(n: unknown): Prisma.Decimal {
  if (n == null) return new Prisma.Decimal(0);
  if (typeof n === 'number' && Number.isFinite(n)) return new Prisma.Decimal(String(n));
  if (typeof n === 'object' && n !== null && 'toString' in n) return new Prisma.Decimal(String(n));
  const s = String(n).trim();
  if (!s || !Number.isFinite(Number(s))) return new Prisma.Decimal(0);
  return new Prisma.Decimal(s);
}

const DISCOUNT_PERCENT_PRECISION = 4;
const PERCENT_BASE = 100;

/** Percentagem de desconto (0–100) quando há preço original > final; caso contrário `null`. */
export function computeDiscountPercent(original: Prisma.Decimal, finalPrice: Prisma.Decimal): number | null {
  if (original.lte(0) || finalPrice.lt(0)) return null;
  if (original.lte(finalPrice)) return null;
  const raw = original.minus(finalPrice).div(original).mul(PERCENT_BASE);
  const n = Number(raw.toFixed(DISCOUNT_PERCENT_PRECISION));
  return Number.isFinite(n) && n > 0 ? n : null;
}
