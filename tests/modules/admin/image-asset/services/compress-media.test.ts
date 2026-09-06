import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compressMediaFileInPlace } from '../../../../../server/modules/admin/image-asset/services/compress-media.js';

describe('modules/admin/image-asset/services/compress-media', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-media-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ficheiro inexistente: no-op, não lança', async () => {
    await expect(compressMediaFileInPlace(path.join(root, 'nao-existe.png'))).resolves.toBeUndefined();
  });

  it('extensão sem tratamento (ex.: .txt): no-op, não lança', async () => {
    const abs = path.join(root, 'x.txt');
    fs.writeFileSync(abs, 'hello');
    await compressMediaFileInPlace(abs);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello');
  });

  it('PNG válido: recomprime in-place sem trocar de extensão', async () => {
    const abs = path.join(root, 'x.png');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png({ compressionLevel: 0 }).toFile(abs);
    const before = fs.statSync(abs).size;
    await compressMediaFileInPlace(abs);
    expect(fs.existsSync(abs)).toBe(true);
    const meta = await sharp(fs.readFileSync(abs)).metadata();
    expect(meta.format).toBe('png');
    expect(fs.statSync(abs).size).toBeLessThanOrEqual(before);
  });

  it('ficheiro corrompido com extensão de imagem: best-effort, não lança e mantém o ficheiro', async () => {
    const abs = path.join(root, 'corrupt.png');
    fs.writeFileSync(abs, Buffer.from('not-a-real-png'));
    await expect(compressMediaFileInPlace(abs)).resolves.toBeUndefined();
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('GIF: tenta recompressão via ffmpeg sem lançar (best-effort, mesmo se o binário faltar)', async () => {
    const abs = path.join(root, 'x.gif');
    // GIF89a mínimo válido (1x1, transparente) — suficiente pro ffmpeg processar.
    const gif1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');
    fs.writeFileSync(abs, gif1x1);
    await expect(compressMediaFileInPlace(abs)).resolves.toBeUndefined();
  });
});
