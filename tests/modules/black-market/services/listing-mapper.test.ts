import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLegacyExpiredListingExpiresAt,
  isP2PListingNoExpiryExpiresAt,
  mapCustodyListingForClient,
  mapListingForClient,
  P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS,
  resolveSellerDisplayNameFromListingRow,
  resolveSellerIdFromListingRow,
  timestampMsFromDb
} from '../../../../server/modules/black-market/services/listing-mapper.js';

describe('P2P listing expiry helpers (no product TTL)', () => {
  it('sentinel is MAX_SAFE_INTEGER and never legacy-expired', () => {
    expect(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS).toBe(Number.MAX_SAFE_INTEGER);
    expect(isP2PListingNoExpiryExpiresAt(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS)).toBe(true);
    expect(isLegacyExpiredListingExpiresAt(P2P_LISTING_NO_EXPIRY_EXPIRES_AT_MS, Date.now())).toBe(false);
    expect(isLegacyExpiredListingExpiresAt(Date.now() - 1000, Date.now())).toBe(true);
    expect(isLegacyExpiredListingExpiresAt(Date.now() + 86_400_000, Date.now())).toBe(false);
  });
});

describe('timestampMsFromDb', () => {
  it('number/bigint/string numérica/Date/ISO/null', () => {
    expect(timestampMsFromDb(1000)).toBe(1000);
    expect(timestampMsFromDb(1000n)).toBe(1000);
    expect(timestampMsFromDb('2000')).toBe(2000);
    expect(timestampMsFromDb(null)).toBe(0);
    expect(timestampMsFromDb('')).toBe(0);
    const d = new Date(5000);
    expect(timestampMsFromDb(d)).toBe(5000);
    expect(timestampMsFromDb('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});

describe('resolveSellerIdFromListingRow / resolveSellerDisplayNameFromListingRow', () => {
  it('prefere seller_id, cai pra user_id', () => {
    expect(resolveSellerIdFromListingRow({ seller_id: 5 } as any)).toBe(5);
    expect(resolveSellerIdFromListingRow({ user_id: 7 } as any)).toBe(7);
    expect(resolveSellerIdFromListingRow({} as any)).toBe(0);
  });

  it('nome: seller_display_name > username > email', () => {
    expect(resolveSellerDisplayNameFromListingRow({ seller_display_name: 'Fulano' } as any)).toBe('Fulano');
    expect(resolveSellerDisplayNameFromListingRow({ username: 'fulano123' } as any)).toBe('fulano123');
    expect(resolveSellerDisplayNameFromListingRow({ email: 'x@y.com' } as any)).toBe('x@y.com');
  });
});

describe('mapListingForClient', () => {
  it('calcula lineTotal e marca reservedBy só quando reserva ainda válida', () => {
    const now = 1_000_000;
    const row = { id: 'l1', seller_id: 1, username: 'vendedor', item_id: 'gpu_1', price: '10.5', qty: 3, expires_at: now + 60000, reserved_until: now + 30000, reserver_username: 'comprador' } as any;
    const dto = mapListingForClient(row, now);
    expect(dto.lineTotal).toBeCloseTo(31.5);
    expect(dto.reservedBy).toBe('comprador');
    expect(dto.reservedUntil).toBe(now + 30000);
  });

  it('reserva expirada não aparece', () => {
    const now = 1_000_000;
    const row = { id: 'l1', seller_id: 1, username: 'v', item_id: 'gpu_1', price: 10, qty: 1, expires_at: now + 60000, reserved_until: now - 1000, reserver_username: 'x' } as any;
    const dto = mapListingForClient(row, now);
    expect(dto.reservedBy).toBeUndefined();
    expect(dto.reservedUntil).toBeUndefined();
  });

  it('qty inválida vira 1', () => {
    const row = { id: 'l1', seller_id: 1, username: 'v', item_id: 'gpu_1', price: 10, qty: -5, expires_at: 0 } as any;
    expect(mapListingForClient(row, 0).qty).toBe(1);
  });
});

describe('mapCustodyListingForClient', () => {
  it('inclui buyerPaidUsdc quando presente e numérico', () => {
    const row = { id: 'l1', seller_id: 1, username: 'v', item_id: 'gpu_1', price: 10, qty: 1, expires_at: 0, buyer_paid_usdc: '9.5' } as any;
    const dto = mapCustodyListingForClient(row, 0);
    expect(dto.buyerPaidUsdc).toBe(9.5);
  });

  it('omite buyerPaidUsdc quando ausente/inválido', () => {
    const row = { id: 'l1', seller_id: 1, username: 'v', item_id: 'gpu_1', price: 10, qty: 1, expires_at: 0 } as any;
    const dto = mapCustodyListingForClient(row, 0);
    expect(dto.buyerPaidUsdc).toBeUndefined();
  });
});

describe('getBlackMarketPriceBandPercent / isP2PMarketEnabled', () => {
  let prismaMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        economy_settings: { findUnique: vi.fn().mockResolvedValue({ black_market_price_band_percent: 30, black_market_enabled: 1 }) },
        settings: { findUnique: vi.fn().mockResolvedValue(null) }
      }
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  it('usa economy_settings quando disponível', async () => {
    const { getBlackMarketPriceBandPercent } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await getBlackMarketPriceBandPercent()).toBe(30);
  });

  it('cai pro fallback default (20) quando tudo falha', async () => {
    prismaMock.prisma.economy_settings.findUnique.mockRejectedValue(new Error('boom'));
    prismaMock.prisma.settings.findUnique.mockRejectedValue(new Error('boom'));
    const { getBlackMarketPriceBandPercent } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await getBlackMarketPriceBandPercent()).toBe(20);
  });

  it('clampa fora do intervalo [1,90]', async () => {
    prismaMock.prisma.economy_settings.findUnique.mockResolvedValue({ black_market_price_band_percent: 999 });
    const { getBlackMarketPriceBandPercent } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await getBlackMarketPriceBandPercent()).toBe(90);
  });

  it('isP2PMarketEnabled: economy_settings manda quando existe', async () => {
    const { isP2PMarketEnabled } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await isP2PMarketEnabled()).toBe(true);
  });

  it('isP2PMarketEnabled: desligado quando economy_settings diz 0', async () => {
    prismaMock.prisma.economy_settings.findUnique.mockResolvedValue({ black_market_enabled: 0 });
    const { isP2PMarketEnabled } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await isP2PMarketEnabled()).toBe(false);
  });

  it('isP2PMarketEnabled: erro cai em default true', async () => {
    prismaMock.prisma.economy_settings.findUnique.mockRejectedValue(new Error('boom'));
    prismaMock.prisma.settings.findUnique.mockRejectedValue(new Error('boom'));
    const { isP2PMarketEnabled } = await import('../../../../server/modules/black-market/services/listing-mapper.js');
    expect(await isP2PMarketEnabled()).toBe(true);
  });
});
