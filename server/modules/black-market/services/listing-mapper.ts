/**
 * Migrado de legacy/backend/models/p2pMarketModel.ts.
 *
 * `expires_at` em `player_listings`:
 * - **Anúncios novos:** gravados com `P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS` (sem TTL de produto).
 * - **Legado (pré-remoção do TTL 7d):** podem ter `expires_at` no passado; o livro/buy
 *   tratam-nos como não listáveis e `reclaimExpiredActiveListings` devolve o stock.
 * - **awaiting_pickup:** o campo pode ser cópia histórica; NÃO significa expiração do claim.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../../core/database/prisma.js';
import { MS_PER_DAY } from '../../../shared/utils/time.js';
import {
  computeP2PBandReferenceUsd,
  isReservationActive,
  MARKET_RESERVE_MS
} from './black-market-rust-bridge.js';

export { MARKET_RESERVE_MS, computeP2PBandReferenceUsd, isReservationActive };

/**
 * Valor gravado em `player_listings.expires_at` para anúncios **novos** (sem expiração de produto).
 * Mantém o schema NOT NULL e permite que predicados `expires_at > now` (compat legado)
 * continuem a listar/comprar anúncios novos indefinidamente.
 *
 * Não usar literais mágicos noutros ficheiros — só esta constante.
 */
export const P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

/**
 * TTL histórico de 7 dias — **não** é regra de produto.
 * Só para estimar instante de criação em auditoria (`expires_at - TTL`) em anúncios legados.
 */
const LEGACY_P2P_LISTING_TTL_DAYS = 7;
export const LEGACY_P2P_LISTING_TTL_MS = LEGACY_P2P_LISTING_TTL_DAYS * MS_PER_DAY;

/** True se o epoch ms é o sentinel de “sem expiração” (ou ≥ sentinel). */
export function isP2PListingNoExpiryExpiresAt(expiresAtMs: number): boolean {
  return Number.isFinite(expiresAtMs) && expiresAtMs >= P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS;
}

/**
 * Anúncio com contrato legado de TTL: `expires_at` já passou (e não é sentinel).
 * Usado por reclaim / bloqueio de compra de lixo legado.
 */
export function isLegacyExpiredListingExpiresAt(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  if (isP2PListingNoExpiryExpiresAt(expiresAtMs)) return false;
  return expiresAtMs <= nowMs;
}

