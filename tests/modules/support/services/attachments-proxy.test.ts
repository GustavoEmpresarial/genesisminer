import { describe, expect, it } from 'vitest';
import { isSafeSupportStoredFilename, isSupportReplyStoredName, supportStoredFileOwnedByUser } from '../../../../server/modules/support/services/attachments-proxy.js';

describe('modules/support/services/attachments-proxy', () => {
  describe('isSafeSupportStoredFilename', () => {
    it('aceita nomes gerados pelo multer (player e staff)', () => {
      expect(isSafeSupportStoredFilename('support-7-1700000000000-123456789.png')).toBe(true);
      expect(isSafeSupportStoredFilename('support-reply-1-1700000000000-123456789.mp4')).toBe(true);
    });

    it('rejeita path traversal, barras e byte nulo', () => {
      expect(isSafeSupportStoredFilename('../../etc/passwd')).toBe(false);
      expect(isSafeSupportStoredFilename('support-7-1-1/../x.png')).toBe(false);
      expect(isSafeSupportStoredFilename('support-7-1-1\0.png')).toBe(false);
    });

    it('rejeita nomes que não seguem o padrão do multer', () => {
      expect(isSafeSupportStoredFilename('random-file.png')).toBe(false);
      expect(isSafeSupportStoredFilename('')).toBe(false);
    });
  });

  describe('supportStoredFileOwnedByUser', () => {
    it('confirma posse quando o userId no nome bate', () => {
      expect(supportStoredFileOwnedByUser('support-7-1700000000000-123.png', 7)).toBe(true);
    });

    it('nega quando o userId não bate', () => {
      expect(supportStoredFileOwnedByUser('support-7-1700000000000-123.png', 9)).toBe(false);
    });

    it('nega para nomes fora do padrão support-{uid}-…', () => {
      expect(supportStoredFileOwnedByUser('support-reply-1-1700000000000-123.png', 1)).toBe(false);
    });
  });

  describe('isSupportReplyStoredName', () => {
    it('identifica anexos de resposta da equipa', () => {
      expect(isSupportReplyStoredName('support-reply-1-1700000000000-123.png')).toBe(true);
    });

    it('não confunde com anexo do jogador', () => {
      expect(isSupportReplyStoredName('support-7-1700000000000-123.png')).toBe(false);
    });
  });
});
