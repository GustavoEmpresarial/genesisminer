import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('transparency service', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
  });

  it('mapTransparencyEntryRow maps snake_case and optional fields', async () => {
    const { mapTransparencyEntryRow } = await import(
      '../../../../server/modules/transparency/services/transparency.js'
    );
    expect(
      mapTransparencyEntryRow({
        id: 3,
        category: 'pool',
        title: 'Treasury',
        body: null,
        amount_usdc: 12.5,
        link_url: null,
        sort_order: 2,
        created_at: 1_700_000_000_000n,
        updated_at: 1_700_000_000_100n
      })
    ).toEqual({
      id: 3,
      category: 'pool',
      title: 'Treasury',
      body: undefined,
      amountUsdc: 12.5,
      linkUrl: undefined,
      sortOrder: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100
    });
  });

  it('listTransparencyEntries returns mapped rows', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 1,
        category: 'expense',
        title: 'Hosting',
        body: 'VPS',
        amount_usdc: 40,
        link_url: 'https://example.com',
        sort_order: 0,
        created_at: 10n,
        updated_at: 20n
      }
    ]);
    vi.doMock('../../../../server/core/database/prisma.js', () => ({
      prisma: { transparency_entries: { findMany } }
    }));
    const { listTransparencyEntries } = await import(
      '../../../../server/modules/transparency/services/transparency.js'
    );
    const rows = await listTransparencyEntries();
    expect(findMany).toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ id: 1, title: 'Hosting', amountUsdc: 40, linkUrl: 'https://example.com' });
  });
});
