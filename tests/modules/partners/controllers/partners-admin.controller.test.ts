import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeApp() {
  const routes: Record<string, (req: any, res: any) => Promise<void> | void> = {};
  function register(method: string, routePath: string | string[], fns: any[]) {
    const handler = fns[fns.length - 1];
    const paths = Array.isArray(routePath) ? routePath : [routePath];
    for (const p of paths) {
      routes[`${method} ${p}`] = handler;
    }
  }
  return {
    get: (routePath: string | string[], ...fns: any[]) => register('GET', routePath, fns),
    post: (routePath: string | string[], ...fns: any[]) => register('POST', routePath, fns),
    put: (routePath: string | string[], ...fns: any[]) => register('PUT', routePath, fns),
    delete: (routePath: string | string[], ...fns: any[]) => register('DELETE', routePath, fns),
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

describe('registerPartnersAdminModuleRoutes', () => {
  let adminModelMock: Record<string, any>;
  let adminApplyMock: Record<string, any>;
  let modelMock: Record<string, any>;
  let helpersMock: Record<string, any>;
  let persistenceMock: Record<string, any>;
  let poolClientMock: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let poolMock: { default: { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } };
  let prevHardwareUrl: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    prevHardwareUrl = process.env.GENESIS_HARDWARE_URL;
    process.env.GENESIS_HARDWARE_URL = 'http://hw.test';
    vi.doMock('../../../../server/modules/hardware/services/hardware-client.js', () => ({
      hardwareWorkerBaseUrl: () => 'http://hw.test',
      callHardwarePersist: vi.fn().mockResolvedValue({ ok: true })
    }));

    adminModelMock = {
      listPartnerYoutubeSubmissionsForAdmin: vi.fn().mockResolvedValue([]),
      updatePartnerYoutubeApprove: vi.fn().mockResolvedValue(1),
      updatePartnerYoutubeReject: vi.fn().mockResolvedValue(1),
      deletePartnerYoutubeSubmission: vi.fn().mockResolvedValue(1),
      listPartnerYoutubePartnersForAdmin: vi.fn().mockResolvedValue([]),
      addPartnerYoutubeManualAllowlist: vi.fn().mockResolvedValue(true),
      removePartnerYoutubeManualAllowlist: vi.fn().mockResolvedValue(true),
      findUserIdsByNormalizedEmail: vi.fn().mockResolvedValue([]),
      findUserIdsByNormalizedUsername: vi.fn().mockResolvedValue([]),
      userExistsById: vi.fn().mockResolvedValue(true),
      listPartnerYoutubeApplicationsForAdmin: vi.fn().mockResolvedValue([]),
      upsertPartnerYoutubeCreatorProfile: vi.fn().mockResolvedValue(undefined)
    };
    adminApplyMock = {
      runPartnerYoutubeApplicationApprove: vi.fn(),
      runPartnerYoutubeApplicationReject: vi.fn()
    };
    modelMock = {
      getPartnerYoutubeCreatorProfile: vi.fn().mockResolvedValue(null)
    };
    helpersMock = {
      sanitizePartnerCreatorAvatarUrl: (v: string) => v,
      sanitizePartnerCreatorChannelUrl: (v: string) => v,
      sanitizePartnerChannelName: (v: string) => v,
      sanitizePartnerChannelDescription: (v: string) => v
    };
    persistenceMock = {
      loadUserPlacedRacksWithSlots: vi.fn().mockResolvedValue([]),
      persistStockStoredBatteriesPlacedRacks: vi.fn().mockResolvedValue(undefined)
    };
    poolClientMock = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    poolMock = {
      default: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        connect: vi.fn().mockResolvedValue(poolClientMock)
      }
    };

    vi.doMock('../../../../server/modules/partners/services/admin-model.js', () => adminModelMock);
    vi.doMock('../../../../server/modules/partners/services/admin-apply.js', () => adminApplyMock);
    vi.doMock('../../../../server/modules/partners/services/model.js', () => modelMock);
    vi.doMock('../../../../server/modules/partners/services/helpers.js', () => helpersMock);
    vi.doMock('../../../../server/modules/hardware/services/persistence.js', () => persistenceMock);
    vi.doMock('../../../../server/core/database/pool.js', () => poolMock);
  });

  afterEach(() => {
    if (prevHardwareUrl === undefined) delete process.env.GENESIS_HARDWARE_URL;
    else process.env.GENESIS_HARDWARE_URL = prevHardwareUrl;
    vi.doUnmock('../../../../server/modules/partners/services/admin-model.js');
    vi.doUnmock('../../../../server/modules/partners/services/admin-apply.js');
    vi.doUnmock('../../../../server/modules/partners/services/model.js');
    vi.doUnmock('../../../../server/modules/partners/services/helpers.js');
    vi.doUnmock('../../../../server/modules/hardware/services/persistence.js');
    vi.doUnmock('../../../../server/modules/hardware/services/hardware-client.js');
    vi.doUnmock('../../../../server/core/database/pool.js');
  });

  async function loadApp() {
    const { registerPartnersAdminModuleRoutes } = await import('../../../../server/modules/partners/controllers/partners-admin.controller.js');
    const app = fakeApp();
    registerPartnersAdminModuleRoutes(app as any, { isAdmin });
    return app;
  }

  // ── allowlist ──────────────────────────────────────────────────────────

  it('POST allowlist sem admin autenticado devolve 401', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: undefined, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST allowlist sem userId nem username devolve 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST allowlist por userId válido: insere', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: { userId: 42 } }, res);
    expect(res.body).toEqual({ ok: true, inserted: true, userId: 42 });
  });

  it('POST allowlist por userId inexistente: 404', async () => {
    adminModelMock.userExistsById.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: { userId: 999 } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST allowlist por username sem resultados: 404', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: { username: 'ninguem' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST allowlist por username ambíguo (>1 resultado): 400', async () => {
    adminModelMock.findUserIdsByNormalizedUsername.mockResolvedValue([1, 2]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: { username: 'dup' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST allowlist por email (contém @): resolve via findUserIdsByNormalizedEmail', async () => {
    adminModelMock.findUserIdsByNormalizedEmail.mockResolvedValue([7]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-allowlist']({ headers: {}, userId: 1, body: { username: 'a@b.com' } }, res);
    expect(res.body).toEqual({ ok: true, inserted: true, userId: 7 });
    expect(adminModelMock.findUserIdsByNormalizedEmail).toHaveBeenCalledWith('a@b.com');
  });

  it('DELETE allowlist inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-youtube-allowlist/:userId']({ headers: {}, userId: 1, params: { userId: 'x' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('DELETE allowlist não encontrado: 404', async () => {
    adminModelMock.removePartnerYoutubeManualAllowlist.mockResolvedValue(false);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-youtube-allowlist/:userId']({ headers: {}, userId: 1, params: { userId: '5' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE allowlist caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-youtube-allowlist/:userId']({ headers: {}, userId: 1, params: { userId: '5' } }, res);
    expect(res.body).toEqual({ ok: true, userId: 5 });
  });

  // ── partner videos (submissions) ──────────────────────────────────────

  it('GET partner-videos lista submissions', async () => {
    adminModelMock.listPartnerYoutubeSubmissionsForAdmin.mockResolvedValue([
      { id: 's1', user_id: 1, username: 'a', email: 'a@x.com', title: 'T', youtube_url: 'u', youtube_video_id: 'v', description: '', status: 'pending', created_at: 100n, reviewed_at: null, reviewed_by: null, reject_reason: null }
    ]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/partner-videos']({ headers: {}, query: {} }, res);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0].id).toBe('s1');
  });

  it('POST approve vídeo inexistente: 404', async () => {
    adminModelMock.updatePartnerYoutubeApprove.mockResolvedValue(0);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-videos/:id/approve']({ headers: {}, userId: 1, params: { id: 's1' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('POST approve vídeo caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-videos/:id/approve']({ headers: {}, userId: 1, params: { id: 's1' } }, res);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST reject vídeo caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-videos/:id/reject']({ headers: {}, userId: 1, params: { id: 's1' }, body: { reason: 'ruim' } }, res);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE partner-videos id inválido (caracteres proibidos): 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-videos/:id']({ headers: {}, userId: 1, params: { id: 'a b/c' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('DELETE partner-videos não encontrado: 404', async () => {
    adminModelMock.deletePartnerYoutubeSubmission.mockResolvedValue(0);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-videos/:id']({ headers: {}, userId: 1, params: { id: 'abc123' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE partner-videos caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['DELETE /api/admin/partner-videos/:id']({ headers: {}, userId: 1, params: { id: 'abc123' } }, res);
    expect(res.body).toEqual({ ok: true });
  });

  // ── creator profile ────────────────────────────────────────────────────

  it('GET creator profile ID inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/partner-youtube-creators/:userId']({ headers: {}, params: { userId: 'x' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('GET creator profile inexistente devolve defaults vazios', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/partner-youtube-creators/:userId']({ headers: {}, params: { userId: '5' } }, res);
    expect(res.body).toEqual({ channelUrl: '', avatarUrl: '', channelName: '', description: '' });
  });

  it('PUT creator profile link do canal inválido: 400', async () => {
    helpersMock.sanitizePartnerCreatorChannelUrl = () => '';
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/partner-youtube-creators/:userId']({ headers: {}, userId: 1, params: { userId: '5' }, body: { channelUrl: 'not-a-url' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('PUT creator profile caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['PUT /api/admin/partner-youtube-creators/:userId']({ headers: {}, userId: 1, params: { userId: '5' }, body: { channelUrl: 'https://youtube.com/@x', avatarUrl: '' } }, res);
    expect(res.body.ok).toBe(true);
  });

  // ── applications ───────────────────────────────────────────────────────

  it('GET applications lista candidaturas', async () => {
    adminModelMock.listPartnerYoutubeApplicationsForAdmin.mockResolvedValue([
      { id: 'a1', user_id: 1, username: 'a', email: 'a@x.com', channel_name: 'C', channel_url: 'u', avatar_url: '', description: '', status: 'pending', created_at: 100n, reviewed_at: null, reject_reason: null }
    ]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/partner-youtube-applications']({ headers: {}, query: {} }, res);
    expect(res.body.applications).toHaveLength(1);
  });

  it('POST application approve caminho feliz', async () => {
    adminApplyMock.runPartnerYoutubeApplicationApprove.mockResolvedValue({ userId: 9 });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-applications/:id/approve']({ headers: {}, userId: 1, params: { id: 'a1' } }, res);
    expect(res.body).toEqual({ ok: true, userId: 9 });
  });

  it('POST application approve propaga HttpControlledError (404)', async () => {
    const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
    adminApplyMock.runPartnerYoutubeApplicationApprove.mockRejectedValue(new HttpControlledError(404, { error: 'Candidatura não encontrada ou já processada.', code: 'NOT_FOUND' }));
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-applications/:id/approve']({ headers: {}, userId: 1, params: { id: 'a1' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('POST application approve sem adminId autenticado: 401', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-applications/:id/approve']({ headers: {}, userId: undefined, params: { id: 'a1' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('POST application reject caminho feliz', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-applications/:id/reject']({ headers: {}, userId: 1, params: { id: 'a1' }, body: { reason: 'não serve' } }, res);
    expect(res.body).toEqual({ ok: true });
  });

  // ── streamer room ──────────────────────────────────────────────────────

  it('GET streamer-room-users lista utilizadores', async () => {
    poolMock.default.query.mockResolvedValue({ rows: [{ user_id: 1, username: 'a', email: 'a@x.com', last_approved_at: null, approved_last_60d: '0' }] });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/streamer-room-users']({ headers: {}, query: {} }, res);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].overdue).toBe(true);
  });

  it('POST streamer-room-users/:userId/deactivate caminho feliz', async () => {
    persistenceMock.loadUserPlacedRacksWithSlots.mockResolvedValue([{ id: 'r1', roomId: 'room_1766898636697' }, { id: 'r2', roomId: 'other' }]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/streamer-room-users/:userId/deactivate']({ headers: {}, userId: 1, params: { userId: '5' } }, res);
    expect(res.body).toEqual({ ok: true, removedRackCount: 1 });
    expect(poolClientMock.query).toHaveBeenCalledWith('BEGIN');
    expect(poolClientMock.query).toHaveBeenCalledWith('COMMIT');
    expect(poolClientMock.release).toHaveBeenCalled();
  });

  it('POST streamer-room-users/:userId/deactivate id inválido: 400', async () => {
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/streamer-room-users/:userId/deactivate']({ headers: {}, userId: 1, params: { userId: 'x' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('POST partners/:userId/deactivate-nft-room caminho feliz', async () => {
    persistenceMock.loadUserPlacedRacksWithSlots.mockResolvedValue([]);
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['POST /api/admin/partner-youtube-partners/:userId/deactivate-nft-room']({ headers: {}, userId: 1, params: { userId: '5' } }, res);
    expect(res.body).toEqual({ ok: true, roomId: 'room_1766898636697', removedRackCount: 0 });
  });

  // ── partners list ──────────────────────────────────────────────────────

  it('GET partner-youtube-partners junta base + extra rows do NFT room', async () => {
    adminModelMock.listPartnerYoutubePartnersForAdmin.mockResolvedValue([
      { user_id: 1, username: 'alice', email: 'alice@x.com', approved_count: 2, approved_last_365d: 1, last_approved_at: BigInt(Date.now()), partner_channel_url: '', partner_avatar_url: '', is_allowlisted: false }
    ]);
    poolMock.default.query.mockResolvedValue({ rows: [{ user_id: 1 }] });
    const app = await loadApp();
    const res = fakeRes();
    await app.routes['GET /api/admin/partner-youtube-partners']({ headers: {} }, res);
    expect(res.body.partners).toHaveLength(1);
    expect(res.body.partners[0].nftRoom.active).toBe(true);
  });
});
