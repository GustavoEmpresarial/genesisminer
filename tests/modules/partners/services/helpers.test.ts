import { describe, expect, it } from 'vitest';
import {
  encodePartnerYoutubeVideoCursor,
  extractYoutubeVideoId,
  parsePartnerYoutubeVideoCursor,
  partnerYoutubeUtcDayKeyYYYYMMDD,
  sanitizePartnerChannelDescription,
  sanitizePartnerChannelName,
  sanitizePartnerCreatorAvatarUrl,
  sanitizePartnerCreatorChannelUrl,
  userAccessSetHasPartnerLevel
} from '../../../../server/modules/partners/services/helpers.js';

describe('partners services/helpers', () => {
  describe('partnerYoutubeUtcDayKeyYYYYMMDD', () => {
    it('formata como inteiro YYYYMMDD em UTC', () => {
      expect(partnerYoutubeUtcDayKeyYYYYMMDD(Date.UTC(2026, 0, 5))).toBe(20260105);
    });
  });

  describe('extractYoutubeVideoId', () => {
    it('extrai de watch, youtu.be, embed e shorts', () => {
      expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=abcdefghijk')).toBe('abcdefghijk');
      expect(extractYoutubeVideoId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
      expect(extractYoutubeVideoId('https://youtube.com/embed/abcdefghijk')).toBe('abcdefghijk');
      expect(extractYoutubeVideoId('https://youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk');
    });

    it('devolve vazio para host não-YouTube ou URL inválida', () => {
      expect(extractYoutubeVideoId('https://vimeo.com/12345')).toBe('');
      expect(extractYoutubeVideoId('not a url')).toBe('');
    });
  });

  describe('userAccessSetHasPartnerLevel', () => {
    it('true para qualquer variante pt/en do nível de parceiro', () => {
      expect(userAccessSetHasPartnerLevel(new Set(['Partners']))).toBe(true);
      expect(userAccessSetHasPartnerLevel(new Set(['parceiro']))).toBe(true);
    });

    it('false quando não há nível de parceiro', () => {
      expect(userAccessSetHasPartnerLevel(new Set(['founder']))).toBe(false);
    });
  });

  describe('cursor', () => {
    it('encode/decode roundtrip', () => {
      const encoded = encodePartnerYoutubeVideoCursor(1000, 'video-id-1');
      expect(parsePartnerYoutubeVideoCursor(encoded)).toEqual({ sortTs: 1000n, id: 'video-id-1' });
    });

    it('rejeita formatos inválidos', () => {
      expect(parsePartnerYoutubeVideoCursor('sem-underscore')).toBeNull();
      expect(parsePartnerYoutubeVideoCursor('abc_shortid')).toBeNull();
      expect(parsePartnerYoutubeVideoCursor(undefined)).toBeNull();
    });
  });

  describe('sanitizePartnerCreatorChannelUrl', () => {
    it('aceita URL de canal https válida', () => {
      expect(sanitizePartnerCreatorChannelUrl('https://youtube.com/@meucanal')).toBe('https://youtube.com/@meucanal');
    });

    it('rejeita links de vídeo (watch/shorts/embed) e domínios fora do YouTube', () => {
      expect(sanitizePartnerCreatorChannelUrl('https://youtube.com/watch?v=x')).toBe('');
      expect(sanitizePartnerCreatorChannelUrl('https://youtu.be/x')).toBe('');
      expect(sanitizePartnerCreatorChannelUrl('https://vimeo.com/x')).toBe('');
    });
  });

  describe('sanitizePartnerCreatorAvatarUrl', () => {
    it('aceita https absoluto ou caminho relativo seguro', () => {
      expect(sanitizePartnerCreatorAvatarUrl('https://cdn.x.com/a.png')).toBe('https://cdn.x.com/a.png');
      expect(sanitizePartnerCreatorAvatarUrl('/img/a.png')).toBe('/img/a.png');
    });

    it('rejeita vazio, esquema não-https ou path com ..', () => {
      expect(sanitizePartnerCreatorAvatarUrl('')).toBe('');
      expect(sanitizePartnerCreatorAvatarUrl('javascript:alert(1)')).toBe('');
      expect(sanitizePartnerCreatorAvatarUrl('/img/../../etc/passwd')).toBe('');
    });
  });

  describe('sanitizePartnerChannelName / sanitizePartnerChannelDescription', () => {
    it('colapsa espaços e trunca', () => {
      expect(sanitizePartnerChannelName('  meu   canal  ')).toBe('meu canal');
      expect(sanitizePartnerChannelDescription('a'.repeat(900)).length).toBe(800);
    });
  });
});
