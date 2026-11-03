import { describe, expect, it } from 'vitest';
import { SUPPORT_ATTACHMENT_MIN_BYTES } from '../../../../../client/src/shared/constants/formLimits.js';
import {
  decideSupportAttachment,
  prepareSupportAttachment
} from '../../../../../client/src/features/support/lib/prepareSupportAttachment.js';

function fileOf(name: string, type: string, size = SUPPORT_ATTACHMENT_MIN_BYTES): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('decideSupportAttachment', () => {
  it('keeps a png', () => {
    expect(decideSupportAttachment('shot.png', 'application/octet-stream')).toEqual({ kind: 'keep' });
  });

  it('transcodes a heic filename', () => {
    expect(decideSupportAttachment('photo.heic', '')).toEqual({ kind: 'transcode' });
  });

  it('renames an extensionless jpeg', () => {
    expect(decideSupportAttachment('blob', 'image/jpeg')).toEqual({ kind: 'rename', ext: '.jpg' });
  });

  it('rejects pdf', () => {
    expect(decideSupportAttachment('notes.pdf', 'application/pdf')).toEqual({ kind: 'reject' });
  });

  it('transcodes heic mime even when the name is jpg', () => {
    expect(decideSupportAttachment('photo.jpg', 'image/heic')).toEqual({ kind: 'transcode' });
  });
});

describe('prepareSupportAttachment', () => {
  it('renames blob jpeg to blob.jpg without transcoding', async () => {
    const result = await prepareSupportAttachment(fileOf('blob', 'image/jpeg'), async () => {
      throw new Error('should not transcode');
    });
    expect('file' in result).toBe(true);
    if ('file' in result) {
      expect(result.file.name).toBe('blob.jpg');
      expect(result.file.type).toBe('image/jpeg');
    }
  });

  it('returns the transcoder file for heic', async () => {
    const jpeg = fileOf('photo.jpg', 'image/jpeg');
    const result = await prepareSupportAttachment(fileOf('photo.heic', 'image/heic'), async () => jpeg);
    expect(result).toEqual({ file: jpeg });
  });

  it('reports an unreadable heic when transcode fails', async () => {
    const result = await prepareSupportAttachment(fileOf('photo.heic', 'image/heic'), async () => null);
    expect(result).toEqual({ error: 'unreadable', name: 'photo.heic' });
  });

  it('rejects pdf', async () => {
    const result = await prepareSupportAttachment(fileOf('notes.pdf', 'application/pdf'), async () => null);
    expect(result).toEqual({ error: 'type', name: 'notes.pdf' });
  });
});
