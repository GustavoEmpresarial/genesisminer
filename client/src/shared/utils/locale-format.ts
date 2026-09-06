/**
 * Locale helpers for player UI (i18n → Intl).
 * Prefer these over ad-hoc `pt-BR` / `en-US` switches in feature pages.
 */
import type { AppLocale } from '../i18n';

/** BCP 47 tag for `Intl` / `toLocaleString`. */
export function dateLocaleFor(appLocale: AppLocale): string {
  if (appLocale === 'pt-BR') return 'pt-BR';
  if (appLocale === 'es') return 'es-ES';
  return 'en-US';
}

/** USDC money string with `$` prefix. */
export function formatUsdcAmount(
  n: number,
  locale: AppLocale,
  opts?: { minFractionDigits?: number; maxFractionDigits?: number }
): string {
  const loc = dateLocaleFor(locale);
  return `$${n.toLocaleString(loc, {
    minimumFractionDigits: opts?.minFractionDigits ?? 2,
    maximumFractionDigits: opts?.maxFractionDigits ?? 4
  })}`;
}

/** Precisão de saldos minerados (BNB, etc.) — alinhado com saque/carteira. */
export const MINED_COIN_DISPLAY_DECIMALS = 8;

const MINED_COIN_SCALE = 10 ** MINED_COIN_DISPLAY_DECIMALS;

/** Arredonda saldo minerado antes de formatar (evita 11+ dígitos de float na navbar). */
export function roundMinedCoinAmount(val: number): number {
  if (!Number.isFinite(val) || val === 0) return 0;
  return Math.round(val * MINED_COIN_SCALE) / MINED_COIN_SCALE;
}

/** Formata saldo/rate de moeda minerada para UI do jogador (≤ 8 casas). */
export function formatMinedCoinAmount(val: number): string {
  const n = roundMinedCoinAmount(val);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1e-8) {
    return n.toExponential(2);
  }
  if (abs < 1) {
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: MINED_COIN_DISPLAY_DECIMALS
    });
  }
  if (abs < 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

/**
 * Saldo de token no strip do header.
 * Evita 12 casas (ilegível na navbar); valores < 1 ficam com até 8 decimais.
 */
export function formatTokenAmount(val: number): string {
  return formatMinedCoinAmount(val);
}

export function formatLiveTokenAmount(val: number, _perSec?: number): string {
  return formatTokenAmount(val);
}

/** Hash total no strip do header (legado App.tsx `formatHash`). */
export function formatHashTotal(val: number): string {
  if (val === 0) return '0 H/s';
  if (val < 0.0001) return `${val.toFixed(8)} H/s`;
  return `${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(val)} H/s`;
}

/**
 * Epoch ms (or numeric string) → localized date-time, or `fallback` if invalid.
 * Accepts seconds-era values only if already ms-scale (> 1e12); otherwise treats as ms.
 */
export function formatInstantMs(
  ts: unknown,
  locale: AppLocale,
  fallback = '—'
): string {
  if (ts == null) return fallback;
  const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const d = new Date(Math.trunc(n));
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return d.toLocaleString(dateLocaleFor(locale));
  } catch {
    return fallback;
  }
}
