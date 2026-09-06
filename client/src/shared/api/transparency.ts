import type { AppLocale } from '../i18n';
import { formatUsdcAmount } from '../utils/locale-format';
import { apiFetch } from './http';

const base = '/api';

export type TransparencyCategory = 'pool' | 'trade' | 'expense' | 'investment' | 'other';

export type TransparencyHealthBand = 'excellent' | 'healthy' | 'neutral';

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
  efficiencyPct: number;
  inflowScore: number;
  rentScore: number;
  ledgerScore: number;
  health: number;
  band: TransparencyHealthBand;
  hasAmounts: boolean;
  floor: number;
  computedAt: number;
};

export async function getTransparencyHealth(): Promise<TransparencyHealthSnapshot> {
  const res = await apiFetch(`${base}/transparency/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as TransparencyHealthSnapshot;
}

export type TransparencyEntry = {
  id: number;
  category: string;
  title: string;
  body?: string;
  amountUsdc?: number;
  linkUrl?: string;
  /** `YYYY-MM` or null = standing / Geral. */
  periodYm?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export async function getTransparency(): Promise<TransparencyEntry[]> {
  const res = await apiFetch(`${base}/transparency`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as TransparencyEntry[]) : [];
}

export type Web3SettingsPublic = {
  depositWallet?: string;
};

export async function getWeb3Settings(): Promise<Web3SettingsPublic> {
  const res = await apiFetch(`${base}/web3-settings`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Web3SettingsPublic;
}

/** USDC for transparency amounts; `—` when missing. */
export function formatTransparencyUsdc(n: number | undefined | null, locale: AppLocale): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return formatUsdcAmount(n, locale, { minFractionDigits: 2, maxFractionDigits: 2 });
}
