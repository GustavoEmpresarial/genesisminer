/**
 * Configuração de saque (Web3Withdraw) — portado de legacy/frontend/utils/withdrawTokenMatch.ts.
 */
export interface WithdrawTokenCfgLike {
  name?: string;
  symbol?: string;
  coinId?: string;
  network?: 'polygon' | 'bnb' | 'base';
  contract?: string;
  payoutWallet?: string;
  minAmount?: number;
  minWithdrawalUsdc?: number;
  feePercent?: number;
  /** JSON legado pode gravar string/número; só flags afirmativas contam. */
  disabled?: boolean | string | number | null;
}

const NATIVE_TOKEN_NAMES = new Set(['POL', 'POLYGON', 'BNB', 'ETH', 'WETH']);

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Mesma regra afirmativa de `web3DepositFlagDisabled`: só true, 1, "1", "true", "yes", "on".
 * `"false"` / `"0"` / ausência não desligam o saque.
 */
export function isWithdrawTokenDisabled(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes' || t === 'on';
  }
  return false;
}

function preferEnabled<T extends WithdrawTokenCfgLike>(matches: readonly T[]): T | null {
  if (matches.length === 0) return null;
  return matches.find((t) => !isWithdrawTokenDisabled(t.disabled)) ?? matches[0];
}

function looseNameMatch(
  t: WithdrawTokenCfgLike,
  cId: string,
  cSym: string,
  cNm: string
): boolean {
  const tSym = norm(t.symbol);
  const tNm = norm(t.name);
  if (cId && tNm === cId) return true;
  if (cSym && (tSym === cSym || tNm === cSym)) return true;
  if (cNm && (tNm === cNm || tSym === cNm)) return true;
  return false;
}

/**
 * Devolve a configuração que corresponde à moeda.
 * `coinId` ganha de um homónimo anterior (ex.: linha DAI antiga com `disabled`).
 * Símbolo/nome só servem se não houver `coinId`, e ignoram linhas cujo `coinId` é de outra moeda.
 */
export function findWithdrawTokenCfg<T extends WithdrawTokenCfgLike>(
  tokens: readonly T[] | undefined | null,
  coin: { id?: string; symbol?: string; name?: string } | undefined | null
): T | null {
  if (!tokens || !coin) return null;
  const cId = norm(coin.id);
  const cSym = norm(coin.symbol);
  const cNm = norm(coin.name);
  if (!cId && !cSym && !cNm) return null;

  if (cId) {
    const byId = tokens.filter((t) => norm(t.coinId) === cId);
    const picked = preferEnabled(byId);
    if (picked) return picked;
  }

  const byName = tokens.filter((t) => {
    const tId = norm(t.coinId);
    if (cId && tId && tId !== cId) return false;
    return looseNameMatch(t, cId, cSym, cNm);
  });
  return preferEnabled(byName);
}

/** `true` se a config existe **e** está pronta a usar (contract válido para ERC20 ou token nativo). */
export function isWithdrawTokenUsable(cfg: WithdrawTokenCfgLike | null | undefined): boolean {
  if (!cfg || isWithdrawTokenDisabled(cfg.disabled)) return false;
  const sym = String(cfg.symbol || cfg.name || '').toUpperCase();
  const isNative = NATIVE_TOKEN_NAMES.has(sym);
  const hasValidContract = /^0x[a-fA-F0-9]{40}$/.test(String(cfg.contract || ''));
  return isNative || hasValidContract;
}

/** Taxa USDC por 1 unidade da moeda: preferir `usdcRate`. */
export function effectiveCoinUsdcRate(coin: { usdcRate?: number; priceUSD?: number }): number {
  const u = Number(coin.usdcRate);
  if (Number.isFinite(u) && u > 0) return u;
  const p = Number(coin.priceUSD);
  if (Number.isFinite(p) && p > 0) return p;
  return 0;
}

/**
 * Mínimo em unidades da moeda, igual ao servidor (`Math.max(minAmount, minWithdrawalUsdc / usdc_rate)`).
 */
export function minimumWithdrawCryptoAmount(
  coin: { usdcRate?: number; priceUSD?: number },
  cfg: WithdrawTokenCfgLike | null | undefined
): number {
  if (!cfg) return 0;
  const minByCoinRaw = Number(cfg.minAmount);
  const minByCoin = Number.isFinite(minByCoinRaw) && minByCoinRaw > 0 ? minByCoinRaw : 0;
  const rate = effectiveCoinUsdcRate(coin);
  const minUsdcRaw = Number(cfg.minWithdrawalUsdc);
  const minByUsdc =
    Number.isFinite(minUsdcRaw) && minUsdcRaw > 0 && rate > 0 ? minUsdcRaw / rate : 0;
  return Math.max(minByCoin, minByUsdc);
}
