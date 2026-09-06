/**
 * Tolerância numérica oficial do motor de mineração (Plano 5).
 */
export const MINING_AMOUNT_ABS_EPSILON = 1e-9;
export const MINING_AMOUNT_REL_EPSILON = 1e-12;

export function amountsAlmostEqual(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff <= Math.max(MINING_AMOUNT_ABS_EPSILON, MINING_AMOUNT_REL_EPSILON * scale);
}

export function assertAmountsAlmostEqual(a: number, b: number, context: string): void {
  if (amountsAlmostEqual(a, b)) return;
  const diff = Math.abs(a - b);
  throw new Error(
    `[MiningEpsilon] ${context}: a=${a} b=${b} |Δ|=${diff} (abs=${MINING_AMOUNT_ABS_EPSILON} rel=${MINING_AMOUNT_REL_EPSILON})`
  );
}
