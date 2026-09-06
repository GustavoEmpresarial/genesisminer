import { describe, expect, it } from 'vitest';
import { isConvertibleRasterExt, publicPathToWebp, webpSiblingPath } from '../../../../../server/modules/admin/image-asset/services/webp-paths.js';

describe('admin/image-asset services/webp-paths', () => {
  describe('isConvertibleRasterExt', () => {
    it('aceita png/jpg/jpeg/gif, é case-insensitive', () => {
      expect(isConvertibleRasterExt('.png')).toBe(true);
      expect(isConvertibleRasterExt('.PNG')).toBe(true);
      expect(isConvertibleRasterExt('.jpg')).toBe(true);
      expect(isConvertibleRasterExt('.jpeg')).toBe(true);
      expect(isConvertibleRasterExt('.gif')).toBe(true);
    });

    it('rejeita webp (já convertido) e outras extensões', () => {
      expect(isConvertibleRasterExt('.webp')).toBe(false);
      expect(isConvertibleRasterExt('.svg')).toBe(false);
      expect(isConvertibleRasterExt('')).toBe(false);
    });
  });

  describe('webpSiblingPath', () => {
    it('troca a extensão pra .webp mantendo o resto do caminho', () => {
      expect(webpSiblingPath('/img/miner/foo.png')).toBe('/img/miner/foo.webp');
    });
  });

  describe('publicPathToWebp', () => {
    it('troca png/jpg/jpeg/gif por webp, preserva query string', () => {
      expect(publicPathToWebp('/img/foo.png')).toBe('/img/foo.webp');
      expect(publicPathToWebp('/img/foo.JPEG')).toBe('/img/foo.webp');
      expect(publicPathToWebp('/img/foo.gif?v=2')).toBe('/img/foo.webp?v=2');
    });

    it('sem extensão conhecida: devolve inalterado', () => {
      expect(publicPathToWebp('/img/foo.svg')).toBe('/img/foo.svg');
    });
  });
});
