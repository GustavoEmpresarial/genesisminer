/**
 * Nomes dos assets buildados — guardas contra typos que quebrariam o content-type
 * ou a invalidação de cache (ver `client/asset-epoch.ts`).
 */
import { describe, expect, it } from 'vitest';
import { ASSET_EPOCH, buildAssetFileNames } from '../../../client/asset-epoch.js';

describe('ASSET_EPOCH', () => {
  it('é um sufixo curto e seguro para nome de ficheiro', () => {
    expect(ASSET_EPOCH).toMatch(/^[a-z0-9]+$/);
  });
});

describe('buildAssetFileNames', () => {
  const names = buildAssetFileNames('e9');

  it('mantém a extensão no fim (content-type correto no CDN e no express)', () => {
    expect(names.entryFileNames.endsWith('.js')).toBe(true);
    expect(names.chunkFileNames.endsWith('.js')).toBe(true);
    expect(names.assetFileNames.endsWith('[extname]')).toBe(true);
  });

  it('inclui a época em todos os padrões', () => {
    for (const pattern of Object.values(names)) {
      expect(pattern).toContain('.e9');
    }
  });

  it('mantém o hash de conteúdo (deploy sem mudanças não invalida cache)', () => {
    for (const pattern of Object.values(names)) {
      expect(pattern).toContain('[hash]');
    }
  });

  it('escreve tudo sob assets/ (rota com guard de 404 no servidor)', () => {
    for (const pattern of Object.values(names)) {
      expect(pattern.startsWith('assets/')).toBe(true);
    }
  });

  it('época nova gera nomes diferentes da anterior', () => {
    expect(buildAssetFileNames('e10').assetFileNames).not.toBe(names.assetFileNames);
  });
});
