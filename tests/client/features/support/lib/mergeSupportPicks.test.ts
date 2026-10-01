import { describe, expect, it } from 'vitest';
import { mergeSupportPicks } from '../../../../../client/src/features/support/lib/mergeSupportPicks.js';
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_COUNT,
  SUPPORT_ATTACHMENT_MIN_BYTES
} from '../../../../../client/src/shared/constants/formLimits.js';

function fileOf(name: string, size: number): File {
  const body = size > 0 ? new Uint8Array(size) : new Uint8Array(0);
  return new File([body], name, { type: 'application/octet-stream' });
}

function asFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (const f of files) yield f;
    }
  } as FileList;
  files.forEach((f, i) => {
    Object.defineProperty(list, i, { value: f, enumerable: true });
  });
  return list;
}

describe('mergeSupportPicks', () => {
  const tooLarge = (name: string, mb: number) => `large:${name}:${mb}`;
  const tooMany = (max: number) => `many:${max}`;
  const typeNotAllowed = (name: string) => `type:${name}`;
  const tooSmall = (name: string) => `small:${name}`;

  it('accepts a valid png at or above min bytes', () => {
    const png = fileOf('shot.png', SUPPORT_ATTACHMENT_MIN_BYTES);
    const { next, rejectReason } = mergeSupportPicks(
      [],
      asFileList([png]),
      SUPPORT_ATTACHMENT_MAX_COUNT,
      SUPPORT_ATTACHMENT_MAX_BYTES,
      SUPPORT_ATTACHMENT_MIN_BYTES,
      tooLarge,
      tooMany,
      typeNotAllowed,
      tooSmall
    );
    expect(rejectReason).toBeNull();
    expect(next).toHaveLength(1);
    expect(next[0]?.name).toBe('shot.png');
  });

  it('rejects HEIC extension', () => {
    const heic = fileOf('photo.heic', SUPPORT_ATTACHMENT_MIN_BYTES);
    const { next, rejectReason } = mergeSupportPicks(
      [],
      asFileList([heic]),
      SUPPORT_ATTACHMENT_MAX_COUNT,
      SUPPORT_ATTACHMENT_MAX_BYTES,
      SUPPORT_ATTACHMENT_MIN_BYTES,
      tooLarge,
      tooMany,
      typeNotAllowed,
      tooSmall
    );
    expect(next).toHaveLength(0);
    expect(rejectReason).toBe('type:photo.heic');
  });

  it('rejects tiny / empty files under min bytes', () => {
    const tinyJpgBytes = 4;
    const tiny = fileOf('empty.jpg', tinyJpgBytes);
    const { next, rejectReason } = mergeSupportPicks(
      [],
      asFileList([tiny]),
      SUPPORT_ATTACHMENT_MAX_COUNT,
      SUPPORT_ATTACHMENT_MAX_BYTES,
      SUPPORT_ATTACHMENT_MIN_BYTES,
      tooLarge,
      tooMany,
      typeNotAllowed,
      tooSmall
    );
    expect(next).toHaveLength(0);
    expect(rejectReason).toBe('small:empty.jpg');
  });
});
