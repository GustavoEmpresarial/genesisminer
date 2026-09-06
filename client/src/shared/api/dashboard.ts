/**
 * Player dashboard aggregator — GET /api/dashboard/state.
 */
import { apiFetch } from './http';
import type { DashboardState, DashboardStateResult } from '../../features/dashboard/lib/types';

const base = '/api';

/**
 * GET `/api/dashboard/state` — agregador read-only da dashboard principal.
 * Devolve sempre um `DashboardStateResult` (nunca lança), para que o componente
 * possa renderizar o estado de erro (`Tentar novamente`) sem catch externo.
 */
export async function getDashboardState(): Promise<DashboardStateResult> {
  try {
    const res = await apiFetch(`${base}/dashboard/state`);
    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Sessão expirada. Faça login novamente.' };
    }
    if (!res.ok) {
      let msg = 'Não foi possível carregar a dashboard agora.';
      try {
        const j = (await res.json()) as { error?: string };
        if (j && typeof j.error === 'string' && j.error.trim()) msg = j.error.trim();
      } catch {
        /* corpo não-JSON */
      }
      return { ok: false, status: res.status, error: msg };
    }
    const raw = (await res.json()) as (Partial<DashboardState> & { ok?: boolean }) | null;
    if (!raw || raw.ok !== true || !raw.miner || !raw.wallet) {
      return { ok: false, status: res.status, error: 'Resposta inválida do servidor.' };
    }
    const { ok: _ok, ...data } = raw as DashboardState & { ok?: boolean };
    void _ok;
    return { ok: true, data: data as DashboardState };
  } catch {
    return { ok: false, status: 0, error: 'Não foi possível conectar ao servidor.' };
  }
}
