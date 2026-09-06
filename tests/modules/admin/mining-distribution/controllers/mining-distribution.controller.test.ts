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
    routes
  };
}

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    write(chunk: string) {
      res.chunks.push(chunk);
    },
    end() {
      res.ended = true;
    }
  };
  return res;
}

const isAdmin = (_req: any, _res: any, next: any) => next();

describe('registerAdminMiningDistributionModuleRoutes', () => {
  let reportMock: Record<string, any>;
  let rollupsMock: Record<string, any>;
  let datesMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    reportMock = {
      getDistributionOverview: vi.fn().mockResolvedValue({ ok: 'overview' }),
      getDistributionByCoin: vi.fn().mockResolvedValue({ ok: 'by-coin' }),
      getDistributionTimeline: vi.fn().mockResolvedValue({ ok: 'timeline' }),
      getMiningCreditsLedger: vi.fn().mockResolvedValue({ total: 0, page: 1, limit: 50, rows: [] }),
      getUserMiningDistributionSummary: vi.fn().mockResolvedValue({ ok: 'summary' }),
      streamMiningCreditsCsv: vi.fn().mockResolvedValue({ rowsWritten: 0, truncated: false })
    };
    rollupsMock = {
      rebuildMiningDistributionRollups: vi.fn().mockResolvedValue({ daysProcessed: 1, rowsUpserted: 1 }),
      rebuildMiningDistributionRollupsRecent: vi.fn().mockResolvedValue({ daysProcessed: 45, rowsUpserted: 10 })
    };
    datesMock = {
      parseDistributionDateMs: (v: unknown) => {
        if (v == null) return null;
        const s = String(v).trim();
        if (!s) return null;
        if (/^\d+$/.test(s)) return Number(s);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00.000Z`);
        return null;
      },
      utcDayEndMsFromTs: (ts: number) => ts + 86_399_999
    };
    vi.doMock('../../../../../server/modules/admin/mining-distribution/services/report.js', () => reportMock);
    vi.doMock('../../../../../server/modules/admin/mining-distribution/services/rollups.js', () => rollupsMock);
    vi.doMock('../../../../../server/modules/admin/mining-distribution/services/dates.js', () => datesMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../../server/modules/admin/mining-distribution/services/report.js');
    vi.doUnmock('../../../../../server/modules/admin/mining-distribution/services/rollups.js');
    vi.doUnmock('../../../../../server/modules/admin/mining-distribution/services/dates.js');
  });

  async function loadApp() {
    const { registerAdminMiningDistributionModuleRoutes } = await import('../../../../../server/modules/admin/mining-distribution/controllers/mining-distribution.controller.js');
    const app = fakeApp();
    registerAdminMiningDistributionModuleRoutes(app as any, { isAdmin });
    return app;
  }

  it('GET .../overview devolve o payload do serviço', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/overview']({ headers: {}, query: {} }, res);
    expect(res.body).toEqual({ ok: 'overview' });
  });

  it('GET .../by-coin sem from/to: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/by-coin']({ headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET .../by-coin com range válido: devolve o payload', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/by-coin']({ headers: {}, query: { from: '0', to: '1000' } }, res);
    expect(reportMock.getDistributionByCoin).toHaveBeenCalledWith(0, 1000);
    expect(res.body).toEqual({ ok: 'by-coin' });
  });

  it('GET .../timeline usa bucket=week só quando explicitamente pedido', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/timeline']({ headers: {}, query: { from: '0', to: '1000', bucket: 'week' } }, res);
    expect(reportMock.getDistributionTimeline).toHaveBeenCalledWith(0, 1000, 'week', undefined);
  });

  it('GET .../credits: erro de negócio (HttpControlledError) é repassado com status próprio', async () => {
    const { HttpControlledError } = await import('../../../../../server/shared/errors/http-controlled-error.js');
    reportMock.getMiningCreditsLedger.mockRejectedValue(new HttpControlledError(400, { error: 'Intervalo de datas inválido.' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/credits']({ headers: {}, query: { from: '1000', to: '0' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET .../credits caminho feliz devolve a página', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/credits']({ headers: {}, query: { from: '0', to: '1000' } }, res);
    expect(res.body).toMatchObject({ total: 0 });
  });

  it('GET .../credits/export.csv escreve headers CSV e streama linhas', async () => {
    reportMock.streamMiningCreditsCsv.mockImplementation(async (_f: unknown, write: (c: string) => void) => {
      write('linha,csv\n');
      return { rowsWritten: 1, truncated: false };
    });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/credits/export.csv']({ headers: {}, query: { from: '0', to: '1000' } }, res);
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.chunks.join('')).toContain('linha,csv');
    expect(res.ended).toBe(true);
  });

  it('GET .../credits/export.csv trunca: escreve linha de aviso', async () => {
    reportMock.streamMiningCreditsCsv.mockResolvedValue({ rowsWritten: 50000, truncated: true });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/credits/export.csv']({ headers: {}, query: { from: '0', to: '1000' } }, res);
    expect(res.chunks.join('')).toContain('AVISO');
  });

  it('GET .../users/:userId/summary com userId inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/users/:userId/summary']({ headers: {}, params: { userId: 'abc' }, query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET .../users/:userId/summary caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/mining-distribution/users/:userId/summary']({ headers: {}, params: { userId: '7' }, query: { from: '0', to: '1000' } }, res);
    expect(reportMock.getUserMiningDistributionSummary).toHaveBeenCalledWith(7, 0, 1000);
    expect(res.body).toEqual({ ok: 'summary' });
  });

  it('POST .../rebuild-rollups com fromDay/toDay: usa rebuild por intervalo', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/mining-distribution/rebuild-rollups']({ headers: {}, body: { fromDay: '2026-01-01', toDay: '2026-01-03' } }, res);
    expect(rollupsMock.rebuildMiningDistributionRollups).toHaveBeenCalledWith('2026-01-01', '2026-01-03');
    expect(res.body).toMatchObject({ ok: true, daysProcessed: 1 });
  });

  it('POST .../rebuild-rollups sem fromDay/toDay: usa rebuild recente com daysBack', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/mining-distribution/rebuild-rollups']({ headers: {}, body: { daysBack: 7 } }, res);
    expect(rollupsMock.rebuildMiningDistributionRollupsRecent).toHaveBeenCalledWith(7);
  });

  it('POST .../rebuild-rollups em cooldown: 429', async () => {
    const app = await loadApp();
    const res1 = fakeRes();
    await app.routes['POST /api/admin/mining-distribution/rebuild-rollups']({ headers: {}, body: {} }, res1);
    const res2 = fakeRes();
    await app.routes['POST /api/admin/mining-distribution/rebuild-rollups']({ headers: {}, body: {} }, res2);
    expect(res2.statusCode).toBe(429);
  });
});
