/**
 * ZERads PTC player API — Offerwall provider.
 * `GET /api/zerads/me/token` · `GET /api/zerads/me/stats`
 */
import { apiFetch } from './http';

const base = '/api';

export type ZeradsTokenPayload = { token: string; ptc_url: string };

export type ZeradsStatsPayload = {
  totals: {
    callbacks: number;
    amount_zer: number;
    user_amount_usdc: number;
    platform_amount_usdc: number;
    clicks: number;
  };
  recent: Array<{
    amount_zer: number;
    user_amount_usdc: number;
    clicks: number;
    zer_to_usdc_rate: number;
    created_at: number;
  }>;
};

export async function getZeradsToken(): Promise<{
  data: ZeradsTokenPayload | null;
  error: string | null;
}> {
  try {
    const res = await apiFetch(`${base}/zerads/me/token`);
    if (!res.ok) {
      if (res.status === 401) return { data: null, error: 'SESSION' };
      return { data: null, error: 'LOAD_FAILED' };
    }
    const raw = (await res.json().catch(() => null)) as ZeradsTokenPayload | null;
    if (!raw?.token || !raw?.ptc_url) return { data: null, error: 'INVALID' };
    return { data: raw, error: null };
  } catch {
    return { data: null, error: 'NETWORK' };
  }
}

export async function getZeradsStats(): Promise<{
  data: ZeradsStatsPayload | null;
  error: string | null;
}> {
  try {
    const res = await apiFetch(`${base}/zerads/me/stats`);
    if (!res.ok) {
      if (res.status === 401) return { data: null, error: 'SESSION' };
      return { data: null, error: 'LOAD_FAILED' };
    }
    const raw = (await res.json().catch(() => null)) as ZeradsStatsPayload | null;
    if (!raw?.totals || !Array.isArray(raw.recent)) return { data: null, error: 'INVALID' };
    return { data: raw, error: null };
  } catch {
    return { data: null, error: 'NETWORK' };
  }
}
