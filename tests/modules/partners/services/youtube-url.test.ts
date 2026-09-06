import { describe, expect, it } from 'vitest';
import { validateAndCanonicalYoutubeUrl, youtubeEmbedUrl, youtubeThumbnailUrl } from '../../../../server/modules/partners/services/youtube-url.js';

describe('partners services/youtube-url', () => {
  describe('validateAndCanonicalYoutubeUrl', () => {
    it('canonicaliza uma URL válida de watch', () => {
      const out = validateAndCanonicalYoutubeUrl('https://www.youtube.com/watch?v=abcdefghijk&t=10s');
      expect(out).toEqual({ videoId: 'abcdefghijk', canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk' });
    });

    it('rejeita host fora do YouTube', () => {
      expect(validateAndCanonicalYoutubeUrl('https://vimeo.com/123')).toBeNull();
    });

    it('rejeita esquemas perigosos e bytes de controlo', () => {
      expect(validateAndCanonicalYoutubeUrl('javascript:alert(1)')).toBeNull();
      expect(validateAndCanonicalYoutubeUrl('https://youtube.com/watch?v=x\x01x')).toBeNull();
    });

    it('rejeita string vazia ou longa demais', () => {
      expect(validateAndCanonicalYoutubeUrl('')).toBeNull();
      expect(validateAndCanonicalYoutubeUrl('https://youtube.com/watch?v=' + 'a'.repeat(500))).toBeNull();
    });
  });

  describe('youtubeThumbnailUrl / youtubeEmbedUrl', () => {
    it('gera URLs só para IDs de 11 chars válidos', () => {
      expect(youtubeThumbnailUrl('abcdefghijk')).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
      expect(youtubeEmbedUrl('abcdefghijk')).toBe('https://www.youtube.com/embed/abcdefghijk');
    });

    it('devolve vazio para ID inválido', () => {
      expect(youtubeThumbnailUrl('short')).toBe('');
      expect(youtubeEmbedUrl('')).toBe('');
    });
  });
});
