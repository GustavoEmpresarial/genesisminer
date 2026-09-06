import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertImageFileMagicBytes } from '../../../../../server/modules/admin/image-asset/services/magic-bytes.js';

describe('modules/admin/image-asset/services/magic-bytes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-bytes-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(name: string, bytes: number[] | Buffer): string {
    const abs = path.join(root, name);
    fs.writeFileSync(abs, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return abs;
  }

  it('PNG válido: aceita', () => {
    const abs = write('x.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(assertImageFileMagicBytes(abs, '.png')).toBe(true);
  });

  it('JPEG válido: aceita para .jpg e .jpeg', () => {
    const abs = write('x.jpg', [0xff, 0xd8, 0xff, 0xe0]);
    expect(assertImageFileMagicBytes(abs, '.jpg')).toBe(true);
    expect(assertImageFileMagicBytes(abs, '.jpeg')).toBe(true);
  });

  it('GIF87a e GIF89a: ambas aceites', () => {
    const a = write('a.gif', Buffer.from('GIF87a-resto'));
    const b = write('b.gif', Buffer.from('GIF89a-resto'));
    expect(assertImageFileMagicBytes(a, '.gif')).toBe(true);
    expect(assertImageFileMagicBytes(b, '.gif')).toBe(true);
  });

  it('bytes não correspondem à extensão declarada: rejeita', () => {
    const abs = write('fake.png', Buffer.from('not-a-real-png-header'));
    expect(assertImageFileMagicBytes(abs, '.png')).toBe(false);
  });

  it('extensão desconhecida: rejeita sempre', () => {
    const abs = write('x.bmp', [0x89, 0x50, 0x4e, 0x47]);
    expect(assertImageFileMagicBytes(abs, '.bmp')).toBe(false);
  });

  it('ficheiro inexistente: rejeita sem lançar', () => {
    expect(assertImageFileMagicBytes(path.join(root, 'nao-existe.png'), '.png')).toBe(false);
  });
});
