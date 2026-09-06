/**
 * Taxa USD para moedas de mineração (payback / calculadora / wallet).
 */
import {
  isNftRoomExclusiveMiningCoinRef,
  normalizeMiningCoinSymbolKey,
  NFT_ROOM_STABLE_USD_SYMBOLS
} from './nft-room-mining.js';

function coinUsdNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Taxa USD: `usdc_rate` / `price_usd`, com fallback 1.0 em stables NFT (DAI, USDT, GHO). */
export function resolveMiningCoinUsdRate(coin: {
  id?: unknown;
  symbol?: unknown;
  usdc_rate?: unknown;
  price_usd?: unknown;
  usdcRate?: unknown;
  priceUSD?: unknown;
}): number {
  const usdc = coinUsdNumber(coin.usdc_rate ?? coin.usdcRate);
  if (usdc > 0) return usdc;
  const px = coinUsdNumber(coin.price_usd ?? coin.priceUSD);
  if (px > 0) return px;
  if (!isNftRoomExclusiveMiningCoinRef({ id: coin.id, symbol: coin.symbol })) return 0;
  const sym = normalizeMiningCoinSymbolKey(coin.symbol);
  if ((NFT_ROOM_STABLE_USD_SYMBOLS as readonly string[]).includes(sym)) return 1;
  return 0;
}
