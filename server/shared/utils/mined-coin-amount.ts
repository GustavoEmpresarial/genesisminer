/**
 * Precisão canónica de saldos minerados (`coin_balances.amount`).
 * Alinhado com saque/carteira (8 casas) — evita 11+ dígitos de ruído IEEE-754 na UI.
 */
export const MINED_COIN_AMOUNT_DECIMALS = 8;

const SCALE = 10 ** MINED_COIN_AMOUNT_DECIMALS;

/** Arredonda saldo minerado para a precisão de exibição / saque. */
export function roundMinedCoinAmount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n)) return 0;
  if (n === 0) return 0;
  return Math.round(n * SCALE) / SCALE;
}
