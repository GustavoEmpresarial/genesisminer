/**
 * Ícone de moeda (CDN cryptocurrency-icons) + badge letra se falhar.
 * Usado no seletor da sala e no strip Tokens do GameTopNav.
 */
import { useEffect, useState } from 'react';

export type MiningCoinIconRef = {
  id?: string;
  name?: string;
  symbol?: string;
  color?: string;
};

/** Sufixos de variante na BD (DAI_nft, USDC_gpu, GEMT_Airdrop) — ícone = base. */
const COIN_VARIANT_SUFFIX =
  /(?:^|[_\s-]+)(gpu|nft|airdrop|erc20|bep20|polygon|room)$/i;

const COIN_ICON_ALIASES: Record<string, string> = {
  pol: 'matic',
  polygon: 'matic',
  maticnetwork: 'matic',
  matic: 'matic',
  wrappedbtc: 'wbtc',
  weth: 'eth',
  tether: 'usdt',
  usdterc20: 'usdt',
  cbbtc: 'btc',
  coinbasebtc: 'btc',
  coinbasewrappedbtc: 'btc'
};

function looksLikeUuidOrGeneratedId(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return true;
  if (/^coin_\d+/.test(t)) return true;
  return false;
}

function slugForCoinIcon(coin: MiningCoinIconRef): string {
  const candidates = [coin.symbol, coin.name, coin.id];
  for (const raw of candidates) {
    if (raw == null) continue;
    let s = String(raw).trim().toLowerCase();
    if (!s || looksLikeUuidOrGeneratedId(s)) continue;
    s = s.replace(COIN_VARIANT_SUFFIX, '');
    s = s.replace(/[^a-z0-9]/g, '');
    if (!s) continue;
    const slug = COIN_ICON_ALIASES[s] || s;
    if (slug.length >= 2) return slug;
  }
  return '';
}

export function miningCoinIconSrc(coin: MiningCoinIconRef): string {
  const slug = slugForCoinIcon(coin);
  if (!slug || slug.length < 2) return '';
  return `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.17.2/128/color/${slug}.png`;
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
  const [broken, setBroken] = useState(false);
  const src = miningCoinIconSrc(coin);
  const label = miningCoinBadgeLabel(coin);
  const bg = coin.color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(coin.color) ? coin.color : '#475569';

  useEffect(() => {
    setBroken(false);
  }, [src]);

  if (!src || broken) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full font-black text-white shadow-inner ring-1 ring-black/10 dark:ring-white/10 ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(8, size * 0.32), backgroundColor: bg }}
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
      onError={() => setBroken(true)}
    />
  );
}
