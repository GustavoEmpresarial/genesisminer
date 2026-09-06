/** Saúde do projecto a partir das publicações de transparência.
 *  Fonte única no client — o servidor replica a mesma regra em
 *  `server/modules/transparency/services/health.ts` (Rust via
 *  `GENESIS_TRANSPARENCY_RUST=1` / `genesis-core::transparency`).
 *
 *  Caixa real: Relatórios → Transações USDC on-chain (entradas/saídas tesouraria).
 *  Portal: pool + trade − despesa.
 *  `investment` e `other` são informativos — não entram na base.
 *  Piso 50. Dia = America/Sao_Paulo (BRT).
 */

export const TRANSPARENCY_HEALTH_FLOOR = 50;
export const TRANSPARENCY_HEALTH_CEILING = 100;
export const TRANSPARENCY_HEALTH_TZ = 'America/Sao_Paulo';
export const HEALTH_WEIGHT_INFLOW = 0.4;
export const HEALTH_WEIGHT_RENT = 0.35;
export const HEALTH_WEIGHT_LEDGER = 0.25;

export const TRANSPARENCY_CATEGORIES = ['pool', 'trade', 'investment', 'expense', 'other'] as const;
export type TransparencyHealthCategory = (typeof TRANSPARENCY_CATEGORIES)[number];

export type TransparencyHealthEntry = {
  category?: string | null;
  amountUsdc?: number | null;
  createdAt?: number | null;
};

export type HealthBand = 'excellent' | 'healthy' | 'neutral';

export type PlayerCashFlows = {
  depositsUsdc?: number;
  withdrawalsUsdc?: number;
  dayDepositsUsdc?: number;
  dayWithdrawalsUsdc?: number;
};

export type TransparencyHealthSnapshot = {
  poolUsdc: number;
  tradeUsdc: number;
  investmentUsdc: number;
  expenseUsdc: number;
  otherUsdc: number;
  depositsUsdc: number;
  withdrawalsUsdc: number;
  totalInUsdc: number;
  totalOutUsdc: number;
  netProfitUsdc: number;
  dayInUsdc: number;
  dayOutUsdc: number;
  dayProfitUsdc: number;
  dayDepositsUsdc: number;
  dayWithdrawalsUsdc: number;
  /** Eficiência do diário publicado (pool + trade − despesa). */
  efficiencyPct: number;
  inflowScore: number;
  rentScore: number;
  ledgerScore: number;
  /** Índice publicado — nunca abaixo de 50. */
  health: number;
  band: HealthBand;
  hasAmounts: boolean;
};

export function isTransparencyHealthCategory(raw: unknown): raw is TransparencyHealthCategory {
  return TRANSPARENCY_CATEGORIES.includes(String(raw) as TransparencyHealthCategory);
}

export function normalizeHealthCategory(raw: unknown): TransparencyHealthCategory {
  return isTransparencyHealthCategory(raw) ? raw : 'other';
}

export function entryTimeMs(createdAt: number | null | undefined): number {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return 0;
  return createdAt < 1e12 ? createdAt * 1000 : createdAt;
}

export function ymdInTimeZone(ms: number, timeZone = TRANSPARENCY_HEALTH_TZ): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export function isSameZonedDay(ms: number, nowMs: number, timeZone = TRANSPARENCY_HEALTH_TZ): boolean {
  const a = ymdInTimeZone(ms, timeZone);
  const b = ymdInTimeZone(nowMs, timeZone);
  return Boolean(a && b && a === b);
}

export function healthBand(score: number): HealthBand {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'healthy';
  return 'neutral';
}

export function clampHealth(raw: number): number {
  if (!Number.isFinite(raw)) return TRANSPARENCY_HEALTH_FLOOR;
  return Math.min(
    TRANSPARENCY_HEALTH_CEILING,
    Math.max(TRANSPARENCY_HEALTH_FLOOR, Math.round(raw))
  );
}

