import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('partners services/profile', () => {
  let modelMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    modelMock = {
      getPartnerAccessLevelIdsLower: vi.fn().mockResolvedValue(new Set(['partners'])),
      isPartnerYoutubeManualAllowlisted: vi.fn().mockResolvedValue(false),
      getPartnerYoutubeCreatorProfile: vi.fn().mockResolvedValue({ channel_name: 'Canal', channel_url: 'https://youtube.com/@x', avatar_url: 'https://cdn.x.com/a.png', description: '' }),
      updatePartnerYoutubeCreatorProfileEditable: vi.fn().mockResolvedValue(undefined),
      userHasNftRoomAccess: vi.fn().mockResolvedValue(true),
      getPartnerLastApprovedVideoAt: vi.fn().mockResolvedValue(null),
      countPartnerApprovedVideosSince: vi.fn().mockResolvedValue(0)
    };
    vi.doMock('../../../../server/modules/partners/services/model.js', () => modelMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/partners/services/model.js');
  });

  describe('assertUserIsPartner / runPartnerYoutubeProfileUpdate', () => {
    it('não-parceiro: NOT_PARTNER', async () => {
      modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
      const { runPartnerYoutubeProfileUpdate } = await import('../../../../server/modules/partners/services/profile.js');
      await expect(runPartnerYoutubeProfileUpdate({ userId: 1, channelNameRaw: 'Novo Nome', avatarUrlRaw: 'https://cdn.x.com/b.png' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'NOT_PARTNER' }) });
    });

    it('perfil inexistente: NOT_FOUND', async () => {
      modelMock.getPartnerYoutubeCreatorProfile.mockResolvedValue(null);
      const { runPartnerYoutubeProfileUpdate } = await import('../../../../server/modules/partners/services/profile.js');
      await expect(runPartnerYoutubeProfileUpdate({ userId: 1, channelNameRaw: 'Novo Nome', avatarUrlRaw: 'https://cdn.x.com/b.png' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'NOT_FOUND' }) });
    });

    it('caminho feliz: atualiza e mantém channelUrl original', async () => {
      const { runPartnerYoutubeProfileUpdate } = await import('../../../../server/modules/partners/services/profile.js');
      const out = await runPartnerYoutubeProfileUpdate({ userId: 1, channelNameRaw: 'Novo Nome', avatarUrlRaw: 'https://cdn.x.com/b.png' });
      expect(out).toEqual({ channelName: 'Novo Nome', avatarUrl: 'https://cdn.x.com/b.png', channelUrl: 'https://youtube.com/@x' });
    });
  });

  describe('buildPartnerNftRoomStatus', () => {
    it('overdue quando ativo mas sem vídeo aprovado nos últimos 60 dias', async () => {
      const { buildPartnerNftRoomStatus } = await import('../../../../server/modules/partners/services/profile.js');
      const out = await buildPartnerNftRoomStatus(1);
      expect(out).toMatchObject({ active: true, overdue: true, compliant: false, requiredIntervalDays: 60 });
    });

    it('compliant quando não está ativo', async () => {
      modelMock.userHasNftRoomAccess.mockResolvedValue(false);
      const { buildPartnerNftRoomStatus } = await import('../../../../server/modules/partners/services/profile.js');
      const out = await buildPartnerNftRoomStatus(1);
      expect(out).toMatchObject({ active: false, compliant: true, overdue: false });
    });
  });
});
