import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CLIENT_PATH = '../../../../server/modules/hardware/services/hardware-client.js';

describe('hardware-client market paths', () => {
  let prevUrl: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    prevUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevUrl;
  });

  async function jsonRes(status: number, body: unknown): Promise<Response> {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  it('callMarketSell POST /v1/market/sell e devolve listingId', async () => {
    fetchMock.mockResolvedValue(await jsonRes(200, { ok: true, listingId: 'lid-1' }));
    const { callMarketSell } = await import(CLIENT_PATH);
    const out = await callMarketSell({ userId: 1, itemId: 'item_x', price: 10, qty: 2 });
    expect(out).toEqual({ listingId: 'lid-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://hw.test/v1/market/sell');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ userId: 1, itemId: 'item_x', price: 10, qty: 2 });
  });

  it('callMarketCancel / buy / reclaim / claim* usam paths /v1/market/*', async () => {
    const { callMarketCancel, callMarketBuy, callMarketReclaim, callMarketClaimItem, callMarketClaimAll, callMarketClaimProceeds } =
      await import(CLIENT_PATH);
    fetchMock
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, itemId: 'i', qty: 1, price: 2 }))
      .mockResolvedValueOnce(
        await jsonRes(200, {
          ok: true,
          buyQty: 1,
          totalPrice: 10,
          unitPrice: 10,
          sellerId: 2,
          itemId: 'i',
          listingId: 'lid'
        })
      )
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, reclaimed: 3 }))
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, itemId: 'i', qty: 1 }))
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, claimedIds: ['a'] }))
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, moved: 4 }));
    await callMarketCancel({ userId: 1, listingId: 'lid' });
    await callMarketBuy({ buyerId: 1, listingId: 'lid', idempotencyKey: 'abcdefgh' });
    await callMarketReclaim({ nowMs: 1, batchSize: 200, maxRounds: 1 });
    await callMarketClaimItem({ userId: 1, listingId: 'lid' });
    await callMarketClaimAll({ userId: 1 });
    await callMarketClaimProceeds({ userId: 1 });
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      'http://hw.test/v1/market/cancel',
      'http://hw.test/v1/market/buy',
      'http://hw.test/v1/market/reclaim',
      'http://hw.test/v1/market/claim-item',
      'http://hw.test/v1/market/claim-all',
      'http://hw.test/v1/market/claim-proceeds'
    ]);
  });

  it('domínio 400 → HardwareMarketError com o mesmo error (não throw genérico)', async () => {
    fetchMock.mockImplementation(async () => jsonRes(400, { ok: false, error: 'Insufficient stock to list.' }));
    const { callMarketSell, HardwareMarketError } = await import(CLIENT_PATH);
    await expect(callMarketSell({ userId: 1, itemId: 'item_x', price: 10, qty: 1 })).rejects.toBeInstanceOf(
      HardwareMarketError
    );
    try {
      await callMarketSell({ userId: 1, itemId: 'item_x', price: 10, qty: 1 });
      expect.fail('expected HardwareMarketError');
    } catch (e) {
      expect(e).toBeInstanceOf(HardwareMarketError);
      expect(e).toMatchObject({ statusCode: 400, jsonBody: { error: 'Insufficient stock to list.' } });
    }
  });

  it('leituras: listings / history / state', async () => {
    fetchMock
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, items: [], total: 0 }))
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, purchases: [], sales: [] }))
      .mockResolvedValueOnce(await jsonRes(200, { ok: true, state: { version: 1, enabled: true } }));
    const { callMarketListings, callMarketHistory, callMarketState } = await import(CLIENT_PATH);
    await expect(callMarketListings({ excludeSellerId: 1 })).resolves.toEqual({ items: [], total: 0 });
    await expect(callMarketHistory({ userId: 1, limit: 80 })).resolves.toEqual({ purchases: [], sales: [] });
    await expect(callMarketState({ userId: 1 })).resolves.toEqual({ version: 1, enabled: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://hw.test/v1/market/listings',
      'http://hw.test/v1/market/history',
      'http://hw.test/v1/market/state'
    ]);
  });
});
