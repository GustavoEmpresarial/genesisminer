import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const BASE_ROW = {
  id: VALID_UUID,
  title: 'Título',
  message: 'Mensagem',
  link: null,
  image_url: null,
  is_active: 1,
  priority: 5,
  starts_at: null,
  ends_at: null,
  created_at: 1000n,
  created_by: 1
};

const WORKER_ROW = {
  id: VALID_UUID,
  title: 'Título',
  message: 'Mensagem',
  link: null,
  imageUrl: null,
  isActive: 1,
  priority: 5,
  startsAt: null,
  endsAt: null,
  createdAt: 1000,
  createdBy: 1
};

describe('announcements services/announcements', () => {
  let prismaMock: Record<string, any>;
  let workerMock: {
    callMiningWorkerAnnouncementCreate: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementUpdate: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementDelete: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementMarkRead: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementPending: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementMiniBlog: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementAdminList: ReturnType<typeof vi.fn>;
    callMiningWorkerAnnouncementGet: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    prismaMock = {
      prisma: {
        in_app_announcements: {
          findMany: vi.fn().mockResolvedValue([BASE_ROW]),
          findUnique: vi.fn().mockResolvedValue(BASE_ROW),
          create: vi.fn().mockResolvedValue(BASE_ROW),
          update: vi.fn().mockResolvedValue(BASE_ROW),
          delete: vi.fn().mockResolvedValue(BASE_ROW)
        },
        in_app_announcement_reads: {
          upsert: vi.fn().mockResolvedValue(undefined),
          groupBy: vi.fn().mockResolvedValue([{ announcement_id: VALID_UUID, _count: { announcement_id: 3 } }]),
          count: vi.fn().mockResolvedValue(3)
        }
      }
    };
    workerMock = {
      callMiningWorkerAnnouncementCreate: vi.fn().mockResolvedValue({ ok: true, row: WORKER_ROW, readCount: 0 }),
      callMiningWorkerAnnouncementUpdate: vi.fn().mockResolvedValue({ ok: true, row: { ...WORKER_ROW, title: 'Novo' }, readCount: 3 }),
      callMiningWorkerAnnouncementDelete: vi.fn().mockResolvedValue({ ok: true, deleted: true }),
      callMiningWorkerAnnouncementMarkRead: vi.fn().mockResolvedValue({ ok: true }),
      callMiningWorkerAnnouncementPending: vi.fn().mockResolvedValue({ ok: true, rows: [WORKER_ROW] }),
      callMiningWorkerAnnouncementMiniBlog: vi.fn().mockResolvedValue({ ok: true, rows: [WORKER_ROW] }),
      callMiningWorkerAnnouncementAdminList: vi.fn().mockResolvedValue({ ok: true, rows: [{ ...WORKER_ROW, readCount: 3 }] }),
      callMiningWorkerAnnouncementGet: vi.fn().mockResolvedValue({ ok: true, row: WORKER_ROW, readCount: 3 })
    };
    vi.doMock('../../../../server/core/database/prisma.js', () => prismaMock);
    vi.doMock('../../../../server/modules/mining-engine/services/mining-worker-client.js', () => workerMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/core/database/prisma.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/mining-worker-client.js');
  });

  describe('listPendingAnnouncementsForUser / listMiniBlogEntriesForUser', () => {
    it('mapeia linhas pra DTO do jogador', async () => {
      const { listPendingAnnouncementsForUser } = await import('../../../../server/modules/announcements/services/announcements.js');
      const list = await listPendingAnnouncementsForUser(1);
      expect(list).toEqual([{ id: VALID_UUID, title: 'Título', message: 'Mensagem', link: null, imageUrl: null, priority: 5, createdAt: 1000 }]);
    });

    it('link/imageUrl inválidos na BD viram null no DTO (não quebram)', async () => {
      workerMock.callMiningWorkerAnnouncementMiniBlog.mockResolvedValue({
        ok: true,
        rows: [{ ...WORKER_ROW, link: 'ftp://bad', imageUrl: 'https://evil.com/x.png' }]
      });
      const { listMiniBlogEntriesForUser } = await import('../../../../server/modules/announcements/services/announcements.js');
      const list = await listMiniBlogEntriesForUser(1);
      expect(list[0].link).toBeNull();
      expect(list[0].imageUrl).toBeNull();
    });
  });

  describe('dismissAnnouncementForUser', () => {
    it('id inválido: invalid_id, sem tocar na BD', async () => {
      const { dismissAnnouncementForUser } = await import('../../../../server/modules/announcements/services/announcements.js');
      const result = await dismissAnnouncementForUser(1, 'nao-e-uuid');
      expect(result).toBe('invalid_id');
      expect(workerMock.callMiningWorkerAnnouncementGet).not.toHaveBeenCalled();
    });

    it('aviso inexistente: not_found', async () => {
      workerMock.callMiningWorkerAnnouncementGet.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Announcement not found.' });
      const { dismissAnnouncementForUser } = await import('../../../../server/modules/announcements/services/announcements.js');
      const result = await dismissAnnouncementForUser(1, VALID_UUID);
      expect(result).toBe('not_found');
    });

    it('sucesso: mark-read no worker', async () => {
      const { dismissAnnouncementForUser } = await import('../../../../server/modules/announcements/services/announcements.js');
      const result = await dismissAnnouncementForUser(1, VALID_UUID);
      expect(result).toBe('ok');
      expect(workerMock.callMiningWorkerAnnouncementMarkRead).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, announcementId: VALID_UUID })
      );
    });
  });

  describe('listAnnouncementsAdmin', () => {
    it('agrega readCount por announcement_id', async () => {
      const { listAnnouncementsAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      const list = await listAnnouncementsAdmin();
      expect(list[0]).toMatchObject({ id: VALID_UUID, readCount: 3, isActive: true });
    });
  });

  describe('createAnnouncementAdmin', () => {
    it('grava com created_by e devolve o DTO admin', async () => {
      const { createAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      const out = await createAnnouncementAdmin({ title: 'T', message: 'M', link: null, imageUrl: null, priority: 0, isActive: true, startsAt: null, endsAt: null }, 42);
      expect(workerMock.callMiningWorkerAnnouncementCreate).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 42, title: 'T', message: 'M' }));
      expect(out.readCount).toBe(0);
    });
  });

  describe('updateAnnouncementAdmin', () => {
    it('id inválido: null', async () => {
      const { updateAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      const out = await updateAnnouncementAdmin('nao-e-uuid', {});
      expect(out).toBeNull();
    });

    it('inexistente: null', async () => {
      workerMock.callMiningWorkerAnnouncementGet.mockResolvedValue({ ok: false, code: 'NOT_FOUND', error: 'Announcement not found.' });
      const { updateAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      const out = await updateAnnouncementAdmin(VALID_UUID, {});
      expect(out).toBeNull();
    });

    it('valida schedule range quando startsAt/endsAt mudam', async () => {
      const { updateAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      await expect(updateAnnouncementAdmin(VALID_UUID, { startsAt: 2000, endsAt: 1000 })).rejects.toThrow();
    });

    it('sucesso: actualiza só os campos informados', async () => {
      const { updateAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      const out = await updateAnnouncementAdmin(VALID_UUID, { title: 'Novo' });
      expect(workerMock.callMiningWorkerAnnouncementUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: VALID_UUID, title: 'Novo' }));
      expect(out?.readCount).toBe(3);
    });
  });

  describe('deleteAnnouncementAdmin', () => {
    it('id inválido: false', async () => {
      const { deleteAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      expect(await deleteAnnouncementAdmin('nao-e-uuid')).toBe(false);
    });

    it('sucesso: true', async () => {
      const { deleteAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      expect(await deleteAnnouncementAdmin(VALID_UUID)).toBe(true);
      expect(workerMock.callMiningWorkerAnnouncementDelete).toHaveBeenCalledWith(VALID_UUID);
    });

    it('worker NOT_FOUND: false', async () => {
      workerMock.callMiningWorkerAnnouncementDelete.mockResolvedValue({ ok: false, error: 'Announcement not found.', code: 'NOT_FOUND' });
      const { deleteAnnouncementAdmin } = await import('../../../../server/modules/announcements/services/announcements.js');
      expect(await deleteAnnouncementAdmin(VALID_UUID)).toBe(false);
    });
  });
});
