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
