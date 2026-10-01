/**
 * Helpers do MiningCoinGlyph — aliases + preferência local antes do CDN.
 */
import { describe, expect, it } from 'vitest';
import {
  miningCoinBaseSlug,
  miningCoinCdnIconSlug,
  miningCoinCdnIconSrc,
  miningCoinCustomIconSrc,
  miningCoinIconCascadeSources,
  miningCoinIconSrc,
  miningCoinLocalIconSrc,
  miningCoinLocalLogoSlug
} from '../../../../client/src/shared/ui/MiningCoinGlyph.js';

describe('MiningCoinGlyph helpers', () => {
  it('aliases SHIBAINU / shiba / shib → local+cdn shib', () => {
    expect(miningCoinLocalLogoSlug({ name: 'SHIBAINU' })).toBe('shib');
    expect(miningCoinLocalLogoSlug({ symbol: 'shiba' })).toBe('shib');
    expect(miningCoinLocalLogoSlug({ symbol: 'SHIB' })).toBe('shib');
    expect(miningCoinCdnIconSlug({ name: 'SHIBAINU' })).toBe('shib');
  });

  it('aliases gent → gemt; gho stays gho', () => {
    expect(miningCoinLocalLogoSlug({ symbol: 'GENT' })).toBe('gemt');
    expect(miningCoinCdnIconSlug({ name: 'gent' })).toBe('gemt');
    expect(miningCoinLocalLogoSlug({ symbol: 'GHO_NFT' })).toBe('gho');
    expect(miningCoinBaseSlug({ symbol: 'GHO_NFT' })).toBe('gho');
  });

  it('local slug keeps pol/cbbtc (media-seed names); CDN remaps to matic/btc', () => {
    expect(miningCoinLocalLogoSlug({ symbol: 'POL' })).toBe('pol');
    expect(miningCoinCdnIconSlug({ symbol: 'POL' })).toBe('matic');
    expect(miningCoinLocalLogoSlug({ symbol: 'CBBTC' })).toBe('cbbtc');
    expect(miningCoinCdnIconSlug({ symbol: 'CBBTC' })).toBe('btc');
  });

  it('prefers custom iconUrl, then local path, then CDN', () => {
    const withCustom = { symbol: 'ETH', iconUrl: '  /img/uploads/custom-eth.png  ' };
    expect(miningCoinCustomIconSrc(withCustom)).toBe('/img/uploads/custom-eth.png');
    expect(miningCoinIconSrc(withCustom)).toBe('/img/uploads/custom-eth.png');

    const noCustom = { symbol: 'DOGE' };
    expect(miningCoinLocalIconSrc(noCustom)).toBe('/img/coin-logos/doge.png');
    expect(miningCoinIconSrc(noCustom)).toBe('/img/coin-logos/doge.png');
    expect(miningCoinCdnIconSrc(noCustom)).toContain('/doge.png');
    expect(miningCoinCdnIconSrc(noCustom)).toContain('cryptocurrency-icons');
  });

  it('dedupes identical custom===local URLs in cascade sources', () => {
    const localPath = '/img/coin-logos/doge.png';
    const sameAsLocal = { symbol: 'DOGE', iconUrl: localPath };
    const cascade = miningCoinIconCascadeSources(sameAsLocal);
    expect(cascade[0]).toBe(localPath);
    expect(cascade.filter((s) => s === localPath)).toHaveLength(1);
    expect(cascade.length).toBe(2);
    expect(cascade[1]).toContain('cryptocurrency-icons');
    expect(cascade[1]).toContain('/doge.png');
  });

  it('strips NFT/gpu variant suffixes before slug', () => {
    expect(miningCoinLocalLogoSlug({ symbol: 'DAI_NFT' })).toBe('dai');
    expect(miningCoinLocalLogoSlug({ symbol: 'USDT_NFT' })).toBe('usdt');
    expect(miningCoinLocalLogoSlug({ symbol: 'USDC_gpu' })).toBe('usdc');
  });

  it('resolves full coin names and internal variants when renamed in admin', () => {
    expect(miningCoinLocalLogoSlug({ name: 'Bitcoin' })).toBe('btc');
    expect(miningCoinLocalLogoSlug({ symbol: 'Bitcoin', name: 'Bitcoin' })).toBe('btc');
    expect(miningCoinLocalLogoSlug({ symbol: 'USDC_INTERNO' })).toBe('usdc');
    expect(miningCoinLocalLogoSlug({ symbol: 'USDC_INT' })).toBe('usdc');
    expect(miningCoinLocalLogoSlug({ name: 'USDC (Interno)' })).toBe('usdc');
    expect(miningCoinLocalLogoSlug({ name: 'Ethereum' })).toBe('eth');
    expect(miningCoinLocalLogoSlug({ symbol: 'Ethereum' })).toBe('eth');
    expect(miningCoinLocalLogoSlug({ name: 'Solana' })).toBe('sol');
    expect(miningCoinLocalLogoSlug({ name: 'Binance' })).toBe('bnb');
    expect(miningCoinLocalLogoSlug({ name: 'Binance Coin' })).toBe('bnb');
    expect(miningCoinLocalLogoSlug({ name: 'Dogecoin' })).toBe('doge');
    expect(miningCoinLocalLogoSlug({ name: 'Ripple' })).toBe('xrp');
    expect(miningCoinLocalLogoSlug({ name: 'TRON' })).toBe('trx');
    expect(miningCoinLocalIconSrc({ id: 'btc', name: 'Bitcoin', symbol: 'Bitcoin' })).toBe('/img/coin-logos/btc.png');
  });
});
