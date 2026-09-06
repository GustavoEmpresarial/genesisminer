import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('partners services/apply', () => {
  let modelMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    modelMock = {
      getPartnerAccessLevelIdsLower: vi.fn().mockResolvedValue(new Set(['partners'])),
      isPartnerYoutubeManualAllowlisted: vi.fn().mockResolvedValue(false),
      getPartnerYoutubePendingApplicationForUser: vi.fn().mockResolvedValue(null),
      insertPartnerYoutubeApplication: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../server/modules/partners/services/model.js', () => modelMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/partners/services/model.js');
  });

  describe('assertUserCanApplyForPartner', () => {
    it('lança ALREADY_PARTNER quando já é parceiro', async () => {
      const { assertUserCanApplyForPartner } = await import('../../../../server/modules/partners/services/apply.js');
      const { HttpControlledError } = await import('../../../../server/shared/errors/http-controlled-error.js');
      await expect(assertUserCanApplyForPartner(1)).rejects.toThrow(HttpControlledError);
      await expect(assertUserCanApplyForPartner(1)).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'ALREADY_PARTNER' }) });
    });

    it('lança PENDING_APPLICATION quando já tem candidatura pendente', async () => {
      modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
      modelMock.getPartnerYoutubePendingApplicationForUser.mockResolvedValue({ id: 'app-1' });
      const { assertUserCanApplyForPartner } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(assertUserCanApplyForPartner(1)).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'PENDING_APPLICATION' }) });
    });

    it('passa quando não é parceiro e não tem pendente', async () => {
      modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
      const { assertUserCanApplyForPartner } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(assertUserCanApplyForPartner(1)).resolves.toBeUndefined();
    });
  });

  describe('runPartnerYoutubeApplicationSubmit', () => {
    beforeEach(() => {
      modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
    });

    it('nome de canal curto: VALIDATION', async () => {
      const { runPartnerYoutubeApplicationSubmit } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(
        runPartnerYoutubeApplicationSubmit({ userId: 1, channelNameRaw: 'a', channelUrlRaw: 'https://youtube.com/@x', avatarUrlRaw: 'https://cdn.x.com/a.png', descriptionRaw: '' })
      ).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'VALIDATION' }) });
    });

    it('URL de canal inválida: INVALID_CHANNEL_URL', async () => {
      const { runPartnerYoutubeApplicationSubmit } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(
        runPartnerYoutubeApplicationSubmit({ userId: 1, channelNameRaw: 'Meu Canal', channelUrlRaw: 'https://vimeo.com/x', avatarUrlRaw: 'https://cdn.x.com/a.png', descriptionRaw: '' })
      ).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'INVALID_CHANNEL_URL' }) });
    });

    it('sem avatar: AVATAR_REQUIRED', async () => {
      const { runPartnerYoutubeApplicationSubmit } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(
        runPartnerYoutubeApplicationSubmit({ userId: 1, channelNameRaw: 'Meu Canal', channelUrlRaw: 'https://youtube.com/@x', avatarUrlRaw: '', descriptionRaw: '' })
      ).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'AVATAR_REQUIRED' }) });
    });

    it('caminho feliz: insere e devolve id', async () => {
      const { runPartnerYoutubeApplicationSubmit } = await import('../../../../server/modules/partners/services/apply.js');
      const out = await runPartnerYoutubeApplicationSubmit({ userId: 1, channelNameRaw: 'Meu Canal', channelUrlRaw: 'https://youtube.com/@x', avatarUrlRaw: 'https://cdn.x.com/a.png', descriptionRaw: 'desc' });
      expect(out.id).toBeDefined();
      expect(modelMock.insertPartnerYoutubeApplication).toHaveBeenCalled();
    });

    it('conflito de índice único (P2002): PENDING_APPLICATION', async () => {
      const { Prisma } = await import('@prisma/client');
      modelMock.insertPartnerYoutubeApplication.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
      const { runPartnerYoutubeApplicationSubmit } = await import('../../../../server/modules/partners/services/apply.js');
      await expect(
        runPartnerYoutubeApplicationSubmit({ userId: 1, channelNameRaw: 'Meu Canal', channelUrlRaw: 'https://youtube.com/@x', avatarUrlRaw: 'https://cdn.x.com/a.png', descriptionRaw: '' })
      ).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'PENDING_APPLICATION' }) });
    });
  });
});
