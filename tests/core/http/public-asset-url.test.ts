import { describe, expect, it } from 'vitest';
import { normalizePublicAssetUrl } from '../../../server/core/http/public-asset-url.js';

describe('core/http/public-asset-url', () => {
  it('undefined/vazio devolve undefined', () => {
    expect(normalizePublicAssetUrl(null)).toBeUndefined();
    expect(normalizePublicAssetUrl('   ')).toBeUndefined();
  });

  it('mantém data URIs e URLs absolutas intactas', () => {
    expect(normalizePublicAssetUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
    expect(normalizePublicAssetUrl('https://cdn.x.com/a.png')).toBe('https://cdn.x.com/a.png');
  });

  it('já começando com /img/ fica igual', () => {
    expect(normalizePublicAssetUrl('/img/miner/gpu.png')).toBe('/img/miner/gpu.png');
  });

  it('remove prefixo backend/ antes de normalizar', () => {
    expect(normalizePublicAssetUrl('backend/miner/gpu.png')).toBe('/img/miner/gpu.png');
  });

  it('subpasta conhecida + extensão de imagem move para /img/', () => {
    expect(normalizePublicAssetUrl('miner/gpu.png')).toBe('/img/miner/gpu.png');
    expect(normalizePublicAssetUrl('/moedas/btc.svg')).toBe('/img/moedas/btc.svg');
  });

  it('arquivo solto sem subpasta com extensão de imagem move para /img/', () => {
    expect(normalizePublicAssetUrl('gpu.png')).toBe('/img/gpu.png');
  });

  it('caminho não reconhecido é devolvido como veio', () => {
    expect(normalizePublicAssetUrl('/algum/outro/caminho')).toBe('/algum/outro/caminho');
  });
});