function clampPct(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

/** Volume de depósitos (log) + cobertura depósitos vs saques. */
export function scoreInflow(depositsUsdc: number, withdrawalsUsdc: number): number {
  const volume = Math.min(100, 20 * Math.log10(1 + Math.max(0, depositsUsdc)));
  const both = depositsUsdc + withdrawalsUsdc;
  const coverage = both <= 0 ? 50 : (depositsUsdc / both) * 100;
  return clampPct(0.55 * volume + 0.45 * coverage);
}

/** Quanto do dinheiro que entra fica no projecto depois dos saques. */
export function scoreRent(depositsUsdc: number, withdrawalsUsdc: number): number {
  if (!(depositsUsdc > 0)) return 50;
  return clampPct(((depositsUsdc - withdrawalsUsdc) / depositsUsdc) * 100);
}

/** Receitas publicadas (pool + trade) vs despesas publicadas. */
export function scorePublishedLedger(poolUsdc: number, tradeUsdc: number, expenseUsdc: number): number {
  const publishedIn = Math.max(0, poolUsdc) + Math.max(0, tradeUsdc);
  const publishedOut = Math.max(0, expenseUsdc);
  if (publishedIn <= 0 && publishedOut <= 0) return 50;
  if (publishedIn <= 0) return publishedOut > 0 ? 0 : 50;
  return clampPct(((publishedIn - publishedOut) / publishedIn) * 100);
}

function amountOf(entry: TransparencyHealthEntry): number | null {
  const n = Number(entry.amountUsdc);
  return Number.isFinite(n) ? n : null;
}

function countsInPortalLedger(cat: TransparencyHealthCategory): boolean {
  return cat === 'pool' || cat === 'trade' || cat === 'expense';
}

export function computeTransparencyHealth(
  entries: readonly TransparencyHealthEntry[],
  nowMs = Date.now(),
  cash: PlayerCashFlows = {}
): TransparencyHealthSnapshot {
  let poolUsdc = 0;
  let tradeUsdc = 0;
  let investmentUsdc = 0;
  let expenseUsdc = 0;
  let otherUsdc = 0;
  let dayPublishedIn = 0;
  let dayPublishedOut = 0;
  const depositsUsdc = Number(cash.depositsUsdc) || 0;
  const withdrawalsUsdc = Number(cash.withdrawalsUsdc) || 0;
  const dayDepositsUsdc = Number(cash.dayDepositsUsdc) || 0;
  const dayWithdrawalsUsdc = Number(cash.dayWithdrawalsUsdc) || 0;
  let hasAmounts = depositsUsdc > 0 || withdrawalsUsdc > 0;

  for (const entry of entries) {
    const amt = amountOf(entry);
    if (amt == null) continue;
    hasAmounts = true;
    const cat = normalizeHealthCategory(entry.category);
    if (cat === 'pool') poolUsdc += amt;
    else if (cat === 'trade') tradeUsdc += amt;
    else if (cat === 'investment') investmentUsdc += amt;
    else if (cat === 'expense') expenseUsdc += amt;
    else otherUsdc += amt;

    const when = entryTimeMs(entry.createdAt ?? null);
    if (when > 0 && isSameZonedDay(when, nowMs) && countsInPortalLedger(cat)) {
      if (cat === 'expense') dayPublishedOut += amt;
      else dayPublishedIn += amt;
    }
  }

  const totalInUsdc = depositsUsdc + poolUsdc + tradeUsdc;
  const totalOutUsdc = withdrawalsUsdc + expenseUsdc;
  const netProfitUsdc = totalInUsdc - totalOutUsdc;
  const dayInUsdc = dayDepositsUsdc + dayPublishedIn;
  const dayOutUsdc = dayWithdrawalsUsdc + dayPublishedOut;
  const dayProfitUsdc = dayInUsdc - dayOutUsdc;
  const inflowScore = scoreInflow(depositsUsdc, withdrawalsUsdc);
  const rentScore = scoreRent(depositsUsdc, withdrawalsUsdc);
  const ledgerScore = scorePublishedLedger(poolUsdc, tradeUsdc, expenseUsdc);
  const efficiencyPct = ledgerScore;
  const health = clampHealth(
    HEALTH_WEIGHT_INFLOW * inflowScore +
      HEALTH_WEIGHT_RENT * rentScore +
      HEALTH_WEIGHT_LEDGER * ledgerScore
  );

  return {
    poolUsdc,
    tradeUsdc,
    investmentUsdc,
    expenseUsdc,
    otherUsdc,
    depositsUsdc,
    withdrawalsUsdc,
    totalInUsdc,
    totalOutUsdc,
    netProfitUsdc,
    dayInUsdc,
    dayOutUsdc,
    dayProfitUsdc,
    dayDepositsUsdc,
    dayWithdrawalsUsdc,
    efficiencyPct,
    inflowScore,
    rentScore,
    ledgerScore,
    health,
    band: healthBand(health),
    hasAmounts
  };
}
