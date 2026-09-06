/**
 * Texto de ajuda quando a API ou o cliente detetam falta de USDC.
 */

function finitePositiveUsdc(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Indica mensagem típica de saldo USDC insuficiente (heurística para UX). */
export function looksLikeInsufficientUsdcMessage(message: string): boolean {
  const t = message.toLowerCase();
  const short =
    t.includes('insuficiente') ||
    t.includes('insufficient') ||
    t.includes('not enough');
  if (!short) return false;
  return (
    t.includes('usdc') ||
    t.includes('saldo') ||
    t.includes('balance') ||
    t.includes('funds')
  );
}

/**
 * Junta ao texto base uma linha com o valor em falta, quando `missingUsdc` é válido.
 * Evita duplicar se o texto já mencionar «Faltam».
 */
export function appendUsdcShortfallLine(baseMessage: string, missingUsdc?: unknown): string {
  const m = finitePositiveUsdc(missingUsdc);
  const b = typeof baseMessage === 'string' ? baseMessage.trim() : '';
  if (m == null) return b;
  const line = `Faltam ~USDC ${m.toFixed(2)}.`;
  if (!b) return line;
  if (/\bfaltam\b/i.test(b) && /\busdc\b/i.test(b)) return b;
  return `${b}\n\n${line}`;
}
