import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('partners services/admin-apply', () => {
  let adminModelMock: Record<string, any>;
  let nftRoomMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    adminModelMock = {
      getPartnerYoutubeApplicationById: vi.fn().mockResolvedValue({
        id: 'app-1',
        user_id: 9,
        channel_name: 'Canal X',
        channel_url: 'https://youtube.com/@x',
        avatar_url: 'https://cdn.x.com/a.png',
        description: 'desc',
        status: 'pending',
        created_at: 100n,
        reviewed_at: null,
        reject_reason: null
      }),
      updatePartnerYoutubeApplicationApprove: vi.fn().mockResolvedValue(1),
      updatePartnerYoutubeApplicationReject: vi.fn().mockResolvedValue(1),
      addPartnerYoutubeManualAllowlist: vi.fn().mockResolvedValue(true),
      ensurePartnerAccessLevel: vi.fn().mockResolvedValue(undefined),
      grantPartnerNftRoomAccess: vi.fn().mockResolvedValue(undefined),
      upsertPartnerYoutubeCreatorProfile: vi.fn().mockResolvedValue(undefined)
    };
    nftRoomMock = { NFT_AUTO_ROOM_ID: 'room_test_nft' };
    vi.doMock('../../../../server/modules/partners/services/admin-model.js', () => adminModelMock);
    vi.doMock('../../../../server/modules/mining-engine/services/nft-room-mining.js', () => nftRoomMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/partners/services/admin-model.js');
    vi.doUnmock('../../../../server/modules/mining-engine/services/nft-room-mining.js');
  });

  describe('runPartnerYoutubeApplicationApprove', () => {
    it('ID vazio: VALIDATION', async () => {
      const { runPartnerYoutubeApplicationApprove } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationApprove({ applicationId: '  ', adminUserId: 1 })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'VALIDATION' })
      });
    });

    it('candidatura inexistente: NOT_FOUND', async () => {
      adminModelMock.getPartnerYoutubeApplicationById.mockResolvedValue(null);
      const { runPartnerYoutubeApplicationApprove } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationApprove({ applicationId: 'app-1', adminUserId: 1 })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'NOT_FOUND' })
      });
    });

    it('candidatura já processada (status != pending): NOT_FOUND', async () => {
      adminModelMock.getPartnerYoutubeApplicationById.mockResolvedValue({ id: 'app-1', user_id: 9, status: 'approved' });
      const { runPartnerYoutubeApplicationApprove } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationApprove({ applicationId: 'app-1', adminUserId: 1 })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'NOT_FOUND' })
      });
    });

    it('update retorna 0 linhas (corrida concorrente): NOT_FOUND', async () => {
      adminModelMock.updatePartnerYoutubeApplicationApprove.mockResolvedValue(0);
      const { runPartnerYoutubeApplicationApprove } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationApprove({ applicationId: 'app-1', adminUserId: 1 })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'NOT_FOUND' })
      });
    });

    it('caminho feliz: concede allowlist, nível e acesso à sala NFT', async () => {
      const { runPartnerYoutubeApplicationApprove } = await import('../../../../server/modules/partners/services/admin-apply.js');
      const result = await runPartnerYoutubeApplicationApprove({ applicationId: 'app-1', adminUserId: 42 });
      expect(result).toEqual({ userId: 9 });
      expect(adminModelMock.addPartnerYoutubeManualAllowlist).toHaveBeenCalledWith(9, 42, expect.any(Number));
      expect(adminModelMock.ensurePartnerAccessLevel).toHaveBeenCalledWith(9);
      expect(adminModelMock.grantPartnerNftRoomAccess).toHaveBeenCalledWith(9, 'room_test_nft');
      expect(adminModelMock.upsertPartnerYoutubeCreatorProfile).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 9, channelName: 'Canal X', channelUrl: 'https://youtube.com/@x' })
      );
    });
  });

  describe('runPartnerYoutubeApplicationReject', () => {
    it('ID vazio: VALIDATION', async () => {
      const { runPartnerYoutubeApplicationReject } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationReject({ applicationId: '', adminUserId: 1, reasonRaw: 'x' })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'VALIDATION' })
      });
    });

    it('não encontrada / já processada: NOT_FOUND', async () => {
      adminModelMock.updatePartnerYoutubeApplicationReject.mockResolvedValue(0);
      const { runPartnerYoutubeApplicationReject } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await expect(runPartnerYoutubeApplicationReject({ applicationId: 'app-1', adminUserId: 1, reasonRaw: 'x' })).rejects.toMatchObject({
        jsonBody: expect.objectContaining({ code: 'NOT_FOUND' })
      });
    });

    it('caminho feliz: trunca motivo e passa null quando ausente', async () => {
      const { runPartnerYoutubeApplicationReject } = await import('../../../../server/modules/partners/services/admin-apply.js');
      await runPartnerYoutubeApplicationReject({ applicationId: 'app-1', adminUserId: 1, reasonRaw: undefined });
      expect(adminModelMock.updatePartnerYoutubeApplicationReject).toHaveBeenCalledWith('app-1', 1, null, expect.any(Number));
    });
  });
});
