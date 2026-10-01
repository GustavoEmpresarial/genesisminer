import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../../../client/src/shared/api/http', () => ({ apiFetch }));

async function load() {
  return import('../../../client/src/shared/api/admin-economy.js');
}

function res(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  apiFetch.mockReset();
  vi.resetModules();
});

describe('normalizeMiningCoinPayload flags', () => {
  it('missing showInExchange → true no payload de save', async () => {
    apiFetch.mockResolvedValue(res(true, { ok: true }));
    const { saveMiningCoin } = await load();
    await saveMiningCoin({
      id: 'btc',
      networkHashrate: 1,
      blockReward: 1,
      usdcRate: 1
    });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.showInExchange).toBe(true);
    expect(body.isActive).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, 'showInExchange')).toBe(true);
  });

  it('explicit showInExchange false → false', async () => {
    apiFetch.mockResolvedValue(res(true, { ok: true }));
    const { saveMiningCoin } = await load();
    await saveMiningCoin({
      id: 'btc',
      networkHashrate: 1,
      blockReward: 1,
      usdcRate: 1,
      showInExchange: false
    });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.showInExchange).toBe(false);
  });

  it('isInternal coerce (true/1/"1" → true; else false)', async () => {
    const { normalizeMiningCoinPayload } = await load();
    const base = { networkHashrate: 1, blockReward: 1, usdcRate: 1 };
    expect(normalizeMiningCoinPayload({ ...base, isInternal: true }).isInternal).toBe(true);
    expect(normalizeMiningCoinPayload({ ...base, isInternal: 1 }).isInternal).toBe(true);
    expect(normalizeMiningCoinPayload({ ...base, isInternal: '1' }).isInternal).toBe(true);
    expect(normalizeMiningCoinPayload({ ...base, isInternal: false }).isInternal).toBe(false);
    expect(normalizeMiningCoinPayload({ ...base }).isInternal).toBe(false);
  });

  it('isActive explicit off (false/0/"0") → false; absent → true', async () => {
    const { normalizeMiningCoinPayload } = await load();
    const base = { networkHashrate: 1, blockReward: 1, usdcRate: 1 };
    expect(normalizeMiningCoinPayload({ ...base }).isActive).toBe(true);
    expect(normalizeMiningCoinPayload({ ...base, isActive: false }).isActive).toBe(false);
    expect(normalizeMiningCoinPayload({ ...base, isActive: 0 }).isActive).toBe(false);
    expect(normalizeMiningCoinPayload({ ...base, isActive: '0' }).isActive).toBe(false);
  });
});

describe('setMiningCoinActive / deleteMiningCoin', () => {
  it('POSTa /api/mining-coins/set-active com { id, active }', async () => {
    apiFetch.mockResolvedValue(res(true, { ok: true, activeMiners: 3 }));
    const { setMiningCoinActive } = await load();
    const out = await setMiningCoinActive('btc', false);
    expect(out).toEqual({ ok: true, activeMiners: 3, error: undefined });
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/mining-coins/set-active');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ id: 'btc', active: false });
  });

  it('id vazio não chama a API', async () => {
    const { setMiningCoinActive } = await load();
    const out = await setMiningCoinActive('   ', true);
    expect(out).toEqual({ ok: false, error: 'id da moeda é obrigatório.' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('propaga o erro do servidor', async () => {
    apiFetch.mockResolvedValue(res(false, { ok: false, error: 'Moeda não encontrada.' }, 400));
    const { setMiningCoinActive } = await load();
    const out = await setMiningCoinActive('x', false);
    expect(out).toEqual({ ok: false, error: 'Moeda não encontrada.' });
  });

  it('deleteMiningCoin = setMiningCoinActive(id, false)', async () => {
    apiFetch.mockResolvedValue(res(true, { ok: true }));
    const { deleteMiningCoin } = await load();
    const out = await deleteMiningCoin('doge');
    expect(out.ok).toBe(true);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ id: 'doge', active: false });
  });
});
