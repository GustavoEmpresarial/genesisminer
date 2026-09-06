import { describe, expect, it } from 'vitest';
import { buildAttachmentsFromFiles, sendSupportMulterError } from '../../../../server/modules/support/services/attachments.js';

describe('modules/support/services/attachments', () => {
  describe('buildAttachmentsFromFiles', () => {
    it('sem ficheiros: lista vazia', () => {
      expect(buildAttachmentsFromFiles(undefined)).toEqual({ list: [] });
      expect(buildAttachmentsFromFiles([])).toEqual({ list: [] });
    });

    it('mapeia ficheiros válidos pra { url, originalName, mime }', () => {
      const files = [
        { filename: 'support-7-1-1.png', originalname: 'print.png', mimetype: 'image/png' },
        { filename: 'support-7-1-2.mp4', originalname: 'video.mp4', mimetype: 'video/mp4' }
      ] as any;
      expect(buildAttachmentsFromFiles(files)).toEqual({
        list: [
          { url: '/img/support-7-1-1.png', originalName: 'print.png', mime: 'image/png' },
          { url: '/img/support-7-1-2.mp4', originalName: 'video.mp4', mime: 'video/mp4' }
        ]
      });
    });

    it('ignora ficheiro com extensão fora da allowlist', () => {
      const files = [{ filename: 'support-7-1-1.exe', originalname: 'x.exe', mimetype: 'application/x-msdownload' }] as any;
      expect(buildAttachmentsFromFiles(files)).toEqual({ list: [] });
    });

    it('trunca originalName/mime muito longos', () => {
      const files = [{ filename: 'support-7-1-1.png', originalname: 'a'.repeat(300), mimetype: 'b'.repeat(200) }] as any;
      const { list } = buildAttachmentsFromFiles(files);
      expect(list[0]!.originalName.length).toBe(200);
      expect(list[0]!.mime.length).toBe(120);
    });
  });

  describe('sendSupportMulterError', () => {
    function fakeRes() {
      const res: any = { statusCode: 0, body: undefined, status(n: number) { res.statusCode = n; return res; }, json(b: unknown) { res.body = b; return res; } };
      return res;
    }

    it('LIMIT_FILE_SIZE: 413 PAYLOAD_TOO_LARGE', () => {
      const res = fakeRes();
      sendSupportMulterError(res, { code: 'LIMIT_FILE_SIZE' });
      expect(res.statusCode).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('LIMIT_PART_COUNT: 413 PAYLOAD_TOO_LARGE', () => {
      const res = fakeRes();
      sendSupportMulterError(res, { code: 'LIMIT_PART_COUNT' });
      expect(res.statusCode).toBe(413);
    });

    it('erro genérico: 400 UPLOAD com a mensagem do Error', () => {
      const res = fakeRes();
      sendSupportMulterError(res, new Error('File type not allowed'));
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'File type not allowed', code: 'UPLOAD' });
    });

    it('erro não-Error: 400 UPLOAD com mensagem default', () => {
      const res = fakeRes();
      sendSupportMulterError(res, 'boom');
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Upload error', code: 'UPLOAD' });
    });
  });
});
