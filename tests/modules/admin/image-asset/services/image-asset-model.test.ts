import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStoredUploadFilename,
  classifyImageSubfolder,
  organizeLooseFilesInImgRoot,
  reclassifyFilesInDirectory,
  resolveLegacyFlatImgFilePath,
  sanitizeOriginalNameBase
} from '../../../../../server/modules/admin/image-asset/services/image-asset-model.js';

describe('admin/image-asset services/image-asset-model', () => {
  describe('classifyImageSubfolder', () => {
    it('classifica por prefixo/palavra-chave conhecida (pastas EN)', () => {
      expect(classifyImageSubfolder('ad-123.png')).toBe('uploads');
      expect(classifyImageSubfolder('support-abc.png')).toBe('support');
      expect(classifyImageSubfolder('genesis-miner-logo.png')).toBe('favicon');
      expect(classifyImageSubfolder('favicon.ico')).toBe('favicon');
      expect(classifyImageSubfolder('carregador_v2.png')).toBe('charger');
      expect(classifyImageSubfolder('bateria_1000wh.png')).toBe('battery');
      expect(classifyImageSubfolder('usdc_coin.png')).toBe('coin');
      expect(classifyImageSubfolder('RackPreto.png')).toBe('rack');
      expect(classifyImageSubfolder('TurboFan.gif')).toBe('fan');
      expect(classifyImageSubfolder('ai_opt_v7.png')).toBe('chip');
      expect(classifyImageSubfolder('blockminer.webp')).toBe('partner');
    });

    it('gpu com "battery" no nome não vira battery (exclusão explícita)', () => {
      expect(classifyImageSubfolder('gpu_battery_pack.png')).not.toBe('battery');
    });

    it('sem correspondência: cai em miner (default)', () => {
      expect(classifyImageSubfolder('random_asset.png')).toBe('miner');
    });
  });

  describe('sanitizeOriginalNameBase', () => {
    it('remove caracteres não alfanuméricos e trunca em 32', () => {
      expect(sanitizeOriginalNameBase('my file (final)!!.png')).toBe('myfilefinalpng');
      expect(sanitizeOriginalNameBase('a'.repeat(50))).toHaveLength(32);
    });

    it('nome vazio/objeto cai no fallback "image"', () => {
      expect(sanitizeOriginalNameBase(null)).toBe('image');
      expect(sanitizeOriginalNameBase({})).toBe('image');
      expect(sanitizeOriginalNameBase('!!!')).toBe('image');
    });
  });

  describe('buildStoredUploadFilename', () => {
    it('monta <timestamp>_<random>_<base><ext>', () => {
      const name = buildStoredUploadFilename('foo', '.png');
      expect(name).toMatch(/^\d+_[a-z0-9]+_foo\.png$/);
    });
  });

  describe('organizeLooseFilesInImgRoot / resolveLegacyFlatImgFilePath (filesystem real, tmp dir)', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'img-asset-test-'));
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('move ficheiros soltos da raiz pra subpasta classificada', () => {
      fs.writeFileSync(path.join(root, 'carregador_v2.png'), 'x');
      fs.writeFileSync(path.join(root, '.hidden.png'), 'x');
      const moved = organizeLooseFilesInImgRoot(root);
      expect(moved).toBe(1);
      expect(fs.existsSync(path.join(root, 'charger', 'carregador_v2.png'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.hidden.png'))).toBe(true);
    });

    it('ignora extensões não movíveis', () => {
      fs.writeFileSync(path.join(root, 'readme.txt'), 'x');
      const moved = organizeLooseFilesInImgRoot(root);
      expect(moved).toBe(0);
      expect(fs.existsSync(path.join(root, 'readme.txt'))).toBe(true);
    });

    it('resolveLegacyFlatImgFilePath acha o ficheiro em uploads/ ou nas subpastas canónicas', () => {
      const uploadsDir = path.join(root, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, 'foo.png'), 'x');
      const hit = resolveLegacyFlatImgFilePath(uploadsDir, root, 'foo.png');
      expect(hit).toBe(path.resolve(uploadsDir, 'foo.png'));
    });

    it('resolveLegacyFlatImgFilePath cai pro sibling .webp se o original não existir', () => {
      const uploadsDir = path.join(root, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(path.join(uploadsDir, 'foo.webp'), 'x');
      const hit = resolveLegacyFlatImgFilePath(uploadsDir, root, 'foo.png');
      expect(hit).toBe(path.resolve(uploadsDir, 'foo.webp'));
    });

    it('rejeita segmentos com path traversal ou extensão não suportada', () => {
      expect(resolveLegacyFlatImgFilePath(root, root, '../etc/passwd')).toBeNull();
      expect(resolveLegacyFlatImgFilePath(root, root, 'foo.exe')).toBeNull();
    });

    it('sem correspondência em nenhuma subpasta: devolve null', () => {
      expect(resolveLegacyFlatImgFilePath(path.join(root, 'uploads'), root, 'nao-existe.png')).toBeNull();
    });
  });

  describe('reclassifyFilesInDirectory', () => {
    let catalog: string;
    let uploads: string;

    beforeEach(() => {
      catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'img-catalog-'));
      uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'img-uploads-'));
      fs.symlinkSync(uploads, path.join(catalog, 'uploads'));
    });

    afterEach(() => {
      fs.rmSync(catalog, { recursive: true, force: true });
      fs.rmSync(uploads, { recursive: true, force: true });
    });

    it('não move support-* de uploads/ para media-seed/support (runtime ≠ catálogo)', () => {
      const name = 'support-7-1-1.webp';
      fs.writeFileSync(path.join(uploads, name), 'x');
      expect(reclassifyFilesInDirectory(uploads, catalog)).toBe(0);
      expect(reclassifyFilesInDirectory(path.join(catalog, 'uploads'), catalog)).toBe(0);
      expect(fs.existsSync(path.join(uploads, name))).toBe(true);
      expect(fs.existsSync(path.join(catalog, 'support', name))).toBe(false);
    });

    it('não move nenhum ficheiro de uploads/ para o catálogo (incl. nomes de seed)', () => {
      fs.writeFileSync(path.join(uploads, 'ad-1.webp'), 'x');
      fs.writeFileSync(path.join(uploads, 'RackPreto.png'), 'x');
      const moved = reclassifyFilesInDirectory(uploads, catalog);
      expect(moved).toBe(0);
      expect(fs.existsSync(path.join(uploads, 'ad-1.webp'))).toBe(true);
      expect(fs.existsSync(path.join(uploads, 'RackPreto.png'))).toBe(true);
      expect(fs.existsSync(path.join(catalog, 'rack', 'RackPreto.png'))).toBe(false);
    });

    it('não reclassifica uploads/ mesmo sem symlink media-seed/uploads', () => {
      const catalogNoLink = fs.mkdtempSync(path.join(os.tmpdir(), 'img-catalog-nolink-'));
      try {
        const name = 'support-reply-1-1-1.webp';
        fs.writeFileSync(path.join(uploads, name), 'x');
        expect(reclassifyFilesInDirectory(uploads, catalogNoLink)).toBe(0);
        expect(fs.existsSync(path.join(uploads, name))).toBe(true);
        expect(fs.existsSync(path.join(catalogNoLink, 'support', name))).toBe(false);
      } finally {
        fs.rmSync(catalogNoLink, { recursive: true, force: true });
      }
    });

    it('ainda reclassifica dentro do catálogo (miner/ → charger/)', () => {
      const miner = path.join(catalog, 'miner');
      fs.mkdirSync(miner, { recursive: true });
      fs.writeFileSync(path.join(miner, 'carregador_v2.png'), 'x');
      const moved = reclassifyFilesInDirectory(miner, catalog);
      expect(moved).toBe(1);
      expect(fs.existsSync(path.join(catalog, 'charger', 'carregador_v2.png'))).toBe(true);
      expect(fs.existsSync(path.join(miner, 'carregador_v2.png'))).toBe(false);
    });
  });
});