/** Interpreta USDC vindo da BD (numeric/string; vírgula como decimal). */
export function parseUsdFromDb(raw: unknown): number {
  if (raw == null) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string') {
    const t = raw.trim().replace(/\s/g, '').replace(',', '.');
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Igual a `getBlackMarketPriceBandPercent`, mas **só** com o cliente `tx` da transação interactiva.
 * Nunca chamar `prisma` global dentro de `prisma.$transaction` — bloqueia o pool.
 */
export async function getBlackMarketPriceBandPercentInTx(tx: Prisma.TransactionClient): Promise<number> {
  try {
    const row = await tx.economy_settings.findUnique({ where: { id: 1 }, select: { black_market_price_band_percent: true } });
    const n = Number(row?.black_market_price_band_percent ?? PRICE_BAND_DEFAULT_PERCENT);
    return Math.min(PRICE_BAND_MAX_PERCENT, Math.max(PRICE_BAND_MIN_PERCENT, Number.isFinite(n) ? n : PRICE_BAND_DEFAULT_PERCENT));
  } catch {
    try {
      const bk = await tx.settings.findUnique({ where: { key: 'black_market_price_band_percent' }, select: { value: true } });
      const n = Number(bk?.value);
      return Math.min(PRICE_BAND_MAX_PERCENT, Math.max(PRICE_BAND_MIN_PERCENT, Number.isFinite(n) ? n : PRICE_BAND_DEFAULT_PERCENT));
    } catch {
      return PRICE_BAND_DEFAULT_PERCENT;
    }
  }
}

/** Converte valor vindo do PG (BIGINT como string, número, ISO) para epoch ms. */
export function timestampMsFromDb(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (val instanceof Date) {
    const t = val.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

const PRICE_BAND_MIN_PERCENT = 1;
const PRICE_BAND_MAX_PERCENT = 90;
const PRICE_BAND_DEFAULT_PERCENT = 20;

/**
 * Mesma regra que `GET /api/economy-settings` (blackMarketEnabled):
 * linha em `economy_settings` manda; senão fallback em `settings`.
 * % de banda (1–90); fallback 20.
 */
/** Igual a `getBlackMarketPriceBandPercentInTx`, mas usando o pool global do Prisma (fora de uma transação interativa). */
export async function getBlackMarketPriceBandPercent(): Promise<number> {
  try {
    const row = await prisma.economy_settings.findUnique({ where: { id: 1 }, select: { black_market_price_band_percent: true } });
    const n = Number(row?.black_market_price_band_percent ?? PRICE_BAND_DEFAULT_PERCENT);
    return Math.min(PRICE_BAND_MAX_PERCENT, Math.max(PRICE_BAND_MIN_PERCENT, Number.isFinite(n) ? n : PRICE_BAND_DEFAULT_PERCENT));
  } catch {
    try {
      const bk = await prisma.settings.findUnique({ where: { key: 'black_market_price_band_percent' }, select: { value: true } });
      const n = Number(bk?.value);
      return Math.min(PRICE_BAND_MAX_PERCENT, Math.max(PRICE_BAND_MIN_PERCENT, Number.isFinite(n) ? n : PRICE_BAND_DEFAULT_PERCENT));
    } catch {
      return PRICE_BAND_DEFAULT_PERCENT;
    }
  }
}

/** Se o mercado P2P está ligado; `economy_settings` manda, com fallback em `settings`. Default `true` em caso de erro. */
export async function isP2PMarketEnabled(): Promise<boolean> {
  try {
    const row = await prisma.economy_settings.findUnique({ where: { id: 1 }, select: { black_market_enabled: true } });
    const bk = await prisma.settings.findUnique({ where: { key: 'black_market_enabled' }, select: { value: true } });
    if (row != null) return Number(row.black_market_enabled) !== 0;
    if (bk?.value != null) return bk.value === '1';
    return true;
  } catch {
    return true;
  }
}

/**
 * Colunas explícitas para listagens P2P + vendedor (sem `l.*` — evita ambiguidade no mapeamento).
 * Alias do vendedor na query deve ser `usr`.
 */
export const P2P_LISTING_SELECT_SQL = `
  l.id,
  l.user_id AS seller_id,
  l.item_id,
  l.price,
  l.qty,
  l.expires_at,
  l.status,
  l.reserved_by,
  l.reserved_until,
  l.is_player,
  l.buyer_paid_usdc,
  COALESCE(NULLIF(TRIM(usr.username), ''), usr.email::text, '') AS seller_display_name,
  ru.username AS reserver_username
`;

export type PlayerListingRow = {
  id: string;
  seller_id?: number | string;
  seller_display_name?: string | null;
  username?: string;
  email?: string;
  reserver_username?: string | null;
  item_id: string;
  price: string | number;
  qty?: number | null;
  expires_at: string | number;
  reserved_until?: string | number | null;
  status?: string;
  user_id?: number;
  reserved_by?: number | null;
  buyer_paid_usdc?: number | string | null;
  is_player?: number | null;
};

export type MarketListingClientDto = {
  id: string;
  sellerId: number;
  sellerName: string;
  itemId: string;
  price: number;
  qty: number;
  lineTotal: number;
  expiresAt: number;
  reservedBy?: string;
  reservedUntil?: number;
};

/** Extrai o id do vendedor de uma linha crua (aceita tanto `seller_id` quanto `user_id`); `0` se ausente/inválido. */
export function resolveSellerIdFromListingRow(l: PlayerListingRow): number {
  const raw = l.seller_id ?? l.user_id;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Nome de exibição do vendedor: `seller_display_name` pré-calculado > `username` > `email`. */
export function resolveSellerDisplayNameFromListingRow(l: PlayerListingRow): string {
  const explicit = l.seller_display_name != null && String(l.seller_display_name).trim() ? String(l.seller_display_name).trim() : '';
  if (explicit) return explicit;
  const u = l.username != null ? String(l.username).trim() : '';
  if (u) return u;
  const e = l.email != null ? String(l.email).trim() : '';
  return e;
}

/** Converte uma linha crua de `player_listings` no DTO enviado ao cliente (preço unitário, `lineTotal`, reserva ativa). */
export function mapListingForClient(l: PlayerListingRow, now: number): MarketListingClientDto {
  const exp = timestampMsFromDb(l.expires_at);
  const resUntil = timestampMsFromDb(l.reserved_until);
  const reservedActive = isReservationActive(l.reserved_until != null ? resUntil : null, now);
  let reservedBy: string | undefined;
  if (reservedActive && l.reserver_username) {
    reservedBy = l.reserver_username;
  }
  const unitPrice = Number(l.price);
  const qty = Math.max(1, parseInt(String(l.qty ?? 1), 10) || 1);
  return {
    id: l.id,
    sellerId: resolveSellerIdFromListingRow(l),
    sellerName: resolveSellerDisplayNameFromListingRow(l),
    itemId: l.item_id,
    price: unitPrice,
    qty,
    lineTotal: unitPrice * qty,
    expiresAt: exp,
    reservedBy,
    reservedUntil: reservedActive ? resUntil : undefined
  };
}

/** Como `mapListingForClient`, mas para itens em custódia — inclui `buyerPaidUsdc` quando disponível. */
export function mapCustodyListingForClient(l: PlayerListingRow, now: number): MarketListingClientDto & { buyerPaidUsdc?: number } {
  const base = mapListingForClient(l, now);
  const paidRaw = l.buyer_paid_usdc;
  const paid = paidRaw != null && paidRaw !== '' && Number.isFinite(Number(paidRaw)) ? Number(paidRaw) : undefined;
  return paid !== undefined ? { ...base, buyerPaidUsdc: paid } : base;
}
