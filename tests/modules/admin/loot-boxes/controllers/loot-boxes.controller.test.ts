import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  return {
    get: (path: string, ...fns: any[]) => {
      routes[`GET ${path}`] = fns[fns.length - 1];
    },
    post: (path: string, ...fns: any[]) => {
      routes[`POST ${path}`] = fns[fns.length - 1];
    },
    delete: (path: string, ...fns: any[]) => {
      routes[`DELETE ${path}`] = fns[fns.length - 1];
    },
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

describe('registerLootBoxAdminModuleRoutes', () => {
  let catalogMock: Record<string, any>;
  let inventoryMock: Record<string, any>;
  let redemptionsMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    catalogMock = {
      upsertLootBoxCatalog: vi.fn().mockResolvedValue([]),
      deleteLootBoxAdmin: vi.fn().mockResolvedValue({ boxName: 'Caixa', summary: { lootBoxesRemoved: 1 } }),
      parseLootBoxId: (raw: unknown) => (typeof raw === 'string' && /^[a-zA-Z0-9_.-]+$/.test(raw) ? raw : null)
    };
    inventoryMock = {
      listUserUnopenedBoxes: vi.fn().mockResolvedValue({ boxes: [{ box_id: 'b1', qty: 2 }] }),
      deleteUserUnopenedBox: vi.fn().mockResolvedValue({ ok: true, message: 'Deleted 2x box b1 from a@b.c', deletedQty: 2 })
    };
    redemptionsMock = {
      listLootBoxRedemptions: vi.fn().mockResolvedValue([
        { code: 'X1', type: 'per_player', username: 'alice', redeemedAt: 1000 }
      ])
    };
    vi.doMock('../../../../../server/modules/admin/loot-boxes/services/catalog.js', () => catalogMock);
    vi.doMock('../../../../../server/modules/admin/loot-boxes/services/user-inventory.js', () => inventoryMock);
    vi.doMock('../../../../../server/modules/admin/loot-boxes/services/redemptions.js', () => redemptionsMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/loot-boxes/services/catalog.js');
    vi.doUnmock('../../../../../server/modules/admin/loot-boxes/services/user-inventory.js');
    vi.doUnmock('../../../../../server/modules/admin/loot-boxes/services/redemptions.js');
  });

  async function loadApp() {
    const { registerLootBoxAdminModuleRoutes } = await import('../../../../../server/modules/admin/loot-boxes/controllers/loot-boxes.controller.js');
    const app = fakeApp();
    registerLootBoxAdminModuleRoutes(app as any, { isAdmin });
    return app;
  }

  describe('GET /api/admin/loot-box-redemptions/:boxId', () => {
    it('boxId inválido: 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/loot-box-redemptions/:boxId']({ params: { boxId: 'bad id!' } }, res);
      expect(res.statusCode).toBe(400);
      expect(redemptionsMock.listLootBoxRedemptions).not.toHaveBeenCalled();
    });

    it('caminho feliz: devolve array', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/loot-box-redemptions/:boxId']({ params: { boxId: 'box_a' } }, res);
      expect(redemptionsMock.listLootBoxRedemptions).toHaveBeenCalledWith('box_a');
      expect(res.body).toEqual([{ code: 'X1', type: 'per_player', username: 'alice', redeemedAt: 1000 }]);
    });

    it('HttpControlledError do serviço: status/corpo controlado', async () => {
      const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
      redemptionsMock.listLootBoxRedemptions.mockRejectedValue(new HttpControlledError(404, { error: 'missing' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/loot-box-redemptions/:boxId']({ params: { boxId: 'box_a' } }, res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'missing' });
    });
  });

  describe('GET /api/admin/user-boxes', () => {
    it('caminho feliz: lista boxes', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/user-boxes']({ query: { email: 'a@b.c' } }, res);
      expect(inventoryMock.listUserUnopenedBoxes).toHaveBeenCalledWith('a@b.c');
      expect(res.body).toEqual({ boxes: [{ box_id: 'b1', qty: 2 }] });
    });

    it('HttpControlledError do serviço: status/corpo controlado', async () => {
      const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
      inventoryMock.listUserUnopenedBoxes.mockRejectedValue(new HttpControlledError(400, { error: 'Email required' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['GET /api/admin/user-boxes']({ query: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Email required' });
    });
  });

  describe('POST /api/admin/delete-user-box', () => {
    it('caminho feliz: apaga e devolve deletedQty', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/delete-user-box']({ body: { email: 'a@b.c', boxId: 'b1' } }, res);
      expect(inventoryMock.deleteUserUnopenedBox).toHaveBeenCalledWith('a@b.c', 'b1');
      expect(res.body).toEqual({ ok: true, message: 'Deleted 2x box b1 from a@b.c', deletedQty: 2 });
    });

    it('HttpControlledError 404 do serviço: status/corpo controlado', async () => {
      const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
      inventoryMock.deleteUserUnopenedBox.mockRejectedValue(
        new HttpControlledError(404, { error: 'Box not found in user inventory' })
      );
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/delete-user-box']({ body: { email: 'a@b.c', boxId: 'x' } }, res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Box not found in user inventory' });
    });
  });

  describe('POST /api/admin/loot-boxes', () => {
    it('body inválido: 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/loot-boxes']({ body: { foo: 'bar' } }, res);
      expect(res.statusCode).toBe(400);
    });

    it('aceita array legado direto', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/loot-boxes']({ body: [{ id: 'b1', name: 'Caixa' }] }, res);
      expect(catalogMock.upsertLootBoxCatalog).toHaveBeenCalledWith([{ id: 'b1', name: 'Caixa' }], false);
      expect(res.body).toEqual({ ok: true });
    });

    it('aceita { boxes, replaceCatalog } e devolve warnings quando existirem', async () => {
      catalogMock.upsertLootBoxCatalog.mockResolvedValue(['aviso 1']);
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/loot-boxes']({ body: { boxes: [{ id: 'b1' }], replaceCatalog: true } }, res);
      expect(catalogMock.upsertLootBoxCatalog).toHaveBeenCalledWith([{ id: 'b1' }], true);
      expect(res.body).toEqual({ ok: true, warnings: ['aviso 1'] });
    });

    it('HttpControlledError do serviço: status/corpo controlado', async () => {
      const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
      catalogMock.upsertLootBoxCatalog.mockRejectedValue(new HttpControlledError(400, { error: 'preço inválido' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['POST /api/admin/loot-boxes']({ body: [{ id: 'b1' }] }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'preço inválido' });
    });
  });

  describe('DELETE /api/admin/loot-boxes/:boxId', () => {
    it('boxId inválido: 400', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/loot-boxes/:boxId']({ params: { boxId: 'bad id!' }, query: {} }, res);
      expect(res.statusCode).toBe(400);
    });

    it('caminho feliz: apaga e devolve resumo', async () => {
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/loot-boxes/:boxId']({ params: { boxId: 'b1' }, query: { brokenOnly: '1' } }, res);
      expect(catalogMock.deleteLootBoxAdmin).toHaveBeenCalledWith('b1', true);
      expect(res.body).toEqual({ ok: true, summary: { lootBoxesRemoved: 1 } });
    });

    it('HttpControlledError do serviço (ex.: 404): status/corpo controlado', async () => {
      const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
      catalogMock.deleteLootBoxAdmin.mockRejectedValue(new HttpControlledError(404, { error: 'Caixa não encontrada.' }));
      const app = await loadApp();
      const res = fakeRes();
      await app.routes['DELETE /api/admin/loot-boxes/:boxId']({ params: { boxId: 'b1' }, query: {} }, res);
      expect(res.statusCode).toBe(404);
    });
  });
});
