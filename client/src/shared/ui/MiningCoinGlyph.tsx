/**
 * Ícone de moeda: upload admin (`iconUrl`) → logos locais `/img/coin-logos` → CDN → badge letra.
 * Usado no seletor da sala, strip Tokens do GameTopNav, wallet e calculadora.
 */
import { useEffect, useState } from 'react';
import { normalizePublicAssetUrl } from '../utils/public-url';

export type MiningCoinIconRef = {
  id?: string;
  name?: string;
  symbol?: string;
  color?: string;
  iconUrl?: string | null;
};

/** Sufixos de variante na BD (DAI_nft, USDC_gpu, GEMT_Airdrop, USDC_INTERNO) — ícone = base. */
const COIN_VARIANT_SUFFIX =
  /(?:^|[_\s-]+)(gpu|nft|airdrop|erc20|bep20|polygon|room|interno|int)$/i;

const MIN_COIN_ICON_SLUG_LENGTH = 2;

/** Logos servidos de `storage/media-seed/coin-logos` via IMG_DIR. */
const COIN_LOGOS_PUBLIC_PREFIX = '/img/coin-logos';
const COIN_LOGO_FILE_EXT = 'png';

/**
 * Slug do ficheiro local (`/img/coin-logos/<slug>.png`).
 * Mantém `pol`/`cbbtc`/`gho` (ficheiros no media-seed), não o nome do pacote CDN.
 */
const LOCAL_COIN_LOGO_ALIASES: Record<string, string> = {
  bitcoin: 'btc',
  btc: 'btc',
  ethereum: 'eth',
  ether: 'eth',
  eth: 'eth',
  binancecoin: 'bnb',
  binance: 'bnb',
  bnb: 'bnb',
  solana: 'sol',
  sol: 'sol',
  dogecoin: 'doge',
  doge: 'doge',
  ripple: 'xrp',
  xrp: 'xrp',
  tron: 'trx',
  trx: 'trx',
  shibainu: 'shib',
  shiba: 'shib',
  shib: 'shib',
  tether: 'usdt',
  usdterc20: 'usdt',
  usdt: 'usdt',
  usdcoin: 'usdc',
  usdc: 'usdc',
  usdcint: 'usdc',
  usdcinterno: 'usdc',
  dai: 'dai',
  gemt: 'gemt',
  gent: 'gemt',
  genesis: 'gemt',
  gho: 'gho',
  pol: 'pol',
  polygon: 'pol',
  matic: 'matic',
  maticnetwork: 'matic',
  wrappedbtc: 'wbtc',
  wrappedbitcoin: 'wbtc',
  wbtc: 'wbtc',
  cbbtc: 'cbbtc',
  coinbasebtc: 'cbbtc',
  coinbasewrappedbtc: 'cbbtc'
};

/**
 * Slug do pacote `cryptocurrency-icons` (jsDelivr).
 * Inclui remaps CDN (`pol`→`matic`, `cbbtc`→`btc`) + aliases locais em falta no CDN.
 */
const CDN_COIN_ICON_ALIASES: Record<string, string> = {
  bitcoin: 'btc',
  btc: 'btc',
  ethereum: 'eth',
  ether: 'eth',
  eth: 'eth',
  binancecoin: 'bnb',
  binance: 'bnb',
  bnb: 'bnb',
  solana: 'sol',
  sol: 'sol',
  dogecoin: 'doge',
  doge: 'doge',
  ripple: 'xrp',
  xrp: 'xrp',
  tron: 'trx',
  trx: 'trx',
  shibainu: 'shib',
  shiba: 'shib',
  shib: 'shib',
  tether: 'usdt',
  usdterc20: 'usdt',
  usdt: 'usdt',
  usdcoin: 'usdc',
  usdc: 'usdc',
  usdcint: 'usdc',
  usdcinterno: 'usdc',
  dai: 'dai',
  gemt: 'gemt',
  gent: 'gemt',
  genesis: 'gemt',
  gho: 'gho',
  pol: 'matic',
  polygon: 'matic',
  maticnetwork: 'matic',
  matic: 'matic',
  wrappedbtc: 'wbtc',
  wrappedbitcoin: 'wbtc',
  wbtc: 'wbtc',
  weth: 'eth',
  cbbtc: 'btc',
  coinbasebtc: 'btc',
  coinbasewrappedbtc: 'btc'
};

const CRYPTOCURRENCY_ICONS_CDN_BASE =
  'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.17.2/128/color';

const BADGE_FALLBACK_BG = '#475569';
const BADGE_MIN_FONT_PX = 8;
const BADGE_FONT_SIZE_RATIO = 0.32;

function looksLikeUuidOrGeneratedId(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return true;
  if (/^coin_\d+/.test(t)) return true;
  return false;
}

function rawToCleanSlug(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw).trim().toLowerCase();
  if (!s || looksLikeUuidOrGeneratedId(s)) return '';
  s = s.replace(/[()[\]{}]/g, ' ').trim();
  s = s.replace(COIN_VARIANT_SUFFIX, '');
  s = s.replace(/[^a-z0-9]/g, '');
  return s.length >= MIN_COIN_ICON_SLUG_LENGTH ? s : '';
}

