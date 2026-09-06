/**
 * Contrato FE OCC — parsing/payload do catálogo (sem montar AdminPanel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('upgrades catalog OCC client', () => {
  let apiFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    apiFetch = vi.fn();
    vi.doMock('../../../client/src/shared/api/http.js', () => ({
      apiFetch,
      setSessionHint: vi.fn()
    }));
  });

  afterEach(() => {
    vi.doUnmock('../../../client/src/shared/api/http.js');
  });

  it('A) GET devolve upgrades + catalogRevision', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ catalogRevision: 42, upgrades: [{ id: 'gpu_1', name: 'GPU' }] })
    });
    const { getUpgradesCatalog } = await import('../../../client/src/shared/api/admin-legacy.js');
    const pack = await getUpgradesCatalog();
    expect(pack).toEqual({
      catalogRevision: 42,
      upgrades: [{ id: 'gpu_1', name: 'GPU' }]
    });
  });

  it('B) POST envia expectedCatalogRevision', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, catalogRevision: 43 })
    });
    const { setUpgrades } = await import('../../../client/src/shared/api/admin-legacy.js');
    const res = await setUpgrades([{ id: 'gpu_1', name: 'GPU' } as never], 42);
    expect(res).toEqual({ ok: true, catalogRevision: 43 });
    expect(apiFetch).toHaveBeenCalled();
    const init = apiFetch.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({
      upgrades: [{ id: 'gpu_1', name: 'GPU' }],
      expectedCatalogRevision: 42
    });
  });

  it('C) 409 CATALOG_VERSION_CONFLICT não reporta ok', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          error: 'Catálogo foi alterado',
          code: 'CATALOG_VERSION_CONFLICT',
          forceReload: true,
          catalogRevision: 43
        })
    });
    const { setUpgrades } = await import('../../../client/src/shared/api/admin-legacy.js');
    const res = await setUpgrades([{ id: 'gpu_1' } as never], 42);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('CATALOG_VERSION_CONFLICT');
      expect(res.forceReload).toBe(true);
      expect(res.catalogRevision).toBe(43);
    }
  });

  it('D) getUpgrades (compat) devolve só o array', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ catalogRevision: 5, upgrades: [{ id: 'a' }] })
    });
    const { getUpgrades } = await import('../../../client/src/shared/api/admin-legacy.js');
    expect(await getUpgrades()).toEqual([{ id: 'a' }]);
  });
});
