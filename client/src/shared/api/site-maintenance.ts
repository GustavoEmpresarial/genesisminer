import { apiFetch } from './http';

export type SiteStatus = {
  maintenance: boolean;
};

export async function getSiteStatus(): Promise<SiteStatus> {
  try {
    const res = await apiFetch('/api/site-status');
    if (!res.ok) return { maintenance: false };
    const j = (await res.json()) as { maintenance?: boolean };
    return { maintenance: j.maintenance === true };
  } catch {
    return { maintenance: false };
  }
}

export async function setSiteMaintenance(maintenance: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/admin/site-maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintenance })
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: j.error || 'Pedido falhou.' };
    return { ok: j.ok !== false };
  } catch {
    return { ok: false, error: 'Erro de rede.' };
  }
}
