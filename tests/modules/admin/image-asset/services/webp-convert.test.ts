import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertRasterFileToWebp } from '../../../../../server/modules/admin/image-asset/services/webp-convert.js';

describe('modules/admin/image-asset/services/webp-convert', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'webp-convert-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function writePng(name: string): Promise<string> {
    const abs = path.join(root, name);
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toFile(abs);
    return abs;
  }

  it('ficheiro inexistente: devolve ok=false sem lançar', async () => {
    const result = await convertRasterFileToWebp(path.join(root, 'nao-existe.png'));
    expect(result).toEqual({ ok: false, absPath: path.join(root, 'nao-existe.png'), converted: false, error: 'missing' });
  });

  it('já é .webp: no-op (ok=true, converted=false)', async () => {
    const abs = path.join(root, 'already.webp');
    await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).webp().toFile(abs);
    const result = await convertRasterFileToWebp(abs);
    expect(result).toEqual({ ok: true, absPath: abs, converted: false });
  });

  it('extensão não convertível (ex.: .bmp): devolve ok=false com skip_ext', async () => {
    const abs = path.join(root, 'x.bmp');
    fs.writeFileSync(abs, Buffer.from('not-really-bmp'));
    const result = await convertRasterFileToWebp(abs);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('skip_ext:.bmp');
  });

  it('converte PNG válido para webp e remove o original por default', async () => {
    const abs = await writePng('foo.png');
    const result = await convertRasterFileToWebp(abs);
    expect(result.ok).toBe(true);
    expect(result.converted).toBe(true);
    expect(result.absPath).toBe(path.join(root, 'foo.webp'));
    expect(fs.existsSync(result.absPath)).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('removeOriginal: false mantém o ficheiro original', async () => {
    const abs = await writePng('bar.png');
    const result = await convertRasterFileToWebp(abs, { removeOriginal: false });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.existsSync(result.absPath)).toBe(true);
  });

  it('ficheiro corrompido (bytes inválidos com extensão png): devolve ok=false sem lançar', async () => {
    const abs = path.join(root, 'corrupt.png');
    fs.writeFileSync(abs, Buffer.from('not-a-real-png'));
    const result = await convertRasterFileToWebp(abs);
    expect(result.ok).toBe(false);
    expect(result.converted).toBe(false);
  });
});