/** Normalized alphanumeric base from symbol → name → id (variants stripped). */
export function miningCoinBaseSlug(coin: MiningCoinIconRef): string {
  const candidates = [coin.symbol, coin.name, coin.id];
  for (const raw of candidates) {
    const s = rawToCleanSlug(raw);
    if (s) return s;
  }
  return '';
}

function applyAlias(base: string, aliases: Record<string, string>): string {
  if (!base) return '';
  const slug = aliases[base] || base;
  return slug.length >= MIN_COIN_ICON_SLUG_LENGTH ? slug : '';
}

/** Slug for `/img/coin-logos/<slug>.png`. */
export function miningCoinLocalLogoSlug(coin: MiningCoinIconRef): string {
  const candidates = [coin.symbol, coin.name, coin.id];
  for (const raw of candidates) {
    const s = rawToCleanSlug(raw);
    if (!s) continue;
    if (LOCAL_COIN_LOGO_ALIASES[s]) return LOCAL_COIN_LOGO_ALIASES[s];
  }
  return applyAlias(miningCoinBaseSlug(coin), LOCAL_COIN_LOGO_ALIASES);
}

/** Slug for cryptocurrency-icons CDN. */
export function miningCoinCdnIconSlug(coin: MiningCoinIconRef): string {
  const candidates = [coin.symbol, coin.name, coin.id];
  for (const raw of candidates) {
    const s = rawToCleanSlug(raw);
    if (!s) continue;
    if (CDN_COIN_ICON_ALIASES[s]) return CDN_COIN_ICON_ALIASES[s];
  }
  return applyAlias(miningCoinBaseSlug(coin), CDN_COIN_ICON_ALIASES);
}

/** Admin / upload path — empty if unset. */
export function miningCoinCustomIconSrc(coin: MiningCoinIconRef): string {
  const raw = typeof coin.iconUrl === 'string' ? coin.iconUrl.trim() : '';
  if (!raw) return '';
  return normalizePublicAssetUrl(raw) || raw;
}

/** Local media-seed logos — empty if no usable slug. */
export function miningCoinLocalIconSrc(coin: MiningCoinIconRef): string {
  const slug = miningCoinLocalLogoSlug(coin);
  if (!slug) return '';
  const path = `${COIN_LOGOS_PUBLIC_PREFIX}/${slug}.${COIN_LOGO_FILE_EXT}`;
  return normalizePublicAssetUrl(path) || path;
}

/** CDN fallback from symbol/name/id slug. */
export function miningCoinCdnIconSrc(coin: MiningCoinIconRef): string {
  const slug = miningCoinCdnIconSlug(coin);
  if (!slug) return '';
  return `${CRYPTOCURRENCY_ICONS_CDN_BASE}/${slug}.png`;
}

/** Prefer custom → local → CDN; drop empty and identical URLs (avoids double onError hops). */
export function miningCoinIconCascadeSources(coin: MiningCoinIconRef): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (url?: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  add(miningCoinCustomIconSrc(coin));
  add(miningCoinLocalIconSrc(coin));
  add(miningCoinCdnIconSrc(coin));

  const candidates = [coin.symbol, coin.name, coin.id];
  for (const raw of candidates) {
    const s = rawToCleanSlug(raw);
    if (!s) continue;
    const localSlug = LOCAL_COIN_LOGO_ALIASES[s] || s;
    if (localSlug) {
      const path = `${COIN_LOGOS_PUBLIC_PREFIX}/${localSlug}.${COIN_LOGO_FILE_EXT}`;
      add(normalizePublicAssetUrl(path) || path);
    }
    const cdnSlug = CDN_COIN_ICON_ALIASES[s] || s;
    if (cdnSlug) {
      add(`${CRYPTOCURRENCY_ICONS_CDN_BASE}/${cdnSlug}.png`);
    }
  }

  return out;
}

/** Prefer custom `iconUrl`, else local logos, else CDN slug. */
export function miningCoinIconSrc(coin: MiningCoinIconRef): string {
  return miningCoinIconCascadeSources(coin)[0] ?? '';
}

export function miningCoinBadgeLabel(coin: MiningCoinIconRef): string {
  const rawLabel = (coin.symbol || coin.name || '?').trim();
  return (
    rawLabel
      .replace(COIN_VARIANT_SUFFIX, '')
      .replace(/[_\s-]+/g, '')
      .slice(0, 3)
      .toUpperCase() || '?'
  );
}

export function MiningCoinGlyph({
  coin,
  size = 22,
  className = ''
}: {
  coin: MiningCoinIconRef;
  size?: number;
  className?: string;
}) {
  const sources = miningCoinIconCascadeSources(coin);
  const sourcesKey = sources.join('\0');
  const [failIndex, setFailIndex] = useState(0);
  const label = miningCoinBadgeLabel(coin);
  const bg =
    coin.color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(coin.color) ? coin.color : BADGE_FALLBACK_BG;

  useEffect(() => {
    setFailIndex(0);
  }, [sourcesKey]);

  const src = sources[failIndex] ?? '';

  if (!src) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full font-black text-white shadow-inner ring-1 ring-black/10 dark:ring-white/10 ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(BADGE_MIN_FONT_PX, size * BADGE_FONT_SIZE_RATIO),
          backgroundColor: bg
        }}
        aria-hidden
      >
        {label}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/10 ${className}`}
      onError={() => {
        setFailIndex((i) => i + 1);
      }}
    />
  );
}
