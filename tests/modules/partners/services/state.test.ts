import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APPROVED_ROW = {
  id: 'sub-1',
  title: 'Video Legal',
  youtube_url: 'https://www.youtube.com/watch?v=abcdefghijk',
  youtube_video_id: 'abcdefghijk',
  description: 'desc',
  created_at: 1000n,
  reviewed_at: 2000n,
  user_id: 7,
  username: 'jogador',
  partner_display_name: 'Canal Legal',
  partner_channel_url: 'https://youtube.com/@x',
  partner_avatar_url: 'https://cdn.x.com/a.png'
};

describe('partners services/state', () => {
  let modelMock: Record<string, any>;
  let profileMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    modelMock = {
      listPartnerYoutubeApprovedPublicCursor: vi.fn().mockResolvedValue([APPROVED_ROW]),
      getPartnerYoutubeApprovedByPublicId: vi.fn().mockResolvedValue(APPROVED_ROW),
      getPartnerAccessLevelIdsLower: vi.fn().mockResolvedValue(new Set(['partners'])),
      isPartnerYoutubeManualAllowlisted: vi.fn().mockResolvedValue(false),
      countPartnerSubmissionsForUserUtcDay: vi.fn().mockResolvedValue(0),
      listPartnerYoutubeByUser: vi.fn().mockResolvedValue([]),
      getPartnerYoutubeApplicationForUser: vi.fn().mockResolvedValue(null),
      getPartnerYoutubeCreatorProfile: vi.fn().mockResolvedValue(null)
    };
    profileMock = { buildPartnerNftRoomStatus: vi.fn().mockResolvedValue({ active: true, compliant: true, overdue: false, requiredIntervalDays: 60, lastApprovedAt: null, nextDeadlineAt: null, approvedLast60d: 1 }) };
    vi.doMock('../../../../server/modules/partners/services/model.js', () => modelMock);
    vi.doMock('../../../../server/modules/partners/services/profile.js', () => profileMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/partners/services/model.js');
    vi.doUnmock('../../../../server/modules/partners/services/profile.js');
  });

  describe('buildPartnersStatePayload', () => {
    it('sem userId: só showcase público, auth.authenticated=false', async () => {
      const { buildPartnersStatePayload } = await import('../../../../server/modules/partners/services/state.js');
      const out = await buildPartnersStatePayload({ optionalUserId: null, query: {} });
      expect(out.auth).toEqual({ authenticated: false });
      const showcase = out.showcase as any;
      expect(showcase.videos[0]).toMatchObject({ publicId: 'sub-1', youtubeVideoId: 'abcdefghijk', creator: { displayName: 'Canal Legal' } });
    });

    it('com userId: monta auth com isPartner/canSubmitToday e mySubmissions', async () => {
      const { buildPartnersStatePayload } = await import('../../../../server/modules/partners/services/state.js');
      const out = await buildPartnersStatePayload({ optionalUserId: 7, query: {} });
      expect(out.auth).toMatchObject({ authenticated: true, isPartner: true, canSubmitToday: true, submissionsToday: 0 });
      expect(out.nftRoom).toMatchObject({ active: true });
    });

    it('não-parceiro sem candidatura: canApply=true', async () => {
      modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
      const { buildPartnersStatePayload } = await import('../../../../server/modules/partners/services/state.js');
      const out = await buildPartnersStatePayload({ optionalUserId: 7, query: {} });
      expect((out.auth as any).canApply).toBe(true);
      expect(out.nftRoom).toBeNull();
    });
  });

  describe('getApprovedPartnerVideoByPublicId', () => {
    it('id vazio devolve null sem consultar', async () => {
      const { getApprovedPartnerVideoByPublicId } = await import('../../../../server/modules/partners/services/state.js');
      expect(await getApprovedPartnerVideoByPublicId('')).toBeNull();
      expect(modelMock.getPartnerYoutubeApprovedByPublicId).not.toHaveBeenCalled();
    });

    it('encontrado: mapeia para o DTO público', async () => {
      const { getApprovedPartnerVideoByPublicId } = await import('../../../../server/modules/partners/services/state.js');
      const out = await getApprovedPartnerVideoByPublicId('sub-1');
      expect(out).toMatchObject({ publicId: 'sub-1', embedUrl: 'https://www.youtube.com/embed/abcdefghijk' });
    });
  });
});
