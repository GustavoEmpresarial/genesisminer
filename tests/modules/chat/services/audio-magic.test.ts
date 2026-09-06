import { describe, expect, it } from 'vitest';
import { looksLikeAudioMagic, resolveAudioExt } from '../../../../server/modules/chat/services/audio-magic.js';

describe('modules/chat/services/audio-magic', () => {
  describe('resolveAudioExt', () => {
    it('resolve por mimetype conhecido', () => {
      expect(resolveAudioExt('blob', 'audio/webm')).toBe('.webm');
      expect(resolveAudioExt('blob', 'audio/mpeg')).toBe('.mp3');
      expect(resolveAudioExt('blob', 'audio/mp4')).toBe('.m4a');
      expect(resolveAudioExt('blob', 'audio/wav;codecs=1')).toBe('.wav');
    });

    it('cai pra extensão do nome original quando o mimetype é desconhecido', () => {
      expect(resolveAudioExt('gravacao.ogg', 'application/octet-stream')).toBe('.ogg');
      expect(resolveAudioExt('gravacao.mp4', 'application/octet-stream')).toBe('.m4a');
    });

    it('rejeita formatos não suportados', () => {
      expect(resolveAudioExt('malware.exe', 'application/x-msdownload')).toBeNull();
      expect(resolveAudioExt('', '')).toBeNull();
    });
  });

  describe('looksLikeAudioMagic', () => {
    it('aceita RIFF/WAVE', () => {
      expect(looksLikeAudioMagic(Buffer.from('RIFF\0\0\0\0WAVEfmt \0\0\0\0'))).toBe(true);
    });

    it('aceita ID3 (MP3 com tag)', () => {
      expect(looksLikeAudioMagic(Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    });

    it('aceita frame sync MPEG puro', () => {
      expect(looksLikeAudioMagic(Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    });

    it('aceita OggS', () => {
      expect(looksLikeAudioMagic(Buffer.from('OggS' + '\0'.repeat(8)))).toBe(true);
    });

    it('aceita ftyp (mp4/m4a)', () => {
      const buf = Buffer.alloc(12);
      buf.write('ftyp', 4, 'ascii');
      expect(looksLikeAudioMagic(buf)).toBe(true);
    });

    it('aceita EBML (webm)', () => {
      expect(looksLikeAudioMagic(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    });

    it('rejeita bytes que não batem com nenhuma assinatura', () => {
      expect(looksLikeAudioMagic(Buffer.from('not-audio-at-all-just-text'))).toBe(false);
    });

    it('rejeita buffer curto demais', () => {
      expect(looksLikeAudioMagic(Buffer.from('short'))).toBe(false);
    });
  });
});
