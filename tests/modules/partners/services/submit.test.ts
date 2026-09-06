import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('partners services/submit', () => {
  let modelMock: Record<string, any>;

  beforeEach(() => {
    vi.resetModules();
    modelMock = {
      getPartnerAccessLevelIdsLower: vi.fn().mockResolvedValue(new Set(['partners'])),
      isPartnerYoutubeManualAllowlisted: vi.fn().mockResolvedValue(false),
      countPartnerYoutubeActiveDuplicateVideo: vi.fn().mockResolvedValue(0),
      insertPartnerYoutubeSubmission: vi.fn().mockResolvedValue(undefined)
    };
    vi.doMock('../../../../server/modules/partners/services/model.js', () => modelMock);
  });

  afterEach(() => {
    vi.doUnmock('../../../../server/modules/partners/services/model.js');
  });

  it('título curto: VALIDATION', async () => {
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    await expect(runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'ab', youtubeUrlRaw: 'https://youtube.com/watch?v=abcdefghijk', descriptionRaw: '' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'VALIDATION' }) });
  });

  it('URL inválida: INVALID_URL', async () => {
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    await expect(runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'Titulo valido', youtubeUrlRaw: 'https://vimeo.com/x', descriptionRaw: '' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'INVALID_URL' }) });
  });

  it('sem nível de parceiro: NOT_PARTNER', async () => {
    modelMock.getPartnerAccessLevelIdsLower.mockResolvedValue(new Set());
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    await expect(runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'Titulo valido', youtubeUrlRaw: 'https://youtube.com/watch?v=abcdefghijk', descriptionRaw: '' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'NOT_PARTNER' }) });
  });

  it('vídeo duplicado na fila/vitrine: DUPLICATE_VIDEO', async () => {
    modelMock.countPartnerYoutubeActiveDuplicateVideo.mockResolvedValue(1);
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    await expect(runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'Titulo valido', youtubeUrlRaw: 'https://youtube.com/watch?v=abcdefghijk', descriptionRaw: '' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'DUPLICATE_VIDEO' }) });
  });

  it('caminho feliz: insere e devolve id', async () => {
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    const out = await runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'Titulo valido', youtubeUrlRaw: 'https://youtube.com/watch?v=abcdefghijk', descriptionRaw: 'd' });
    expect(out.id).toBeDefined();
    expect(modelMock.insertPartnerYoutubeSubmission).toHaveBeenCalledWith(expect.objectContaining({ youtubeVideoId: 'abcdefghijk' }));
  });

  it('conflito de limite diário (P2002): DAILY_LIMIT_OR_CONFLICT', async () => {
    const { Prisma } = await import('@prisma/client');
    modelMock.insertPartnerYoutubeSubmission.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    const { runPartnerYoutubeSubmitVideo } = await import('../../../../server/modules/partners/services/submit.js');
    await expect(runPartnerYoutubeSubmitVideo({ userId: 1, titleRaw: 'Titulo valido', youtubeUrlRaw: 'https://youtube.com/watch?v=abcdefghijk', descriptionRaw: '' })).rejects.toMatchObject({ jsonBody: expect.objectContaining({ code: 'DAILY_LIMIT_OR_CONFLICT' }) });
  });
});
