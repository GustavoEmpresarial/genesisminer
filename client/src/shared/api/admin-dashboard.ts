/** Tipos e fetchers do dashboard / métricas admin. */
import { apiFetch } from './http';

const base = '/api';

export type AdminDashboardStats = {
  totalUsers: number;
  deactivatedUsers?: number;
  onlineUsers: number;
  totalDeposited: number;
  totalWithdrawn: number;
  last10: Array<{ username: string; email: string }>;
  topDeposits: Array<{ username: string; email: string; amount: number }>;
  topWithdrawalsByCoin: Array<{
    coinId: string;
    coinName: string;
    top: Array<{ username: string; email: string; total: number }>;
  }>;
  globalPower?: number;
  topMiners?: Array<{ username: string; email: string; amount: number }>;
  rankingExcluded?: Array<{ id?: number; username: string; email: string; isAdmin?: boolean; is_admin?: number }>;
  miningCoins?: Array<{ id: string; name: string }>;
};

export type DailyMetricRow = {
  date: string;
  signups: number;
  activeUsers: number;
};

export type AdminSiteMetrics = {
  generatedAtMs: number;
  registeredUsers: number;
  deactivatedUsers: number;
  onlineUsers: number;
  dau: number;
  wau: number;
  mau: number;
  signupsToday: number;
  signupsThisWeek: number;
  signupsThisMonth: number;
  totalAccounts: number;
  adminAccounts: number;
  usersWithWallet: number;
  usersMiningNow: number;
  dailySeries: DailyMetricRow[];
};

export async function getAdminDashboardStats(): Promise<AdminDashboardStats | null> {
  try {
    const res = await apiFetch(`${base}/admin/dashboard-stats`);
    if (!res.ok) return null;
    return (await res.json()) as AdminDashboardStats;
  } catch {
    return null;
  }
}

export async function getAdminSiteMetrics(): Promise<AdminSiteMetrics | null> {
  try {
    const res = await apiFetch(`${base}/admin/metrics`);
    if (!res.ok) return null;
    return (await res.json()) as AdminSiteMetrics;
  } catch {
    return null;
  }
}

export async function toggleRankingExclusion(
  email: string,
  excluded: boolean
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`${base}/admin/ranking-exclusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, excluded })
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

/** Mapa leve id/username/email/wallet — usado no dashboard on-chain. */
export async function getAdminUserMap(): Promise<
  Array<{ id: number; username: string; email: string; polygonWallet?: string | null }>
> {
  try {
    const res = await apiFetch(`${base}/admin/users/map`);
    if (!res.ok) return [];
    const raw = await res.json();
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
