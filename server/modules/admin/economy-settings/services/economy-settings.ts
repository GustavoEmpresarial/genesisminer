/**
 * GET/POST `/api/economy-settings` (AdminBlackMarket / AdminMonetization).
 *
 * GET público: `economy_settings` id=1 manda; senão fallback em `settings` KV;
 * defaults: mercados true, taxa 0, banda 20. Taxa clamp [0,100], banda [0,200].
 *
 * POST admin: escreve as 4 chaves KV **e** a linha singleton na mesma
 * `$transaction` (legado). `Number(tax) || 0`; banda inválida reusa a anterior
 * ou 20. Booleanos: truthy → 1.
 *
 * Não é `POST /api/admin/economy-settings` (hashrate/reward de moeda).
 */
import { prisma } from '../../../../core/database/prisma.js';
import { HttpControlledError } from '../../../../shared/errors/http-controlled-error.js';
import { getSettingsRecord } from '../../../../shared/settings/settings-repository.js';

const HTTP_BAD_REQUEST = 400;
const TAX_MIN = 0;
const TAX_MAX = 100;
const BAND_MIN = 0;
const BAND_MAX = 200;
const BAND_DEFAULT = 20;

export const ECONOMY_SETTINGS_KV_KEYS = [
  'hardware_market_enabled',
  'black_market_enabled',
  'market_tax_percent',
  'black_market_price_band_percent'
] as const;

export type EconomySettingsDto = {
  hardwareMarketEnabled: boolean;
  blackMarketEnabled: boolean;
  marketTaxPercent: number;
  blackMarketPriceBandPercent: number;
};

export type EconomySettingsRow = {
  black_market_enabled?: unknown;
  hardware_market_enabled?: unknown;
  market_tax_percent?: unknown;
  black_market_price_band_percent?: unknown;
};

function isPresentScalar(v: unknown): boolean {
  return v != null && v !== '';
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function flagFromRowOrKv(rowPresent: boolean, rowVal: unknown, kvVal: string | undefined, defaultOn: boolean): boolean {
  if (rowPresent) return Number(rowVal) !== 0;
  if (kvVal != null) return kvVal === '1';
  return defaultOn;
}

function taxFromRowOrKv(row: EconomySettingsRow | null | undefined, kv: Record<string, string>): number {
  let tax = NaN;
  if (row && isPresentScalar(row.market_tax_percent)) {
    tax = Number(row.market_tax_percent);
  }
  if (!Number.isFinite(tax)) {
    tax = kv.market_tax_percent != null ? Number(kv.market_tax_percent) : 0;
  }
  if (!Number.isFinite(tax)) tax = 0;
  return clamp(tax, TAX_MIN, TAX_MAX);
}

function bandFromRowOrKv(row: EconomySettingsRow | null | undefined, kv: Record<string, string>): number {
  let band = BAND_DEFAULT;
  if (row && isPresentScalar(row.black_market_price_band_percent)) {
    const b = Number(row.black_market_price_band_percent);
    if (Number.isFinite(b)) band = clamp(b, BAND_MIN, BAND_MAX);
  } else if (isPresentScalar(kv.black_market_price_band_percent)) {
    const b = Number(kv.black_market_price_band_percent);
    if (Number.isFinite(b)) band = clamp(b, BAND_MIN, BAND_MAX);
  }
  return band;
}

/** Contrato GET — sem campos extra (realActiveMiners fica noutro endpoint). */
export function mapEconomySettingsFromStores(
  row: EconomySettingsRow | null | undefined,
  kv: Record<string, string>
): EconomySettingsDto {
  const rowPresent = row != null;
  return {
    hardwareMarketEnabled: flagFromRowOrKv(rowPresent, row?.hardware_market_enabled, kv.hardware_market_enabled, true),
    blackMarketEnabled: flagFromRowOrKv(rowPresent, row?.black_market_enabled, kv.black_market_enabled, true),
    marketTaxPercent: taxFromRowOrKv(row, kv),
    blackMarketPriceBandPercent: bandFromRowOrKv(row, kv)
  };
}

export async function loadEconomySettings(): Promise<EconomySettingsDto> {
  const row = await prisma.economy_settings.findUnique({
    where: { id: 1 },
    select: {
      black_market_enabled: true,
      hardware_market_enabled: true,
      market_tax_percent: true,
      black_market_price_band_percent: true
    }
  });
  const kv = await getSettingsRecord([...ECONOMY_SETTINGS_KV_KEYS]);
  return mapEconomySettingsFromStores(row, kv);
}

function coerceTax(raw: unknown): number {
  return clamp(Number(raw) || 0, TAX_MIN, TAX_MAX);
}

function coerceBand(raw: unknown, previousOrDefault: number): number {
  let band = Number(raw);
  if (!Number.isFinite(band)) band = previousOrDefault;
  if (!Number.isFinite(band)) band = BAND_DEFAULT;
  return clamp(band, BAND_MIN, BAND_MAX);
}

export type EconomySettingsPersistPlan = {
  tax: number;
  band: number;
  bm: number;
  hm: number;
};

export async function planEconomySettingsPersist(body: unknown): Promise<EconomySettingsPersistPlan> {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    throw new HttpControlledError(HTTP_BAD_REQUEST, { error: 'Invalid payload.' });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const tax = coerceTax(b.marketTaxPercent);
  let previousBand = BAND_DEFAULT;
  if (!Number.isFinite(Number(b.blackMarketPriceBandPercent))) {
    const prev = await prisma.economy_settings.findUnique({
      where: { id: 1 },
      select: { black_market_price_band_percent: true }
    });
    const prevBand = prev?.black_market_price_band_percent != null ? Number(prev.black_market_price_band_percent) : NaN;
    previousBand = Number.isFinite(prevBand) ? prevBand : BAND_DEFAULT;
  }
  const band = coerceBand(b.blackMarketPriceBandPercent, previousBand);
  return {
    tax,
    band,
    bm: b.blackMarketEnabled ? 1 : 0,
    hm: b.hardwareMarketEnabled ? 1 : 0
  };
}

export async function persistEconomySettings(body: unknown): Promise<{ ok: true }> {
  const { tax, band, bm, hm } = await planEconomySettingsPersist(body);
  const hmStr = hm ? '1' : '0';
  const bmStr = bm ? '1' : '0';

  await prisma.$transaction([
    prisma.settings.upsert({
      where: { key: 'hardware_market_enabled' },
      create: { key: 'hardware_market_enabled', value: hmStr },
      update: { value: hmStr }
    }),
    prisma.settings.upsert({
      where: { key: 'black_market_enabled' },
      create: { key: 'black_market_enabled', value: bmStr },
      update: { value: bmStr }
    }),
    prisma.settings.upsert({
      where: { key: 'market_tax_percent' },
      create: { key: 'market_tax_percent', value: String(tax) },
      update: { value: String(tax) }
    }),
    prisma.settings.upsert({
      where: { key: 'black_market_price_band_percent' },
      create: { key: 'black_market_price_band_percent', value: String(band) },
      update: { value: String(band) }
    }),
    prisma.economy_settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        black_market_enabled: bm,
        hardware_market_enabled: hm,
        market_tax_percent: tax,
        black_market_price_band_percent: band
      },
      update: {
        black_market_enabled: bm,
        hardware_market_enabled: hm,
        market_tax_percent: tax,
        black_market_price_band_percent: band
      }
    })
  ]);

  return { ok: true };
}
